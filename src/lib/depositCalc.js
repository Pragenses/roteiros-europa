// Konečné počty a výpočet záloh (Realizace, část B — schváleno 11. 10. 2026).
//
// Konečné počty: offers/<id>.rzFinal = {
//   group:  { pax, dbl, sgl, trpl, guide, driver, setBy, setAt },   // společné pro akci
//   hotels: { [itemId]: { exception: true|false, pax, dbl, sgl, trpl, guide, driver,
//                         calc: { meals: [itemId…], foc: { on, n, type: 'sgl'|'dbl' } },
//                         setBy, setAt } },
//   log:    [ { at, by, where, text } ]   // posledních 100 změn
// }
// Ukládá se po částech přes FieldPath (id položek obsahují tečky) — nabídka
// toto pole nikdy nepřepisuje.
//
// „Celá cena hotelu“ (pro %):
//   (DBL × cena DBL + SGL × cena SGL + TRPL × cena TRPL + (průvodce + řidič) × cena SGL) × noci
//   + city tax  + zaškrtnutá strava (osoby × cena za osobu)  − FOC (jen když je zapnuté)
// FOC se odečítá jen na vyžádání (u každého hotelu jinak). City tax u FOC zůstává.
// Ceny se berou z karty hotelu v nabídce (stejná čísla jako kalkulace).

import { evalAmount, getEffectiveCostDbl } from './offerCalc';
import { kindOf, suggestKind } from './serviceKinds';

export const FINAL_FIELDS = [
  { key: 'pax',    label: 'Osoby',     short: 'os.' },
  { key: 'dbl',    label: 'DBL',       short: 'DBL' },
  { key: 'sgl',    label: 'SGL',       short: 'SGL' },
  { key: 'trpl',   label: 'TRPL',      short: 'TRPL' },
  { key: 'guide',  label: 'Průvodce (SGL)', short: 'průvodce' },
  { key: 'driver', label: 'Řidič (SGL)',    short: 'řidič' },
];

const n = (v) => {
  const s = String(v === 0 ? '0' : (v || '')).replace(/[\s  ]/g, '').replace(',', '.');
  const x = parseFloat(s);
  return Number.isFinite(x) ? x : 0;
};
const filled = (v) => String(v === 0 ? '0' : (v ?? '')).trim() !== '';
export const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const fmt = (x) => (Number(x) || 0).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (x) => String(r2(x)).replace('.', ',');

// Počty pro jeden hotel: výjimka hotelu, jinak společné počty akce.
export function finalFor(offer, itemId) {
  const f = (offer && offer.rzFinal) || {};
  const g = f.group || {};
  const h = (f.hotels || {})[String(itemId)] || {};
  const src = h.exception ? h : g;
  const counts = {};
  FINAL_FIELDS.forEach(({ key }) => { counts[key] = src[key] ?? ''; });
  const any = FINAL_FIELDS.some(({ key }) => filled(counts[key]));
  return { counts, exception: !!h.exception, any, calc: h.calc || {}, hotel: h, group: g };
}

// Karty stravy (polopenze / jídlo v hotelu), které jde k hotelu připočíst.
export function mealCandidates(offer) {
  const rz = (offer && offer.rzServices) || {};
  return (offer.items || []).filter(it =>
    it.enabled !== false && !it.cancelled && it.subType !== 'hotel'
    && (kindOf(it, rz) === 'halfboard' || (!kindOf(it, rz) && suggestKind(it) === 'halfboard')));
}

// Celková cena hotelu podle konečných počtů. Vrací řádky výpočtu (pro ℹ).
export function hotelTotal(item, offer) {
  const { counts, calc, any } = finalFor(offer, item.id);
  const warnings = [];
  const cur = item.currency || 'EUR';
  const nights = n(item.nights);
  const dbl = n(counts.dbl), sgl = n(counts.sgl), trpl = n(counts.trpl);
  const staff = n(counts.guide) + n(counts.driver);
  const pax = n(counts.pax);
  const pDbl = evalAmount(item.pricePerNightDbl);
  const pSgl = evalAmount(item.pricePerNightSngl);
  const pTrpl = evalAmount(item.trplPrice);
  // City tax: DBL pole = za DBL pokoj/noc, SGL pole = za osobu/noc.
  const hasSglTax = filled(item.cityTaxSngl);
  const tDbl = evalAmount(item.cityTax);
  const tSgl = hasSglTax ? evalAmount(item.cityTaxSngl) : tDbl;
  const tTrpl = hasSglTax ? tSgl * 3 : tDbl * 1.5;

  if (!any) warnings.push('Chybí konečné počty (osoby, pokoje).');
  if (!nights) warnings.push('Na kartě hotelu chybí počet nocí.');
  if (dbl && !pDbl) warnings.push('Na kartě chybí cena DBL.');
  if ((sgl || staff) && !pSgl) warnings.push('Na kartě chybí cena SGL.');
  if (trpl && !pTrpl) warnings.push('Na kartě chybí cena TRPL (pole TRPL u hotelu).');

  const lines = [];
  const add = (label, amount, kind) => { if (amount) lines.push({ label, amount: r2(amount), kind }); };
  add(`${dbl} DBL × ${fmt(pDbl)} × ${nights} nocí`, dbl * pDbl * nights, 'room');
  add(`${sgl} SGL × ${fmt(pSgl)} × ${nights} nocí`, sgl * pSgl * nights, 'room');
  add(`${trpl} TRPL × ${fmt(pTrpl)} × ${nights} nocí`, trpl * pTrpl * nights, 'room');
  add(`průvodce + řidič ${staff} SGL × ${fmt(pSgl)} × ${nights} nocí`, staff * pSgl * nights, 'room');
  const rooms = lines.reduce((s, l) => s + l.amount, 0);

  const tax = (dbl * tDbl + (sgl + staff) * tSgl + trpl * tTrpl) * nights;
  if (tax) lines.push({ label: `city tax (DBL ${fmtN(tDbl)}, SGL ${fmtN(tSgl)}${trpl ? `, TRPL ${fmtN(tTrpl)}` : ''} za pokoj/noc)`, amount: r2(tax), kind: 'tax' });

  let meals = 0;
  const mealIds = Array.isArray(calc.meals) ? calc.meals.map(String) : [];
  const persons = pax + staff;
  (offer.items || []).filter(it => mealIds.includes(String(it.id))).forEach(m => {
    if ((m.currency || 'EUR') !== cur) { warnings.push(`Strava „${m.name || ''}“ je v jiné měně (${m.currency}) — nepřipočtena.`); return; }
    const per = getEffectiveCostDbl(m);
    const amt = persons * per;
    meals += amt;
    lines.push({ label: `${m.name || 'strava'}: ${persons} os. × ${fmt(per)}`, amount: r2(amt), kind: 'meal' });
  });

  let foc = 0;
  const f = calc.foc || {};
  if (f.on) {
    const cnt = n(f.n) || 1;
    const price = f.type === 'dbl' ? pDbl : pSgl;
    foc = cnt * price * nights;
    lines.push({ label: `FOC ${cnt} ${f.type === 'dbl' ? 'DBL' : 'SGL'} × ${fmt(price)} × ${nights} nocí (odečteno)`, amount: -r2(foc), kind: 'foc' });
  }

  const total = rooms + tax + meals - foc;
  return {
    currency: cur, lines, rooms: r2(rooms), tax: r2(tax), meals: r2(meals), foc: r2(foc),
    total: r2(total), roomsOnly: r2(rooms - foc), roomCount: dbl + sgl + trpl + staff, pax, persons, warnings, any,
  };
}

// Částka zálohy podle podmínky (null = nedá se spočítat).
export function computeDeposit(row, item, offer) {
  const kind = row && row.kind ? row.kind : 'fixed';
  if (kind === 'fixed' || !offer) return null;
  const isHotel = item.subType === 'hotel';
  if (kind === 'percent') {
    if (!isHotel) return { amount: null, lines: [], warnings: ['Procento jde spočítat jen u hotelu.'] };
    const h = hotelTotal(item, offer);
    const pct = n(row.pct);
    const base = row.basis === 'no_tax' ? h.roomsOnly : h.total;
    const lines = row.basis === 'no_tax' ? h.lines.filter(l => l.kind === 'room' || l.kind === 'foc') : h.lines;
    const ok = h.any && pct > 0 && base > 0;
    return {
      amount: ok ? r2(base * pct / 100) : null, lines, base: r2(base), pct,
      formula: `${fmtN(pct)} % z ${row.basis === 'no_tax' ? 'ubytování bez city tax' : 'celé ceny'} ${fmt(base)} ${h.currency}`,
      warnings: [...h.warnings, ...(pct > 0 ? [] : ['Zadejte procento.'])], currency: h.currency,
    };
  }
  const { counts, any } = finalFor(offer, item.id);
  const unit = n(row.unit);
  if (kind === 'per_room') {
    const rooms = n(counts.dbl) + n(counts.sgl) + n(counts.trpl) + n(counts.guide) + n(counts.driver);
    return {
      amount: any && unit > 0 && rooms > 0 ? r2(rooms * unit) : null, lines: [{ label: `${rooms} pokojů × ${fmt(unit)}`, amount: r2(rooms * unit) }],
      formula: `${rooms} pokojů × ${fmt(unit)}`, warnings: any ? [] : ['Chybí konečné počty.'], currency: item.currency || 'EUR',
    };
  }
  if (kind === 'per_pax') {
    const pax = n(counts.pax);
    return {
      amount: any && unit > 0 && pax > 0 ? r2(pax * unit) : null, lines: [{ label: `${pax} osob × ${fmt(unit)}`, amount: r2(pax * unit) }],
      formula: `${pax} osob × ${fmt(unit)}`, warnings: any ? [] : ['Chybí konečné počty.'], currency: item.currency || 'EUR',
    };
  }
  return null;
}
