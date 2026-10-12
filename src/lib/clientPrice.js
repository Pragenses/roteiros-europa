// Cena pro klienta v Realizaci (krok 2 — schváleno 12. 10. 2026).
//
// Vychází JEN ze zamčené prodejní ceny (realization.sold) a z Konečných počtů
// celé akce. S našimi náklady se nemíchá.
//   • Řádek ceny (např. 20+1) = řádek prodané verze („Pax sizes“ z nabídky).
//     Aplikace navrhne nejvyšší řádek, který nepřesahuje počet platících
//     (22 platících → 20+1); vybrat jde ručně.
//   • Platící = počet klientů − osoby zdarma (FOC klienta).
//   • Celkem = platící v DBL × cena DBL + platící v SGL × cena SNGL.
//     FOC klienta neplatí: když je FOC v SGL (sold.focType), jeho SGL se mezi
//     platící SGL nepočítá.
//   • TRPL se nepočítá automaticky (řeší se individuálně) — upozornění +
//     ruční úprava (+/−) s poznámkou. Celkovou částku jde přepsat.
// Uložení: offers/<id>.rzClient = { tierPax, parts: { [měna]: { adj, adjNote, override, overrideNote } },
//                                   setAt, setBy, log: [] }  (zápis po částech přes FieldPath)

const n = (v) => { const x = parseFloat(String(v === 0 ? '0' : (v || '')).replace(/[\s  ]/g, '').replace(',', '.')); return Number.isFinite(x) ? x : 0; };
const filled = (v) => String(v === 0 ? '0' : (v ?? '')).trim() !== '';
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

// Části ceny podle měn: bez rozdělení jedna část v EUR (combinedRows).
export function soldParts(sold) {
  if (sold && sold.showSplit && Array.isArray(sold.split) && sold.split.length) {
    return sold.split.map(p => ({ cur: p.cur, rows: p.rows || [] }));
  }
  return [{ cur: 'EUR', rows: (sold && sold.combinedRows) || [] }];
}

export function suggestTier(rows, paying) {
  const tiers = (rows || []).map(r => Number(r.pax)).filter(x => x > 0).sort((a, b) => a - b);
  if (!tiers.length || !(paying > 0)) return null;
  const fit = tiers.filter(t => t <= paying);
  return fit.length ? fit[fit.length - 1] : tiers[0];
}

export function clientTotal(offer) {
  const rz = (offer && offer.realization) || {};
  const sold = rz.sold || {};
  const rc = (offer && offer.rzClient) || {};
  const g = ((offer && offer.rzFinal) || {}).group || {};
  const pax = n(g.pax), foc = n(g.foc), sgl = n(g.sgl), trpl = n(g.trpl);
  const paying = Math.max(pax - foc, 0);
  const focType = sold.focType === 'sgl' ? 'sgl' : 'dbl';
  const payingSgl = Math.max(sgl - (focType === 'sgl' ? foc : 0), 0);
  const trplPersons = trpl * 3;
  const payingDbl = Math.max(paying - payingSgl - trplPersons, 0);
  const parts0 = soldParts(sold);
  const tiersRows = parts0[0].rows;
  const suggested = suggestTier(tiersRows, paying);
  const tierPax = rc.tierPax ? Number(rc.tierPax) : suggested;
  const warnings = [];
  if (!filled(g.pax)) warnings.push('Vyplňte Konečné počty (počet klientů a pokoje).');
  if (paying > 0 && tiersRows.length && paying < Math.min(...tiersRows.map(r => Number(r.pax)))) warnings.push(`Platících (${paying}) je méně než nejmenší řádek ceny — zkontrolujte cenu.`);
  if (trpl > 0) warnings.push(`TRPL: ${trpl} pokoj(e) = ${trplPersons} os. se nepočítají automaticky — doplňte je v ruční úpravě.`);
  if (rc.tierPax && suggested && Number(rc.tierPax) !== suggested) warnings.push(`Vybrán řádek ${rc.tierPax}+${sold.focCount || 0}, podle počtu platících by vycházel ${suggested}+${sold.focCount || 0}.`);
  const parts = parts0.map(p => {
    const row = p.rows.find(r => Number(r.pax) === Number(tierPax)) || null;
    const set = (rc.parts || {})[p.cur] || {};
    const pDbl = row ? n(row.finalDbl) : 0, pSgl = row ? n(row.finalSngl) : 0;
    const lines = [];
    if (row) {
      if (payingDbl) lines.push({ label: `${payingDbl} os. v DBL × ${pDbl.toLocaleString('cs-CZ', { minimumFractionDigits: 2 })}`, amount: r2(payingDbl * pDbl) });
      if (payingSgl) lines.push({ label: `${payingSgl} os. v SGL × ${pSgl.toLocaleString('cs-CZ', { minimumFractionDigits: 2 })}`, amount: r2(payingSgl * pSgl) });
    }
    const computed = r2(lines.reduce((s, l) => s + l.amount, 0));
    const adj = n(set.adj);
    const withAdj = r2(computed + adj);
    const overridden = filled(set.override);
    return { cur: p.cur, row, pDbl, pSgl, lines, computed, adj, adjNote: set.adjNote || '', withAdj,
      overridden, override: set.override || '', overrideNote: set.overrideNote || '',
      total: overridden ? r2(n(set.override)) : withAdj };
  });
  return { sold, tierPax, suggested, pax, foc, focType, paying, payingDbl, payingSgl, trpl, trplPersons, parts, warnings,
    focCount: sold.focCount, any: filled(g.pax) };
}
