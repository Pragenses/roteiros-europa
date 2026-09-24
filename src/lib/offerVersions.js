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
// Číslo verze = nejvyšší dosavadní číslo u téže nabídky + 1 (počítají se
// i starší verze ze zeleného tlačítka). Název verze jde při ukládání i později
// ručně změnit — třeba když klient už dostal NR1–NR4 mimo systém, první verze
// v systému se přepíše na NR5 a další pak pokračují NR6, NR7…

import { db, storage, auth } from './firebase';
import { collection, getDocs, query, where, addDoc, updateDoc, doc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL, updateMetadata } from 'firebase/storage';

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

// Číslo verze z názvu: „NR5_BALCAS…" → 5, „NR 3" → 3. Bez NR na začátku → null.
export function versionNoFromName(name) {
  const m = /^\s*NR\s*(\d+)/i.exec(String(name || ''));
  return m ? parseInt(m[1], 10) : null;
}

// Úprava názvu zadaného ručně: pryč znaky, které v názvu souboru dělají potíže,
// a na konci vždy .pdf. Háčky a podtržítka zůstávají — je to název, který
// napsal člověk.
export function cleanTypedFileName(raw) {
  let s = String(raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\.pdf$/i, '').trim();
  return s ? s + '.pdf' : '';
}

// Hlavička, podle které prohlížeč pojmenuje soubor při stažení. `inline` =
// PDF se dál otevírá v prohlížeči, jen při uložení dostane správný název.
export function contentDispositionFor(fileName) {
  const ascii = String(fileName).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// Všechna čísla verzí použitá u nabídky — nové verze i ty starší ze
// zeleného tlačítka (ty mají číslo jen v názvu, např. „NR 3").
export async function usedVersionNumbers(offerId, legacyVersions) {
  const snap = await getDocs(query(collection(db, 'offerVersions'), where('offerId', '==', offerId)));
  const nums = [];
  snap.forEach(d => {
    const n = parseInt(d.data().versionNo, 10);
    if (n > 0) nums.push(n);
  });
  (legacyVersions || []).forEach(v => {
    const n = versionNoFromName(v.label);
    if (n) nums.push(n);
  });
  return nums;
}

export async function nextVersionNo(offerId, legacyVersions) {
  const nums = await usedVersionNumbers(offerId, legacyVersions);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

// Uloží PDF + výpočet. Vrací { versionNo, fileName }.
// `fileName` je název z okna (člověk ho mohl přepsat). Číslo verze se bere
// z jeho začátku (NR5 → 5); když tam NR není, dostane verze další volné číslo,
// aby se v seznamu správně řadila.
export async function saveOfferVersion({ offer, blob, snapshot, source, fileName: typedName }) {
  const fileName = cleanTypedFileName(typedName) || versionFileName(offer, await nextVersionNo(offer.id, offer.pdfVersions));
  const versionNo = versionNoFromName(fileName) || await nextVersionNo(offer.id, offer.pdfVersions);
  const path = `offers/${offer.id}/versions/${Date.now()}_${fileName.normalize('NFD').replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, blob, { contentType: 'application/pdf', contentDisposition: contentDispositionFor(fileName) });
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

// Přejmenování uložené verze. Mění se JEN název a číslo — ceny, výpočet
// a samotné PDF zůstávají beze změny. Název ke stažení se přepíše i na
// souboru ve Storage; kdyby to selhalo, přejmenování v seznamu přesto platí.
export async function renameOfferVersion(version, newName) {
  const fileName = cleanTypedFileName(newName);
  if (!fileName) throw new Error('Název nesmí být prázdný.');
  const versionNo = versionNoFromName(fileName) || version.versionNo || null;
  await updateDoc(doc(db, 'offerVersions', version.id), {
    fileName,
    versionNo,
    renamedAt: new Date().toISOString(),
    renamedBy: auth.currentUser?.email || '',
  });
  await setDownloadName(version.pdfPath, fileName);
  return { fileName, versionNo };
}

// Nastaví název, pod kterým se PDF stáhne. Chyba se jen zapíše do konzole.
export async function setDownloadName(path, fileName) {
  if (!path) return;
  try {
    await updateMetadata(storageRef(storage, path), { contentDisposition: contentDispositionFor(fileName) });
  } catch (err) {
    console.error('Název souboru ve Storage se nepodařilo změnit:', err);
  }
}

// --- Koš ---------------------------------------------------------------------
// Smazání verzi jen přesune do koše: záznam, ceny i PDF zůstávají a verze jde
// obnovit. Číslo verze v koši zůstává obsazené, aby po obnovení nevznikly
// dvě verze se stejným NR.
export async function trashOfferVersion(version) {
  await updateDoc(doc(db, 'offerVersions', version.id), {
    deletedAt: new Date().toISOString(),
    deletedBy: auth.currentUser?.email || '',
  });
}

export async function restoreOfferVersion(version) {
  await updateDoc(doc(db, 'offerVersions', version.id), {
    deletedAt: null,
    deletedBy: null,
    restoredAt: new Date().toISOString(),
    restoredBy: auth.currentUser?.email || '',
  });
}
