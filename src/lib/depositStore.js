// Zápisy záloh a konečných počtů — jedno společné místo pro nabídku i Realizaci
// (schváleno 11. 10. 2026). Popis dat: lib/deposits.js a lib/depositCalc.js.
//
// Každá změna zapisuje jen jeden řádek zálohy (FieldPath: depositsBy → karta → řádek),
// takže úprava v nabídce a v Realizaci se navzájem nepřepíšou, ani když má
// někdo nabídku otevřenou. Pole items v nabídce se tu nikdy nemění.

import { db, auth } from './firebase';
import { doc, updateDoc, FieldPath, deleteField, arrayUnion } from 'firebase/firestore';
import { codeForEmail } from './people';
import { effectiveDeposits } from './deposits';
import { FINAL_FIELDS } from './depositCalc';

const who = () => codeForEmail(auth.currentUser?.email) || auth.currentUser?.email || '';
const ref = (offerId) => doc(db, 'offers', offerId);

const LABELS = {
  kind: 'typ', pct: '%', basis: 'z čeho', unit: 'za jednotku', amount: 'částka',
  dueMode: 'splatnost', dueDays: 'dní před příjezdem', due: 'splatnost', paid: 'zaplaceno',
  date: 'datum platby', method: 'čím',
};
const show = (k, v) => {
  if (k === 'paid') return v ? 'ano' : 'ne';
  if (k === 'kind') return ({ fixed: 'pevná částka', percent: '% z ceny', per_room: 'za pokoj', per_pax: 'za osobu' })[v] || v || '—';
  if (k === 'basis') return v === 'no_tax' ? 'bez city tax' : 'celá cena';
  if (k === 'dueMode') return v === 'before' ? 'dní před příjezdem' : 'datum';
  if ((k === 'due' || k === 'date') && /^\d{4}-\d{2}-\d{2}/.test(String(v || ''))) { const [y, m, d] = String(v).slice(0, 10).split('-'); return `${d}.${m}.${y}`; }
  return (v === '' || v === undefined || v === null) ? '—' : String(v);
};
function describe(prev, patch) {
  return Object.keys(patch)
    .filter(k => LABELS[k] && String(prev[k] ?? '') !== String(patch[k] ?? ''))
    .map(k => `${LABELS[k]}: ${show(k, prev[k])} → ${show(k, patch[k])}`)
    .join(', ');
}
const clean = (o) => {
  const x = { ...o };
  delete x._key; delete x._legacy;
  Object.keys(x).forEach(k => { if (x[k] === undefined) delete x[k]; });
  return x;
};
const hasBox = (offer, item) => !!(offer.depositsBy && offer.depositsBy[String(item.id)]);

// Celý seznam karty do společného místa (jen poprvé — převod ze starého seznamu).
async function writeWholeBox(offerId, item, rows) {
  const box = { _init: true };
  rows.forEach((r, i) => { box[String(r._key || r.id || i)] = clean({ ...r, order: r.order ?? i }); });
  await updateDoc(ref(offerId), new FieldPath('depositsBy', String(item.id)), box);
}

// Změna jednoho řádku. `from` = 'nabídka' | 'Realizace'.
export async function saveDepositRow(offerId, offer, item, rowKey, patch, from) {
  const rows = effectiveDeposits(offer, item);
  const prev = rows.find(r => r._key === String(rowKey)) || {};
  const now = new Date().toISOString();
  const by = who();
  const text = describe(prev, patch);
  const next = clean({ ...prev, ...patch, lastAt: now, lastBy: by, lastFrom: from });
  if (text) next.log = [{ at: now, by, from, text }, ...(Array.isArray(prev.log) ? prev.log : [])].slice(0, 20);
  if (!hasBox(offer, item)) {
    await writeWholeBox(offerId, item, rows.map(r => (r._key === String(rowKey) ? { ...next, _key: r._key } : r)));
    return;
  }
  await updateDoc(ref(offerId), new FieldPath('depositsBy', String(item.id), String(rowKey)), next);
}

export async function addDepositRow(offerId, offer, item, from, init = {}) {
  const key = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const now = new Date().toISOString();
  const by = who();
  const row = clean({ id: key, amount: '', due: '', paid: false, date: '', method: '', order: Date.now(),
    ...init, lastAt: now, lastBy: by, lastFrom: from, log: [{ at: now, by, from, text: 'nová záloha' }] });
  if (!hasBox(offer, item)) {
    await writeWholeBox(offerId, item, [...effectiveDeposits(offer, item), { ...row, _key: key }]);
    return key;
  }
  await updateDoc(ref(offerId), new FieldPath('depositsBy', String(item.id), key), row);
  return key;
}

export async function deleteDepositRow(offerId, offer, item, rowKey) {
  if (!hasBox(offer, item)) {
    await writeWholeBox(offerId, item, effectiveDeposits(offer, item).filter(r => r._key !== String(rowKey)));
    return;
  }
  await updateDoc(ref(offerId), new FieldPath('depositsBy', String(item.id), String(rowKey)), deleteField());
}

// ── Konečné počty (offers/<id>.rzFinal) ──
const describeCounts = (prev, patch) => FINAL_FIELDS
  .filter(({ key }) => key in patch && String(prev[key] ?? '') !== String(patch[key] ?? ''))
  .map(({ key, label }) => `${label}: ${prev[key] === '' || prev[key] === undefined ? '—' : prev[key]} → ${patch[key] === '' ? '—' : patch[key]}`)
  .join(', ');

export async function saveFinalGroup(offerId, offer, patch) {
  const prev = ((offer.rzFinal || {}).group) || {};
  const now = new Date().toISOString();
  const by = who();
  const next = clean({ ...prev, ...patch, setAt: now, setBy: by });
  const text = describeCounts(prev, patch);
  const args = [new FieldPath('rzFinal', 'group'), next];
  if (text) args.push(new FieldPath('rzFinal', 'log'), arrayUnion({ at: now, by, where: 'celá akce', text }));
  await updateDoc(ref(offerId), ...args);
}

export async function saveFinalHotel(offerId, offer, item, patch, logText) {
  const prev = (((offer.rzFinal || {}).hotels) || {})[String(item.id)] || {};
  const now = new Date().toISOString();
  const by = who();
  const next = clean({ ...prev, ...patch, setAt: now, setBy: by });
  const text = logText || describeCounts(prev, patch);
  const args = [new FieldPath('rzFinal', 'hotels', String(item.id)), next];
  if (text) args.push(new FieldPath('rzFinal', 'log'), arrayUnion({ at: now, by, where: [item.city, item.name].filter(Boolean).join(' – ') || 'hotel', text }));
  await updateDoc(ref(offerId), ...args);
}
