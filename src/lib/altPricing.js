// Rozdíl ceny pro hotelové alternativy.
//
// computeCombinedRows je PŘESNÁ KOPIE výpočtu tabulky „Selling price per pax“
// (zobrazení celkem v EUR) z OfferDetail.js – stejné vzorce pro hotely,
// vstupenky, skupinové náklady, hotel průvodce a řidiče, marži i FOC.
// Hlavní tabulka tuto funkci NEPOUŽÍVÁ a nic se v ní nemění; slouží jen
// k dopočtu „o kolik dražší/levnější“ by byla nabídka s alternativou.
// Při jakékoli změně výpočtu v OfferDetail.js je nutné upravit i tuto kopii.

import { evalAmount, getEffectiveCostDbl, getEffectiveCostSngl, toEUR } from './offerCalc';
import { altMainOf, isOfferedAlt } from './hotelAlt';

export const computeCombinedRows = (items, { margin, paxCounts, focCountNum, focType, rates }) => {
  const toEURWithRates = (amount, currency) => toEUR(amount, currency, rates);
  const activeItems = items.filter(it => it.enabled !== false);
  const groupItems = activeItems.filter(it => it.type === 'group');
  const paxItems = activeItems.filter(it => it.type === 'per_pax');

  const perPaxDblEUR = paxItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostDbl(it), it.currency), 0);
  const perPaxSnglEUR = paxItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostSngl(it), it.currency), 0);
  const snglSupplementEUR = perPaxSnglEUR - perPaxDblEUR;

  const regularGroupItems = groupItems.filter(it => it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
  const guideHotelItems = groupItems.filter(it => it.subType === 'guide_hotel');
  const driverHotelItems = groupItems.filter(it => it.subType === 'driver_hotel');
  const regularGroupTotalEUR = regularGroupItems.reduce((sum, it) => sum + toEURWithRates(evalAmount(it.groupCost), it.currency), 0);

  const hotelOnlyItems = paxItems.filter(it => it.subType === 'hotel');
  const hotelOnlySnglEUR = hotelOnlyItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostSngl(it), it.currency), 0);

  const getGuideHotelCost = (it) => {
    const override = it.guideOverride;
    if (override !== '' && override !== undefined && override !== null) {
      return toEURWithRates(evalAmount(override), it.currency || 'EUR');
    }
    return perPaxSnglEUR;
  };
  const getDriverHotelCost = (it) => {
    const override = it.guideOverride;
    if (override !== '' && override !== undefined && override !== null) {
      return toEURWithRates(evalAmount(override), it.currency || 'EUR');
    }
    return hotelOnlySnglEUR;
  };
  const guideHotelTotalEUR = guideHotelItems.reduce((sum, it) => sum + getGuideHotelCost(it), 0);
  const driverHotelTotalEUR = driverHotelItems.reduce((sum, it) => sum + getDriverHotelCost(it), 0);
  const groupTotalEUR = regularGroupTotalEUR + guideHotelTotalEUR + driverHotelTotalEUR;

  const focPoolEUR = focType === 'sngl' ? perPaxSnglEUR : perPaxDblEUR;

  return paxCounts.map(pax => {
    const groupPerPax = groupTotalEUR / pax;
    const costDbl = groupPerPax + perPaxDblEUR;
    const marginAmount = costDbl * (margin / 100);
    const sellingBeforeFoc = costDbl + marginAmount;
    const focShare = (focPoolEUR * focCountNum) / pax;
    const finalDbl = sellingBeforeFoc + focShare;
    const finalSngl = finalDbl + snglSupplementEUR;
    return { pax, groupPerPax, costDbl, marginAmount, sellingBeforeFoc, focShare, finalDbl, finalSngl };
  });
};

// Pro každou nabídnutou alternativu: konečná cena s alternativou místo
// hlavního hotelu minus konečná cena hlavní nabídky, pro každou velikost
// skupiny. Kladné číslo = dražší, záporné = levnější. Vše v EUR.
export const computeAltDiffs = (items, opts) => {
  const list = items || [];
  const base = computeCombinedRows(list, opts);
  return list.filter(it => isOfferedAlt(it, list)).map(alt => {
    const main = altMainOf(alt, list);
    const swapped = list.map(x =>
      x.id === main.id ? { ...x, enabled: false }
        : x.id === alt.id ? { ...x, enabled: true }
          : x);
    const withAlt = computeCombinedRows(swapped, opts);
    return {
      alt, main,
      rows: base.map((b, i) => ({
        pax: b.pax,
        dDbl: withAlt[i].finalDbl - b.finalDbl,
        dSngl: withAlt[i].finalSngl - b.finalSngl,
      })),
    };
  });
};
