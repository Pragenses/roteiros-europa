// Verze nabídky — archiv toho, co přesně odešlo klientovi.
//
// Každá uložená verze je jeden dokument v kolekci `offerVersions` (ne uvnitř
// nabídky). Důvody:
//   - nabídka je přes sdílený odkaz veřejně čitelná, a verze obsahuje interní
//     náklady a marži — ta se ven dostat nesmí;
//   - archiv nabídek (menu) potřebuje projít verze všech nabídek najednou;
//   - dokument nabídky tím nenarůstá.
//
// Verze obsahuje:
//   - PDF soubor (ve Firebase Storage) — přesně ten, který se stáhl klientovi;
//   - „zmrazený" výpočet — čísla v okamžiku uložení. Pozdější úprava nabídky
//     ani změna vzorce ve výpočtu starou verzi NEPŘEPÍŠE. Náhled a porovnání
//     verzí se vždy kreslí z těchto uložených čísel, nikdy se nepřepočítávají.
//
// Číslo verze = nejvyšší dosavadní číslo u téže nabídky + 1. Smazané verze se
// (až bude mazání) jen označí, aby se jejich číslo nikdy znovu nepoužilo.

import { db, storage, auth } from './firebase';
import { collection, getDocs, query, where, addDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

// Pro název souboru: bez háčků a čárek, bez znaků, které v názvu souboru
// dělají potíže (/ \ : * ? " < > | a podtržítko, které odděluje části).
// Mezery zůstávají, aby se název dobře četl.
const clean = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[\\/:*?"<>|_\u0000-\u001f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// NR1_BALCAS SOCAL_AN-27001_2027.pdf
//   NR1          = pořadí verze
//   BALCAS SOCAL = název skupiny (nabídky)
//   AN-27001     = číslo nabídky (když ještě není, vynechá se)
//   2027         = rok, kdy skupina jede (když chybí termín, vynechá se)
export function versionFileName(offer, versionNo) {
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(offer.startDate || ''));
  const parts = [
    `NR${versionNo}`,
    clean(offer.name) || 'oferta',
    clean(offer.offerNumber),
    m ? m[1] : '',
  ].filter(Boolean);
  return parts.join('_') + '.pdf';
}

export async function nextVersionNo(offerId) {
  const snap = await getDocs(query(collection(db, 'offerVersions'), where('offerId', '==', offerId)));
  let max = 0;
  snap.forEach(d => {
    const n = parseInt(d.data().versionNo, 10);
    if (n > max) max = n;
  });
  return max + 1;
}

// Uloží PDF + výpočet. Vrací { versionNo, fileName }.
// Číslo verze se zjišťuje znovu až těsně před uložením, ne už při otevření
// okna — kdyby mezitím uložil verzi někdo jiný, dostane tahle další číslo.
export async function saveOfferVersion({ offer, blob, snapshot, source }) {
  const versionNo = await nextVersionNo(offer.id);
  const fileName = versionFileName(offer, versionNo);
  const path = `offers/${offer.id}/versions/${Date.now()}_${fileName.replace(/\s+/g, '-')}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType: 'application/pdf' });
  const pdfUrl = await getDownloadURL(fileRef);

  await addDoc(collection(db, 'offerVersions'), {
    offerId: offer.id,
    offerName: offer.name || '',
    offerNumber: offer.offerNumber || '',
    clientId: offer.clientId || '',
    clientName: offer.clientName || '',
    startDate: offer.startDate || '',
    versionNo,
    fileName,
    pdfUrl,
    pdfPath: path,
    source, // 'pdf' = hnědé tlačítko, 'print' = Imprimir
    createdAt: new Date().toISOString(),
    createdBy: auth.currentUser?.email || '',
    snapshot,
  });
  return { versionNo, fileName };
}
