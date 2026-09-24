// Porovnání dvou verzí nabídky (nebo verze a aktuálního stavu).
//
// Pracuje jen s „zmrazenými" výpočty (snapshot) — nic nepřepočítává.
// `a` je starší, `b` novější. Výsledek je čistá data; kreslí je
// src/components/OfferVersions.js.

// Pole služby, jejichž změna se ukazuje. Pořadí = pořadí ve výpisu.
export const ITEM_FIELDS = [
  ['name', 'Název'],
  ['city', 'Město'],
  ['dateFrom', 'Od'],
  ['dateTo', 'Do'],
  ['nights', 'Nocí'],
  ['currency', 'Měna'],
  ['pricePerNightDbl', 'DBL / pokoj / noc'],
  ['pricePerNightSngl', 'SNGL / pokoj / noc'],
  ['cityTax', 'City tax'],
  ['cityTaxSngl', 'City tax SNGL'],
  ['costDbl', 'Cena DBL / os.'],
  ['costSngl', 'Cena SNGL / os.'],
  ['groupCost', 'Cena za skupinu'],
  ['guideOverride', 'Ruční cena'],
];

const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
// „120" a „120.00" je totéž; text (např. vzorec „=106*0.05") se porovná jako text.
const same = (x, y) => {
  const a = norm(x), b = norm(y);
  if (a === b) return true;
  const na = Number(a), nb = Number(b);
  return a !== '' && b !== '' && !isNaN(na) && !isNaN(nb) && Math.abs(na - nb) < 0.0001;
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Klíč pro spárování stejné služby ve dvou verzích: nejdřív id, jinak druh+město+název.
const keyOf = (it) => (it.id !== undefined && it.id !== null && it.id !== '' ? 'id:' + it.id : 'n:' + [it.type, it.subType, norm(it.city).toLowerCase(), norm(it.name).toLowerCase()].join('|'));

function compareRows(rowsA, rowsB) {
  const byPax = new Map();
  (rowsA || []).forEach(r => byPax.set(r.pax, { pax: r.pax, a: r }));
  (rowsB || []).forEach(r => byPax.set(r.pax, { ...(byPax.get(r.pax) || { pax: r.pax }), b: r }));
  return [...byPax.values()].sort((x, y) => x.pax - y.pax).map(({ pax, a, b }) => ({
    pax,
    dblA: a ? r2(a.finalDbl) : null,
    dblB: b ? r2(b.finalDbl) : null,
    dblDiff: a && b ? r2(b.finalDbl - a.finalDbl) : null,
    snglA: a ? r2(a.finalSngl) : null,
    snglB: b ? r2(b.finalSngl) : null,
    snglDiff: a && b ? r2(b.finalSngl - a.finalSngl) : null,
  }));
}

export function compareSnapshots(a, b) {
  a = a || {}; b = b || {};

  // --- Nastavení nabídky ---
  const settings = [];
  const pushIf = (label, x, y) => { if (!same(x, y)) settings.push({ label, a: norm(x), b: norm(y) }); };
  pushIf('Marže %', a.margin, b.margin);
  pushIf('Počet FOC', a.focCount, b.focCount);
  pushIf('FOC v pokoji', String(a.focType || 'dbl').toUpperCase(), String(b.focType || 'dbl').toUpperCase());
  pushIf('Velikosti skupiny', norm(a.paxList).replace(/\s+/g, ''), norm(b.paxList).replace(/\s+/g, ''));
  if (!!a.showSplit !== !!b.showSplit) settings.push({ label: 'Ceny pro klienta', a: a.showSplit ? 'podle měn' : 'v EUR', b: b.showSplit ? 'podle měn' : 'v EUR' });

  // --- Kurzy: jen měny, které se v některé z verzí opravdu vyskytují ---
  const curs = new Set([...(a.items || []), ...(b.items || [])].map(it => it.currency).filter(c => c && c !== 'EUR'));
  const rates = [];
  curs.forEach(c => {
    const ra = a.rates && a.rates[c], rb = b.rates && b.rates[c];
    if (ra && rb && Math.abs(ra - rb) > 0.00005) rates.push({ cur: c, a: Number(ra), b: Number(rb) });
  });

  // --- Ceny ---
  const combined = compareRows(a.combinedRows, b.combinedRows);
  let split = null;
  if (a.split && b.split && a.split.length && b.split.length) {
    const cursAll = [...new Set([...a.split.map(p => p.cur), ...b.split.map(p => p.cur)])];
    split = cursAll.map(cur => {
      const pa = a.split.find(p => p.cur === cur), pb = b.split.find(p => p.cur === cur);
      return { cur, rows: compareRows(pa && pa.rows, pb && pb.rows) };
    });
  }

  // --- Služby ---
  const mapA = new Map(), mapB = new Map();
  (a.items || []).forEach(it => mapA.set(keyOf(it), it));
  (b.items || []).forEach(it => mapB.set(keyOf(it), it));
  const added = [], removed = [], changed = [];
  mapB.forEach((it, k) => { if (!mapA.has(k)) added.push(it); });
  mapA.forEach((it, k) => {
    if (!mapB.has(k)) { removed.push(it); return; }
    const nb = mapB.get(k);
    const diffs = ITEM_FIELDS.filter(([f]) => !same(it[f], nb[f])).map(([f, label]) => ({ field: f, label, a: norm(it[f]), b: norm(nb[f]) }));
    if (diffs.length) changed.push({ item: nb, before: it, diffs });
  });

  const anyPriceChange = combined.some(r => r.dblDiff !== 0 || r.snglDiff !== 0);
  const splitUnchanged = split ? split.every(p => p.rows.every(r => r.dblDiff === 0 && r.snglDiff === 0)) : false;
  // Cena v EUR se změnila, ale nic jiného ne → je to jen vliv kurzu.
  const onlyRateEffect = anyPriceChange && rates.length > 0 && settings.length === 0
    && added.length === 0 && removed.length === 0 && changed.length === 0
    && (split ? splitUnchanged : true);

  return { settings, rates, combined, split, added, removed, changed, anyPriceChange, onlyRateEffect };
}
