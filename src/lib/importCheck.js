import { evalAmount, getEffectiveCostDbl, getEffectiveCostSngl, toEUR, DEFAULT_RATES } from './offerCalc';

// Import starých akcí — KROK 3b: kontrola, že karty návrhu dají v aplikaci
// přesně prodané ceny. Výpočet je doslovná kopie výpočtu v OfferDetail.js
// (hotel/ticket na osobu, skupinové karty, hotel průvodce / řidiče, marže,
// FOC po marži), aby kontrola odpovídala tomu, co pak ukáže nabídka.

export const TOL = 0.005; // „sedí na cent"

const num = (v) => evalAmount(v);
// Sedí, když je rozdíl pod půl centu nebo jsou čísla po zaokrouhlení na centy stejná.
export const same = (a, b) => Math.abs(a - b) < TOL || Math.round(a * 100) === Math.round(b * 100);
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

// Druh karty z návrhu → typ/podtyp karty v nabídce
export const KIND_TO_ITEM = {
  hotel: { type: 'per_pax', subType: 'hotel' },
  ticket: { type: 'per_pax', subType: 'ticket' },
  group: { type: 'group', subType: '' },
  guide_hotel: { type: 'group', subType: 'guide_hotel' },
  driver_hotel: { type: 'group', subType: 'driver_hotel' },
};

// Karta návrhu → karta ve tvaru nabídky (pro výpočet i pozdější uložení)
export function toOfferItem(it) {
  const t = KIND_TO_ITEM[it.kind] || KIND_TO_ITEM.ticket;
  const s = (v) => (has(v) ? String(v).trim() : '');
  return {
    name: s(it.name), city: s(it.city), type: t.type, subType: t.subType,
    enabled: it.enabled !== false,
    costDbl: s(it.costDbl), costSngl: s(it.costSngl),
    pricePerNightDbl: s(it.pricePerNightDbl), pricePerNightSngl: s(it.pricePerNightSngl),
    nights: s(it.nights), cityTax: s(it.cityTax), cityTaxSngl: s(it.cityTaxSngl),
    guideOverride: s(it.guideOverride), dateFrom: s(it.dateFrom), dateTo: s(it.dateTo),
    groupCost: s(it.groupCost), currency: s(it.currency) || 'EUR',
  };
}

// Spočítá celou nabídku stejně jako OfferDetail.
export function computeDraft(items, header, rates = DEFAULT_RATES) {
  const offerItems = items.map(toOfferItem);
  const active = offerItems.filter(it => it.enabled !== false);
  const paxItems = active.filter(it => it.type === 'per_pax');
  const groupItems = active.filter(it => it.type === 'group');
  const eur = (a, c) => toEUR(a, c, rates);

  const perPaxDblEUR = paxItems.reduce((s, it) => s + eur(getEffectiveCostDbl(it), it.currency), 0);
  const perPaxSnglEUR = paxItems.reduce((s, it) => s + eur(getEffectiveCostSngl(it), it.currency), 0);
  const snglSupplementEUR = perPaxSnglEUR - perPaxDblEUR;
  const hotelOnlySnglEUR = paxItems.filter(it => it.subType === 'hotel')
    .reduce((s, it) => s + eur(getEffectiveCostSngl(it), it.currency), 0);

  const autoGuide = perPaxSnglEUR;        // hotely + vstupenky/jídla
  const autoDriver = hotelOnlySnglEUR;    // jen hotely
  const lodging = (it) => {
    if (has(it.guideOverride)) return eur(num(it.guideOverride), it.currency || 'EUR');
    return it.subType === 'guide_hotel' ? autoGuide : autoDriver;
  };
  const groupTotalEUR = groupItems.reduce((s, it) => {
    if (it.subType === 'guide_hotel' || it.subType === 'driver_hotel') return s + lodging(it);
    return s + eur(num(it.groupCost), it.currency);
  }, 0);

  const margin = parseFloat(header.margin) || 0;
  const focCount = has(header.focCount) ? (parseInt(header.focCount, 10) || 0) : 1;
  const focPool = header.focType === 'sngl' ? perPaxSnglEUR : perPaxDblEUR;
  const paxCounts = String(header.paxList || '').split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0);

  const rows = paxCounts.map(pax => {
    const costDbl = groupTotalEUR / pax + perPaxDblEUR;
    const sellingBeforeFoc = costDbl * (1 + margin / 100);
    const finalDbl = sellingBeforeFoc + (focPool * focCount) / pax;
    return { pax, finalDbl, finalSngl: finalDbl + snglSupplementEUR };
  });

  const nonEur = [...new Set(active.map(it => it.currency).filter(c => c && c !== 'EUR'))];
  return { perPaxDblEUR, perPaxSnglEUR, groupTotalEUR, autoGuide, autoDriver, rows, nonEur };
}

// Kontrola jedné karty proti částkám z kalkulace.
// Vrací { status: 'ok' | 'diff' | 'nocheck' | 'off', lines: [...], fix: {field: value} | null }
export function checkItem(it, calc) {
  if (it.enabled === false) return { status: 'off', lines: [], fix: null };
  const o = toOfferItem(it);
  const lines = [];
  const fix = {};
  const cmp = (label, got, exp) => {
    const ok = same(got, exp);
    lines.push({ label, got, exp, ok });
    return ok;
  };

  if (o.subType === 'hotel') {
    const n = parseFloat(o.nights) || 0;
    if (has(it.expectedDbl)) {
      if (!cmp('DBL na osobu', getEffectiveCostDbl(o), num(it.expectedDbl)) && n > 0) {
        const ct = (num(it.expectedDbl) * 2) / n - num(o.pricePerNightDbl);
        if (ct > -TOL) fix.cityTax = round4(Math.max(0, ct));
      }
    }
    if (has(it.expectedSngl)) {
      if (!cmp('SGL na osobu', getEffectiveCostSngl(o), num(it.expectedSngl)) && n > 0) {
        const cts = num(it.expectedSngl) / n - num(o.pricePerNightSngl);
        if (cts > -TOL) fix.cityTaxSngl = round4(Math.max(0, cts));
      }
    }
  } else if (o.subType === 'ticket' || (o.type === 'per_pax')) {
    if (has(it.expectedDbl) && !cmp('Na osobu DBL', getEffectiveCostDbl(o), num(it.expectedDbl))) fix.costDbl = round4(num(it.expectedDbl));
    if (has(it.expectedSngl) && !cmp('Na osobu SGL', getEffectiveCostSngl(o), num(it.expectedSngl))) fix.costSngl = round4(num(it.expectedSngl));
  } else if (o.subType === 'guide_hotel' || o.subType === 'driver_hotel') {
    if (has(it.expectedGroup)) {
      const got = has(o.guideOverride) ? num(o.guideOverride) : (o.subType === 'guide_hotel' ? calc.autoGuide : calc.autoDriver);
      if (!cmp(has(o.guideOverride) ? 'Pevná částka' : 'Automaticky (součet SGL)', got, num(it.expectedGroup))) fix.guideOverride = round4(num(it.expectedGroup));
    }
  } else if (has(it.expectedGroup)) {
    if (!cmp('Za skupinu', num(o.groupCost), num(it.expectedGroup))) fix.groupCost = round4(num(it.expectedGroup));
  }

  if (!lines.length) return { status: 'nocheck', lines, fix: null };
  const ok = lines.every(l => l.ok);
  return { status: ok ? 'ok' : 'diff', lines, fix: ok || !Object.keys(fix).length ? null : fix };
}

// Porovnání konečných cen s prodanými.
export function checkFinal(calc, soldPrices) {
  return (soldPrices || []).map(sp => {
    const pax = parseInt(sp.pax, 10);
    const row = calc.rows.find(r => r.pax === pax);
    const expDbl = num(sp.finalDbl);
    const expSngl = has(sp.finalSngl) ? num(sp.finalSngl) : null;
    if (!row) return { pax, missing: true, expDbl, expSngl };
    return {
      pax, gotDbl: row.finalDbl, expDbl, okDbl: same(row.finalDbl, expDbl),
      gotSngl: row.finalSngl, expSngl, okSngl: expSngl === null ? null : same(row.finalSngl, expSngl),
      currency: sp.currency || 'EUR',
    };
  });
}

export const round4 = (x) => Math.round(x * 10000) / 10000;
