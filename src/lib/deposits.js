// Zálohy dodavatelům — plán i zaplacené (schváleno 11. 10. 2026).
//
// Každá karta (hotel, bus, průvodce…) má seznam `deposits`. Řádek:
//   { id, amount, due, paid, date, method }
//   amount = částka ve měně karty, due = splatnost (do kdy zaplatit),
//   paid = true/false, date = kdy zaplaceno, method = čím (FIO, KB…).
// Starší řádky neměly `due` ani `paid` — byly to jen ZAPLACENÉ zálohy
// (date = datum zaplacení). Proto: `paid` chybí + je vyplněné datum ⇒ zaplaceno.
// Do ceny pro klienta se nic nepočítá — jen hlídání plateb.

export const readAmount = (v) => {
  const cleaned = String(v === 0 ? '0' : (v || '')).replace(/[\s   ]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
};

export const isPaid = (r) => r.paid === true || (r.paid === undefined && String(r.date || '').trim() !== '');

const ymd = (d) => String(d || '').slice(0, 10);
const addDays = (d, n) => { const x = new Date(ymd(d) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const SOON_DAYS = 14;

// Stav jednoho řádku: 'paid' | 'overdue' | 'soon' | 'planned' | 'nodue' | 'empty'
export function depositStatus(r, today = new Date().toISOString().slice(0, 10)) {
  if (isPaid(r)) return 'paid';
  const hasAmount = readAmount(r.amount) > 0;
  const due = ymd(r.due);
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
export function depositSummary(item, today) {
  const rows = Array.isArray(item.deposits) ? item.deposits : [];
  let total = 0, paid = 0, open = 0, next = null, worst = null;
  const rank = { overdue: 0, soon: 1, nodue: 2, planned: 3, paid: 4, empty: 5 };
  rows.forEach(r => {
    const a = readAmount(r.amount);
    const st = depositStatus(r, today);
    if (st === 'empty') return;
    total += a;
    if (st === 'paid') paid += a; else {
      open += a;
      const d = ymd(r.due);
      if (d.length === 10 && (!next || d < next.due)) next = { due: d, amount: a, status: st };
    }
    if (!worst || rank[st] < rank[worst]) worst = st;
  });
  return { rows, total, paid, open, next, worst, currency: item.currency || 'EUR' };
}

// Všechny řádky záloh v nabídce (pro Realizaci a kontrolu).
export function allDeposits(items, today) {
  const out = [];
  (items || []).forEach(it => {
    if (it.enabled === false && !(Array.isArray(it.deposits) && it.deposits.length)) return;
    (Array.isArray(it.deposits) ? it.deposits : []).forEach(r => {
      const status = depositStatus(r, today);
      if (status === 'empty') return;
      out.push({ item: it, row: r, status, amount: readAmount(r.amount), currency: it.currency || 'EUR' });
    });
  });
  return out;
}
