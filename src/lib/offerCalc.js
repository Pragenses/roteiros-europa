// Shared calculation helpers for Offers (selling price calculator) and the printable client proposal.

export const DEFAULT_RATES = { GBP: 1.17, CHF: 1.07, PLN: 0.23, NOK: 0.087, DKK: 0.134, CZK: 0.040, USD: 0.92 };
export const CURRENCIES = ['EUR', 'GBP', 'CHF', 'PLN', 'NOK', 'DKK', 'CZK', 'USD'];

// Allow city tax / prices to be entered as a plain number OR an Excel-style formula starting with "="
// e.g. "=106*0.05" -> evaluates to 5.3
export const evalAmount = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const str = String(value).trim();
  if (str.startsWith('=')) {
    const expr = str.slice(1);
    if (!/^[0-9+\-*/.() ]+$/.test(expr)) return 0;
    try {
      // eslint-disable-next-line no-new-func
      const result = new Function('return (' + expr + ')')();
      return typeof result === 'number' && isFinite(result) ? result : 0;
    } catch {
      return 0;
    }
  }
  return parseFloat(str) || 0;
};

// DBL: room price + city tax, both shared by 2 people, per night
export const getEffectiveCostDbl = (it) => {
  if (it.subType === 'hotel') {
    const price = evalAmount(it.pricePerNightDbl);
    const nights = parseFloat(it.nights) || 0;
    const cityTax = evalAmount(it.cityTax);
    return ((price + cityTax) * nights) / 2;
  }
  return evalAmount(it.costDbl);
};

// SNGL: room price + city tax, full amount (no sharing), per night
export const getEffectiveCostSngl = (it) => {
  if (it.subType === 'hotel') {
    const price = evalAmount(it.pricePerNightSngl);
    const nights = parseFloat(it.nights) || 0;
    const cityTax = evalAmount(it.cityTaxSngl !== '' && it.cityTaxSngl !== undefined ? it.cityTaxSngl : it.cityTax);
    return price * nights + cityTax * nights;
  }
  return evalAmount(it.costSngl || it.costDbl);
};

export const toEUR = (amount, currency, rates) => {
  const val = parseFloat(amount) || 0;
  if (!currency || currency === 'EUR') return val;
  return val * ((rates && rates[currency]) || 1);
};

// Computes the full selling-price table for a given offer's items/margin/paxList using the given rates.
export const computeOfferPricing = (items, margin, paxList, rates) => {
  const activeItems = items.filter(it => it.enabled !== false);
  const groupItems = activeItems.filter(it => it.type === 'group');
  const paxItems = activeItems.filter(it => it.type === 'per_pax');

  const regularGroupItems = groupItems.filter(it => it.subType !== 'guide_hotel');
  const guideHotelItems = groupItems.filter(it => it.subType === 'guide_hotel');

  const perPaxDblEUR = paxItems.reduce((sum, it) => sum + toEUR(getEffectiveCostDbl(it), it.currency, rates), 0);
  const perPaxSnglEUR = paxItems.reduce((sum, it) => sum + toEUR(getEffectiveCostSngl(it), it.currency, rates), 0);
  const snglSupplementEUR = perPaxSnglEUR - perPaxDblEUR;

  const regularGroupTotalEUR = regularGroupItems.reduce((sum, it) => sum + toEUR(evalAmount(it.groupCost), it.currency, rates), 0);

  const getGuideHotelCost = (it) => {
    const override = it.guideOverride;
    if (override !== '' && override !== undefined && override !== null) return evalAmount(override);
    return perPaxSnglEUR;
  };
  const guideHotelTotalEUR = guideHotelItems.reduce((sum, it) => sum + getGuideHotelCost(it), 0);
  const groupTotalEUR = regularGroupTotalEUR + guideHotelTotalEUR;

  // FOC: the free person's cost is the sum of ALL per-pax items (hotels, meals, tickets, city tax, boats, trains...)
  // on a DBL basis, divided across the paying pax (always 1 FOC, matching the agency's Excel convention).
  const focPoolEUR = perPaxDblEUR;

  const paxCounts = (paxList || '').split(',').map(s => parseInt(s.trim())).filter(n => n > 0);

  const rows = paxCounts.map(pax => {
    const groupPerPax = groupTotalEUR / pax;
    const costDbl = groupPerPax + perPaxDblEUR;
    const marginAmount = costDbl * (margin / 100);
    const sellingBeforeFoc = costDbl + marginAmount;
    const focShare = focPoolEUR / pax;
    const finalDbl = sellingBeforeFoc + focShare;
    const finalSngl = finalDbl + snglSupplementEUR;
    return { pax, groupPerPax, costDbl, marginAmount, sellingBeforeFoc, focShare, finalDbl, finalSngl };
  });

  return { perPaxDblEUR, perPaxSnglEUR, snglSupplementEUR, groupTotalEUR, focPoolEUR, rows };
};
