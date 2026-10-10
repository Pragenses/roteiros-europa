import { evalAmount } from './offerCalc';

// City tax v NABÍDCE je za POKOJ a noc: cityTax = DBL pokoj (2 osoby),
// cityTaxSngl = SNGL pokoj (1 osoba), prázdné SNGL = stejné jako DBL.
// Zakázka (orders/…/services) má jednu hodnotu + typ (per_person / per_room /
// percent). Tahle funkce vybere typ, který dá PŘESNĚ stejné částky jako nabídka.
// Stejná pravidla jako při převodu nabídky na zakázku v OfferDetail.js.
export const r4 = (n) => String(Math.round(n * 10000) / 10000);
const same = (a, b) => Math.abs(a - b) < 0.005;

export const cityTaxForOrder = (h) => {
  const dbl = evalAmount(h.cityTax);
  const snglRaw = (h.cityTaxSngl !== '' && h.cityTaxSngl !== undefined && h.cityTaxSngl !== null) ? h.cityTaxSngl : h.cityTax;
  const sngl = evalAmount(snglRaw);
  if (!dbl && !sngl) return { cityTax: '', cityTaxType: 'per_person', note: '', exact: true };
  const note = `City tax z nabídky: DBL pokoj ${r4(dbl)}, SNGL pokoj ${r4(sngl)} ${h.currency || 'EUR'} za noc.`;
  if (same(dbl, sngl)) return { cityTax: r4(dbl), cityTaxType: 'per_room', note, exact: true };
  if (same(dbl, 2 * sngl)) return { cityTax: r4(sngl), cityTaxType: 'per_person', note, exact: true };
  const pDbl = evalAmount(h.pricePerNightDbl), pSngl = evalAmount(h.pricePerNightSngl);
  if (pDbl > 0 && pSngl > 0 && same(dbl / pDbl * 100, sngl / pSngl * 100)) {
    return { cityTax: r4(dbl / pDbl * 100), cityTaxType: 'percent', note, exact: true };
  }
  return { cityTax: r4(dbl), cityTaxType: 'per_room', exact: false,
    note: `⚠ ${note} Nejde převést přesně (DBL a SNGL se liší) — převedeno jako ${r4(dbl)} za pokoj, ZKONTROLUJTE.` };
};
