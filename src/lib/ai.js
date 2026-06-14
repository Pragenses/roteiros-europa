import { db } from './firebase';
import { doc, getDoc } from 'firebase/firestore';

async function getApiKey() {
  const snap = await getDoc(doc(db, 'settings', 'apiKeys'));
  return snap.exists() ? (snap.data().anthropicKey || '') : '';
}

async function callClaude(prompt, useWebSearch = true) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No Anthropic API key configured. Go to Settings to add one.');
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }]
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'API error');
  const textBlocks = data.content?.filter(b => b.type === 'text').map(b => b.text) || [];
  const text = textBlocks.join('\n');
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

// Search the web for a provider (hotel, transport, guide, etc.)
export async function aiFillProvider(name) {
  const prompt = `Search the web for this travel industry provider/company and return ONLY a valid JSON object, absolutely no markdown, no explanation, no code blocks - just the raw JSON on its own. Fields: name (string), type (one of: hotel/transport/guide/attraction/restaurant/other), address (street address), city, zip, country, vat (VAT/DIC tax number if found), ico (company registration number/ICO if found), email (reservations/groups email if found), phone, website, notes (brief useful notes for a tour operator, e.g. group booking conditions). Provider to search: "${name}". Use empty string "" for fields you cannot find.`;
  return callClaude(prompt, true);
}

// Search the web for a Brazilian/international tour operator client
export async function aiFillClient(name) {
  const prompt = `Search the web for this tour operator / travel agency company and return ONLY a valid JSON object, absolutely no markdown, no explanation, no code blocks - just the raw JSON on its own. Fields: name (string, official company name), country (string), state (string, state/province/federation unit if applicable e.g. for Brazil "Estado" like "SP", "RJ"), billingCompany (full legal company name), billingAddress (street address), billingCity, billingZip, billingCountry, billingVat (VAT/CNPJ/tax number if found), billingIco (company registration number if different from VAT), billingEmail (contact/info email if found), website, notes (brief useful info). Company to search: "${name}". Use empty string "" for fields you cannot find.`;
  return callClaude(prompt, true);
}

// Parse pasted free-text into structured provider fields (no web search, just extraction)
export async function parseProviderText(text) {
  const prompt = `Extract structured company/provider information from the following text. Return ONLY a valid JSON object, absolutely no markdown, no explanation, no code blocks - just the raw JSON. Fields: name, type (one of: hotel/transport/guide/attraction/restaurant/other - guess based on context), address (street), city, zip, country, vat (VAT/DIC/tax number), ico (company registration number/ICO), email, phone, website, notes (any other relevant info not captured above). Use empty string "" for fields not present in the text.\n\nTEXT TO PARSE:\n${text}`;
  return callClaude(prompt, false);
}

// Parse pasted free-text into structured client (tour operator) fields
export async function parseClientText(text) {
  const prompt = `Extract structured company information from the following text about a tour operator / travel agency. Return ONLY a valid JSON object, absolutely no markdown, no explanation, no code blocks - just the raw JSON. Fields: name (agency/brand name), country, state (state/province/federation unit, e.g. for Brazil "SP", "RJ"), billingCompany (full legal company name), billingAddress (street), billingCity, billingZip, billingCountry, billingVat (VAT/CNPJ/tax number), billingIco (registration number if different), billingEmail, notes (any other relevant info), contacts (array of objects with name, role, email, phone - extract any people mentioned). Use empty string "" or empty array for fields not present in the text.\n\nTEXT TO PARSE:\n${text}`;
  return callClaude(prompt, false);
}

async function getGeminiKey() {
  const snap = await getDoc(doc(db, 'settings', 'apiKeys'));
  return snap.exists() ? (snap.data().geminiKey || '') : '';
}

async function callGemini(prompt) {
  const GEMINI_KEY = await getGeminiKey();
  if (!GEMINI_KEY) throw new Error('No Gemini API key configured. Go to Settings to add one.');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1500 }
      })
    }
  );
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Gemini API error');
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

// Search the web (free, via Gemini) for a provider (hotel, transport, guide, etc.)
export async function aiFillProviderFree(name) {
  const prompt = `Search the web for this travel industry provider/company and return ONLY a valid JSON object, absolutely no markdown, no explanation, no code blocks - just the raw JSON on its own. Fields: name (string), type (one of: hotel/transport/guide/attraction/restaurant/other), address (street address), city, zip, country, vat (VAT/DIC tax number if found), ico (company registration number/ICO if found), email (reservations/groups email if found), phone, website, notes (brief useful notes for a tour operator, e.g. group booking conditions). Provider to search: "${name}". Use empty string "" for fields you cannot find.`;
  return callGemini(prompt);
}

// Search the web (free, via Gemini) for a Brazilian/international tour operator client
export async function aiFillClientFree(name) {
  const prompt = `Search the web for this tour operator / travel agency company and return ONLY a valid JSON object, absolutely no markdown, no explanation, no code blocks - just the raw JSON on its own. Fields: name (string, official company name), country (string), state (string, state/province/federation unit if applicable e.g. for Brazil "Estado" like "SP", "RJ"), billingCompany (full legal company name), billingAddress (street address), billingCity, billingZip, billingCountry, billingVat (VAT/CNPJ/tax number if found), billingIco (company registration number if different from VAT), billingEmail (contact/info email if found), website, notes (brief useful info). Company to search: "${name}". Use empty string "" for fields you cannot find.`;
  return callGemini(prompt);
}

// Parse pasted text (e.g. from a client email) into service fields for a specific order service type
export async function parseServiceText(text, serviceType) {
  const fieldHints = {
    hotel: 'name (hotel name), city, dateFrom (YYYY-MM-DD, check-in date), dateTo (YYYY-MM-DD, check-out date), nights (number of nights)',
    restaurant: 'name (restaurant name), city, dateFrom (YYYY-MM-DD)',
    ticket: 'name (attraction/ticket name), city',
    train_boat: 'name, city, dateFrom (YYYY-MM-DD), dateTo (YYYY-MM-DD)',
    bus: 'name (transport company), city',
    guide: 'name, city, dateFrom (YYYY-MM-DD), dateTo (YYYY-MM-DD)',
    extra_cost: 'name, city',
    other: 'name, city, dateFrom (YYYY-MM-DD), dateTo (YYYY-MM-DD)',
  };
  const hints = fieldHints[serviceType] || fieldHints.other;
  const prompt = `Extract booking information from the following text (likely from an email, possibly in Portuguese, about a European tour booking). Return ONLY a valid JSON object, absolutely no markdown, no explanation, no code blocks - just the raw JSON. Today's reference year context: if a date has no year, assume the year mentioned elsewhere in the text or 2027 if none given. Fields to extract: ${hints}. Use empty string "" for fields not present in the text. Dates must be in YYYY-MM-DD format.\n\nTEXT:\n${text}`;
  return callClaude(prompt, false);
}
