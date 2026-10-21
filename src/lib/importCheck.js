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

// Ceny pro klienta bývají zaokrouhlené nahoru na celé euro (nebo na 5).
// Za „zaokrouhleno" bereme: prodaná cena je CELÉ číslo, je vyšší nebo stejná
// než výpočet a rozdíl je menší než ROUND_MAX. Přesné ceny s centy (z kalkulace)
// se tím nezakryjí — ty musí sedět na cent.
export const ROUND_MAX = 5;
export const isRounded = (got, exp) => {
  if (!isFinite(got) || !isFinite(exp)) return false;
  const whole = Math.abs(exp - Math.round(exp)) < TOL;
  const diff = exp - got;
  return whole && diff > -TOL && diff < ROUND_MAX;
};

// Paušální SGL příplatek: u všech (aspoň 2) řádků je prodaná SGL = prodaná DBL + stejná částka.
// Aplikace počítá SGL z nákladů, takže paušál na cent sedět nemůže — není to chyba, jen jiný způsob prodeje.
export function flatSnglSupplement(soldPrices) {
  const d = (soldPrices || []).filter(p => has(p.finalDbl) && has(p.finalSngl)).map(p => num(p.finalSngl) - num(p.finalDbl));
  if (d.length < 2) return null;
  return d.every(x => same(x, d[0])) && d[0] > 0 ? Math.round(d[0] * 100) / 100 : null;
}

// Porovnání konečných cen s prodanými.
// okDbl/okSngl = sedí na cent; roundedDbl/roundedSngl = rozdíl je jen zaokrouhlení pro klienta;
// flatSngl = SGL prodána s paušálním příplatkem (viz flatSnglSupplement).
export function checkFinal(calc, soldPrices) {
  const flat = flatSnglSupplement(soldPrices);
  return (soldPrices || []).map(sp => {
    const pax = parseInt(sp.pax, 10);
    const row = calc.rows.find(r => r.pax === pax);
    const expDbl = num(sp.finalDbl);
    const expSngl = has(sp.finalSngl) ? num(sp.finalSngl) : null;
    if (!row) return { pax, missing: true, expDbl, expSngl };
    const okDbl = same(row.finalDbl, expDbl);
    const okSngl = expSngl === null ? null : same(row.finalSngl, expSngl);
    const roundedDbl = !okDbl && isRounded(row.finalDbl, expDbl);
    const roundedSngl = okSngl === false && isRounded(row.finalSngl, expSngl);
    const flatSngl = okSngl === false && !roundedSngl && flat !== null ? flat : null;
    return {
      pax, gotDbl: row.finalDbl, expDbl, okDbl, roundedDbl,
      gotSngl: row.finalSngl, expSngl, okSngl, roundedSngl, flatSngl,
      bad: (!okDbl && !roundedDbl) || (okSngl === false && !roundedSngl && flatSngl === null),
      currency: sp.currency || 'EUR',
    };
  });
}

export const round4 = (x) => Math.round(x * 10000) / 10000;

// ── Kontrolní částky přímo z buněk Excelu ──
// ref = "F8+F9" nebo "List1!F8+'Můj list'!G9" (jen buňky spojené +).
// sheets = [{ name, values: { F8: 186 } }]. Vrací { value } nebo { error }.
export function resolveRef(ref, sheets) {
  const txt = String(ref || '').trim();
  if (!txt) return { error: 'bez adresy' };
  if (!sheets || !sheets.length) return { error: 'Excel není k dispozici' };
  let total = 0;
  for (const raw of txt.split('+')) {
    const part = raw.trim().replace(/\$/g, '');
    const m = part.match(/^(?:(?:'([^']+)'|([^!]+))!)?([A-Z]{1,3}[0-9]{1,6})$/i);
    if (!m) return { error: `neplatná adresa „${part}"` };
    const sheetName = m[1] || m[2];
    const addr = m[3].toUpperCase();
    const sh = sheetName ? sheets.find(x => x.name.trim().toLowerCase() === sheetName.trim().toLowerCase()) : sheets[0];
    if (!sh) return { error: `list „${sheetName}" neexistuje` };
    const v = sh.values[addr];
    if (typeof v !== 'number') return { error: `buňka ${addr} není číslo` };
    total += v;
  }
  return { value: total };
}

// Doplní kartám kontrolní částky z buněk Excelu (přednost před číslem od Clauda).
// excelCells = [{ fileName, sheets }]. U karty zůstane: refCheck = { Dbl|Sngl|Group: { ref, value, claude, error } }.
export function applyExcelRefs(items, excelCells) {
  const files = (excelCells || []).filter(f => f && f.sheets && f.sheets.length);
  if (!files.length) return items;
  return items.map(it => {
    const file = (has(it.refFile) && files.find(f => f.fileName === String(it.refFile).trim())) || files[0];
    const out = { ...it };
    const refCheck = {};
    [['Dbl', 'refDbl', 'expectedDbl'], ['Sngl', 'refSngl', 'expectedSngl'], ['Group', 'refGroup', 'expectedGroup']].forEach(([k, refKey, expKey]) => {
      if (!has(it[refKey])) return;
      const r = resolveRef(it[refKey], file.sheets);
      const claude = has(it[expKey]) ? num(it[expKey]) : null;
      if (r.error) { refCheck[k] = { ref: it[refKey], error: r.error, claude }; return; }
      refCheck[k] = { ref: it[refKey], value: round4(r.value), claude, file: file.fileName };
      out[expKey] = String(round4(r.value));
    });
    if (Object.keys(refCheck).length) out.refCheck = refCheck;
    return out;
  });
}
