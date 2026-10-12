// Účet klienta a účty skupin (Realizace, krok 3 — schváleno 12. 10. 2026).
//
// Funguje jako bankovní účty:
//   • Účet klienta (clients/<id>): přijaté platby `payments` — každá platba se
//     zapisuje JEN JEDNOU, tady. Zůstatek se vede zvlášť pro každou měnu,
//     nic se nepřevádí.
//       { id, date, amount, currency, payer, ident, channel, note, by, at }
//   • Převod na skupinu = záznam v `allocations` klienta:
//       { id, amount, currency, offerId, offerLabel, paymentId, note, by, at }
//     Starší záznamy mají jen `label` (název akce, bez offerId) — zůstávají,
//     jdou „propojit se skupinou“.
//     Převod jde vrátit (smazat) → peníze se vrátí na volný zůstatek klienta.
//   • Účet skupiny (Realizace) = součet převodů s offerId této akce + plán
//     plateb (offers/<id>.rzClient.plan) proti ceně pro klienta (clientPrice.js).
// Zápisy do klienta jdou přes transakci (přečte aktuální stav, přidá/změní
// jeden záznam), takže se zápisy z Clients a z Realizace nepřepíšou.

import { db, auth } from './firebase';
import { doc, runTransaction, updateDoc, FieldPath, deleteField, arrayUnion } from 'firebase/firestore';
import { codeForEmail } from './people';

export const INCOMING_CHANNELS = [
  { value: '',        label: 'kam přišlo?' },
  { value: 'fio_eur', label: 'FIO EUR' },
  { value: 'fio_chf', label: 'FIO CHF' },
  { value: 'kb_czk',  label: 'KB CZK' },
  { value: 'kb_eur',  label: 'KB EUR' },
  { value: 'kb_chf',  label: 'KB CHF' },
  { value: 'cash',    label: 'Hotovost' },
  { value: 'other',   label: 'jiné' },
];
export const channelLabel = (v) => (INCOMING_CHANNELS.find(c => c.value === v) || {}).label || v || '';

const who = () => codeForEmail(auth.currentUser?.email) || auth.currentUser?.email || '';
const num = (v) => { const x = parseFloat(String(v === 0 ? '0' : (v || '')).replace(/[\s  ]/g, '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const newId = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const clean = (o) => { const x = { ...o }; Object.keys(x).forEach(k => { if (x[k] === undefined) delete x[k]; }); return x; };

// ── Výpočty ──
export function balances(client) {
  const out = {};
  const add = (cur, k, v) => { const c = out[cur] = out[cur] || { currency: cur, received: 0, allocated: 0, free: 0 }; c[k] += v; };
  ((client && client.payments) || []).forEach(p => add(p.currency || 'EUR', 'received', num(p.amount)));
  ((client && client.allocations) || []).forEach(a => add(a.currency || 'EUR', 'allocated', num(a.amount)));
  Object.values(out).forEach(c => { c.received = r2(c.received); c.allocated = r2(c.allocated); c.free = r2(c.received - c.allocated); });
  return Object.values(out);
}

const norm = (s) => String(s || '').trim().toLowerCase();
// Převody na tuto skupinu: propojené (offerId) + staré podle názvu (legacy).
export function groupAllocations(client, offer) {
  const list = (client && client.allocations) || [];
  const names = [offer.name, [offer.offerNumber, offer.name].filter(Boolean).join(' · ')].map(norm).filter(Boolean);
  return list
    .filter(a => (a.offerId && a.offerId === offer.id) || (!a.offerId && names.includes(norm(a.label))))
    .map(a => ({ ...a, legacy: !a.offerId }));
}
export function receivedByCurrency(allocs) {
  const out = {};
  (allocs || []).forEach(a => { const c = a.currency || 'EUR'; out[c] = r2((out[c] || 0) + num(a.amount)); });
  return out;
}

// Plán plateb: řádky { id, kind: 'percent'|'fixed'|'rest', pct, amount, cur, dueMode, due, dueDays, note, order }
export const PLAN_KINDS = [
  { value: 'percent', label: '% z celkové ceny' },
  { value: 'fixed',   label: 'pevná částka' },
  { value: 'rest',    label: 'zbytek' },
];
const ymd = (d) => String(d || '').slice(0, 10);
const addDays = (d, n) => { const x = new Date(ymd(d) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export function planDue(row, offer) {
  if (row.dueMode === 'before') {
    const days = parseInt(String(row.dueDays || ''), 10);
    if (!Number.isFinite(days) || ymd(offer.startDate).length < 10) return '';
    return addDays(offer.startDate, -days);
  }
  return ymd(row.due);
}
export function planRows(offer) {
  const box = ((offer && offer.rzClient) || {}).plan || {};
  return Object.entries(box).filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => ({ ...v, id: k })).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

// totals = { EUR: 32650, … } (cena pro klienta po měnách), received = { EUR: … }
export function planStatus(offer, totals, received, today = new Date().toISOString().slice(0, 10)) {
  const rows = planRows(offer);
  const byCur = {};
  rows.forEach(r => { const c = r.cur || 'EUR'; (byCur[c] = byCur[c] || []).push(r); });
  const out = [];
  Object.entries(byCur).forEach(([cur, list]) => {
    const total = num(totals[cur]);
    const fixedSum = list.filter(r => r.kind !== 'rest').reduce((s, r) => s + (r.kind === 'percent' ? total * num(r.pct) / 100 : num(r.amount)), 0);
    const withAmt = list.map(r => ({ ...r, cur, due: planDue(r, offer),
      amount: r2(r.kind === 'percent' ? total * num(r.pct) / 100 : r.kind === 'rest' ? Math.max(total - fixedSum, 0) : num(r.amount)) }));
    // Přijaté peníze se započítávají postupně v pořadí plánu (1. záloha, 2. záloha, doplatek…).
    let pot = num(received[cur]);
    withAmt.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)).forEach(r => {
      const covered = r2(Math.min(pot, r.amount));
      pot = r2(pot - covered);
      const missing = r2(r.amount - covered);
      const soon = addDays(today, 14);
      const status = missing <= 0.004 ? 'paid' : !r.due ? (covered > 0 ? 'partial' : 'nodue')
        : r.due < today ? 'overdue' : r.due <= soon ? 'soon' : (covered > 0 ? 'partial' : 'planned');
      out.push({ ...r, covered, missing, status });
    });
  });
  return out;
}
export const PLAN_STYLE = {
  paid:    { icon: '✅', label: 'přišlo',          color: '#27500A', bg: '#e8f5e9' },
  partial: { icon: '◐',  label: 'přišla část',     color: '#1d4ed8', bg: '#eff6ff' },
  planned: { icon: '🗓', label: 'čeká se',         color: '#1d4ed8', bg: '#eff6ff' },
  soon:    { icon: '⏳', label: 'splatné brzy',    color: '#9a3412', bg: '#ffedd5' },
  overdue: { icon: '⛔', label: 'po splatnosti',   color: '#b91c1c', bg: '#fee2e2' },
  nodue:   { icon: '❓', label: 'chybí splatnost', color: '#c2410c', bg: '#fff7ed' },
};

// ── Zápisy do klienta (transakce) ──
async function txClient(clientId, fn) {
  const ref = doc(db, 'clients', clientId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Klient nenalezen');
    const d = snap.data();
    const patch = fn({ payments: Array.isArray(d.payments) ? [...d.payments] : [], allocations: Array.isArray(d.allocations) ? [...d.allocations] : [] });
    if (patch) tx.update(ref, patch);
  });
}

export const addPayment = (clientId, p) => txClient(clientId, ({ payments }) => ({
  payments: [...payments, clean({ id: newId(), date: p.date || new Date().toISOString().slice(0, 10), amount: num(p.amount), currency: p.currency || 'EUR',
    payer: (p.payer || '').trim(), ident: (p.ident || '').trim(), channel: p.channel || '', note: (p.note || '').trim(), by: who(), at: new Date().toISOString() })],
}));
export const updatePayment = (clientId, id, patch) => txClient(clientId, ({ payments }) => ({
  payments: payments.map(p => (String(p.id) === String(id) ? clean({ ...p, ...patch, amount: patch.amount !== undefined ? num(patch.amount) : p.amount, editedBy: who(), editedAt: new Date().toISOString() }) : p)),
}));
export const deletePayment = (clientId, id) => txClient(clientId, ({ payments }) => ({ payments: payments.filter(p => String(p.id) !== String(id)) }));

export const addAllocation = (clientId, a) => txClient(clientId, ({ allocations }) => ({
  allocations: [...allocations, clean({ id: newId(), amount: num(a.amount), currency: a.currency || 'EUR', offerId: a.offerId || undefined,
    offerLabel: a.offerLabel || undefined, label: a.label || a.offerLabel || '', paymentId: a.paymentId || undefined,
    note: (a.note || '').trim(), by: who(), at: new Date().toISOString() })],
}));
export const deleteAllocation = (clientId, id) => txClient(clientId, ({ allocations }) => ({ allocations: allocations.filter(a => String(a.id) !== String(id)) }));
export const linkAllocation = (clientId, id, offer) => txClient(clientId, ({ allocations }) => ({
  allocations: allocations.map(a => (String(a.id) === String(id)
    ? clean({ ...a, offerId: offer.id, offerLabel: [offer.offerNumber, offer.name].filter(Boolean).join(' · '), linkedBy: who(), linkedAt: new Date().toISOString() }) : a)),
}));

// ── Plán plateb ve skupině (offers/<id>.rzClient.plan.<rowId>) ──
const offerRef = (offerId) => doc(db, 'offers', offerId);
const logArgs = (text) => text ? [new FieldPath('rzClient', 'log'), arrayUnion({ at: new Date().toISOString(), by: who(), text })] : [];
export async function addPlanRow(offerId, init = {}) {
  const id = newId();
  await updateDoc(offerRef(offerId), new FieldPath('rzClient', 'plan', id),
    clean({ kind: 'percent', pct: '', amount: '', cur: 'EUR', dueMode: 'date', due: '', dueDays: '', note: '', order: Date.now(), ...init }),
    ...logArgs('nový řádek plánu plateb'));
}
export async function savePlanRow(offerId, offer, id, patch, text) {
  const prev = ((((offer || {}).rzClient || {}).plan) || {})[id] || {};
  await updateDoc(offerRef(offerId), new FieldPath('rzClient', 'plan', String(id)), clean({ ...prev, ...patch, setBy: who(), setAt: new Date().toISOString() }), ...logArgs(text));
}
export async function deletePlanRow(offerId, id) {
  await updateDoc(offerRef(offerId), new FieldPath('rzClient', 'plan', String(id)), deleteField(), ...logArgs('řádek plánu plateb smazán'));
}
