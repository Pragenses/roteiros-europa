// Druh služby a harmonogram rezervací (Realizace, krok A — schváleno 10. 10. 2026).
//
// Druh je JEN ŠTÍTEK pro termíny, stavy a později platby. Do výpočtu ceny
// nevstupuje — ten se dál řídí typem karty v nabídce (za osobu / za skupinu /
// hotel). Karty v nabídce se nemění.
//
// Uložení: offers/<id>.rzServices = { [itemId]: { kind, transport, pax, due, setBy, setAt } }
// — samostatné pole, které nabídka nikdy nepřepisuje (ukládá jen vybraná pole),
// takže se nemůže ztratit při souběžné úpravě nabídky.
//
// Termíny se počítají od DATA PŘÍJEZDU skupiny (offer.startDate).

export const KINDS = [
  { id: 'hotel',      icon: '🏨', label: 'Hotel',                       color: '#1a3a5c', bg: '#e6f1fb', rule: 'ihned po potvrzení klientem' },
  { id: 'halfboard',  icon: '🍲', label: 'Polopenze / jídlo v hotelu',  color: '#0c4a6e', bg: '#e0f2fe', rule: 'řeší se s hotelem (na faktuře hotelu)' },
  { id: 'bus',        icon: '🚌', label: 'Autobus',                     color: '#27500A', bg: '#eaf3de', rule: 'ihned po potvrzení hotelů' },
  { id: 'tourguide',  icon: '🧭', label: 'Doprovodný průvodce',         color: '#5b21b6', bg: '#ede9fe', rule: '10 měsíců před příjezdem', months: 10 },
  { id: 'transport',  icon: '🚆', label: 'Doprava',                     color: '#0f766e', bg: '#ccfbf1', rule: '10 měsíců před příjezdem', months: 10 },
  { id: 'localguide', icon: '👤', label: 'Místní průvodce',             color: '#9d174d', bg: '#fce7f3', rule: '6 měsíců před příjezdem', months: 6 },
  { id: 'tickets',    icon: '🎟', label: 'Vstupenky',                   color: '#854f0b', bg: '#fef3c7', rule: '3 měsíce před příjezdem', months: 3 },
  { id: 'restaurant', icon: '🍽', label: 'Restaurace mimo hotel',       color: '#c2410c', bg: '#ffedd5', rule: 'začít 3 měsíce před, nejpozději 1 týden před', months: 3, lastDays: 7 },
  { id: 'custom',     icon: '✳️', label: 'Custom (mimo nabídku)',       color: '#475569', bg: '#f1f5f9', rule: 'vlastní datum' },
];
export const kindById = (id) => KINDS.find(k => k.id === id) || null;

export const TRANSPORT = [
  { id: 'vlak', label: 'vlak' }, { id: 'lod', label: 'loď' },
  { id: 'transfer', label: 'transfer' }, { id: 'let', label: 'let' },
];

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Návrh druhu podle typu karty a názvu. Jen NÁVRH — uloží se, až ho uživatel vybere.
// Hotelová karta je hotel vždy (typ karty je jednoznačný), proto se bere rovnou.
export function suggestKind(it) {
  if (it.subType === 'hotel') return 'hotel';
  const n = norm(it.name);
  if (/\b(bus|onibus|autocarro|autobus|coach|motorista)\b/.test(n)) return 'bus';
  if (/acompanhante|tour ?leader|doprovod/.test(n)) return 'tourguide';
  if (/\b(trem|train|vlak|barco|boat|ferry|lod|balsa|transfer|traslado|voo|flight|letenka|aviao|cruzeiro|funicular|telef)/.test(n)) return 'transport';
  if (/meia pensao|half ?board|polopenz/.test(n)) return 'halfboard';
  if (/jantar|almoco|dinner|lunch|restaur|refeic|degusta/.test(n)) return 'restaurant';
  if (/\b(guia|guide|pruvodce|guida)\b/.test(n)) return 'localguide';
  if (it.subType === 'ticket' || /ingress|ticket|entrada|vstup|castelo|museu|museo|parque|fortalez|muralha|tunel|palacio|igreja|catedral/.test(n)) return 'tickets';
  return '';
}

// Uložený druh služby (nebo hotel automaticky). '' = nevybráno.
export function kindOf(it, rzServices) {
  const saved = rzServices && rzServices[String(it.id)];
  if (saved && saved.kind) return saved.kind;
  return it.subType === 'hotel' ? 'hotel' : '';
}

const ymd = (d) => String(d || '').slice(0, 10);
const addMonths = (d, m) => { const x = new Date(ymd(d) + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const addDays = (d, n) => { const x = new Date(ymd(d) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const isDate = (d) => /^\d{4}-\d{2}-\d{2}/.test(String(d || ''));
const WARN_DAYS = 30; // oranžově měsíc před termínem

// Stav termínu jedné služby:
//   { level: 'done'|'ok'|'warn'|'late'|'none'|'nokind', text, due }
//   done = potvrzeno; ok = termín je daleko; warn = blíží se / rezervovat teď;
//   late = termín prošel; none = bez vlastního termínu; nokind = druh nevybrán.
export function deadlineState({ it, kind, saved, offer, statusOf, hotelsAllConfirmed, today = new Date().toISOString().slice(0, 10) }) {
  const st = statusOf(it);
  if (st === 'cancelled') return { level: 'none', text: 'zrušeno' };
  if (st === 'confirmed') return { level: 'done', text: 'potvrzeno' };
  if (!kind) return { level: 'nokind', text: 'vyberte druh služby' };
  const k = kindById(kind);
  const arrival = isDate(offer.startDate) ? ymd(offer.startDate) : null;

  if (kind === 'halfboard') return { level: 'none', text: 'řeší se s hotelem' };
  if (kind === 'hotel') return { level: 'warn', text: 'rezervovat ihned' };
  if (kind === 'bus') {
    return hotelsAllConfirmed
      ? { level: 'warn', text: 'rezervovat ihned — hotely jsou potvrzené' }
      : { level: 'ok', text: 'hned po potvrzení hotelů' };
  }
  if (kind === 'custom') {
    if (!saved || !isDate(saved.due)) return { level: 'none', text: 'bez termínu' };
    return byDue(ymd(saved.due), today);
  }
  if (!arrival) return { level: 'none', text: 'chybí datum příjezdu' };
  if (kind === 'restaurant') {
    const start = addMonths(arrival, -k.months), last = addDays(arrival, -k.lastDays);
    if (today > last) return { level: 'late', text: `termín prošel (${fmt(last)})`, due: last };
    if (today >= start) return { level: 'warn', text: `rezervovat do ${fmt(last)}`, due: last };
    return { level: 'ok', text: `od ${fmt(start)}, nejpozději ${fmt(last)}`, due: last };
  }
  return byDue(addMonths(arrival, -k.months), today);
}

function byDue(due, today) {
  if (today > due) return { level: 'late', text: `termín prošel (${fmt(due)})`, due };
  if (today >= addDays(due, -WARN_DAYS)) return { level: 'warn', text: `rezervovat do ${fmt(due)}`, due };
  return { level: 'ok', text: `do ${fmt(due)}`, due };
}
function fmt(d) { const [y, m, day] = ymd(d).split('-'); return `${day}.${m}.${y}`; }

export const LEVEL_STYLE = {
  done:   { icon: '✅', color: '#27500A', bg: '#eaf3de' },
  ok:     { icon: '🗓', color: '#475569', bg: '#f1f5f9' },
  warn:   { icon: '⏳', color: '#9a3412', bg: '#ffedd5' },
  late:   { icon: '⛔', color: '#b91c1c', bg: '#fee2e2' },
  none:   { icon: '·',  color: '#64748b', bg: 'transparent' },
  nokind: { icon: '❓', color: '#c2410c', bg: '#fff7ed' },
};
