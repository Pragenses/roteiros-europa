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
const useFallback = { web: false, plain: false, last: false };

export async function callAi(opts) {
  const kind = opts.web ? 'web' : 'plain';
  let model = opts.model || (useFallback[kind] ? MODEL_FALLBACK : MODEL_FAST);
  if (model === MODEL_FALLBACK && useFallback.last) model = MODEL_LAST;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await callOnce({ ...opts, model });
    } catch (e) {
      const busy = e.status === 429 || e.status === 529 || /overloaded|rate_limit/i.test(e.kind);
      if (busy) { await sleep(4000 * (attempt + 1)); continue; }
      const unsupported = (e.status === 400 || e.status === 404) && model === MODEL_FAST && /model|tool|support/i.test(e.message);
      if (unsupported) { model = MODEL_FALLBACK; useFallback[kind] = true; continue; }
      const noModel = (e.status === 400 || e.status === 404) && model === MODEL_FALLBACK && /model/i.test(e.message);
      if (noModel) { model = MODEL_LAST; useFallback.last = true; continue; }
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
