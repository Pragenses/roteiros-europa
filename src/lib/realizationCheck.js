// Kontrola před převodem do Realizace („Klient potvrdil“).
//
// Projde vybranou verzi (NR), aktuální nabídku a program (PT-BR) a vrátí
// seznam zjištění. NIC NEBLOKUJE — jen upozorní (rozhodnutí 10. 10. 2026):
//   level 'stop' ⛔ vážný problém, 'warn' ⚠ ke kontrole, 'ok' ✅ v pořádku.
// Čistá funkce bez databáze — data dodá volající.

import { compareSnapshots } from './offerCompare';
import { evalAmount } from './offerCalc';
import { itemStatus, fmtDate } from './realization';

const STATUS_LABEL = { '': 'bez stavu', requested: 'Poptáno', negotiating: 'V jednání', preapproved: 'Předschváleno', confirmed: 'Potvrzeno', cancelled: 'Zrušeno' };
const label = (it) => [it.city, it.name].filter(Boolean).join(' – ') || it.name || 'bez názvu';
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d);
const ymd = (d) => String(d).slice(0, 10);
const addDays = (d, n) => { const x = new Date(ymd(d) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const nightsOf = (it) => {
  if (!isDate(it.dateFrom) || !isDate(it.dateTo)) return [];
  const out = []; let d = ymd(it.dateFrom); const end = ymd(it.dateTo);
  for (let i = 0; d < end && i < 60; i++) { out.push(d); d = addDays(d, 1); }
  return out;
};

// ── Města: názvy v programu (portugalsky) vs. u hotelu (místní/anglicky) ──
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/đ/g, 'd').replace(/[^a-z]/g, '');
const ALIASES = [
  ['ljubljana', 'liubliana', 'lubiana', 'lublana'], ['zagreb', 'zagrebe', 'zagabria'], ['belgrade', 'belgrado', 'beograd'],
  ['bucharest', 'bucareste', 'bucuresti'], ['prague', 'praga', 'praha'], ['vienna', 'viena', 'wien'], ['budapest', 'budapeste'],
  ['krakow', 'cracovia', 'krakov'], ['warsaw', 'varsovia', 'warszawa'], ['munich', 'munique', 'munchen'], ['venice', 'veneza', 'venezia'],
  ['florence', 'florenca', 'firenze'], ['rome', 'roma'], ['milan', 'milao', 'milano'], ['naples', 'napoles', 'napoli'],
  ['geneva', 'genebra', 'geneve'], ['lucerne', 'lucerna', 'luzern'], ['zurich', 'zurique'], ['athens', 'atenas'],
  ['istanbul', 'istambul'], ['copenhagen', 'copenhague', 'kobenhavn'], ['stockholm', 'estocolmo'], ['edinburgh', 'edimburgo'],
  ['london', 'londres'], ['brussels', 'bruxelas', 'bruxelles'], ['amsterdam', 'amsterda'], ['berlin', 'berlim'],
  ['dresden', 'dresda'], ['salzburg', 'salzburgo'], ['sofia', 'sofija'], ['tirana', 'tirane'], ['pristina', 'prishtina', 'pristine'],
  ['medjugorje', 'medugorje', 'medjugorie'], ['timisoara', 'timishoara'], ['bratislava', 'bratislavia'], ['oslo'], ['helsinki', 'helsinque'],
  ['moscow', 'moscou'], ['saintpetersburg', 'saopetersburgo'], ['tallinn', 'talin'], ['riga'], ['vilnius', 'vilnius'],
  ['seville', 'sevilha', 'sevilla'], ['lisbon', 'lisboa'], ['porto', 'oporto'], ['nice', 'nica'], ['cologne', 'colonia', 'koln'],
  ['frankfurt', 'frankfurt'], ['heidelberg'], ['innsbruck'], ['dubrovnik'], ['split'], ['kotor'], ['sarajevo'], ['skopje', 'escopia'],
  ['ohrid'], ['tbilisi', 'tbilissi'], ['bergen'], ['cesky krumlov', 'ceskykrumlov', 'krumlov'],
].map(list => list.map(norm));
const canon = (s) => { const n = norm(s); const hit = ALIASES.find(l => l.includes(n)); return hit ? hit[0] : n; };
const lev = (a, b) => {
  const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]); for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
};
export const sameCity = (a, b) => {
  const x = canon(a), y = canon(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  return Math.min(x.length, y.length) >= 5 && lev(x, y) <= 2;
};

// Dny programu: „2° DIA – 20/05/2027 – FRANKFURT / LIUBLIANA“ → { day, date, overnight: 'LIUBLIANA' }.
export function parseProgramDays(html) {
  const text = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ');
  const days = [];
  text.split('\n').forEach(line => {
    const m = line.match(/(\d{1,2})\s*[º°oª]?\s*DIA\s*[–\-—:]?\s*(\d{1,2})[/.](\d{1,2})[/.](\d{4})\s*[–\-—:]?\s*(.*)$/i);
    if (!m) return;
    const date = `${m[4]}-${m[3].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const route = m[5].replace(/\(.*?\)/g, '').trim();
    const parts = route.split(/\s*[/–—-]\s*|\s+x\s+/i).map(p => p.trim()).filter(Boolean);
    days.push({ day: parseInt(m[1], 10), date, route, overnight: parts.length ? parts[parts.length - 1] : '' });
  });
  return days;
}

export function checkBeforeRealization({ offer, version, currentSnapshot, today = new Date().toISOString().slice(0, 10) }) {
  const out = [];
  const add = (level, title, details = []) => out.push({ level, title, details });
  const items = offer.items || [];
  const active = items.filter(it => it.enabled !== false && !it.cancelled);
  const hotels = active.filter(it => it.subType === 'hotel');

  // ── 1. Verze vs. aktuální nabídka ──
  if (version && version.snapshot && currentSnapshot) {
    const cmp = compareSnapshots(version.snapshot, currentSnapshot);
    const priceRows = (cmp.combined || []).filter(r => r.dblDiff !== null && r.dblDiff !== 0);
    if (priceRows.length) {
      add('warn', 'Dnešní výpočet nabídky se liší od vybrané verze' + (cmp.onlyRateEffect ? ' (jen vlivem kurzu)' : ''),
        [...priceRows.map(r => `${r.pax} pax: verze ${r.dblA} € → dnes ${r.dblB} € (${r.dblDiff > 0 ? '+' : ''}${r.dblDiff} €)`),
          'Zamkne se cena z VERZE — to, co klient dostal.']);
    }
    const svc = [
      ...cmp.added.map(it => `přibylo: ${label(it)}`),
      ...cmp.removed.map(it => `ubylo: ${label(it)}`),
      ...cmp.changed.map(c => `změněno: ${label(c.item)} (${c.diffs.map(d => d.label).join(', ')})`),
      ...cmp.settings.map(s => `${s.label}: ${s.a} → ${s.b}`),
    ];
    if (svc.length) add('warn', `Od uložení verze se nabídka změnila (${svc.length})`, svc);
    if (!priceRows.length && !svc.length) add('ok', 'Verze odpovídá aktuální nabídce');
  }
  if (version && version.snapshot && version.snapshot.checkMismatch) add('warn', 'U verze nesouhlasila kontrola mezisoučtů — ceny zkontrolujte');

  // ── 2. Hotely ──
  const notConfirmed = hotels.filter(it => itemStatus(it) !== 'confirmed');
  if (notConfirmed.length) add('warn', `Nepotvrzené hotely (${notConfirmed.length})`, notConfirmed.map(it => `${label(it)} — ${STATUS_LABEL[itemStatus(it)] || itemStatus(it)}`));
  else if (hotels.length) add('ok', `Všechny hotely potvrzené (${hotels.length})`);

  const expired = active.filter(it => isDate(it.optionDate) && ymd(it.optionDate) < today && itemStatus(it) !== 'confirmed');
  if (expired.length) add('stop', 'Prošlá opce u nepotvrzené služby', expired.map(it => `${label(it)} — opce ${fmtDate(it.optionDate)}`));

  const strays = items.filter(it => it.subType === 'hotel' && it.enabled === false && !it.cancelled && itemStatus(it) === 'confirmed');
  if (strays.length) add('warn', 'Potvrzené hotely, které nejsou ve výběru (zrušit u hotelu?)', strays.map(label));

  const byNight = {};
  hotels.forEach(h => nightsOf(h).forEach(d => { (byNight[d] = byNight[d] || []).push(h); }));
  const doubles = Object.entries(byNight).filter(([, l]) => l.length > 1).sort();
  if (doubles.length) add('stop', 'Dva hotely na stejnou noc — oba se počítají do ceny', doubles.map(([d, l]) => `${fmtDate(d)}: ${l.map(label).join(' + ')}`));

  if (isDate(offer.startDate) && isDate(offer.endDate)) {
    const missing = [];
    for (let d = ymd(offer.startDate), i = 0; d < ymd(offer.endDate) && i < 90; d = addDays(d, 1), i++) if (!byNight[d]) missing.push(d);
    if (missing.length) add('warn', `Noci bez hotelu (${missing.length})`, [missing.map(fmtDate).join(', '), 'V pořádku jen u nočního letu, lodi apod.']);
    else if (hotels.length) add('ok', 'Hotely pokrývají všechny noci termínu');
  }
  const noDates = hotels.filter(h => !isDate(h.dateFrom) || !isDate(h.dateTo));
  if (noDates.length) add('warn', 'Hotely bez data příjezdu/odjezdu', noDates.map(label));

  const noPrice = hotels.filter(h => String(h.pricePerNightDbl ?? '').trim() === '' || String(h.pricePerNightSngl ?? '').trim() === '');
  if (noPrice.length) add('warn', 'Hotely bez ceny DBL nebo SNGL', noPrice.map(label));
  const taxOdd = hotels.filter(h => {
    const snglSet = h.cityTaxSngl !== '' && h.cityTaxSngl !== undefined && h.cityTaxSngl !== null;
    const dbl = evalAmount(h.cityTax), sngl = snglSet ? evalAmount(h.cityTaxSngl) : 0;
    if (!dbl && !sngl) return false;
    return !snglSet || Math.abs(dbl - 2 * sngl) >= 0.005;
  });
  if (taxOdd.length) add('warn', 'City tax ke kontrole (DBL není 2× SNGL nebo SNGL chybí)', taxOdd.map(label));

  // ── 3. Program vs. hotely ──
  const days = parseProgramDays(offer.programText);
  if (!String(offer.programText || '').trim()) {
    add('warn', 'Program (PT-BR) je prázdný');
  } else if (!days.length) {
    add('warn', 'Program se nepodařilo přečíst', ['Dny musí být ve tvaru „2° DIA – 20/05/2027 – MĚSTO“.']);
  } else {
    const issues = [];
    const end = isDate(offer.endDate) ? ymd(offer.endDate) : null;
    const start = isDate(offer.startDate) ? ymd(offer.startDate) : null;
    days.forEach(dy => {
      if (end && dy.date >= end) return;     // poslední den — odjezd, bez noclehu
      if (start && dy.date < start) return;  // dny před začátkem termínu (let z Brazílie)
      const hs = byNight[dy.date] || [];
      if (!hs.length) { issues.push(`${dy.day}. den ${fmtDate(dy.date)} (${dy.route}): na tuto noc není hotel`); return; }
      if (dy.overnight && !hs.some(h => sameCity(h.city, dy.overnight))) {
        issues.push(`${dy.day}. den ${fmtDate(dy.date)}: program končí v „${dy.overnight}“, hotel je v „${hs.map(h => h.city || '?').join(' / ')}“`);
      }
    });
    const progDates = new Set(days.map(d => d.date));
    Object.keys(byNight).sort().forEach(d => { if (!progDates.has(d)) issues.push(`Noc ${fmtDate(d)} (${byNight[d].map(label).join(', ')}) nemá den v programu`); });
    if (issues.length) add('warn', `Program a hotely nesedí (${issues.length})`, [...issues, 'Názvy měst se mohou lišit jazykem — zkontrolujte, co opravdu nesedí.']);
    else add('ok', `Program sedí s hotely (${days.length} dní)`);
  }

  // ── 4. Ostatní služby ──
  const others = active.filter(it => it.subType !== 'hotel' && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel' && (it.type === 'per_pax' || it.type === 'group'));
  const noStatus = others.filter(it => itemStatus(it) === '');
  if (noStatus.length) add('warn', `Služby bez stavu (${noStatus.length} z ${others.length})`, noStatus.map(label));
  else if (others.length) add('ok', `Ostatní služby mají stav (${others.length})`);

  const order = { stop: 0, warn: 1, ok: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return out;
}
