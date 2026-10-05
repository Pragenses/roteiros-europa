import { db } from './firebase';
import { doc, getDoc } from 'firebase/firestore';

// Import starých akcí — KROK 2: čtení jednoho podkladu Claudem.
// Každý soubor se čte ZVLÁŠŤ. Claude vypíše jen to, co v souboru opravdu je;
// spojení údajů z více souborů dělá až krok 3.

const MODEL = 'claude-sonnet-4-6';
const MAX_PDF_MB = 25;          // limit API na jeden požadavek je 32 MB (po base64 ~ +33 %)
const MAX_TEXT_CHARS = 150000;  // ochrana proti obřím Excelům
const IMG_MAX_SIDE = 1800;      // zmenšení fotek — čitelné a levnější

// Knihovny se načítají z CDN, až když jsou potřeba (stejně jako export do Excelu).
const LIBS = {
  XLSX: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  // heic2any neuměl novější fotky z iPhonu (ERR_LIBHEIF) — heic-to má aktuální libheif.
  HeicTo: 'https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/iife/heic-to.js',
};

const loadLib = (name) => new Promise((resolve, reject) => {
  if (window[name]) { resolve(window[name]); return; }
  const s = document.createElement('script');
  s.src = LIBS[name];
  s.onload = () => (window[name] ? resolve(window[name]) : reject(new Error(`Knihovnu ${name} se nepodařilo načíst.`)));
  s.onerror = () => reject(new Error(`Knihovnu ${name} se nepodařilo načíst (internet?).`));
  document.head.appendChild(s);
});

// Chyba, kterou stránka pozná a ukáže k ní vysvětlení.
export class DownloadBlockedError extends Error {
  constructor() {
    super('Prohlížeč nedovolil stáhnout soubor zpět z úložiště.');
    this.code = 'download-blocked';
  }
}

async function getApiKey() {
  const snap = await getDoc(doc(db, 'settings', 'apiKeys'));
  return snap.exists() ? (snap.data().anthropicKey || '') : '';
}

function extractJSON(text) {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { start = i; break; }
  }
  if (start === -1) throw new Error('Claude nevrátil čitelný výsledek.');
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('Výsledek je neúplný (dokument je možná příliš dlouhý).');
}

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onloadend = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(new Error('Soubor se nepodařilo převést.'));
  r.readAsDataURL(blob);
});

async function downloadBlob(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    // Síťová chyba bez odpovědi = typicky blokace prohlížečem (CORS).
    throw new DownloadBlockedError();
  }
  if (!res.ok) throw new Error(`Soubor se nepodařilo stáhnout (${res.status}).`);
  return res.blob();
}

// Fotka → zmenšený JPEG. HEIC z iPhonu: Safari ho umí otevřít sám,
// jinde (Brave, Chrome) se nejdřív převede knihovnou heic-to.
const openImage = (blob) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(blob);
  const i = new Image();
  i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
  i.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Fotku se nepodařilo otevřít.')); };
  i.src = url;
});

async function imageToJpegBase64(blob, fileName) {
  const isHeic = /\.(heic|heif)$/i.test(fileName || '') || /heic|heif/i.test(blob.type || '');
  let img;
  try {
    img = await openImage(blob);
  } catch (e) {
    if (!isHeic) throw e;
    const HeicTo = await loadLib('HeicTo');
    let jpeg;
    try {
      jpeg = await HeicTo({ blob, type: 'image/jpeg', quality: 0.9 });
    } catch (err) {
      throw new Error('Fotku HEIC se nepodařilo převést (' + (err?.message || err) + ').');
    }
    img = await openImage(jpeg);
  }
  const scale = Math.min(1, IMG_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!out) throw new Error('Fotku se nepodařilo zmenšit.');
  return blobToBase64(out);
}

// Excel → text s adresami buněk a vzorci, aby Claude viděl, jak se čísla počítají.
// Řádek vypadá např.:  12: A=Praga | C=130 | D=260 {=C12*2}
export function sheetsToText(XLSX, wb) {
  const pad = (n) => String(n).padStart(2, '0');
  const show = (c) => {
    if (c.t === 'n' && c.z && XLSX.SSF.is_date(c.z)) {
      // Datumy vždy jako RRRR-MM-DD — jinak by Excel mohl dát americké 5/3/27 (květen? březen?).
      const p = XLSX.SSF.parse_date_code(c.v);
      if (p && p.y) return `${p.y}-${pad(p.m)}-${pad(p.d)}` + (p.H || p.M ? ` ${pad(p.H)}:${pad(p.M)}` : '');
    }
    if (c.w !== undefined && c.w !== null && String(c.w).trim() !== '') return String(c.w).trim();
    if (c.v !== undefined && c.v !== null) return String(c.v).trim();
    return '';
  };
  return wb.SheetNames.map(name => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return `=== List: ${name} === (prázdný)`;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const lines = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells = [];
      for (let col = range.s.c; col <= range.e.c; col++) {
        const addr = XLSX.utils.encode_cell({ r, c: col });
        const c = ws[addr];
        if (!c) continue;
        const val = show(c).replace(/\s+/g, ' ');
        const f = c.f ? ` {=${c.f}}` : '';
        if (!val && !f) continue;
        cells.push(`${XLSX.utils.encode_col(col)}=${val}${f}`);
      }
      if (cells.length) lines.push(`${r + 1}: ${cells.join(' | ')}`);
    }
    return `=== List: ${name} ===\n${lines.join('\n')}`;
  }).join('\n\n');
}

async function excelToText(blob) {
  const XLSX = await loadLib('XLSX');
  const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array', cellNF: true, cellFormula: true });
  return sheetsToText(XLSX, wb);
}

async function wordToText(blob) {
  const mammoth = await loadLib('mammoth');
  const r = await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  return r.value || '';
}

const PROMPT = `Jsi asistent české cestovní kanceláře (DMC), která připravuje skupinové zájezdy po Evropě pro brazilské cestovní kanceláře. Dostáváš JEDEN podklad ke staré akci, která se ještě nekonala: hotelovou smlouvu, potvrzení skupiny, kalkulaci v Excelu, nabídku pro klienta ve Wordu, e-mail, nebo fotku/scan některé z nich. Dokument může být česky, portugalsky, anglicky nebo v jiném evropském jazyce.

DŮLEŽITÁ PRAVIDLA:
- Může jít jen o JEDNU STRÁNKU delšího dokumentu. Vypiš POUZE to, co v tomto podkladu opravdu je. Nic nedomýšlej, nepočítej a nedoplňuj z obecných znalostí.
- Když tabulka nebo text zjevně pokračuje jinde, nastav "continuesElsewhere": true.
- Nejistý údaj (rozmazané číslo, nejasná měna, nejasné, zda je cena za osobu nebo za pokoj) ZAPIŠ, ale vysvětli ho v "uncertain".
- Ceny piš jako čísla bez mezer a měny (desetinná tečka), měnu zvlášť (EUR, CZK, USD, BRL, CHF, GBP, HUF, PLN, SEK…). U každé ceny uveď, k čemu se vztahuje (za osobu / za pokoj a noc / celkem…).
- U Excelu dostaneš buňky s adresou (např. "12: A=Praga | D=260 {=C12*2}"); ve složených závorkách je vzorec, kterým se číslo počítá. Vzorce použij k pochopení, co číslo znamená (cena za noc × noci, za pokoj ÷ 2 na osobu, součet, marže, kurz…) a k určení, zda jde o cenu za osobu, za pokoj a noc, nebo celkem. Co je ze vzorce jasné, už nepiš mezi nejisté. Do výsledku piš hodnoty (čísla), ne vzorce.
- Data piš YYYY-MM-DD. Když rok v podkladu chybí, napiš datum tak, jak je, a zmiň to v "uncertain".
- Údaj, který v podkladu není, vynech nebo dej "". Prázdné seznamy nech prázdné [].
- Texty "summary", "uncertain" a "notes" piš česky. Názvy hotelů, firem a míst nech tak, jak jsou v podkladu.

Vrať POUZE JSON (žádný jiný text, žádné \`\`\`) v tomto tvaru:
{
  "documentType": "hotelová smlouva | potvrzení skupiny | kalkulace | nabídka pro klienta | program | e-mail | faktura | jiné",
  "summary": "1–2 věty, co to je",
  "partialPage": false,
  "continuesElsewhere": false,
  "group": { "name": "", "client": "", "startDate": "", "endDate": "", "pax": "", "paxNote": "" },
  "itinerary": [ { "date": "", "city": "", "description": "" } ],
  "hotels": [ { "city": "", "name": "", "checkIn": "", "checkOut": "", "nights": "", "rooms": "", "priceDbl": "", "priceSgl": "", "priceBasis": "", "currency": "", "cityTax": "", "cityTaxBasis": "", "meals": "", "optionDate": "", "cancellationTerms": "", "paymentTerms": "", "foc": "", "status": "", "contact": "" } ],
  "transport": [ { "type": "", "supplier": "", "dates": "", "route": "", "price": "", "priceBasis": "", "currency": "", "notes": "" } ],
  "guides": [ { "type": "", "supplier": "", "dates": "", "city": "", "price": "", "priceBasis": "", "currency": "", "notes": "" } ],
  "services": [ { "type": "", "name": "", "city": "", "date": "", "pax": "", "price": "", "priceBasis": "", "currency": "", "notes": "" } ],
  "clientPrice": [ { "paxVariant": "", "pricePerPerson": "", "currency": "", "notes": "" } ],
  "payments": [ { "direction": "od klienta | dodavateli", "party": "", "amount": "", "currency": "", "date": "", "dueDate": "", "method": "", "notes": "" } ],
  "uncertain": [ "" ],
  "notes": ""
}`;

async function callClaude(content) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Chybí klíč k Claude API (Settings).');
  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    throw new Error('Spojení s Claude selhalo (internet?).');
  }
  const data = await response.json();
  if (data.error) throw new Error('Claude: ' + (data.error.message || 'chyba'));
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (data.stop_reason === 'max_tokens') throw new Error('Výsledek je příliš dlouhý — dokument je asi potřeba rozdělit.');
  return { result: extractJSON(text), usage: data.usage || {} };
}

// Přečte jeden soubor ze složky. entry = položka z folder.files.
export async function readImportFile(entry) {
  const blob = await downloadBlob(entry.url);
  const name = entry.name || '';
  const intro = { type: 'text', text: `Název souboru: ${name}` };
  let content;

  if (entry.kind === 'pdf') {
    if (blob.size > MAX_PDF_MB * 1024 * 1024) throw new Error(`PDF je větší než ${MAX_PDF_MB} MB — rozdělte ho prosím na menší části.`);
    const b64 = await blobToBase64(blob);
    content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, intro, { type: 'text', text: PROMPT }];
  } else if (entry.kind === 'image') {
    const b64 = await imageToJpegBase64(blob, name);
    content = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } }, intro, { type: 'text', text: PROMPT }];
  } else {
    let text;
    if (entry.kind === 'excel') {
      text = /\.csv$/i.test(name) ? await blob.text() : await excelToText(blob);
    } else if (/\.docx$/i.test(name)) {
      text = await wordToText(blob);
    } else if (/\.doc$/i.test(name)) {
      throw new Error('Starý formát Word (.doc) neumím přečíst — uložte ho prosím jako .docx nebo PDF.');
    } else if (/\.rtf$/i.test(name)) {
      throw new Error('Formát .rtf neumím přečíst — uložte ho prosím jako .docx nebo PDF.');
    } else if (entry.kind === 'text') {
      text = await blob.text();
      if (/\.html?$/i.test(name)) text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
    } else {
      throw new Error('Tento typ souboru zatím neumím přečíst.');
    }
    text = (text || '').trim();
    if (!text) throw new Error('V souboru není žádný text (jde možná o obrázek vložený do Wordu — pošlete ho jako PDF nebo fotku).');
    const cut = text.length > MAX_TEXT_CHARS;
    if (cut) text = text.slice(0, MAX_TEXT_CHARS);
    content = [{ type: 'text', text: `${intro.text}\n\nObsah souboru${cut ? ' (zkrácený, soubor je velmi dlouhý)' : ''}:\n\n${text}\n\n---\n\n${PROMPT}` }];
  }

  return callClaude(content);
}
