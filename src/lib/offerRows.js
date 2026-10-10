// Živý výpočet nákladů a ceny nabídky v EUR pro všechny velikosti skupiny.
//
// PŘESNÁ KOPIE výpočtu v OfferDetail.js (část „rows“: perPaxDblEUR,
// groupTotalEUR včetně pokoje průvodce a řidiče, FOC podle focType a
// focCount, marže). Používá ji Realizace, aby ukázala dnešní náklady
// a zisk proti zamčené prodejní ceně. Když se změní výpočet v nabídce,
// musí se změnit i tady (a naopak) — jinak by se čísla rozešla.
//
// Navíc počítá „pevnou“ část nákladů: kolik z nákladů na osobu tvoří
// služby ve stavu Potvrzeno (zbytek je zatím odhad).

import { evalAmount, getEffectiveCostDbl, getEffectiveCostSngl, toEUR } from './offerCalc';

const isConfirmed = (it) => !it.cancelled && it.bookingStatus === 'confirmed';
const hasOverride = (it) => it.guideOverride !== '' && it.guideOverride !== undefined && it.guideOverride !== null;

export function computeOfferRows(offer, rates) {
  const items = offer.items || [];
  const margin = offer.margin ?? 15;
  const paxList = offer.paxList || '15,20,25,30,35';
  const focType = offer.focType || 'dbl';
  const focCount = offer.focCount ?? 1;
  const eur = (amount, currency) => toEUR(amount, currency, rates);

  const activeItems = items.filter(it => it.enabled !== false);
  const groupItems = activeItems.filter(it => it.type === 'group');
  const paxItems = activeItems.filter(it => it.type === 'per_pax');

  const perPaxDblEUR = paxItems.reduce((s, it) => s + eur(getEffectiveCostDbl(it), it.currency), 0);
  const perPaxSnglEUR = paxItems.reduce((s, it) => s + eur(getEffectiveCostSngl(it), it.currency), 0);
  const snglSupplementEUR = perPaxSnglEUR - perPaxDblEUR;

  const regularGroupItems = groupItems.filter(it => it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
  const guideHotelItems = groupItems.filter(it => it.subType === 'guide_hotel');
  const driverHotelItems = groupItems.filter(it => it.subType === 'driver_hotel');
  const regularGroupTotalEUR = regularGroupItems.reduce((s, it) => s + eur(evalAmount(it.groupCost), it.currency), 0);

  const hotelOnlyItems = paxItems.filter(it => it.subType === 'hotel');
  const hotelOnlySnglEUR = hotelOnlyItems.reduce((s, it) => s + eur(getEffectiveCostSngl(it), it.currency), 0);

  const guideCost = (it) => hasOverride(it) ? eur(evalAmount(it.guideOverride), it.currency || 'EUR') : perPaxSnglEUR;
  const driverCost = (it) => hasOverride(it) ? eur(evalAmount(it.guideOverride), it.currency || 'EUR') : hotelOnlySnglEUR;
  const guideHotelTotalEUR = guideHotelItems.reduce((s, it) => s + guideCost(it), 0);
  const driverHotelTotalEUR = driverHotelItems.reduce((s, it) => s + driverCost(it), 0);
  const groupTotalEUR = regularGroupTotalEUR + guideHotelTotalEUR + driverHotelTotalEUR;

  const focPoolEUR = focType === 'sngl' ? perPaxSnglEUR : perPaxDblEUR;
  const focCountNum = (focCount === '' || focCount === undefined || focCount === null) ? 1 : (parseInt(focCount) || 0);
  const paxCounts = String(paxList).split(',').map(s => parseInt(s.trim())).filter(n => n > 0);

  // ── Pevná (potvrzená) část nákladů — stejné vzorce jen nad potvrzenými službami ──
  const cPax = paxItems.filter(isConfirmed);
  const cPerPaxDbl = cPax.reduce((s, it) => s + eur(getEffectiveCostDbl(it), it.currency), 0);
  const cPerPaxSngl = cPax.reduce((s, it) => s + eur(getEffectiveCostSngl(it), it.currency), 0);
  const cHotelSngl = cPax.filter(it => it.subType === 'hotel').reduce((s, it) => s + eur(getEffectiveCostSngl(it), it.currency), 0);
  const cGroup = regularGroupItems.filter(isConfirmed).reduce((s, it) => s + eur(evalAmount(it.groupCost), it.currency), 0)
    // Pokoj průvodce/řidiče je pevný tam, kde je pevný hotel (s ruční cenou podle stavu té položky).
    + guideHotelItems.reduce((s, it) => s + (hasOverride(it) ? (isConfirmed(it) ? guideCost(it) : 0) : cPerPaxSngl), 0)
    + driverHotelItems.reduce((s, it) => s + (hasOverride(it) ? (isConfirmed(it) ? driverCost(it) : 0) : cHotelSngl), 0);
  const cFocPool = focType === 'sngl' ? cPerPaxSngl : cPerPaxDbl;

  const rows = paxCounts.map(pax => {
    const groupPerPax = groupTotalEUR / pax;
    const costDbl = groupPerPax + perPaxDblEUR;
    const marginAmount = costDbl * (margin / 100);
    const sellingBeforeFoc = costDbl + marginAmount;
    const focShare = (focPoolEUR * focCountNum) / pax;
    const finalDbl = sellingBeforeFoc + focShare;
    const finalSngl = finalDbl + snglSupplementEUR;
    // Náklad na platící osobu v DBL = služby + podíl na nákladech FOC osoby.
    const totalCostDbl = costDbl + focShare;
    const confirmedCostDbl = cGroup / pax + cPerPaxDbl + (cFocPool * focCountNum) / pax;
    return { pax, groupPerPax, costDbl, marginAmount, sellingBeforeFoc, focShare, finalDbl, finalSngl, totalCostDbl, confirmedCostDbl };
  });

  return { perPaxDblEUR, perPaxSnglEUR, snglSupplementEUR, groupTotalEUR, focPoolEUR, focCountNum, rows };
}
