// ─────────────────────────────────────────────────────────────────────────────
// AI PRO KARTY HOTELŮ — etapa 2a: doplnění chybějících názvů.
//
// Dva průchody:
//   1) LEVNÝ — model Haiku bez internetu dostane po dávkách adresy + města
//      a z domény určí název ("info@hotelbern.ch" + Bern → "Hotel Bern").
//      Jistý je jen tam, kde doména název opravdu obsahuje.
//   2) S INTERNETEM — jen pro nejisté případy (kódy řetězců, gmail, centrály):
//      AI dohledá na webu, komu adresa patří, a vrátí odkaz na zdroj.
//
// Každé volání vrací i cenu v Kč spočtenou z údajů, které posílá Anthropic
// (počet tokenů a hledání), takže útrata se dá hlídat limitem.
// Ceny: https://platform.claude.com/docs/en/about-claude/pricing (10/2026)
// ─────────────────────────────────────────────────────────────────────────────
import { db } from './firebase';
import { doc, getDoc } from 'firebase/firestore';

export const MODEL_FAST = 'claude-haiku-5-5';
export const MODEL_FALLBACK = 'claude-sonnet-5';

// USD za milion tokenů (vstup / výstup).
const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50 },
  'claude-sonnet-5':  { in: 2,    out: 10 },
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
function extractJSON(text) {
  let start = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === '{' || text[i] === '[') { start = i; break; }
  if (start < 0) throw new Error('V odpovědi AI chybí data');
  const open = text[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('Odpověď AI je neúplná');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callOnce({ model, prompt, web, maxTokens }) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('Chybí klíč k AI (Settings → Anthropic API key).');
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
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
    throw err;
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const cost = costCzk(model, data.usage || {});
  let json = null;
  try { json = extractJSON(text); } catch (e) { json = null; }
  return { json, cost, model };
}

// Volání s pojistkami: při přetížení počká a zkusí znovu; když levný model
// nějakou funkci nepodporuje, použije dražší (Sonnet).
// Když levný model nějakou funkci odmítne, zapamatuje se to a další volání
// stejného druhu jdou rovnou na Sonnet (bez zbytečného neúspěšného pokusu).
const useFallback = { web: false, plain: false };

export async function callAi(opts) {
  const kind = opts.web ? 'web' : 'plain';
  let model = useFallback[kind] ? MODEL_FALLBACK : MODEL_FAST;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await callOnce({ ...opts, model });
    } catch (e) {
      const busy = e.status === 429 || e.status === 529 || /overloaded|rate_limit/i.test(e.kind);
      if (busy) { await sleep(4000 * (attempt + 1)); continue; }
      const unsupported = (e.status === 400 || e.status === 404) && model === MODEL_FAST && /model|tool|support/i.test(e.message);
      if (unsupported) { model = MODEL_FALLBACK; useFallback[kind] = true; continue; }
      throw e;
    }
  }
  throw new Error('AI je přetížená, zkuste to za chvíli znovu.');
}

// 1) Levný průchod: názvy z adres, po dávkách.
//    items = [{ i, email, city }] → [{ i, name, sure }]
export async function namesFromEmails(items) {
  const prompt =
`You help a tour operator identify hotels in its supplier list. Each item is a hotel booking e-mail address and the city it is filed under (city may be written in Czech, Portuguese or upper-case).
Return ONLY a JSON array, one object per item, in the same order: {"i": <number>, "name": "<hotel name or empty string>", "sure": true|false}

Rules:
- sure=true ONLY when the e-mail domain itself clearly spells the hotel's own name, e.g. info@hotelbern.ch in Bern -> "Hotel Bern"; reservation@belvedere-hotel.it in Bolzano -> "Hotel Belvedere"; info@kursaal-bern.ch -> "Kursaal Bern".
- Write the name the way the hotel writes it: proper capitalisation, accents, spaces ("Cappello d'Oro", not "cappellodoro").
- sure=false for: hotel chains and their booking centres (accor.com, nh-hotels.com, marriott.com, iberostar.com…), codes (h1765@accor.com), free-mail (gmail, hotmail…), agencies, event/MICE departments where the domain is a group name, or whenever you are guessing. Still give your best guess in "name".
- Never invent a hotel that the address does not point to.

Items:
${JSON.stringify(items)}`;
  const r = await callAi({ prompt, web: false, maxTokens: 120 + items.length * 60 });
  const arr = Array.isArray(r.json) ? r.json : [];
  return { results: arr, cost: r.cost, model: r.model };
}

// 2) S internetem: komu adresa patří. → { name, sure, source }
export async function nameFromWeb(email, city) {
  const prompt =
`Find which hotel uses this booking e-mail address. Search the web.
E-mail: ${email}
City (from our list; may be in Czech/Portuguese/upper-case): ${city || 'unknown'}

Return ONLY a JSON object: {"name": "<official hotel name or empty>", "sure": true|false, "source": "<URL of the page that confirms it, or empty>"}
sure=true ONLY if a web page confirms that this exact e-mail address (or, for a chain code like h1765@accor.com, this hotel code) belongs to that hotel in that city. Otherwise sure=false with your best guess.`;
  const r = await callAi({ prompt, web: true, maxTokens: 600 });
  const j = r.json && !Array.isArray(r.json) ? r.json : {};
  return {
    name: String(j.name || '').trim(),
    sure: j.sure === true,
    source: String(j.source || '').trim(),
    cost: r.cost,
    model: r.model,
  };
}
