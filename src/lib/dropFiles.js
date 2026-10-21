// ─────────────────────────────────────────────────────────────────────────────
// Soubory z přetažení (drag & drop) a ze schránky (Cmd+V).
//
// Přetáhnout jde soubor z Finderu i přílohu z pošty. Webová pošta (Gmail,
// Outlook na webu) někdy místo souboru pošle jen odkaz ke stažení
// („DownloadURL“) — ten se zkusí stáhnout.
// ─────────────────────────────────────────────────────────────────────────────

export const dragHasFiles = (e) => {
  const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
  return types.includes('Files') || types.includes('DownloadURL') || types.includes('text/uri-list');
};

export async function filesFromDrop(e) {
  const dt = e.dataTransfer;
  if (!dt) return [];
  let files = Array.from(dt.files || []);
  if (!files.length && dt.items) {
    files = Array.from(dt.items).filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
  }
  if (files.length) return files;
  const downloadUrl = dt.getData('DownloadURL');
  if (downloadUrl) {
    try {
      // Formát „typ/souboru:název:adresa“
      const a = downloadUrl.indexOf(':');
      const b = downloadUrl.indexOf(':', a + 1);
      const name = b > -1 ? downloadUrl.slice(a + 1, b) : 'priloha';
      const url = b > -1 ? downloadUrl.slice(b + 1) : downloadUrl;
      const resp = await fetch(url);
      const blob = await resp.blob();
      return [new File([blob], name, { type: blob.type })];
    } catch (err) {
      console.error('Přílohu z pošty se nepodařilo stáhnout:', err);
    }
  }
  return [];
}

// Soubor vložený ze schránky (snímek obrazovky, zkopírované PDF).
// Když schránka obsahuje i text (zkopírovaný e-mail, Word), vloží se text jako
// dosud — soubor se bere jen tehdy, když jde o samotný obrázek / PDF.
export function filesFromPaste(e) {
  const cd = e.clipboardData;
  if (!cd) return [];
  // Soubor zkopírovaný ve Finderu má jako text jen svůj název — ten nevadí.
  const text = String(cd.getData('text/plain') || '').trim();
  if (text && !/^[^\n]{1,255}\.(pdf|png|jpe?g|gif|webp|heic|tiff?)$/i.test(text)) return [];
  const items = Array.from(cd.items || []);
  return items.filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
}
