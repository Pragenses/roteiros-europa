// Zálohy dodavatelům — plán i zaplacené (schváleno 11. 10. 2026).
//
// Každá karta (hotel, bus, průvodce…) má seznam `deposits`. Řádek:
//   { id, amount, due, paid, date, method }
//   amount = částka ve měně karty, due = splatnost (do kdy zaplatit),
//   paid = true/false, date = kdy zaplaceno, method = čím (FIO, KB…).
// Starší řádky neměly `due` ani `paid` — byly to jen ZAPLACENÉ zálohy
// (date = datum zaplacení). Proto: `paid` chybí + je vyplněné datum ⇒ zaplaceno.
// Do ceny pro klienta se nic nepočítá — jen hlídání plateb.
//
// Podmínka zálohy (schváleno 11. 10. 2026). Řádek může mít navíc:
//   kind  = 'fixed' (pevná částka, výchozí) | 'percent' | 'per_room' | 'per_pax'
//   pct   = procento (u 'percent'), basis = 'all' (z celé domluvené ceny, výchozí)
//           | 'no_tax' (jen ubytování bez city tax)
//   unit  = částka za pokoj / za osobu (u 'per_room' / 'per_pax')
//   dueMode = 'date' (výchozí, pole due) | 'before' (dueDays dní před příjezdem
//           do hotelu = item.dateFrom, jinak začátek akce)
//   amount = u podmínky skutečná částka; prázdná = „určí se“ (podle konečných počtů).

export const readAmount = (v) => {
  const cleaned = String(v === 0 ? '0' : (v || '')).replace(/[\s   ]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
};

export const isPaid = (r) => r.paid === true || (r.paid === undefined && String(r.date || '').trim() !== '');

const ymd = (d) => String(d || '').slice(0, 10);
const addDays = (d, n) => { const x = new Date(ymd(d) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const SOON_DAYS = 14;

export const DEPOSIT_KINDS = [
  { value: 'fixed',    label: 'pevná částka' },
  { value: 'percent',  label: '% z ceny' },
  { value: 'per_room', label: 'za pokoj' },
  { value: 'per_pax',  label: 'za osobu' },
];
export const depositKind = (r) => (r && DEPOSIT_KINDS.some(k => k.value === r.kind)) ? r.kind : 'fixed';

// Splatnost řádku: buď zadané datum, nebo X dní před příjezdem.
export function rowDue(r, item, arrival) {
  if (r && r.dueMode === 'before') {
    const days = parseInt(String(r.dueDays || '').trim(), 10);
    const base = ymd((item && item.dateFrom) || arrival);
    if (!Number.isFinite(days) || base.length < 10) return '';
    return addDays(base, -days);
  }
  return ymd(r && r.due);
}

// Krátký popis podmínky: „30 % z celé ceny“, „50 EUR/pokoj“…
export function conditionLabel(r, currency = 'EUR') {
  const k = depositKind(r);
  if (k === 'percent') return `${String(r.pct || '?').replace('.', ',')} % ${r.basis === 'no_tax' ? 'z ubytování bez city tax' : 'z celé ceny'}`;
  if (k === 'per_room') return `${String(r.unit || '?').replace('.', ',')} ${currency}/pokoj`;
  if (k === 'per_pax') return `${String(r.unit || '?').replace('.', ',')} ${currency}/osobu`;
  return '';
}
// Je u podmínky už známá částka?
export const amountKnown = (r) => readAmount(r.amount) > 0;

// Stav jednoho řádku: 'paid' | 'overdue' | 'soon' | 'planned' | 'nodue' | 'empty'
export function depositStatus(r, today = new Date().toISOString().slice(0, 10), item, arrival) {
  if (isPaid(r)) return 'paid';
  const hasAmount = readAmount(r.amount) > 0 || depositKind(r) !== 'fixed';
  const due = rowDue(r, item, arrival);
  if (!hasAmount && !due) return 'empty';
  if (due.length < 10) return 'nodue';
  if (due < today) return 'overdue';
  if (due <= addDays(today, SOON_DAYS)) return 'soon';
  return 'planned';
}

export const DEPOSIT_STYLE = {
  paid:    { icon: '✅', label: 'zaplaceno',        color: '#27500A', bg: '#e8f5e9' },
  overdue: { icon: '⛔', label: 'po splatnosti',    color: '#b91c1c', bg: '#fee2e2' },
  soon:    { icon: '⏳', label: 'splatné brzy',     color: '#9a3412', bg: '#ffedd5' },
  planned: { icon: '🗓', label: 'k zaplacení',      color: '#1d4ed8', bg: '#eff6ff' },
  nodue:   { icon: '❓', label: 'chybí splatnost',  color: '#c2410c', bg: '#fff7ed' },
  empty:   { icon: '·',  label: 'nevyplněno',       color: '#64748b', bg: 'transparent' },
};

// Souhrn jedné karty.
export function depositSummary(item, today, arrival) {
  const rows = Array.isArray(item.deposits) ? item.deposits : [];
  let total = 0, paid = 0, open = 0, next = null, worst = null, unknown = 0;
  const rank = { overdue: 0, soon: 1, nodue: 2, planned: 3, paid: 4, empty: 5 };
  rows.forEach(r => {
    const a = readAmount(r.amount);
    const st = depositStatus(r, today, item, arrival);
    if (st === 'empty') return;
    if (!(a > 0)) unknown++; // podmínka, částka se teprve určí
    total += a;
    if (st === 'paid') paid += a; else {
      open += a;
      const d = rowDue(r, item, arrival);
      if (d.length === 10 && (!next || d < next.due)) next = { due: d, amount: a, status: st };
    }
    if (!worst || rank[st] < rank[worst]) worst = st;
  });
  return { rows, total, paid, open, next, worst, unknown, currency: item.currency || 'EUR' };
}

// Všechny řádky záloh v nabídce (pro Realizaci a kontrolu).
// Každý řádek: { item, row, status, amount, currency, due, condition, known }.
export function allDeposits(items, today, arrival) {
  const out = [];
  (items || []).forEach(it => {
    if (it.enabled === false && !(Array.isArray(it.deposits) && it.deposits.length)) return;
    (Array.isArray(it.deposits) ? it.deposits : []).forEach(r => {
      const status = depositStatus(r, today, it, arrival);
      if (status === 'empty') return;
      const currency = it.currency || 'EUR';
      out.push({ item: it, row: r, status, amount: readAmount(r.amount), currency,
        due: rowDue(r, it, arrival), condition: conditionLabel(r, currency), known: amountKnown(r) });
    });
  });
  return out;
}
