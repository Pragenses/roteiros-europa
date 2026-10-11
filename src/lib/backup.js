// Kompletní záloha aplikace do jednoho souboru ZIP.
//
// Obsah ZIPu:
//   CTI-MNE.txt          — popis zálohy česky
//   manifest.json        — soupis: co je v záloze, kolik záznamů, které soubory,
//                          co se nepodařilo, kdo a kdy zálohu udělal
//   data/<část>.json     — záznamy z databáze včetně podsložek (služby zakázek,
//                          přílohy služeb, přečtené dokumenty importu …).
//                          Poznámky, úkoly, Realizace, zálohy dodavatelům atd.
//                          jsou uvnitř záznamů, takže jsou v záloze s nimi.
//   files/<cesta>        — soubory z úložiště (PDF verzí, potvrzení hotelů,
//                          importy) pod svou původní cestou.
//
// Formát JSON: { collection, count, docs: { <id>: { data: {...}, sub: { <podsložka>: { <id>: {...} } } } } }
// Zvláštní hodnoty Firestore se ukládají jako { "__t": "ts" | "geo" | "ref" | "bytes" | "num", ... },
// aby je šlo při obnově vrátit přesně do původní podoby.
//
// Tato knihovna nic nemění — jen čte databázi a úložiště.

import {
  collection, collectionGroup, getDocs,
  Timestamp, GeoPoint, DocumentReference, Bytes,
} from 'firebase/firestore';
import { ref as storageRef, listAll, getMetadata, getBlob } from 'firebase/storage';
import { ZipWriter, openZip } from './zip';
import { md5Base64 } from './md5';

export const BACKUP_FORMAT = 'roteiros-europa-zaloha';
export const BACKUP_FORMAT_VERSION = 1;

// Kdo smí zálohovat (rozhodnutí Heleny 10/2026).
export const BACKUP_EMAILS = ['helena.maria.brito@gmail.com', 'filipdlask@gmail.com', 'grupos@tour-pragenses.com'];
export const canBackup = (email) => BACKUP_EMAILS.includes(String(email || '').toLowerCase());

// --- Co se zálohuje ----------------------------------------------------------
// POZOR: když aplikace začne ukládat do nové kolekce, MUSÍ se přidat sem,
// jinak v záloze chybí (aplikace sama seznam kolekcí zjistit neumí).
// subs: podsložky, které se čtou s každým záznamem (do libovolné hloubky).
// Vynecháno záměrně: offers/<id>/presence — dočasné zámky „kdo právě upravuje“.
export const DATA_PARTS = [
  { key: 'offers', label: 'Nabídky', hint: 'včetně Realizace, poznámek, úkolů, stavů a záloh dodavatelům',
    collections: [{ name: 'offers' }] },
  { key: 'offerVersions', label: 'Archiv verzí nabídek', hint: 'záznamy NR verzí se zmrazeným výpočtem (samotná PDF jsou níže mezi soubory)',
    collections: [{ name: 'offerVersions' }] },
  { key: 'orders', label: 'Zakázky', hint: 'včetně služeb, poznámek a příloh nahraných ke službám',
    collections: [{ name: 'orders', subs: { services: { documents: { chunks: {} } } } }] },
  { key: 'clients', label: 'Klienti', hint: 'včetně plateb a poznámek',
    collections: [{ name: 'clients' }] },
  { key: 'providers', label: 'Dodavatelé', collections: [{ name: 'providers' }] },
  { key: 'busCompanies', label: 'Autobusové společnosti', collections: [{ name: 'busCompanies' }] },
  { key: 'hotels', label: 'Databáze hotelů', hint: 'včetně starého archivu sloučených hotelů',
    collections: [{ name: 'hotels' }, { name: 'hotelsArchive' }] },
  { key: 'hotelCards', label: 'Karty hotelů', hint: 'včetně poznámek, propojení s nabídkami a záznamů AI kontrol a oprav (kvůli „Vrátit zpět“)',
    collections: [{ name: 'hotelCards' }, { name: 'hotelCardLinks' }, { name: 'hotelAutoFixes' }, { name: 'hotelAiAttempts' },
      { name: 'hotelMatchChecks' }, { name: 'hotelOrphanChecks' }] },
  { key: 'emailTemplates', label: 'Šablony e-mailů', collections: [{ name: 'emailTemplates' }] },
  { key: 'importFolders', label: 'Importní brána', hint: 'složky starých akcí, přečtené dokumenty, rozpracované skládání',
    collections: [{ name: 'importFolders', subs: { reads: {}, assembly: {} } }] },
  { key: 'logs', label: 'Historie a logy', hint: 'smazané záznamy (pro obnovu v Historii) a odeslané e-maily hotelům, autobusům a dodavatelům',
    collections: [{ name: 'activityLog' }, { name: 'hotelEmailLog' }, { name: 'busEmailLog' }, { name: 'providerEmailLog' }] },
  { key: 'settings', label: 'Nastavení', hint: 'kurzy měn, rozložení Dashboardu',
    collections: [{ name: 'settings', exclude: ['apiKeys'] }] },
  { key: 'apiKeys', label: 'Klíče API (Anthropic, Gemini)', sensitive: true, defaultOff: true,
    hint: 'citlivé — kdo má soubor zálohy, má i klíče. Doporučeno nechat odškrtnuté; při obnově se klíče zadají znovu v Nastavení.',
    collections: [{ name: 'settings', only: ['apiKeys'] }] },
];

export const FILE_PARTS = [
  { key: 'files_versions', label: 'PDF verzí nabídek' },
  { key: 'files_attachments', label: 'Přílohy u nabídek', hint: 'potvrzení hotelů a další nahrané soubory' },
  { key: 'files_import', label: 'Soubory importní brány', hint: 'Excely, PDF, fotky starých akcí' },
  { key: 'files_other', label: 'Ostatní soubory v úložišti', hint: 'starší soubory mimo hlavní složky' },
];

export const fileCategory = (path) => {
  if (path.startsWith('offers/_import/')) return 'files_import';
  if (/^offers\/[^/]+\/versions\//.test(path)) return 'files_versions';
  if (/^offers\/[^/]+\/confirmations\//.test(path)) return 'files_attachments';
  return 'files_other';
};

// --- Převod hodnot Firestore na JSON a zpět ----------------------------------
export function toJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { __t: 'num', v: String(v) };
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(toJson);
  if (v instanceof Timestamp) return { __t: 'ts', s: v.seconds, n: v.nanoseconds };
  if (v instanceof GeoPoint) return { __t: 'geo', lat: v.latitude, lng: v.longitude };
  if (v instanceof DocumentReference) return { __t: 'ref', path: v.path };
  if (v instanceof Bytes) return { __t: 'bytes', b64: v.toBase64() };
  if (v instanceof Date) return { __t: 'ts', s: Math.floor(v.getTime() / 1000), n: (v.getTime() % 1000) * 1e6 };
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = toJson(x);
  return o;
}

// --- Pomocníci ---------------------------------------------------------------
async function pool(items, limit, fn, signal) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      if (signal && signal.aborted) throw new DOMException('Přerušeno', 'AbortError');
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const enc = new TextEncoder();
export const formatBytes = (n) => {
  if (!n) return '0 kB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} GB`;
};

// Načte kolekci včetně podsložek. Podsložky zkusí načíst najednou (collectionGroup),
// a když to pravidla nedovolí, po jednotlivých záznamech.
async function readCollectionTree(db, spec, onDocs, signal) {
  const snap = await getDocs(collection(db, spec.name));
  const docs = {};
  const level0 = [];
  snap.forEach(d => {
    if (spec.exclude && spec.exclude.includes(d.id)) return;
    if (spec.only && !spec.only.includes(d.id)) return;
    const node = { data: toJson(d.data()) };
    docs[d.id] = node;
    level0.push({ path: d.ref.path, node });
  });
  let total = level0.length;
  let orphans = 0;
  onDocs && onDocs(total);

  // Prochází podsložky po úrovních: [{ path, node }] → jejich podsložky
  async function walk(parents, subsSpec, depth) {
    if (!subsSpec || !parents.length) return;
    for (const [subName, deeper] of Object.entries(subsSpec)) {
      if (signal && signal.aborted) throw new DOMException('Přerušeno', 'AbortError');
      const byPath = new Map(parents.map(p => [p.path, p.node]));
      const children = [];
      const attach = (d) => {
        const parentNode = byPath.get(d.ref.parent.parent ? d.ref.parent.parent.path : '');
        if (!parentNode) { orphans++; return; }
        parentNode.sub = parentNode.sub || {};
        parentNode.sub[subName] = parentNode.sub[subName] || {};
        const node = { data: toJson(d.data()) };
        parentNode.sub[subName][d.id] = node;
        children.push({ path: d.ref.path, node });
      };
      let grouped = false;
      try {
        // Jedním dotazem všechny podsložky daného jména; patří sem jen ty,
        // jejichž rodič je v této úrovni (jiné kolekce stejného jména se ignorují).
        const all = await getDocs(collectionGroup(db, subName));
        all.forEach(d => {
          const parent = d.ref.parent.parent;
          const segs = d.ref.path.split('/');
          // cesta musí mít správnou hloubku: <kolekce>/<id>/(<sub>/<id>/)*
          if (!parent || segs.length !== 2 + 2 * depth || segs[0] !== spec.name) return;
          attach(d);
        });
        grouped = true;
      } catch (e) {
        grouped = false;
      }
      if (!grouped) {
        children.length = 0;
        await pool(parents, 8, async (p) => {
          const s = await getDocs(collection(db, p.path, subName));
          s.forEach(attach);
        }, signal);
      }
      total += children.length;
      onDocs && onDocs(total);
      await walk(children, deeper, depth + 1);
    }
  }
  await walk(level0, spec.subs, 1);
  return { docs, count: level0.length, total, orphans };
}

// Projde data a najde odkazy na soubory v úložišti (pro kontrolu, že nic nechybí).
function collectStorageRefs(value, bucket, out) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const m = value.match(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?#]+)/);
    if (m && m[1] === bucket) {
      try { out.add(decodeURIComponent(m[2])); } catch (e) { /* neplatná adresa */ }
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach(v => collectStorageRefs(v, bucket, out)); return; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && /^(path|pdfPath|confirmationFilePath)$/.test(k) && v && !/^https?:/.test(v)) out.add(v);
      else collectStorageRefs(v, bucket, out);
    }
  }
}

async function listAllRecursive(dirRef, out, signal) {
  if (signal && signal.aborted) throw new DOMException('Přerušeno', 'AbortError');
  const res = await listAll(dirRef);
  res.items.forEach(i => out.push(i.fullPath));
  for (const p of res.prefixes) await listAllRecursive(p, out, signal);
}

// --- 1) Průzkum: co je v systému a jak je to velké ---------------------------
// Načte všechna data (to je rychlé) a zjistí seznam a velikosti souborů
// (soubory samotné se zatím nestahují).
export async function scanSystem({ db, storage, onProgress = () => {}, signal }) {
  const at = new Date().toISOString();
  const parts = {};
  const readCache = new Map();
  const bucket = storage.app.options.storageBucket;
  const refs = new Set();   // soubory, na které odkazují záznamy
  let docsDone = 0;
  for (const part of DATA_PARTS) {
    const p = { key: part.key, collections: {}, count: 0, total: 0, orphans: 0 };
    for (const spec of part.collections) {
      onProgress({ phase: 'data', label: part.label, docsDone });
      const cacheKey = JSON.stringify(spec);
      let res = readCache.get(cacheKey);
      if (!res) {
        const before = docsDone;
        res = await readCollectionTree(db, spec, (n) => onProgress({ phase: 'data', label: part.label, docsDone: before + n }), signal);
        readCache.set(cacheKey, res);
      }
      docsDone += res.total;
      p.collections[spec.name] = { count: res.count, total: res.total, orphans: res.orphans, docs: res.docs };
      p.count += res.count; p.total += res.total; p.orphans += res.orphans;
    }
    const payload = {
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, part: part.key, exportedAt: at,
      collections: Object.fromEntries(Object.entries(p.collections).map(([name, c]) => [name, { count: c.count, total: c.total, docs: c.docs }])),
    };
    collectStorageRefs(payload.collections, bucket, refs);
    p.json = JSON.stringify(payload);
    p.bytes = enc.encode(p.json).length;
    // docs už nepotřebujeme držet dvakrát — stačí JSON
    for (const c of Object.values(p.collections)) delete c.docs;
    parts[part.key] = p;
  }

  // Soubory v úložišti
  onProgress({ phase: 'files-list', docsDone });
  let listed = [];
  let listError = '';
  try {
    await listAllRecursive(storageRef(storage), listed, signal);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    listError = (e && (e.code || e.message)) || 'neznámá chyba';
    listed = [];
  }
  const paths = Array.from(new Set([...listed, ...refs])).sort();
  const files = [];
  const missing = [];
  let metaDone = 0;
  await pool(paths, 8, async (path) => {
    try {
      const m = await getMetadata(storageRef(storage, path));
      files.push({ path, size: Number(m.size) || 0, md5Hash: m.md5Hash || '', contentType: m.contentType || '', updated: m.updated || '', category: fileCategory(path), referenced: refs.has(path) });
    } catch (e) {
      if (e && e.code === 'storage/object-not-found') missing.push(path);
      else files.push({ path, size: 0, md5Hash: '', contentType: '', category: fileCategory(path), referenced: refs.has(path), metaError: (e && (e.code || e.message)) || 'chyba' });
    }
    metaDone++;
    onProgress({ phase: 'files-meta', done: metaDone, total: paths.length, docsDone });
  }, signal);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const fileGroups = {};
  for (const fp of FILE_PARTS) fileGroups[fp.key] = { count: 0, bytes: 0 };
  for (const f of files) { fileGroups[f.category].count++; fileGroups[f.category].bytes += f.size; }

  return { at, bucket, parts, files, fileGroups, missing, listError, docsTotal: docsDone };
}

// --- 2) Vytvoření zálohy -------------------------------------------------------
const defaultDownload = async (storage, path) => {
  const blob = await getBlob(storageRef(storage, path));
  return new Uint8Array(await blob.arrayBuffer());
};

export function backupFileName(date, partial) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `Zaloha_RoteirosEuropa_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${partial ? '_castecna' : ''}.zip`;
}

function readmeText(manifest) {
  const lines = [
    'ZÁLOHA APLIKACE ROTEIROS EUROPA',
    '',
    `Vytvořeno: ${new Date(manifest.createdAt).toLocaleString('cs-CZ')}`,
    `Vytvořil(a): ${manifest.createdBy}`,
    `Stav dat k: ${new Date(manifest.dataAt).toLocaleString('cs-CZ')}`,
    manifest.complete ? 'Záloha je ÚPLNÁ (obsahuje všechny části systému).' : 'Záloha je ČÁSTEČNÁ — obsahuje jen vybrané části (viz níže).',
    '',
    'OBSAH:',
  ];
  for (const p of manifest.parts) lines.push(`  ${p.included ? '[x]' : '[ ]'} ${p.label}${p.included ? ` — záznamů: ${p.total}` : ''}`);
  for (const g of manifest.fileParts) lines.push(`  ${g.included ? '[x]' : '[ ]'} ${g.label}${g.included ? ` — souborů: ${g.count}` : ''}`);
  if (manifest.failedFiles.length) {
    lines.push('', 'SOUBORY, KTERÉ SE NEPODAŘILO ZÁLOHOVAT:');
    manifest.failedFiles.forEach(f => lines.push(`  ${f.path} — ${f.error}`));
  }
  if (manifest.missingFiles.length) {
    lines.push('', 'ODKAZY NA SOUBORY, KTERÉ V ÚLOŽIŠTI UŽ NEJSOU (nešlo je zálohovat):');
    manifest.missingFiles.forEach(p => lines.push(`  ${p}`));
  }
  lines.push('',
    'Složka data/ obsahuje záznamy databáze (JSON), složka files/ soubory z úložiště.',
    'Obnova: v aplikaci Settings → Záloha a obnova (soubor ZIP nerozbalujte a neupravujte).',
    'Soubor uchovávejte v bezpečí — obsahuje interní údaje firmy.');
  return lines.join('\n');
}

export async function createBackup({ storage, scan, selected, user, onProgress = () => {}, signal, download }) {
  const dl = download || ((path) => defaultDownload(storage, path));
  const zip = new ZipWriter();
  const createdAt = new Date().toISOString();

  const dataParts = DATA_PARTS.map(p => ({
    key: p.key, label: p.label, included: selected.has(p.key),
    file: `data/${p.key}.json`,
    count: scan.parts[p.key].count, total: scan.parts[p.key].total,
    collections: Object.fromEntries(Object.entries(scan.parts[p.key].collections).map(([n, c]) => [n, { count: c.count, total: c.total }])),
  }));

  // Data
  for (const p of dataParts) {
    if (!p.included) continue;
    onProgress({ phase: 'zip-data', label: p.label });
    await zip.add(p.file, scan.parts[p.key].json, { compress: true });
  }

  // Soubory
  const toFetch = scan.files.filter(f => selected.has(f.category));
  const totalBytes = toFetch.reduce((s, f) => s + f.size, 0);
  let doneBytes = 0, doneCount = 0;
  const saved = [];
  const failed = [];
  await pool(toFetch, 4, async (f) => {
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal && signal.aborted) throw new DOMException('Přerušeno', 'AbortError');
      try {
        const bytes = await dl(f.path);
        if (f.size && bytes.length !== f.size) throw new Error(`nesedí velikost (${bytes.length} místo ${f.size} B)`);
        if (f.md5Hash && md5Base64(bytes) !== f.md5Hash) throw new Error('nesedí kontrolní otisk (MD5)');
        const zipPath = `files/${f.path}`;
        await zip.add(zipPath, bytes, { compress: false });
        saved.push({ path: f.path, zipPath, size: bytes.length, md5Hash: f.md5Hash, contentType: f.contentType, category: f.category, updated: f.updated || '' });
        lastErr = '';
        break;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = (e && (e.code || e.message)) || 'chyba';
      }
    }
    if (lastErr) failed.push({ path: f.path, category: f.category, error: lastErr });
    doneCount++; doneBytes += f.size;
    onProgress({ phase: 'files', done: doneCount, total: toFetch.length, doneBytes, totalBytes });
  }, signal);
  saved.sort((a, b) => a.path.localeCompare(b.path));

  const fileParts = FILE_PARTS.map(g => ({
    key: g.key, label: g.label, included: selected.has(g.key),
    count: saved.filter(f => f.category === g.key).length,
    expected: scan.fileGroups[g.key].count,
  }));
  const allIncluded = DATA_PARTS.every(p => p.defaultOff || selected.has(p.key)) && FILE_PARTS.every(g => selected.has(g.key));
  const manifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: 'Roteiros Europa',
    projectId: storage.app.options.projectId,
    bucket: scan.bucket,
    createdAt,
    dataAt: scan.at,
    createdBy: user || '',
    complete: allIncluded && failed.length === 0,
    parts: dataParts,
    fileParts,
    files: saved,
    failedFiles: failed,
    missingFiles: scan.missing,
    storageListError: scan.listError || '',
    skipped: ['offers/<id>/presence — dočasné zámky „kdo právě upravuje“ (nemají smysl obnovovat)'],
  };
  await zip.add('manifest.json', JSON.stringify(manifest, null, 1), { compress: true });
  await zip.add('CTI-MNE.txt', readmeText(manifest), { compress: false });
  onProgress({ phase: 'finish' });
  const blob = zip.finish();
  return { blob, manifest, fileName: backupFileName(createdAt, !allIncluded) };
}

// --- 3) Kontrola hotové zálohy ------------------------------------------------
// Otevře ZIP znovu, rozbalí každý soubor a ověří kontrolní součty, počty záznamů
// a velikosti souborů. Vrací { ok, problems: [], manifest }.
export async function verifyBackup(blob, { onProgress = () => {} } = {}) {
  const problems = [];
  const z = await openZip(blob);
  let manifest;
  try { manifest = JSON.parse(await z.readText('manifest.json')); }
  catch (e) { return { ok: false, problems: ['Chybí nebo je poškozený soupis zálohy (manifest.json).'], manifest: null }; }
  if (manifest.format !== BACKUP_FORMAT) problems.push('Soubor není záloha aplikace Roteiros Europa.');

  const countDocs = (docs) => {
    let n = 0;
    for (const node of Object.values(docs || {})) {
      n++;
      for (const sub of Object.values(node.sub || {})) n += countDocs(sub);
    }
    return n;
  };
  const parts = (manifest.parts || []).filter(p => p.included);
  let i = 0;
  for (const p of parts) {
    onProgress({ phase: 'verify', done: i++, total: parts.length + (manifest.files || []).length });
    try {
      const j = JSON.parse(await z.readText(p.file));
      for (const [name, c] of Object.entries(p.collections || {})) {
        const got = j.collections && j.collections[name];
        if (!got) { problems.push(`${p.label}: chybí ${name}.`); continue; }
        const n = Object.keys(got.docs || {}).length;
        const t = countDocs(got.docs);
        if (n !== c.count || t !== c.total) problems.push(`${p.label} (${name}): nesedí počet záznamů (${n}/${t} místo ${c.count}/${c.total}).`);
      }
    } catch (e) {
      problems.push(`${p.label}: ${e.message}`);
    }
  }
  for (const f of manifest.files || []) {
    onProgress({ phase: 'verify', done: i++, total: parts.length + manifest.files.length });
    try {
      const bytes = await z.read(f.zipPath);
      if (bytes.length !== f.size) problems.push(`${f.path}: nesedí velikost.`);
    } catch (e) {
      problems.push(`${f.path}: ${e.message}`);
    }
  }
  return { ok: problems.length === 0, problems, manifest, entries: z.entries.length };
}
