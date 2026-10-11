// ─────────────────────────────────────────────────────────────────────────────
// AI PRO KARTY HOTELŮ — etapa 2a: doplnění chybějících názvů.
//
// Každá adresa se ověří na internetu chytřejším modelem (Sonnet). Výsledek je
// "jistý" jen s odkazem na stránku, která hotel potvrzuje. (Levný odhad jen
// z adresy se v praxi neosvědčil a správnost má přednost před cenou.)
//
// Každé volání vrací i cenu v Kč spočtenou z údajů, které posílá Anthropic
// (počet tokenů a hledání), takže útrata se dá hlídat limitem.
// Ceny: https://platform.claude.com/docs/en/about-claude/pricing (10/2026)
// ─────────────────────────────────────────────────────────────────────────────
import { db } from './firebase';
import { doc, getDoc } from 'firebase/firestore';
import { isPortalEmail } from './hotelLinks';

export const MODEL_FAST = 'claude-haiku-5-5';
export const MODEL_FALLBACK = 'claude-sonnet-5';
// Pojistka, kdyby účet Sonnet 5 neměl k dispozici: model, který aplikace
// už dnes používá jinde (src/lib/ai.js).
const MODEL_LAST = 'claude-sonnet-4-6';

// USD za milion tokenů (vstup / výstup).
const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50 },
  'claude-sonnet-5':  { in: 2,    out: 10 },
  'claude-sonnet-4-6': { in: 3,   out: 15 },
};
const WEB_SEARCH_USD = 0.01;   // 10 USD za 1 000 hledání
export const USD_CZK = 23;     // orientační kurz pro hlídání limitu

async function getApiKey() {
  const snap = await getDoc(doc(db, 'settings', 'apiKeys'));
  return snap.exists() ? (snap.data().anthropicKey || '') : '';
}

export function costCzk(model, usage = {}) {
  const p = PRICES[model] || PRICES[MODEL_FALLBACK];
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const usd = inTok / 1e6 * p.in
    + (usage.output_tokens || 0) / 1e6 * p.out
    + (usage.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;
  return usd * USD_CZK;
}

// První úplná JSON hodnota v textu (model občas přidá větu navíc).
// Najde v textu JSON. Zkouší každé místo, kde může začínat, a vezme největší
// platný objekt — text mezi hledáními na webu může obsahovat závorky.
function balancedAt(text, start) {
  const open = text[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
function extractJSON(text) {
  let best = null, bestLen = 0, sawStart = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    sawStart = true;
    const chunk = balancedAt(text, i);
    if (!chunk || chunk.length <= bestLen) continue;
    try { best = JSON.parse(chunk); bestLen = chunk.length; i += chunk.length - 1; } catch (e) { /* zkusit další začátek */ }
  }
  if (best !== null) return best;
  throw new Error(sawStart ? 'Odpověď AI je neúplná' : 'V odpovědi AI chybí data');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callOnce({ model, prompt, web, maxTokens, maxSearches }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Chybí klíč k AI (Settings → Anthropic API key).');
  const messages = [{ role: 'user', content: prompt }];
  const content = [];
  let cost = 0, stopReason = '';
  // Dlouhé hledání na webu může AI „pozastavit“ (pause_turn) — pak se pošle
  // rozpracovaná odpověď zpět a AI pokračuje (nejvýš 3×).
  for (let round = 0; round < 4; round++) {
    const body = { model, max_tokens: maxTokens, messages };
    if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches || 3 }];
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      const err = new Error(data.error.message || 'Chyba AI');
      err.kind = data.error.type || '';
      err.status = res.status;
      err.cost = cost;
      throw err;
    }
    cost += costCzk(model, data.usage || {});
    content.push(...(data.content || []));
    stopReason = data.stop_reason || '';
    if (stopReason !== 'pause_turn') break;
    messages.splice(1, messages.length - 1, { role: 'assistant', content: [...content] });
  }
  // Odpověď s hledáním na webu přijde rozdělená na víc kousků (kvůli odkazům na
  // zdroje) — kousky se spojí BEZ oddělovače. Bere se jen text po posledním
  // hledání (před ním AI jen popisuje, co hledá).
  let lastTool = -1;
  content.forEach((b, i) => { if (b.type !== 'text') lastTool = i; });
  const tail = content.slice(lastTool + 1).filter(b => b.type === 'text').map(b => b.text).join('');
  const all = content.filter(b => b.type === 'text').map(b => b.text).join('');
  let json = null;
  try { json = extractJSON(tail); } catch (e) { try { json = extractJSON(all); } catch (e2) { json = null; } }
  return { json, cost, model, stopReason };
}

// Volání s pojistkami: při přetížení počká a zkusí znovu; když levný model
// nějakou funkci nepodporuje, použije dražší (Sonnet).
// Když levný model nějakou funkci odmítne, zapamatuje se to a další volání
// stejného druhu jdou rovnou na Sonnet (bez zbytečného neúspěšného pokusu).
const useFallback = { web: false, plain: false, last: false };

// Společná pauza při limitu AI účtu: když jedno volání narazí na limit,
// počkají všechna (jinak by se navzájem dál zahlcovala).
let pauseUntil = 0;
let statusListener = null;
export const setAiStatusListener = (fn) => { statusListener = fn; };
const waitForPause = async () => {
  while (Date.now() < pauseUntil) {
    const sec = Math.ceil((pauseUntil - Date.now()) / 1000);
    if (statusListener) statusListener(`⏸ limit AI účtu — čekám ${sec} s`);
    await sleep(Math.min(5000, pauseUntil - Date.now()));
  }
  if (statusListener) statusListener('');
};

export async function callAi(opts) {
  const kind = opts.web ? 'web' : 'plain';
  let model = opts.model || (useFallback[kind] ? MODEL_FALLBACK : MODEL_FAST);
  if (model === MODEL_FALLBACK && useFallback.last) model = MODEL_LAST;
  let busyTries = 0, netTries = 0;
  for (let attempt = 0; attempt < 14; attempt++) {
    await waitForPause();
    try {
      return await callOnce({ ...opts, model });
    } catch (e) {
      const busy = e.status === 429 || e.status === 529 || /overloaded|rate_limit/i.test(e.kind);
      if (busy && busyTries < 8) {
        busyTries++;
        const wait = Math.min(120, 30 * busyTries) * 1000;
        pauseUntil = Math.max(pauseUntil, Date.now() + wait);
        continue;
      }
      // Výpadek připojení (prohlížeč hlásí "Failed to fetch") → zkusit znovu.
      const network = !e.status && (e instanceof TypeError || /fetch|network/i.test(e.message || ''));
      if (network && netTries < 3) { netTries++; await sleep(10000 * netTries); continue; }
      const unsupported = (e.status === 400 || e.status === 404) && model === MODEL_FAST && /model|tool|support/i.test(e.message);
      if (unsupported) { model = MODEL_FALLBACK; useFallback[kind] = true; continue; }
      const noModel = (e.status === 400 || e.status === 404) && model === MODEL_FALLBACK && /model/i.test(e.message);
      if (noModel) { model = MODEL_LAST; useFallback.last = true; continue; }
      if (busy) throw new Error('Limit AI účtu je trvale vyčerpaný — zkuste to později.');
      throw e;
    }
  }
  throw new Error('AI je přetížená, zkuste to za chvíli znovu.');
}

// Ověření na internetu: komu adresa patří. → { name, sure, source, evidence }
// Vždy chytřejší model (Sonnet) — správnost má přednost před cenou.
// "Jisté" je výsledek jen se zdrojem (odkazem); bez odkazu se bere jako nejisté.
export async function nameFromWeb(email, city, hint) {
  const prompt =
`A tour operator has this hotel booking e-mail address in its supplier list and needs to know exactly which hotel it belongs to.
E-mail: ${email}
City it is filed under (may be in Czech, Portuguese or upper-case): ${city || 'unknown'}
${hint ? `Earlier unverified guess (may be wrong): ${hint}\n` : ''}
Search the web (hotel's own website, contact/imprint page, booking pages, chain hotel pages). Then return ONLY a JSON object:
{"name": "<official hotel name as the hotel writes it>", "sure": true|false, "source": "<URL of the page that confirms it>", "evidence": "<one short sentence: what on that page confirms it>"}

Rules — correctness matters more than anything:
- sure=true ONLY if the page at "source" shows this exact e-mail address, or this exact domain as the hotel's own website, or (for chain codes like h1765@accor.com) the hotel code matching that hotel — AND the hotel is in that city.
- If the domain belongs to a group, chain, booking centre, agency or several hotels, or the city does not match, or you are not certain: sure=false, but still give your best guess in "name".
- Never invent a URL. If you have no confirming page, leave "source" empty and set sure=false.`;
  const r = await callAi({ prompt, web: true, maxTokens: 700, model: MODEL_FALLBACK });
  const j = r.json && !Array.isArray(r.json) ? r.json : {};
  const name = String(j.name || '').trim();
  const source = String(j.source || '').trim();
  const okUrl = /^https?:\/\/[^\s]+\.[^\s]+/i.test(source);
  return {
    name,
    sure: j.sure === true && !!name && okUrl,
    source: okUrl ? source : '',
    evidence: String(j.evidence || '').trim().slice(0, 300),
    cost: r.cost,
    model: r.model,
  };
}

// ── Hotel z nabídky bez karty: je to opravdu hotel? (s internetem) ──────────
// → { isHotel, sure, name, city, country, website, source, evidence }
// "Jisté" jen s odkazem na stránku, která hotel potvrzuje.
export async function verifyOfferHotel({ name, city, emails, groups }) {
  const prompt =
`A tour operator typed this into the hotel line of a group-travel offer. The text may contain notes in Portuguese or Czech (e.g. "depósito pago no momento da confirmação"), may be an abbreviation, a ship, an agency or not a hotel at all.
Typed name: ${name}
City as typed (may be Portuguese/Czech, e.g. "Amsterdã", "Praga", "Viena"): ${city || 'unknown'}
Contact e-mails used: ${(emails || []).join(', ') || 'none'}
Used in groups: ${(groups || []).slice(0, 3).join(', ') || '-'}

Search the web and return ONLY a JSON object:
{"isHotel": true|false, "sure": true|false, "name": "<official hotel name, without notes>", "city": "<city in its usual English or local form, e.g. Amsterdam, Prague, Vienna>", "country": "<country in English>", "website": "<official hotel website or empty>", "source": "<URL of the page that confirms it>", "evidence": "<one short sentence>"}

Rules — correctness matters more than anything:
- isHotel=false for ships/cruises, agencies, transport, restaurants, or text that is not a hotel name (then sure=true if you are certain it is not a hotel).
- sure=true for a hotel ONLY if a web page at "source" confirms this hotel exists in that city (and, if e-mails are given, preferably that the e-mail/domain belongs to it).
- Strip notes, prices, payment remarks and booking words from "name".
- Never invent a URL. If no confirming page, leave "source" empty and set sure=false.`;
  const r = await callAi({ prompt, web: true, maxTokens: 800, model: MODEL_FALLBACK });
  const j = r.json && !Array.isArray(r.json) ? r.json : {};
  const source = String(j.source || '').trim();
  const okUrl = /^https?:\/\/[^\s]+\.[^\s]+/i.test(source);
  const isHotel = j.isHotel !== false;
  const nm = String(j.name || '').trim();
  return {
    isHotel,
    // Hotel je jistý jen se zdrojem; "není hotel" stačí jistota AI.
    sure: isHotel ? (j.sure === true && !!nm && okUrl) : j.sure === true,
    name: nm, city: String(j.city || '').trim(), country: String(j.country || '').trim(),
    website: String(j.website || '').trim(), source: okUrl ? source : '',
    evidence: String(j.evidence || '').trim().slice(0, 300),
    cost: r.cost, model: r.model,
  };
}

// ── Možná shoda: je hotel z nabídky totéž co některá karta? (bez internetu) ──
// items = [{ i, name, city, emails, candidates: [{ id, name, city, emails }] }]
// → [{ i, match: '<id karty>' | '', sure }]
export async function judgeMatches(items) {
  const prompt =
`A tour operator must decide whether a hotel written in an offer is the same hotel as one of the existing hotel cards. Cities may be written in Portuguese/Czech/English ("Praga" = Prague = Praha). Hotel chains have many different hotels in the same city (e.g. "ibis Old Town" and "ibis Wenceslas" are DIFFERENT hotels).
For each item return ONLY a JSON array: [{"i": <number>, "match": "<card id or empty string>", "sure": true|false}]
- match = the card id only if it is clearly the same hotel (same property, same city). sure=true only when there is no reasonable doubt.
- If none of the candidates is the same hotel: match="" and sure=true if you are certain, otherwise sure=false.
- When two candidates of the same chain could fit and the offer text does not say which: match="" and sure=false.

Answer with the JSON array only — no explanation before or after it.

Items:
${JSON.stringify(items)}`;
  const pick = (j) => Array.isArray(j) ? j : (j && typeof j === 'object' ? (Object.values(j).find(Array.isArray) || []) : []);
  const maxTokens = 400 + items.length * 120;
  let r = await callAi({ prompt, web: false, maxTokens, model: MODEL_FALLBACK });
  let arr = pick(r.json), cost = r.cost;
  // Prázdná / nečitelná odpověď → jeden další pokus.
  if (!arr.length) {
    r = await callAi({ prompt, web: false, maxTokens: maxTokens * 2, model: MODEL_FALLBACK });
    arr = pick(r.json); cost += r.cost;
  }
  return { results: arr, cost, model: r.model };
}


// ── 🌐 Internetová kontrola karty hotelu ──────────────────────────────────────
// Jedno volání (Sonnet + hledání na webu) vrátí údaje o hotelu, KAŽDÝ se zdrojem,
// a typ každé e-mailové adresy na kartě. Údaj bez odkazu na zdroj se nepoužije.
export const EMAIL_TYPES = {
  hotel: 'přímo hotel', groups: 'skupiny', reservations: 'rezervace', sales: 'sales / obchod',
  events: 'eventy / MICE', central: '🏢 centrální rezervace', agency: 'agentura',
  portal: '📨 systém / portál (podpisy, nabídky)', other: '⚠ jiný hotel — nepatří sem', unknown: 'nezjištěno',
};
const FIELD_KEYS = ['name', 'address', 'city', 'country', 'website', 'phone', 'stars', 'rooms', 'groups', 'groupPolicy',
  'google', 'booking', 'distanceCenter', 'coachStop', 'coachParking', 'twinRooms', 'restaurant', 'elevator', 'aircon', 'salesTerms'];

// Výchozí kritéria vhodnosti (upravují se v aplikaci, uložená v settings/hotelCriteria).
export const DEFAULT_CRITERIA =
`Klienti: skupiny brazilských cestovních kanceláří na okružních cestách po Evropě autobusem (12–18 dní).
Typická skupina: 16 TWIN + 2 SNGL (cca 34 osob) + průvodce a řidič.

1. Kategorie: hlavně 4★. 5★ výborné, ale většinou drahé. 3★ jen výjimečně (výborná poloha nebo kvalita).
2. Kapacita: hotel musí zvládnout cca 18–20 pokojů v jedné noci, ideálně má oddělení pro skupiny a zveřejněné skupinové podmínky.
3. Autobus: autobus by měl zastavit přímo u hotelu nebo do 100–200 m (ne pěší zóna / ZTL), parkování autobusu poblíž. Když to nejde, hotel to nevylučuje, ale je méně vhodný — komplikace, vyšší náklady, klientům se to nelíbí.
4. Poloha: pěšky do centra / historické části (do cca 2 km / 20 min), nebo dobré spojení. Daleko od centra = méně vhodný.
5. Pokoje: dostatek TWIN pokojů (oddělená lůžka), SNGL; TRPL jen výjimečně. Výtah, klimatizace.
6. Jídlo: snídaně pro celou skupinu najednou; vlastní restaurace pro skupinové večeře (polopenze, set menu).
7. Pověst: u 4★ hodnocení Booking aspoň 8,0 nebo Google aspoň 4,2; žádné opakované stížnosti na čistotu, hluk, personál.
8. Naše zkušenost: dřívější spolupráce, potvrzení a realizace jsou plus; problémy v poznámkách jsou minus.`;

export async function webCheckCard(card, ctx = {}) {
  const emails = (card.emails || []).map(e => e.email).filter(Boolean).slice(0, 12);
  const prompt =
`You are checking one hotel record for a Czech DMC that books GROUP TOURS (coach tours for Brazilian tour operators). Correctness matters more than completeness.
Hotel name on our card: ${card.name}
Also known as: ${(card.aliases || []).join(' | ') || '-'}
City on our card: ${card.city || 'unknown'}
E-mail addresses on our card: ${emails.join(', ') || 'none'}
Our own history with this hotel: ${ctx.history || 'none recorded'}

OUR SUITABILITY CRITERIA (written by the company, in Czech):
${ctx.criteria || DEFAULT_CRITERIA}

Search the web (official hotel website, chain website, Google Maps, Booking.com, TripAdvisor, city coach-parking information) and return ONLY one JSON object:
{
  "sure": true|false,
  "name":           {"value": "<official name>", "source": "<URL>"},
  "address":        {"value": "<street address with postcode>", "source": "<URL>"},
  "city":           {"value": "<city>", "source": "<URL>"},
  "country":        {"value": "<country in English>", "source": "<URL>"},
  "website":        {"value": "<official website of THIS hotel (on a chain site: this hotel's own page)>", "source": "<URL>"},
  "phone":          {"value": "<main phone with country code>", "source": "<URL>"},
  "stars":          {"value": <official star rating or null>, "source": "<URL>"},
  "rooms":          {"value": <number of rooms or null>, "source": "<URL>"},
  "groups":         {"value": true|false|null, "source": "<URL>"},
  "groupPolicy":    {"value": "<published group conditions: min rooms, deposit, cancellation, FOC — else empty>", "source": "<URL>"},
  "google":         {"value": {"score": <1-5 or null>, "count": <number or null>}, "source": "<URL>"},
  "booking":        {"value": {"score": <1-10 or null>, "count": <number or null>}, "source": "<URL>"},
  "distanceCenter": {"value": {"km": <number>, "walkMin": <number or null>, "to": "<what centre: old town / main square / station>"}, "source": "<URL>"},
  "coachStop":      {"value": "<can a tour coach stop at the entrance? any pedestrian zone / ZTL / restrictions? nearest coach stop>", "source": "<URL>"},
  "coachParking":   {"value": "<coach parking at or near the hotel, price if known>", "source": "<URL>"},
  "twinRooms":      {"value": "<are twin (two separate beds) rooms available / how many>", "source": "<URL>"},
  "restaurant":     {"value": "<own restaurant suitable for group dinners / half board? capacity?>", "source": "<URL>"},
  "elevator":       {"value": true|false|null, "source": "<URL>"},
  "aircon":         {"value": true|false|null, "source": "<URL>"},
  "salesTerms":     {"value": "<IN CZECH, max 5 short points: the hotel's published booking / sales / cancellation terms (general T&C or group terms: deposit, prepayment, cancellation deadlines and fees, release / option, no-show, FOC, payment) — else empty>", "source": "<URL of the page or PDF with the terms>"},
  "emails": [ {"email": "<one of our addresses>", "type": "hotel|groups|reservations|sales|events|central|portal|agency|other|unknown", "belongsTo": {"name": "<hotel the address really belongs to, only for type other>", "city": "<its city>"}} ],
  "foundEmails": [ {"email": "<e-mail address of THIS hotel published on a web page>", "type": "hotel|groups|reservations|sales|events|central", "source": "<URL of the page where it is written>"} ],
  "suitability": {"rating": "good|caveats|bad", "reasons": "<2-4 short points IN CZECH explaining the rating against OUR criteria, mention what is unknown>"},
  "evidence": "<one short sentence>"
}
Rules:
- Every factual value must come from the page in its "source". If you cannot find it on a real page, use null / "" and source "". Never invent URLs or numbers.
- Fill every field you can find — well-known hotels have address, website, phone, stars, rooms and ratings easy to find. Use "sure": false only for the identity question; still fill fields for the most likely hotel.
- Our card may by mistake contain e-mail addresses of OTHER hotels (collected from offers). Mark such an address "other" and say in "belongsTo" which hotel it belongs to.
- "central" = a chain's central/regional reservation office or an address shared by several hotels.
- "portal" = an address of an e-signature, proposal or booking platform that sends contracts / offers / confirmations on behalf of hotels (e.g. noreply@scrive.com, sender@proposales.com, app@oneflow.com, no-reply@email.backyou.io, DocuSign, Cvent). Such an address belongs to the hotel's communication — NEVER mark it "other" or "central".
- "salesTerms": look for the hotel's or chain's published terms and conditions / group booking terms (often a PDF or a page "AGB", "Terms & Conditions", "Condizioni", "Conditions générales"). Summarise only what is written there.
- "foundEmails": look on the hotel's own contact / groups / MICE / meetings / imprint pages and on the chain's page of this hotel for PUBLISHED e-mail addresses of THIS hotel — above all the groups, sales, MICE/events and reservations departments, plus the general hotel address. Only addresses written literally on the "source" page; never guess or construct an address (no "groups@domain" unless it is printed). No newsletter, privacy, job, press, noreply or other-hotel addresses. A chain's central reservation address serving this hotel = type "central". At most 8.
- "suitability" is your judgement against OUR criteria (no source needed). "good" = fits well, "caveats" = usable with drawbacks, "bad" = clearly unsuitable.
- Output the JSON object only — no text before or after it, no citation markers inside values.`;
  let r = await callAi({ prompt, web: true, maxTokens: 8000, model: MODEL_FALLBACK, maxSearches: 8 });
  let cost = r.cost;
  const firstStop = r.stopReason;
  if (!r.json || Array.isArray(r.json)) {
    const retry = prompt + '\n\nIMPORTANT: your answer MUST end with the complete JSON object described above. Keep text values short. Do not write any other text.';
    r = await callAi({ prompt: retry, web: true, maxTokens: 12000, model: MODEL_FALLBACK, maxSearches: 8 });
    cost += r.cost;
  }
  if (!r.json || Array.isArray(r.json)) {
    const why = { max_tokens: 'odpověď byla příliš dlouhá', pause_turn: 'AI nedokončila hledání', end_turn: 'AI nevrátila data ve správném tvaru' };
    const e = new Error(`Odpověď AI se nepodařilo přečíst (${why[r.stopReason] || why[firstStop] || r.stopReason || 'neznámý důvod'})`);
    e.cost = cost;
    throw e;
  }
  const j = r.json;
  const okUrl = (u) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(String(u || '').trim());
  const fields = {};
  for (const k of FIELD_KEYS) {
    const f = j[k];
    if (!f || typeof f !== 'object') continue;
    const v = f.value;
    const empty = v === null || v === undefined || v === '' ||
      (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(x => x === null || x === '' || x === undefined));
    if (empty || !okUrl(f.source)) continue;     // bez zdroje se údaj nepoužije
    fields[k] = { value: v, source: String(f.source).trim() };
  }
  const known = new Set((card.emails || []).map(e => String(e.email || '').trim().toLowerCase()).filter(Boolean));
  const emailTypes = {}, belongsTo = {};
  (Array.isArray(j.emails) ? j.emails : []).forEach(e => {
    const em = String(e && e.email || '').trim().toLowerCase();
    if (!known.has(em) || !EMAIL_TYPES[e.type]) return;
    if (isPortalEmail(em)) return;   // systém / portál se určí níže, nikdy „jiný hotel“
    emailTypes[em] = e.type;
    if (e.type === 'other' && e.belongsTo && String(e.belongsTo.name || '').trim()) {
      belongsTo[em] = { name: String(e.belongsTo.name).trim(), city: String(e.belongsTo.city || '').trim() };
    }
  });
  known.forEach(em => { if (isPortalEmail(em)) emailTypes[em] = 'portal'; });
  // Nově nalezené e-maily hotelu (jen s platným zdrojem, které na kartě ještě nejsou).
  const foundEmails = [];
  const okEmail = (em) => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(em) && !/(noreply|no-reply|privacy|datenschutz|gdpr|dpo|jobs?|career|karriere|press|presse|newsletter|unsubscribe|webmaster)@/.test(em);
  (Array.isArray(j.foundEmails) ? j.foundEmails : []).forEach(e => {
    const em = String(e && e.email || '').trim().toLowerCase().replace(/^mailto:/, '');
    if (!okEmail(em) || known.has(em) || !okUrl(e.source) || isPortalEmail(em)) return;
    if (foundEmails.some(x => x.email === em) || foundEmails.length >= 8) return;
    const type = ['hotel', 'groups', 'reservations', 'sales', 'events', 'central'].includes(e.type) ? e.type : 'hotel';
    foundEmails.push({ email: em, type, source: String(e.source).trim() });
  });
  if (!Object.keys(fields).length) {
    const e = new Error('AI nenašla žádný údaj s ověřitelným zdrojem');
    e.cost = cost;
    throw e;
  }
  const sRating = j.suitability && ['good', 'caveats', 'bad'].includes(j.suitability.rating) ? j.suitability.rating : '';
  return {
    sure: j.sure === true && !!fields.name,
    fields, emailTypes, belongsTo, foundEmails,
    suitability: sRating ? { rating: sRating, reasons: String(j.suitability.reasons || '').trim().slice(0, 600) } : null,
    evidence: String(j.evidence || '').trim().slice(0, 300),
    cost, model: r.model,
  };
}
