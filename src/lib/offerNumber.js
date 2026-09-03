// Číslo nabídky, např. AN-27001
//   AN  = dvouznakový kód klienta (pole `code` u klienta)
//   27  = poslední dvojčíslí roku, kdy skupina JEDE (ne kdy nabídka vznikla)
//   001 = pořadí v rámci JEDNOHO klienta a JEDNOHO roku
//
// Pravidla dohodnutá s Filipem:
//   - číslo vznikne samo, jakmile má nabídka klienta (s kódem) i termín
//   - jakmile jednou vznikne, UŽ SE NIKDY NEMĚNÍ — ani když se skupina
//     přesune do jiného roku, ani když se klientovi změní kód. Číslo je
//     v tu chvíli už rozeslané v e-mailech a přečíslování by rozbilo
//     dohledatelnost komunikace.
//   - bez klienta nebo bez termínu číslo nevznikne.

import { db } from './firebase';
import { collection, getDocs, doc, getDoc, updateDoc } from 'firebase/firestore';

export function normalizeClientCode(raw) {
  return String(raw || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '')
    .slice(0, 2);
}

// Z data ve tvaru YYYY-MM-DD udělá dvojčíslí roku. Cokoliv jiného => ''.
export function yearTwoDigits(startDate) {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(startDate || ''));
  return m ? m[1].slice(2) : '';
}

// Najde nejvyšší dosud použité pořadí pro daný kód+rok a vrátí následující.
export function nextOfferNumber(code, year2, existingNumbers) {
  const prefix = code + '-' + year2;
  const re = new RegExp('^' + prefix + '(\\d{3})$');
  let max = 0;
  (existingNumbers || []).forEach(n => {
    const m = re.exec(String(n || '').toUpperCase().trim());
    if (m) {
      const seq = parseInt(m[1], 10);
      if (seq > max) max = seq;
    }
  });
  return prefix + String(max + 1).padStart(3, '0');
}

// Přiřadí nabídce číslo, pokud ho ještě nemá a pokud na něj má z čeho.
// Vrací číslo, nebo '' když ho zatím nelze složit.
export async function ensureOfferNumber(offerId, offerData) {
  if (!offerId) return '';
  const existing = String(offerData?.offerNumber || '').trim();
  if (existing) return existing;               // jednou přidělené se nemění

  const clientId = offerData?.clientId;
  const year2 = yearTwoDigits(offerData?.startDate);
  if (!clientId || !year2) return '';

  const cliSnap = await getDoc(doc(db, 'clients', clientId));
  const code = normalizeClientCode(cliSnap.exists() ? cliSnap.data().code : '');
  if (code.length !== 2) return '';            // klient zatím nemá kód

  const offSnap = await getDocs(collection(db, 'offers'));
  const used = offSnap.docs.map(d => d.data().offerNumber).filter(Boolean);

  const number = nextOfferNumber(code, year2, used);
  await updateDoc(doc(db, 'offers', offerId), { offerNumber: number });
  return number;
}
