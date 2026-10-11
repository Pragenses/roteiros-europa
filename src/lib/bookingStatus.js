// Stav služby (karty v nabídce) — sdílený pro nabídku i Realizaci (schváleno 11. 10. 2026).
//
// Ukládá se na kartě v nabídce (items[].bookingStatus), jediné místo, ze kterého
// stav čte celá aplikace. Dva nové stavy:
//   📨 Objednáno  = bookingStatus 'ordered' (odesláno dodavateli, čeká na potvrzení)
//   💶 Zaplaceno  = bookingStatus 'confirmed' + paidInFull: true
// Zaplaceno je tedy zároveň potvrzené — všechna místa, která hlídají
// „potvrzeno“ (opce, storno, alternativy, pevné náklady), fungují beze změny.
// Zrušeno = příznak cancelled (bookingStatus se nemění, viz OfferDetail).
//
// Kdo a kdy: statusAt, statusBy, statusFrom ('nabídka' | 'Realizace') a
// statusLog [{ at, by, from, fromStatus, toStatus }] (posledních 30).

import { db, auth } from './firebase';
import { doc, runTransaction } from 'firebase/firestore';
import { codeForEmail } from './people';

export const BOOKING_STATUS = [
  { value: '',            label: 'Stav?',             border: null,      bg: '#fff',    color: null },
  { value: 'requested',   label: '🟡 Poptáno',        border: '#854f0b', bg: '#fff8e1', color: '#854f0b' },
  { value: 'negotiating', label: '🟠 V jednání',      border: '#c2410c', bg: '#ffedd5', color: '#c2410c' },
  { value: 'preapproved', label: '🔵 Předschváleno',  border: '#1d4ed8', bg: '#dbeafe', color: '#1d4ed8' },
  { value: 'ordered',     label: '📨 Objednáno',      border: '#6d28d9', bg: '#ede9fe', color: '#6d28d9' },
  { value: 'confirmed',   label: '🟢 Potvrzeno',      border: '#2d6a4f', bg: '#e8f5e9', color: '#2d6a4f' },
  { value: 'paid',        label: '💶 Zaplaceno',      border: '#065f46', bg: '#d1fae5', color: '#065f46' },
  { value: 'cancelled',   label: '🔴 Zrušeno',        border: '#dc2626', bg: '#fee2e2', color: '#dc2626' },
];
export const statusStyle = (v) => BOOKING_STATUS.find(o => o.value === (v || '')) || BOOKING_STATUS[0];

// Stav k zobrazení (včetně „Zaplaceno“).
export const displayStatus = (it) => {
  if (!it) return '';
  if (it.cancelled) return 'cancelled';
  if (it.bookingStatus === 'confirmed' && it.paidInFull) return 'paid';
  return it.bookingStatus || '';
};

// Která pole se zapíšou na kartu při výběru stavu.
export function statusFields(it, value) {
  if (value === 'cancelled') return { cancelled: true };
  if (value === 'paid') return { cancelled: false, bookingStatus: 'confirmed', paidInFull: true };
  return { cancelled: false, bookingStatus: value, paidInFull: false };
}

const who = () => codeForEmail(auth.currentUser?.email) || auth.currentUser?.email || '';

// Pole „kdo a kdy“ pro změnu stavu (přidají se ke statusFields).
export function statusMeta(it, value, from) {
  const now = new Date().toISOString();
  const by = who();
  const entry = { at: now, by, from, fromStatus: displayStatus(it), toStatus: value };
  return {
    statusAt: now, statusBy: by, statusFrom: from,
    statusLog: [entry, ...(Array.isArray(it.statusLog) ? it.statusLog : [])].slice(0, 30),
  };
}

// Změna stavu z Realizace: v transakci se přečte aktuální nabídka a změní se
// JEN pole stavu u jedné karty — nic jiného v nabídce se nepřepíše.
export async function setItemStatus(offerId, itemId, value, from = 'Realizace') {
  const ref = doc(db, 'offers', offerId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Nabídka nenalezena');
    const items = Array.isArray(snap.data().items) ? [...snap.data().items] : [];
    const i = items.findIndex(x => String(x.id) === String(itemId));
    if (i < 0) throw new Error('Karta v nabídce nenalezena');
    const it = items[i];
    if (displayStatus(it) === value) return;
    items[i] = { ...it, ...statusFields(it, value), ...statusMeta(it, value, from) };
    tx.update(ref, { items });
  });
}

export const STATUS_FIELDS = ['bookingStatus', 'cancelled', 'paidInFull', 'statusAt', 'statusBy', 'statusFrom', 'statusLog'];

export const fmtStatusAt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
