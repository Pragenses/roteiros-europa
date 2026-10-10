// Realizace (Realization – Operations)
//
// Akce je JEDEN záznam od poptávky po odjezd: nabídka (`offers/<id>`).
// Po potvrzení klientem dostane nabídka pole `realization`; nic se nekopíruje
// do jiné kolekce. Hotely, služby, stavy, opce a zálohy se v Realizaci čtou
// živě z položek nabídky.
//
// Prodejní cena pro klienta se ZAMKNE z uložené verze (NR), kterou klient
// přijal: ceny se zkopírují ze zmrazeného výpočtu té verze (snapshot), takže
// je pozdější úpravy nabídky ani kurz nezmění. Úpravy nákladů se pak projeví
// jen v zisku. Změnit prodanou verzi jde jen vědomě („Změnit prodanou verzi“),
// předchozí zůstává v `realization.history`.
//
// offers/<id>.realization = {
//   status: 'active',
//   confirmedAt, confirmedBy,               // první potvrzení
//   soldVersionId, soldVersionNo, soldVersionName, soldVersionCreatedAt,
//   sold: { margin, focCount, focType, paxList, showSplit, rates,
//           combinedRows: [{ pax, costDbl, focShare, finalDbl, finalSngl }],
//           split: [{ cur, rows: [{ pax, finalDbl, finalSngl }] }] | null },
//   changedAt, changedBy,                   // poslední změna prodané verze
//   history: [{ at, by, versionId, versionName }],
// }

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Verze, ze které jde zamknout cenu: uložená přes „Uložit jako verzi“
// (má zmrazený výpočet s cenami) a není v koši.
export const isLockableVersion = (v) => !!v && !v.deletedAt
  && !!v.snapshot && Array.isArray(v.snapshot.combinedRows) && v.snapshot.combinedRows.length > 0;

// Zamčené ceny z verze — jen to, co je potřeba; nic se nepřepočítává.
export function soldFromVersion(v) {
  const s = v.snapshot || {};
  return {
    margin: s.margin ?? '',
    focCount: s.focCount ?? '',
    focType: s.focType || 'dbl',
    paxList: s.paxList || '',
    showSplit: !!s.showSplit,
    rates: s.rates || {},
    combinedRows: (s.combinedRows || []).map(r => {
      const o = { pax: r.pax, finalDbl: r2(r.finalDbl), finalSngl: r2(r.finalSngl) };
      if (r.costDbl !== undefined) o.costDbl = r2(r.costDbl);
      if (r.focShare !== undefined) o.focShare = r2(r.focShare);
      return o;
    }),
    split: Array.isArray(s.split) && s.split.length
      ? s.split.map(p => ({ cur: p.cur, rows: (p.rows || []).map(r => ({ pax: r.pax, finalDbl: r2(r.finalDbl), finalSngl: r2(r.finalSngl) })) }))
      : null,
    checkMismatch: !!s.checkMismatch,
  };
}

export const isInRealization = (offer) => !!(offer && offer.realization && offer.realization.status === 'active');

// Stav položky — stejné pravidlo jako v OfferDetail.js (itemStatus):
// zrušeno je jen příznak `cancelled`, jinak `bookingStatus`.
export const itemStatus = (it) => (it && it.cancelled) ? 'cancelled' : ((it && it.bookingStatus) || '');

// Služby, které se v akci objednávají: zaškrtnuté hotely, vstupenky/jídla
// a skupinové služby (bus, průvodce…). Ubytování průvodce/řidiče se počítá
// automaticky z hotelů, samostatně se neobjednává.
export const realizationItems = (offer) => (offer.items || []).filter(it =>
  it.enabled !== false
  && (it.type === 'per_pax' || it.type === 'group')
  && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');

export function serviceCounts(offer) {
  const list = realizationItems(offer).filter(it => !it.cancelled);
  return { total: list.length, confirmed: list.filter(it => itemStatus(it) === 'confirmed').length };
}

// Nejbližší budoucí termín (opce nebo storno lhůta) u nezrušených služeb.
export function nextDeadline(offer, today = new Date().toISOString().slice(0, 10)) {
  let best = null;
  realizationItems(offer).filter(it => !it.cancelled).forEach(it => {
    const label = [it.city, it.name].filter(Boolean).join(' – ') || 'služba';
    [['optionDate', 'Opce'], ['cancellationDeadline', 'Storno']].forEach(([f, kind]) => {
      const d = String(it[f] || '').slice(0, 10);
      if (d.length === 10 && d >= today && (!best || d < best.date)) best = { date: d, kind, label };
    });
  });
  return best;
}

export const fmtMoney = (n) => (n === null || n === undefined || n === '') ? '—'
  : Number(n).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtDate = (d) => { const s = String(d || '').slice(0, 10); if (s.length < 10) return s; const [y, m, day] = s.split('-'); return `${day}.${m}.${y}`; };

// Krátký popis zamčené ceny: „25 pax 1 450,00 € · 30 pax 1 390,00 €“
// (u ceny rozdělené podle měn: „25 pax 900,00 CHF + 550,00 EUR“).
export function soldSummary(sold) {
  if (!sold) return '';
  if (sold.showSplit && sold.split && sold.split.length) {
    const paxes = (sold.split[0].rows || []).map(r => r.pax);
    return paxes.map(pax => `${pax} pax ` + sold.split.map(p => {
      const r = (p.rows || []).find(x => x.pax === pax);
      return `${fmtMoney(r ? r.finalDbl : null)} ${p.cur}`;
    }).join(' + ')).join(' · ');
  }
  return (sold.combinedRows || []).map(r => `${r.pax} pax ${fmtMoney(r.finalDbl)} €`).join(' · ');
}
