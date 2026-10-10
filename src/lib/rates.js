// Kurzy měn pro celou aplikaci (Nastavení → „💱 Kurzy“). Schváleno 10. 10. 2026.
//
// Pravidla (Helena + Filip):
//  - Žádná částka se nikdy nepřepisuje do jiné měny — převod na EUR je jen pro
//    zobrazení a součet; uložené verze NR a zamčené ceny v Realizaci se nemění.
//  - Kurzy jsou na jednom místě, s datem, kdo je změnil, a historií.
//  - Nic se neaktualizuje samo: „Načíst dnešní kurzy“ je tlačítko. Zamčená měna
//    se ani tlačítkem nezmění. Ruční úprava měnu rovnou zamkne.
//  - Start: všechny měny zamčené na dosavadních hodnotách z programu
//    (DEFAULT_RATES), takže se žádná cena nepohne.
//
// Firestore: settings/rates = {
//   currencies: { CHF: { value, locked, source: 'default'|'ecb'|'manual', ecbDate, updatedAt, updatedBy } },
//   ecb: { date, rates: { CHF: 1.0738, ... }, loadedAt, loadedBy },   // poslední načtené ECB pro srovnání
//   history: [ { at, by, cur, from, to, source } ],                    // posledních 300 změn
// }
// Kurz = kolik EUR stojí 1 jednotka měny (stejně jako DEFAULT_RATES).

import { db, auth } from './firebase';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { DEFAULT_RATES } from './offerCalc';
import { codeForEmail } from './people';

export const RATE_CURRENCIES = Object.keys(DEFAULT_RATES); // GBP, CHF, PLN, NOK, DKK, SEK, CZK, USD
const ratesRef = () => doc(db, 'settings', 'rates');
const r6 = (n) => Math.round(Number(n) * 1e6) / 1e6;
const who = () => codeForEmail(auth.currentUser?.email) || auth.currentUser?.email || '';

// Dnešní středové kurzy Evropské centrální banky (frankfurter.dev — stará adresa
// api.frankfurter.app přesměrovává a prohlížeč přesměrování blokuje).
export async function fetchEcbRates() {
  const resp = await fetch(`https://api.frankfurter.dev/v1/latest?from=EUR&to=${RATE_CURRENCIES.join(',')}`);
  if (!resp.ok) throw new Error(`služba kurzů odpověděla ${resp.status}`);
  const data = await resp.json();
  if (!data || !data.rates) throw new Error('služba kurzů nevrátila kurzy');
  const rates = {};
  Object.entries(data.rates).forEach(([cur, v]) => { if (v > 0) rates[cur] = r6(1 / v); });
  return { date: data.date || '', rates };
}

// Stav kurzů, jak ho vidí aplikace. Když dokument ještě neexistuje, platí
// výchozí hodnoty z programu — zamčené.
export function ratesState(data) {
  const cur = (data && data.currencies) || {};
  const currencies = {};
  RATE_CURRENCIES.forEach(c => {
    currencies[c] = cur[c] && Number(cur[c].value) > 0
      ? { ...cur[c], value: Number(cur[c].value) }
      : { value: DEFAULT_RATES[c], locked: true, source: 'default', updatedAt: '', updatedBy: '' };
  });
  return { currencies, ecb: (data && data.ecb) || null, history: (data && data.history) || [] };
}

// Kurzy pro výpočty: { CHF: 1.07, ... } — vždy kompletní (chybějící = výchozí).
export function effectiveRates(data) {
  const st = ratesState(data);
  return Object.fromEntries(RATE_CURRENCIES.map(c => [c, st.currencies[c].value]));
}

export async function loadRatesDoc() {
  const snap = await getDoc(ratesRef());
  return snap.exists() ? snap.data() : null;
}

// Uloží nový stav měn + záznamy do historie. `changes` = [{ cur, to, source, locked }].
async function writeChanges(data, changes, extra = {}) {
  const st = ratesState(data);
  const now = new Date().toISOString();
  const by = who();
  const currencies = { ...st.currencies };
  const hist = [];
  changes.forEach(ch => {
    const prev = currencies[ch.cur];
    const next = { ...prev };
    if (ch.to !== undefined) {
      next.value = r6(ch.to); next.source = ch.source || prev.source;
      next.updatedAt = now; next.updatedBy = by;
      if (ch.ecbDate) next.ecbDate = ch.ecbDate;
    }
    if (ch.locked !== undefined) next.locked = ch.locked;
    currencies[ch.cur] = next;
    if (ch.to !== undefined && Math.abs(Number(prev.value) - Number(next.value)) > 1e-9) {
      hist.push({ at: now, by, cur: ch.cur, from: prev.value, to: next.value, source: next.source });
    }
    if (ch.locked !== undefined && !!prev.locked !== !!ch.locked) {
      hist.push({ at: now, by, cur: ch.cur, from: prev.value, to: prev.value, source: ch.locked ? 'zamčeno' : 'odemčeno' });
    }
  });
  const history = [...hist.reverse(), ...st.history].slice(0, 300);
  const payload = { currencies, history, ...extra };
  await setDoc(ratesRef(), payload, { merge: true });
  return { ...(data || {}), ...payload };
}

// „Načíst dnešní kurzy“: uloží ECB pro srovnání a přepíše jen ODEMČENÉ měny.
export async function refreshFromEcb(data) {
  const ecb = await fetchEcbRates();
  const st = ratesState(data);
  const changes = RATE_CURRENCIES
    .filter(c => !st.currencies[c].locked && ecb.rates[c] > 0)
    .map(c => ({ cur: c, to: ecb.rates[c], source: 'ecb', ecbDate: ecb.date }));
  return writeChanges(data, changes, { ecb: { ...ecb, loadedAt: new Date().toISOString(), loadedBy: who() } });
}

export const setManualRate = (data, cur, value) => writeChanges(data, [{ cur, to: value, source: 'manual', locked: true }]);
export const takeEcbRate = (data, cur) => {
  const ecb = data && data.ecb;
  if (!ecb || !(ecb.rates[cur] > 0)) throw new Error('nejdřív načtěte dnešní kurzy');
  return writeChanges(data, [{ cur, to: ecb.rates[cur], source: 'ecb', ecbDate: ecb.date }]);
};
export const setLocked = (data, cur, locked) => writeChanges(data, [{ cur, locked }]);
