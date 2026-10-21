// Kontrola faktur od hotelů (Realizace, krok D — schváleno 21. 10. 2026).
//
// Uložení: offers/<id>.rzInvoices[itemId] = {
//   status: 'waiting' | 'mismatch' | 'ok' | 'okDiff',
//   currency, total,                 // částka z faktury a její měna
//   lines: { dblN, sglN, trplN,      // pokojonoci podle faktury
//            pDbl, pSgl, pTrpl,      // ceny za pokoj/noc podle faktury
//            tax, meals, foc, other },// city tax, strava, FOC (kladné číslo = odečteno), jiné
//   note, files: [{ url, name, path }], log: [{ at, by, text }], setAt, setBy }
// Zápis po částech přes FieldPath — nabídka toto pole nikdy nepřepisuje.
//
// Porovnání: „podle nás“ = výpočet z Konečných počtů a cen z karty (depositCalc.hotelTotal).
// Faktura v jiné měně než karta → porovnání přes kurzy z Nastavení, ORIENTAČNĚ.

import { db, auth, storage } from './firebase';
import { doc, updateDoc, FieldPath, arrayUnion } from 'firebase/firestore';
import { ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { codeForEmail } from './people';
import { finalFor, hotelTotal } from './depositCalc';
import { evalAmount } from './offerCalc';
import { effectiveDeposits, amountOf, isPaid } from './deposits';

const n = (v) => { const x = parseFloat(String(v === 0 ? '0' : (v || '')).replace(/[\s  ]/g, '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const filled = (v) => String(v === 0 ? '0' : (v ?? '')).trim() !== '';
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const who = () => codeForEmail(auth.currentUser?.email) || auth.currentUser?.email || '';

export const INVOICE_STATUS = {
  waiting:  { icon: '⏳', label: 'čeká na fakturu',            color: '#64748b', bg: '#f1f5f9' },
  mismatch: { icon: '⚠',  label: 'nesedí / reklamováno',       color: '#b91c1c', bg: '#fee2e2' },
  okDiff:   { icon: '☑',  label: 'schváleno s rozdílem',       color: '#9a3412', bg: '#ffedd5' },
  ok:       { icon: '✅', label: 'zkontrolováno, sedí',         color: '#27500A', bg: '#e8f5e9' },
};

export const invoiceOf = (offer, itemId) => (((offer && offer.rzInvoices) || {})[String(itemId)]) || {};

// Kurz: kolik EUR je 1 jednotka měny (rates z Nastavení; EUR = 1).
const toEur = (amount, cur, rates) => (cur === 'EUR' ? amount : amount * ((rates && rates[cur]) || 0));
const fromEur = (amount, cur, rates) => (cur === 'EUR' ? amount : ((rates && rates[cur]) ? amount / rates[cur] : 0));

// Naše očekávání pro hotel — řádky ve stejném členění jako faktura.
export function expectedInvoice(item, offer) {
  const { counts } = finalFor(offer, item.id);
  const h = hotelTotal(item, offer);
  const nights = n(item.nights);
  const staff = n(counts.guide) + n(counts.driver);
  return {
    currency: item.currency || 'EUR',
    dblN: n(counts.dbl) * nights,
    sglN: (n(counts.sgl) + staff) * nights,
    trplN: n(counts.trpl) * nights,
    pDbl: evalAmount(item.pricePerNightDbl), pSgl: evalAmount(item.pricePerNightSngl), pTrpl: evalAmount(item.trplPrice),
    tax: h.tax, meals: h.meals, foc: h.foc, other: 0,
    total: h.total, any: h.any, warnings: h.warnings,
  };
}

// Porovnání faktury s očekáváním. Vrací řádky { key, label, ours, theirs, diff, money } a celkový rozdíl.
export function compareInvoice(item, offer, rates) {
  const exp = expectedInvoice(item, offer);
  const inv = invoiceOf(offer, item.id);
  const L = inv.lines || {};
  const invCur = inv.currency || exp.currency;
  const sameCur = invCur === exp.currency;
  // Částku z faktury převedeme do měny karty (jen když se liší — orientačně).
  const conv = (v) => (sameCur ? v : fromEur(toEur(v, invCur, rates), exp.currency, rates));
  const rows = [
    { key: 'dblN',  label: 'DBL pokojonoci',  ours: exp.dblN,  money: false },
    { key: 'sglN',  label: 'SGL pokojonoci (vč. tour leadera a řidiče)', ours: exp.sglN, money: false },
    { key: 'trplN', label: 'TRPL pokojonoci', ours: exp.trplN, money: false },
    { key: 'pDbl',  label: 'cena DBL / noc',  ours: exp.pDbl,  money: true },
    { key: 'pSgl',  label: 'cena SGL / noc',  ours: exp.pSgl,  money: true },
    { key: 'pTrpl', label: 'cena TRPL / noc', ours: exp.pTrpl, money: true },
    { key: 'tax',   label: 'city tax celkem', ours: exp.tax,   money: true },
    { key: 'meals', label: 'strava celkem',   ours: exp.meals, money: true },
    { key: 'foc',   label: 'FOC od hotelu (odečteno)', ours: exp.foc, money: true },
    { key: 'other', label: 'jiné položky',    ours: 0,         money: true },
  ].map(r => {
    const has = filled(L[r.key]);
    const theirsRaw = has ? n(L[r.key]) : null;
    const theirs = has ? (r.money ? r2(conv(theirsRaw)) : theirsRaw) : null;
    const diff = has ? r2(theirs - r.ours) : null;
    return { ...r, theirsRaw, theirs, diff, bad: has && Math.abs(diff) >= (r.money ? 0.5 : 0.01) };
  });
  const hasTotal = filled(inv.total);
  const totalRaw = hasTotal ? n(inv.total) : null;
  const totalConv = hasTotal ? r2(conv(totalRaw)) : null;
  const diff = hasTotal ? r2(totalConv - exp.total) : null;
  const hints = [];
  rows.filter(r => r.bad).forEach(r => {
    if (r.key === 'foc' && r.theirs === 0 && r.ours > 0) hints.push('FOC od hotelu není na faktuře odečten.');
    else if (!r.money) hints.push(`${r.label}: faktura ${r.theirs}, podle nás ${r.ours} (${r.diff > 0 ? '+' : ''}${r.diff}).`);
    else hints.push(`${r.label}: rozdíl ${r.diff > 0 ? '+' : ''}${r.diff.toLocaleString('cs-CZ', { minimumFractionDigits: 2 })} ${exp.currency}.`);
  });
  const suggested = !hasTotal ? 'waiting' : (Math.abs(diff) < 1 && !rows.some(r => r.bad) ? 'ok' : 'mismatch');
  return {
    exp, inv, rows, invCur, sameCur, hasTotal, totalRaw, totalConv, diff, hints,
    status: inv.status || suggested, suggested,
    convOk: sameCur || !!((invCur === 'EUR' || (rates && rates[invCur])) && (exp.currency === 'EUR' || (rates && rates[exp.currency]))),
  };
}

// Zaplacené zálohy hotelu (v měně karty) a doplatek podle faktury.
export function paidDeposits(item, offer) {
  return r2(effectiveDeposits(offer, item).filter(isPaid).reduce((s, r) => s + amountOf(r, item, offer).amount, 0));
}

// ── Zápisy ──
const ref = (offerId) => doc(db, 'offers', offerId);
export async function saveInvoice(offerId, itemId, segs, value, text) {
  const now = new Date().toISOString();
  const by = who();
  const args = [new FieldPath('rzInvoices', String(itemId), ...segs.map(String)), value,
    new FieldPath('rzInvoices', String(itemId), 'setAt'), now, new FieldPath('rzInvoices', String(itemId), 'setBy'), by];
  if (text) args.push(new FieldPath('rzInvoices', String(itemId), 'log'), arrayUnion({ at: now, by, text }));
  await updateDoc(ref(offerId), ...args);
}

export function uploadInvoiceFile(offerId, offer, itemId, file, onProgress) {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `offers/${offerId}/confirmations/invoice_${itemId}_${Date.now()}_${safeName}`;
  const task = uploadBytesResumable(storageRef(storage, path), file);
  return new Promise((resolve, reject) => {
    task.on('state_changed',
      (s) => { if (onProgress) onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)); },
      (err) => reject(new Error(err.code || err.message || 'Neznámá chyba')),
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          await saveInvoice(offerId, itemId, ['files'], arrayUnion({ url, name: file.name, path, at: new Date().toISOString(), by: who() }), `nahrán soubor ${file.name}`);
          resolve();
        } catch (e) { reject(e); }
      });
  });
}

export async function removeInvoiceFile(offerId, offer, itemId, f) {
  if (f.path) { try { await deleteObject(storageRef(storage, f.path)); } catch (e) { console.error('Smazání souboru selhalo (pokračuji):', e); } }
  const files = (invoiceOf(offer, itemId).files || []).filter(x => x.path !== f.path || x.url !== f.url);
  await saveInvoice(offerId, itemId, ['files'], files, `odebrán soubor ${f.name}`);
}

// Upozornění pro Dashboard: faktury, které nesedí, a hotely po odjezdu bez faktury.
export function invoiceAlerts(offers, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  (offers || []).forEach(o => {
    if (!(o.realization && o.realization.status === 'active')) return;
    (o.items || []).filter(it => it.subType === 'hotel' && it.enabled !== false && !it.cancelled).forEach(it => {
      const inv = invoiceOf(o, it.id);
      const label = [it.city, it.name].filter(Boolean).join(' – ') || 'hotel';
      const base = { offerId: o.id, offerLabel: [o.offerNumber, o.name].filter(Boolean).join(' · ') || '(bez názvu)', clientName: o.clientName || '', hotel: label, itemId: it.id };
      const st = inv.status || (filled(inv.total) ? '' : 'waiting');
      if (st === 'mismatch') out.push({ ...base, kind: 'mismatch', text: 'faktura nesedí / reklamace' });
      else if (st === 'waiting' && !filled(inv.total)) {
        const end = String(it.dateTo || o.endDate || '').slice(0, 10);
        if (end.length === 10 && end < today) out.push({ ...base, kind: 'missing', since: end, text: 'po odjezdu bez faktury' });
      }
    });
  });
  return out;
}
