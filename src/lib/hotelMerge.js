// ─────────────────────────────────────────────────────────────────────────────
// SLUČOVÁNÍ DUPLICITNÍCH KARET HOTELŮ
//
// Dvě karty jsou tentýž hotel, když internetová kontrola u obou našla
// STEJNOU adresu hotelu nebo STEJNOU stránku hotelu (ne jen homepage řetězce).
// Jisté = obě kontroly jsou "sure" a shoduje se adresa, nebo stránka hotelu
// s konkrétní cestou. Ostatní shody jdou člověku k rozhodnutí.
// ─────────────────────────────────────────────────────────────────────────────

const stripDia = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

// Webová adresa → porovnatelný klíč: bez https, www, jazyka, index.html,
// parametrů a lomítka na konci.
export function normUrl(u) {
  let s = String(u || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '');
  const slash = s.indexOf('/');
  const host = slash < 0 ? s : s.slice(0, slash);
  let path = slash < 0 ? '' : s.slice(slash);
  path = path
    .replace(/\/(index|default|home)\.[a-z]+$/, '/')
    .replace(/^\/(en|cs|cz|de|fr|it|es|pt|pl|nl|en-gb|en-us|de-de|fr-fr|it-it|es-es|pt-br|pt-pt)(?=\/|$)/, '')
    .replace(/\/+$/, '');
  return host + path;
}
export const urlHasPath = (key) => key.includes('/');

export function normAddr(a) {
  return stripDia(String(a || '').toLowerCase())
    .replace(/\b(street|str|strasse|straße|ulice|rue|via|calle|rua|avenue|ave|av)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const fv = (card, k) => {
  const f = card && card.webInfo && card.webInfo.fields && card.webInfo.fields[k];
  return f && !f.deleted ? f.value : '';
};

// Skupiny duplicit z karet, které mají internetovou kontrolu.
// → [{ key, ids: [...], sure, reason }]
export function findDuplicateGroups(cards) {
  const checked = (cards || []).filter(c => c.webInfo && c.webInfo.checkedAt);
  // Homepage řetězce (bez cesty) sdílí mnoho hotelů — takový klíč nic nespojuje.
  const urlCount = new Map();
  checked.forEach(c => { const u = normUrl(fv(c, 'website')); if (u) urlCount.set(u, (urlCount.get(u) || 0) + 1); });

  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  checked.forEach(c => parent.set(c.id, c.id));

  const byKey = new Map();
  const reasons = new Map();   // pair key → důvod
  for (const c of checked) {
    const keys = [];
    const u = normUrl(fv(c, 'website'));
    if (u && (urlHasPath(u) || (urlCount.get(u) || 0) <= 2)) keys.push(`w:${u}`);
    const a = normAddr(fv(c, 'address'));
    if (a.length >= 8 && /\d/.test(a)) keys.push(`a:${a}`);
    keys.forEach(k => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(c.id); });
  }
  for (const [k, ids] of byKey) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) {
      union(ids[0], ids[i]);
      reasons.set([ids[0], ids[i]].sort().join('|'), k);
    }
  }
  const groups = new Map();
  checked.forEach(c => { const r = find(c.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); });
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ids = list.map(c => c.id).sort();
    const allSure = list.every(c => c.webInfo.sure);
    const addrs = new Set(list.map(c => normAddr(fv(c, 'address'))).filter(Boolean));
    const urls = new Set(list.map(c => normUrl(fv(c, 'website'))).filter(Boolean));
    const sameAddr = addrs.size === 1 && list.every(c => normAddr(fv(c, 'address')));
    const samePage = urls.size === 1 && [...urls][0] && urlHasPath([...urls][0]) && list.every(c => normUrl(fv(c, 'website')));
    out.push({
      key: ids.join('|'), ids,
      sure: allSure && (sameAddr || samePage),
      reason: sameAddr ? 'stejná adresa hotelu' : samePage ? 'stejná stránka hotelu' : 'částečně stejná adresa / web',
    });
  }
  return out;
}

// Sloučená karta. Hlavní = karta s nejvíce adresami / ručními úpravami.
export function buildMerged(list) {
  const score = (c) => (c.emails || []).length + (c.nameManual ? 5 : 0) + Object.values((c.webInfo && c.webInfo.fields) || {}).filter(f => f.manual).length * 3;
  const sorted = [...list].sort((a, b) => score(b) - score(a));
  const primary = sorted[0];
  const official = fv(primary, 'name') || sorted.map(c => fv(c, 'name')).find(Boolean) || '';
  const name = primary.nameManual ? primary.name : (official || primary.name);
  const allNames = [...new Set(list.flatMap(c => [c.name, ...(c.aliases || [])]).filter(Boolean))].filter(n => n !== name);
  const emails = [];
  const seen = new Set();
  sorted.forEach(c => (c.emails || []).forEach(e => {
    const k = String(e.email || '').toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    emails.push({ ...e, main: emails.length === 0 ? true : false, fromCard: c.id === primary.id ? undefined : c.name });
  }));
  emails.forEach(e => { if (e.fromCard === undefined) delete e.fromCard; });
  const notes = [...new Set(list.map(c => String(c.notes || '').trim()).filter(Boolean))].join(' · ');
  // Internetové údaje: ručně zadané mají přednost, jinak hlavní karta, jinak ostatní.
  const fields = {};
  const keys = new Set(list.flatMap(c => Object.keys((c.webInfo && c.webInfo.fields) || {})));
  keys.forEach(k => {
    const cands = sorted.map(c => c.webInfo && c.webInfo.fields && c.webInfo.fields[k]).filter(Boolean);
    fields[k] = cands.find(f => f.manual) || cands[0];
  });
  const webInfo = primary.webInfo ? { ...primary.webInfo, fields } : (sorted.find(c => c.webInfo) || {}).webInfo || null;
  if (webInfo) delete webInfo.prev;
  return {
    primary, others: sorted.slice(1),
    data: {
      name, aliases: allNames, emails, notes,
      city: primary.cityManual ? primary.city : (primary.city || sorted.map(c => c.city).find(Boolean) || ''),
      ...(webInfo ? { webInfo } : {}),
      mergedFrom: [...new Set([...(primary.mergedFrom || []), ...sorted.slice(1).map(c => c.id)])],
    },
  };
}
