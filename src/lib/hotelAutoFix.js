// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATICKÉ OPRAVY DATABÁZE HOTELŮ — etapa 1 (bez AI, zdarma).
//
// Tady jsou jen "čisté" výpočty: z jednoho řádku databáze spočítají, jestli
// a jak ho opravit. Do databáze nic nezapisují — to dělá Hotels.js, který
// každou provedenou změnu zapíše i do deníku `hotelAutoFixes`, aby šla vrátit.
//
// Zásada: automaticky se opraví jen to, co je JISTÉ. Všechno sporné zůstane
// v Kontrole adres k ručnímu rozhodnutí (nebo pro AI v etapě 2).
// ─────────────────────────────────────────────────────────────────────────────

// Koncovky domén, za kterými při importu bývá nalepený začátek dalšího hotelu.
// Musí odpovídat seznamu v Hotels.js (BROKEN_TAIL_RE).
export const KNOWN_TLDS = ['com','cz','sk','net','org','eu','de','at','it','fr','es','pt','pl','hu','si','hr','be','nl','uk','ie','dk','se','no','fi','ch','gr','ro','bg','ba','rs','me','al','mk','tr','ua','ru','lt','lv','ee','lu','is','mt','cy','br','us','ca','info','biz','travel','hotel'];

// Skutečné dlouhé koncovky domén. Bez tohoto seznamu by kontrola považovala
// např. "info@hotel.travel" za slepenou adresu (".tr" + "avel"),
// "x@studio.design" za ".de" + "sign" nebo "y@hotels.group" za ".gr" + "oup".
export const REAL_LONG_TLDS = new Set([
  'travel','tours','tour','holiday','holidays','hotel','hotels','hostel','vacations','voyage','cruises','flights','events',
  'restaurant','cafe','bar','pub','wine','beer','menu','kitchen','pizza',
  'design','media','studio','digital','agency','company','business','services','solutions','group','global','world',
  'international','network','online','site','website','web','store','shop','email','info','biz','pro','name','mobi',
  'berlin','bayern','hamburg','koeln','cologne','wien','tirol','swiss','paris','london','amsterdam','brussels','vlaanderen',
  'barcelona','madrid','istanbul','scot','wales','cymru','irish','eus','gal','cat','bzh','corsica','alsace','city','place',
  'rocks','luxury','life','live','today','plus','one','top','club','house','land','zone','center','centre','guide',
  'museum','art','gallery','photo','photography','camp','golf','ski','spa','yoga','fitness','health','care','clinic',
  'church','school','academy','education','university','college','green','eco','bio','farm','garden','house','homes',
  'apartments','rentals','properties','estate','immo','immobilien','reise','reisen','hotel','tickets','events',
]);

export const lastLabel = (domain) => {
  const d = String(domain || '').toLowerCase();
  return d.slice(d.lastIndexOf('.') + 1);
};

// Je doména podezřelá ze "slepení"? (za známou koncovkou pokračují písmena)
export function looksGlued(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d.includes('.')) return false;
  if (REAL_LONG_TLDS.has(lastLabel(d))) return false;
  return gluedCuts(d).length > 0;
}

// Všechny možné "uříznuté" verze domény, od nejdelší.
//   "happyculture.compointe" → ["happyculture.com"]
//   "hotel.czechhotel"       → ["hotel.cz"]
export function gluedCuts(domain) {
  const d = String(domain || '').toLowerCase();
  const out = new Set();
  for (let p = d.indexOf('.'); p >= 0; p = d.indexOf('.', p + 1)) {
    const label = d.slice(p + 1);
    if (label.includes('.')) continue;          // řez má smysl jen v poslední části
    for (const tld of KNOWN_TLDS) {
      if (label.length > tld.length + 1 && label.startsWith(tld) && /^[a-zÀ-ſ'’-]+$/i.test(label.slice(tld.length))) {
        out.add(d.slice(0, p + 1 + tld.length));
      }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// Bezpečný úklid adresy, který nemění, KAM email jde:
// "mailto:", lomené závorky, uvozovky, mezery, tečka/čárka na konci, velká písmena.
export function tidyEmail(raw) {
  let e = String(raw || '').trim();
  e = e.replace(/^mailto:/i, '');
  e = e.replace(/^[<"'(\[\s]+|[>"')\]\s.,;:]+$/g, '');
  e = e.replace(/\s+/g, '');
  return e.toLowerCase();
}

const SIMPLE_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/i;
export const isPlainValidEmail = (e) => SIMPLE_EMAIL.test(String(e || ''));

// Ověření, že doména opravdu existuje a umí přijímat poštu.
// Používá veřejné DNS služby Googlu a Cloudflare (zdarma, bez klíče).
// Vrací true / false, nebo null, když se ověřit nepodařilo (pak se nic nemění).
const dnsCache = new Map();
async function askDns(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
export async function domainExists(domain) {
  const d = String(domain || '').toLowerCase().trim();
  if (!d || !d.includes('.')) return false;
  if (dnsCache.has(d)) return dnsCache.get(d);
  let result = false;
  for (const type of ['MX', 'A']) {
    const q = `name=${encodeURIComponent(d)}&type=${type}`;
    let j = await askDns(`https://dns.google/resolve?${q}`);
    if (!j) j = await askDns(`https://cloudflare-dns.com/dns-query?${q}`, { accept: 'application/dns-json' });
    if (!j) { result = null; break; }
    if (j.Status === 3) { result = false; break; }            // doména neexistuje
    if (j.Status === 0 && Array.isArray(j.Answer) && j.Answer.length) { result = true; break; }
  }
  if (result !== null) dnsCache.set(d, result);
  return result;
}

// Návrh opravy adresy jednoho řádku. Async kvůli ověření domény.
// Vrací:
//   { action: 'fix', email, reason }    — opravit (jisté)
//   { action: 'verify', reason }        — adresa je ve skutečnosti v pořádku
//   { action: 'review', reason }        — nejisté, nechat člověku
//   null                                — není co dělat
export async function planEmailFix(rawEmail, { needsAttention }) {
  const raw = String(rawEmail || '');
  const tidy = tidyEmail(raw);
  const at = (tidy.match(/@/g) || []).length;
  if (at !== 1) return needsAttention ? { action: 'review', reason: at === 0 ? 'Chybí zavináč' : 'V poli je víc adres najednou' } : null;
  const local = tidy.slice(0, tidy.indexOf('@'));
  const dom = tidy.slice(tidy.indexOf('@') + 1);

  if (looksGlued(dom)) {
    const exists = await domainExists(dom);
    if (exists === null) return { action: 'review', reason: 'Doménu se nepodařilo ověřit (zkusit znovu později)' };
    if (exists) return { action: 'verify', email: tidy, reason: `Doména ${dom} skutečně existuje — adresa není slepená` };
    for (const cut of gluedCuts(dom)) {
      const ok = await domainExists(cut);
      if (ok === null) return { action: 'review', reason: 'Doménu se nepodařilo ověřit (zkusit znovu později)' };
      if (ok) {
        const fixed = `${local}@${cut}`;
        if (!isPlainValidEmail(fixed)) break;
        return { action: 'fix', email: fixed, reason: `Odříznut nalepený text „${dom.slice(cut.length)}“ — doména ${cut} ověřena` };
      }
    }
    return { action: 'review', reason: 'Slepená adresa — žádná zkrácená doména neexistuje' };
  }

  // Úklid mezer/závorek/"mailto:". Samotná velká písmena chyba nejsou a kvůli
  // nim se řádek nemění.
  if (tidy !== raw.trim().toLowerCase()) {
    if (!isPlainValidEmail(tidy)) return needsAttention ? { action: 'review', reason: 'Adresa ani po úklidu neodpovídá' } : null;
    return { action: 'fix', email: tidy, reason: 'Úklid adresy (mezery, závorky, „mailto:“, tečka na konci)' };
  }
  return needsAttention ? { action: 'review', reason: 'Neplatná adresa' } : null;
}

// Návrh opravy názvu s poznámkou. Jen JISTÉ případy:
//   • celý název je v závorce → celé je to poznámka
//   • každý odříznutý kousek obsahuje typické slovo poznámky (neberou, pokoje, skupiny…)
//   • odřízly se jen emoji/odrážky na začátku
// Případy jako "Ibis (Old Town)" nebo "Mercure - Centre 2" zůstávají k ručnímu
// rozhodnutí — závorka i pomlčka tam můžou být část jména a jejich odříznutím
// by se dva různé hotely slily do jednoho.
export function planNameFix(raw, { splitNameNote, stripLead, NOTE_HINT }) {
  const original = String(raw || '').trim();
  if (!original) return null;
  const { name, note } = splitNameNote(original);
  if (!note && name === original) return null;

  const base = stripLead(original);
  if (/^\(\s*(.*?)\s*\)$/s.test(base)) {
    return { action: 'fix', name: '', note, reason: 'Celý název byl poznámka — přesunuto do poznámky, název dohledá AI' };
  }
  const pieces = [];
  base.replace(/\(([^)]*)\)/g, (m, inner) => { if (inner.trim()) pieces.push(inner.trim()); return ' '; });
  const noParen = base.replace(/\(([^)]*)\)/g, ' ');
  const parts = noParen.split(/\s+[-–—]\s+/);
  const dashRest = parts.length > 1 ? parts.slice(1).join(' - ').trim() : '';
  if (dashRest && note.includes(dashRest)) pieces.push(dashRest);

  const allNotes = pieces.every(p => NOTE_HINT.test(p));
  if (!note) {
    // Jen odříznutá emoji / odrážky / mezery.
    return name ? { action: 'fix', name, note: '', reason: 'Odstraněny značky na začátku názvu' } : null;
  }
  if (!name) return { action: 'review', reason: 'Po odříznutí poznámky nezbyl název' };
  if (allNotes && pieces.length > 0) return { action: 'fix', name, note, reason: 'Poznámka přesunuta z názvu do poznámky' };
  return { action: 'review', reason: 'Nejisté, jestli je text v závorce / za pomlčkou poznámka, nebo část jména' };
}
