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

async function readWorkbook(blob) {
  const XLSX = await loadLib('XLSX');
  const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array', cellNF: true, cellFormula: true });
  return { XLSX, wb };
}

async function excelToText(blob) {
  const { XLSX, wb } = await readWorkbook(blob);
  return sheetsToText(XLSX, wb);
}

// Číselné hodnoty buněk (u vzorců výsledek uložený Excelem):
// [{ name: 'List1', values: { F8: 186, ... } }] — aplikace podle nich ověřuje karty.
export function sheetsToCells(wb) {
  return wb.SheetNames.map(name => {
    const ws = wb.Sheets[name] || {};
    const values = {};
    Object.keys(ws).forEach(addr => {
      if (addr[0] === '!') return;
      const c = ws[addr];
      if (c && c.t === 'n' && typeof c.v === 'number' && isFinite(c.v)) values[addr] = c.v;
    });
    return { name, values };
  });
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
- U Excelu jsou prázdné řádky a buňky vynechané schválně — chybějící čísla řádků neznamenají, že dokument pokračuje jinde.
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

// stream = true: odpověď se přebírá průběžně (dlouhé sestavení nevyprší a vidíme postup).
async function callClaude(content, maxTokens = 8000, { stream = false, onProgress } = {}) {
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
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, stream, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    throw new Error('Spojení s Claude selhalo (internet?).');
  }
  if (!stream || !response.ok || !response.body) {
    const data = await response.json();
    if (data.error) throw new Error('Claude: ' + (data.error.message || 'chyba'));
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (data.stop_reason === 'max_tokens') throw new Error('Výsledek je příliš dlouhý — dokument je asi potřeba rozdělit.');
    return { result: extractJSON(text), usage: data.usage || {} };
  }
  const { text, stopReason, usage } = await readStream(response.body, onProgress);
  if (stopReason === 'max_tokens') throw new Error('Výsledek je příliš dlouhý ani po zvýšení limitu — podklady je asi potřeba rozdělit.');
  return { result: extractJSON(text), usage };
}

// Čte průběžnou odpověď (server-sent events) a skládá text.
export async function readStream(body, onProgress) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', stopReason = '';
  const usage = {};
  const handle = (ev) => {
    if (ev.type === 'message_start' && ev.message && ev.message.usage) Object.assign(usage, ev.message.usage);
    else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
      text += ev.delta.text;
      if (onProgress) onProgress(text.length);
    } else if (ev.type === 'message_delta') {
      if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
      if (ev.usage) Object.assign(usage, ev.usage);
    } else if (ev.type === 'error') {
      throw new Error('Claude: ' + ((ev.error && ev.error.message) || 'chyba při přenosu'));
    }
  };
  const flush = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch (e) { continue; }
      handle(ev);
    }
  };
  for (;;) {
    let r;
    try { r = await reader.read(); } catch (e) { throw new Error('Spojení s Claude se přerušilo — zkuste to prosím znovu.'); }
    if (r.done) break;
    buf += decoder.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
  }
  buf += decoder.decode();
  if (buf.trim()) flush(buf);
  if (!stopReason) throw new Error('Odpověď od Clauda nedorazila celá — zkuste to prosím znovu.');
  return { text, stopReason, usage };
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

// ─────────────────────────────────────────────────────────────────────────────
// KROK 3a: sestavení návrhu nabídky ze všech přečtených podkladů složky.
// Výsledek je v TVARU APLIKACE (karty nabídky), aby ho krok 3b mohl spočítat
// stejným výpočtem jako nabídka a porovnat s prodanými cenami.

const ASSEMBLY_PROMPT = `Jsi asistent české DMC. Ze všech přečtených podkladů jedné staré akce (už prodané, cestuje se v budoucnu) sestav NÁVRH NABÍDKY v přesném tvaru jejich aplikace. Ceny jsou PRODANÉ a nesmí se změnit — tvým úkolem je je PŘEVÉST tak, aby výpočet aplikace dal na cent stejné konečné ceny jako kalkulace v podkladech.

JAK APLIKACE POČÍTÁ (musíš to přesně respektovat):
- Karta "hotel": pricePerNightDbl = cena DBL POKOJE za noc, pricePerNightSngl = cena SGL pokoje za noc, cityTax = city tax za DBL POKOJ a noc, cityTaxSngl = city tax za SGL pokoj a noc, nights = počet nocí.
  Na osobu v DBL aplikace počítá: (pricePerNightDbl + cityTax) × nights ÷ 2.  Na osobu v SGL: (pricePerNightSngl + cityTaxSngl) × nights.
  PŘEPOČET CITY TAX: cityTax (DBL pokoj = 2 osoby) = 2 × city tax na osobu a noc. cityTaxSngl (SGL pokoj = 1 osoba) = city tax na osobu a noc — u SGL NIKDY nezdvojnásobuj. Když kalkulace v podkladech počítá city tax ZA OSOBU v DBL (nedělí ho dvěma), zapiš cityTax jako DVOJNÁSOBEK té částky za noc, aby po vydělení dvěma vyšla přesně stejná částka. Když je city tax procentem z ceny pokoje, spočítej číslo. Vždy tak, aby částka na osobu za celý pobyt seděla s kalkulací (DBL i SGL zvlášť). Postup přepočtu stručně popiš v "conversionNote".
- Karta "ticket" (vstupenky, večeře, jídla, lodě, vlaky — cokoliv za osobu): costDbl = částka na osobu v DBL za celou akci, costSngl = částka na osobu v SGL (obvykle stejná).
- Karta "group" (autobus, průvodce, cokoliv placené za celou skupinu): groupCost = celková částka za skupinu. Každý průvodce / každá služba je samostatná karta.
- Karta "guide_hotel" (ubytování průvodce/tour leadera): aplikace automaticky počítá součet SGL na osobu ze VŠECH hotelů i ticket karet. Vytvoř ji JEN tehdy, když ji kalkulace má jako samostatný náklad skupiny. Tour leader, který jede jako volné místo (FOC), NENÍ karta guide_hotel — to řeší focCount/focType.
- Karta "driver_hotel" (ubytování řidiče): aplikace automaticky počítá součet SGL ZA HOTELY (bez ticket karet — tedy bez večeří, vstupenek).
  Když kalkulace počítá ubytování řidiče/průvodce jinak než aplikace automaticky (např. včetně večeří), vyplň guideOverride přesnou částkou z kalkulace a vysvětli v conversionNote.
- enabled = true JEN pro karty, které jsou v ceně PRODANÉ varianty (viz níže). false pro alternativy, hotely mimo výpočet, služby za příplatek nebo „não incluído" a služby, které prodaná varianta neobsahuje (zůstanou jako karty, ale nepočítají se; důvod stručně do notes).
- Konečná cena na osobu v DBL pro každou variantu počtu osob (pax): (součet group karet ÷ pax + součet na osobu v DBL ze všech hotel a ticket karet) × (1 + margin/100) + FOC podíl.
  FOC podíl = (součet na osobu v DBL ze všech hotel a ticket karet × focCount) ÷ pax, přičtený AŽ PO marži. focType "dbl" (nebo "sngl", když kalkulace bere FOC ze SGL). Když kalkulace FOC nemá, focCount = 0.
- Měny: currency u každé karty (EUR, CZK, CHF, GBP…).

KONTROLNÍ ČÁSTKY (velmi důležité — aplikace podle nich sama ověří každou kartu):
- NEJDŮLEŽITĚJŠÍ jsou ADRESY BUNĚK: do "refDbl", "refSngl" a "refGroup" napiš přesné adresy buněk Excelu, jejichž SOUČET dává kontrolní částku (např. refDbl "F8+F9", refSngl "G8+G9", refGroup "C53"). Jen adresy spojené znakem +, nic jiného (žádné vzorce, čísla ani text). Název listu jen když má Excel víc listů ("List1!F8"). Když je Excelů víc, napiš do "refFile" název souboru. Aplikace si hodnoty z buněk přečte sama a podle nich kartu zkontroluje.
- U každé karty "hotel" a "ticket" vyplň expectedDbl = kolik ta položka v kalkulaci stojí NA OSOBU V DBL za celý pobyt / celou akci (u hotelu VČETNĚ city tax), a expectedSngl = totéž na osobu v SGL. Opiš/sečti přesně čísla z kalkulace (např. buňky F a G), NE z tvého přepočtu.
- U karet "group", "guide_hotel", "driver_hotel" vyplň expectedGroup = celková částka té položky v kalkulaci.
- U karet, které nejsou v kalkulaci (alternativy, enabled=false), kontrolní částky nevyplňuj.

POROZUMĚNÍ TEXTU A VARIANTY CEN (velmi důležité):
- Původní text Wordů, e-mailů a textových souborů dostáváš CELÝ. Čti nadpisy a popisky u cen (často portugalsky, např. „PREÇO COM TRANSPORTE…", „PREÇO SEM TRANSPORTE, SEM ESTACIONAMENTO, SEM QUARTO PARA MOTORISTA…", „sem gorjeta", „não inclui…") a pochop, co každá sada cen obsahuje a co ne.
- Každou sadu konečných cen (z nabídky pro klienta i z kalkulace) zapiš do "priceVariants" ZVLÁŠŤ: doslovný popisek z dokumentu, česky co obsahuje / neobsahuje, ceny. Sady cen NIKDY nesměšuj.
- Kalkulace v Excelu může počítat jinou variantu (např. s dopravou), než jaká se klientovi prodala (např. bez dopravy). Rozhoduje, co se klientovi nabídlo a prodalo — obvykle nabídka pro klienta (Word/PDF/e-mail). Prodanou variantu nastav v "soldVariant" a důvod stručně v "soldVariantReason". Nabídka pro klienta s několika variantami SAMA NEŘÍKÁ, kterou si klient vybral — a to, že kalkulace počítá jednu z nich, také ne. Jistá je varianta jen tehdy, když to dokládá potvrzení klienta, objednávka, faktura/záloha nebo výslovný text. Jinak začni důvod slovem „Nejisté:" (člověk to potvrdí).
- U každé karty vyplň "variants" = seznam id variant cen, ve kterých je služba v ceně (např. autobus jen ["B"], hotely ["A","B"]). U alternativ a služeb mimo cenu nech []. Aplikace podle toho při výběru varianty karty sama zaškrtne / odškrtne.
- Pozor na význam sloupců kalkulace: ověř ho ze vzorců (např. jeden sloupec může být cena bez podílu FOC a další s ním). Nepřebírej význam jen podle pořadí.
- KARTY SESTAV PRO PRODANOU VARIANTU: služby, které prodaná varianta neobsahuje (např. autobus, ubytování a strava řidiče, parkování u varianty bez dopravy), vytvoř jako karty s enabled=false a do notes napiš „není v prodané variantě". Kontrolní částky u nich vyplň z kalkulace.
- SGL: když nabídka pro klienta uvádí příplatek za SGL (např. „suplemento por sngl 840"), vyplň finalSngl = finalDbl + příplatek (v soldPrices i v priceVariants). Když je příplatek uveden jen obecně nebo jen u jiné varianty, použij ho a přidej do "observations" bod k ověření.
- Ceny pro klienta bývají zaokrouhlené nahoru (na celé euro nebo na 5). Do "soldPrices" opiš ceny prodané varianty přesně tak, jak byly klientovi nabídnuty. Aplikace sama pozná, že jde o zaokrouhlení.

PRAVIDLA:
- JEDNA KARTA = JEDNA SKUTEČNÁ SLUŽBA. Nikdy nevytvářej druhou „opravnou" kopii karty. Když si nejsi jistý přepočtem, vyplň kartu nejlépe, jak umíš — aplikace ji porovná s kontrolními částkami.
- Údaje z podkladů, které patří k JINÉ akci (jiná skupina, jiný termín, jiný klient), do návrhu NEZAPOČÍTÁVEJ a uveď je v "otherEventFiles".
- Když si podklady odporují (jiná cena, jiné datum, jiný počet nocí), použij hodnotu z kalkulace (podle ní se prodávalo), ale rozpor uveď v "conflicts" se všemi hodnotami a soubory.
- Do "soldPrices" opiš PRODANÉ konečné ceny na osobu (jen prodaná varianta) přesně z podkladů (nepočítej je).
- Do "observations" uveď věci, které vypadají jako chyba nebo nejasnost v původní kalkulaci (např. city tax započítaný dvakrát, nekonzistentní dělení), s návrhem opravy. NIC z toho do karet nepromítej — karty musí odpovídat prodané kalkulaci.
- Čísla piš jako čísla (desetinná tečka), přesně, bez zaokrouhlování (klidně 4 desetinná místa). Data YYYY-MM-DD.
- header.name: název skupiny/akce bez čísel verzí a interních označení (např. bez "NR4").
- clientName: vyber PŘESNĚ jeden název ze seznamu existujících klientů, pokud odpovídá; jinak napiš název z podkladů a clientMatched = false.
- Texty (conversionNote, notes, observations, conflicts, summary) piš česky.

STRUČNOST (výsledek má omezenou délku — piš úsporně):
- summary max 2 věty. conversionNote a notes max 1 krátká věta, nebo prázdné.
- observations max 8 bodů: issue max 2 věty, proposal max 1 věta. Nerozepisuj výpočty krok za krokem.
- conflicts jen podstatné rozdíly (max 10).

Vrať POUZE JSON (žádný jiný text):
{
  "summary": "1–2 věty",
  "header": { "name": "", "clientName": "", "clientMatched": true, "startDate": "", "endDate": "", "paxList": "20,25,30,35", "margin": 15, "focCount": 1, "focType": "dbl", "destinations": "" },
  "items": [
    { "kind": "hotel | ticket | group | guide_hotel | driver_hotel", "enabled": true, "city": "", "name": "", "dateFrom": "", "dateTo": "", "nights": "",
      "pricePerNightDbl": "", "pricePerNightSngl": "", "cityTax": "", "cityTaxSngl": "", "costDbl": "", "costSngl": "", "groupCost": "", "guideOverride": "",
      "expectedDbl": "", "expectedSngl": "", "expectedGroup": "", "refDbl": "", "refSngl": "", "refGroup": "", "refFile": "", "variants": [],
      "currency": "EUR", "conversionNote": "", "notes": "", "sourceFiles": [""] }
  ],
  "priceVariants": [ { "id": "A", "label": "doslovný popisek z dokumentu", "meaning": "česky: co obsahuje a neobsahuje", "sourceFile": "", "prices": [ { "pax": 20, "finalDbl": 0, "finalSngl": "", "currency": "EUR" } ] } ],
  "soldVariant": "A",
  "soldVariantReason": "",
  "soldPrices": [ { "pax": 20, "finalDbl": 0, "finalSngl": "", "currency": "EUR", "sourceFile": "" } ],
  "otherEventFiles": [ { "fileName": "", "reason": "" } ],
  "conflicts": [ { "topic": "", "values": [ { "value": "", "fileName": "" } ], "used": "" } ],
  "observations": [ { "topic": "", "issue": "", "proposal": "" } ]
}`;

// reads: [{ fileName, kind, result }], sourceTexts: [{ fileName, kind, text }], clientNames: [string]
// sourceTexts = celé původní texty (Excel se vzorci, Word, e-maily), aby Claude
// rozuměl popiskům cen a variantám — ne jen výtahu z kroku 2.
export async function assembleOffer({ reads, sourceTexts, clientNames, onProgress }) {
  const parts = [];
  parts.push(`EXISTUJÍCÍ KLIENTI:\n${clientNames.join('\n') || '(žádní)'}`);
  for (const x of sourceTexts) {
    const title = x.kind === 'excel'
      ? `KALKULACE (Excel) — ${x.fileName} — buňky se vzorci; prázdné řádky a buňky jsou vynechané schválně`
      : `PŮVODNÍ TEXT DOKUMENTU — ${x.fileName}`;
    parts.push(`=== ${title} ===\n${x.text.slice(0, MAX_TEXT_CHARS)}`);
  }
  for (const r of reads) {
    parts.push(`=== PŘEČTENÝ PODKLAD — ${r.fileName} (${r.kind}) ===\n${JSON.stringify(r.result)}`);
  }
  const content = [{ type: 'text', text: `${parts.join('\n\n')}\n\n---\n\n${ASSEMBLY_PROMPT}` }];
  return callClaude(content, 32000, { stream: true, onProgress });
}

// Původní text souboru pro sestavení: Excel (se vzorci + hodnoty buněk), Word .docx, textové soubory.
// Vrací { text, cells } (cells jen u Excelu), u PDF a fotek null — ty jdou do sestavení jen jako přečtený výtah.
export async function sourceTextFor(entry) {
  const name = entry.name || '';
  const isExcel = entry.kind === 'excel';
  const isDocx = /\.docx$/i.test(name);
  const isPlain = entry.kind === 'text' && /\.(txt|eml|html?|md)$/i.test(name);
  if (!isExcel && !isDocx && !isPlain) return null;
  const blob = await downloadBlob(entry.url);
  if (isExcel) {
    if (/\.csv$/i.test(name)) return { text: await blob.text(), cells: null };
    const { XLSX, wb } = await readWorkbook(blob);
    return { text: sheetsToText(XLSX, wb), cells: sheetsToCells(wb) };
  }
  if (isDocx) return { text: await wordToText(blob), cells: null };
  let text = await blob.text();
  if (/\.html?$/i.test(name)) text = text.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  return { text, cells: null };
}
