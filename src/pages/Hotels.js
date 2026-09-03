// force-rebuild-signature2
import React, { useState, useEffect, useCallback } from 'react';
import { db, auth } from '../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// TLD deliberately restricted to lowercase letters only: when hotel entries are pasted with
// no separator at all between them (e.g. "...info@hotel.hrHotel Next Name – info@..."), an
// unbounded TLD would swallow the start of the next hotel's name. Real TLDs are lowercase.
const GLOBAL_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,10}/g;
const SAME_LINE_SEP_TRIM_RE = /[:–—-]\s*$/;

// City names are typed by hand into hotel/bus records, so they arrive in every casing
// (LJUBLJANA, ljubljana, LjuBljana). This normalises ONLY what goes into the e-mail
// subject - the stored value is never touched, because the city field is also used to
// filter records (h.city === composeCity) and changing it would break that match.
const CITY_LOWER_WORDS = ['am','an','aan','auf','im','zu','der','den','des','de','del','della','di','da','do','dos','la','le','les','el','en','sur','sous','sul','upon','op','on','of','in','na','nad','pod','ob','u','va','vor','and','y','e'];
function formatCity(raw) {
  if (!raw) return raw;
  return String(raw).trim().split(/(\s+)/).map((part, idx) => {
    if (/^\s+$/.test(part)) return part;
    return part.split('-').map((chunk, ci) => {
      if (!chunk) return chunk;
      const low = chunk.toLowerCase();
      if ((idx > 0 || ci > 0) && CITY_LOWER_WORDS.includes(low)) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    }).join('-');
  }).join('');
}

function parseSimple(text) {
  // If the pasted text has no line breaks between hotel entries at all, force a break
  // right after every recognizable email address so each entry lands on its own line.
  const emailMatches = [...text.matchAll(GLOBAL_EMAIL_RE)];
  let workingText = text;
  if (emailMatches.length > 1) {
    let rebuilt = '';
    let lastEnd = 0;
    for (const m of emailMatches) {
      const end = m.index + m[0].length;
      rebuilt += text.slice(lastEnd, end) + '\n';
      lastEnd = end;
    }
    rebuilt += text.slice(lastEnd);
    workingText = rebuilt;
  }

  const lines = workingText.split('\n').map(l =>
    l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
  ).filter(Boolean);
  const results = [];
  let city = '';
  let pendingName = '';
  let foundFirstEmail = false;
  for (const line of lines) {
    const lineEmails = line.match(GLOBAL_EMAIL_RE);
    if (lineEmails && lineEmails.length === 1) {
      const email = lineEmails[0];
      const namePart = line.slice(0, line.indexOf(email))
        .replace(SAME_LINE_SEP_TRIM_RE, '')
        .trim()
        .replace(/^[*•-]\s*/, '');
      if (namePart) {
        foundFirstEmail = true;
        results.push({ city, name: namePart, email: email.toLowerCase() });
        pendingName = '';
        continue;
      }
    }
    if (EMAIL_RE.test(line)) {
      foundFirstEmail = true;
      results.push({ city, name: pendingName, email: line.toLowerCase() });
      pendingName = '';
    } else if (/^HOTELY\s+|^HOTELS\s+|^HOTEIS\s+/i.test(line)) {
      city = line.replace(/^HOTELY\s+/i,'').replace(/^HOTELS\s+/i,'').replace(/^HOTEIS\s+/i,'').trim();
      pendingName = '';
    } else if (!foundFirstEmail && !city) {
      city = line;
      pendingName = '';
    } else {
      pendingName = line;
    }
  }
  return results.filter(r => r.email);
}

const fmt = (ts) => {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('cs-CZ') + ' ' + d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
};

const TABS = [
  { id: 'import',  label: '📥 Import' },
  { id: 'db',      label: '🏨 Databáze' },
  { id: 'compose', label: '✉ Poptávka' },
  { id: 'log',     label: '📋 Log' },
  { id: 'cards',   label: '🗂 Karty' },
  { id: 'clean',   label: '🧹 Kontrola adres' },
];

// ─────────────────────────────────────────────────────────────────────────────
// KARTY HOTELŮ — slučování řádků databáze do jedné karty na hotel.
//
// Databáze `hotels` má jeden řádek na EMAIL, ne na hotel, takže jeden hotel
// se třemi adresami je tam třikrát. Karta (`hotelCards`) sdružuje ty řádky
// dohromady. Původní řádky se NEMAŽOU ani nemění — jen dostanou `cardId`,
// takže rozesílání poptávek funguje přesně jako dosud.
//
// Pravidlo slučování (doména + název + město, vždycky obojí):
//   • stejná doména + podobný název + stejné město → jistá shoda (zelená)
//   • stejná doména, ale jiný název/město          → nejspíš řetězec (oranžová)
//   • freemail (gmail…)                            → doména se ignoruje
//   • jiná doména, ale stejný název a město        → návrh ke spojení (oranžová)
// Nic se nespojí bez kliknutí uživatele.
// ─────────────────────────────────────────────────────────────────────────────

const FREEMAIL = new Set([
  'gmail.com','googlemail.com','seznam.cz','email.cz','centrum.cz','volny.cz','atlas.cz',
  'hotmail.com','hotmail.co.uk','outlook.com','outlook.cz','live.com','msn.com',
  'yahoo.com','yahoo.co.uk','yahoo.it','yahoo.fr','yahoo.es','ymail.com',
  'icloud.com','me.com','mac.com','aol.com','gmx.de','gmx.net','gmx.com','web.de',
  't-online.de','wp.pl','o2.pl','onet.pl','interia.pl','mail.ru','yandex.ru','yandex.com',
  'libero.it','virgilio.it','alice.it','tiscali.it','orange.fr','wanadoo.fr','free.fr',
  'sfr.fr','laposte.net','terra.com.br','uol.com.br','bol.com.br','ig.com.br','abv.bg',
  'protonmail.com','proton.me','zoho.com','mail.com','post.cz','tiscali.cz',
]);

// Slova, která o identitě hotelu nic neříkají a při porovnávání názvů se odmažou.
const NAME_NOISE = /\b(hotel|hotell|hotels|hotel[eé]?is|h[oôó]tel|penzion|pension|pension[ae]t|hostel|hostal|garni|resort|spa|apartments?|apartm[aá]ny?|apart|residence|rezidence|guesthouse|guest|house|the|and|amp)\b/g;

// Práh, od kterého se adresa považuje za SDÍLENOU (rezervační centrála
// obsluhující víc hotelů). Sdílená adresa nikdy nic nespojuje a smí ležet na
// libovolném počtu karet. Číslo jde kdykoliv změnit.
const SHARED_EMAIL_MIN = 4;

// Název, který o hotelu nic neříká: prázdný, samotná emailová adresa, pomlčka,
// nebo slova, která se do sloupce dostala omylem při importu ("E-mail").
// Do názvů se dostaly emoji a odrážky ("📧 E-mail", "🏨 Grand Hotel", "· ibis
// Styles"). Bez odříznutí by název vypadal jako smysluplný a obcházel kontroly.
const stripLead = (s) => String(s || '')
  .replace(/^[^\p{L}\p{N}(]+/u, '')
  .replace(/[\s·•]+$/u, '')
  .trim();

const JUNK_NAME = /^(e-?mail|email|mail|hotel|hotely|hotels|kontakt|contact|info|n\/?a|nan|null|[-–—.,:;?]+)$/i;
const isRealName = (raw) => {
  const t = stripLead(raw);
  if (!t) return false;
  if (t.includes('@')) return false;          // do názvu spadla adresa
  if (JUNK_NAME.test(t)) return false;
  return /[a-zA-Z0-9À-ž]/.test(t);
};

// Do sloupce s názvem se často dostaly i poznámky:
//   "Nira Caledonia - neberou skupiny už - jen 27 pokojů"
//   "( SOLICITAR HOTEL CENTRAL EM NIUREMBERG - DEVE OFERECER QUARTOS TWIN )"
// Na kartě chceme jen jméno hotelu; zbytek se uloží jako interní poznámka,
// takže se nic neztratí.
const NOTE_HINT = /\b(nebe?r(ou|e)|neber|pokoj|pokoje|pokojů|quartos|habitaciones|zimmer|skupin|grupo|group|solicitar|use central|not specified|nutn|pouze|jen |only |min\.|max\.|neposílat|nepiš|zrušen|zavřen|closed|drah|expensive)\b/i;

function splitNameNote(raw) {
  let name = stripLead(raw);
  let note = '';
  // Celý název v závorce = celé je to poznámka.
  const wrapped = name.match(/^\(\s*(.*?)\s*\)$/s);
  if (wrapped) return { name: '', note: wrapped[1] };
  // Text v závorce odřízneme do poznámky.
  name = name.replace(/\(([^)]*)\)/g, (m, inner) => { note += (note ? ' · ' : '') + inner.trim(); return ' '; });
  // Za první pomlčkou obklopenou mezerami začíná poznámka, pokud vypadá jako
  // poznámka (obsahuje typická slova nebo číslo). Pomlčka uvnitř jména
  // ("Motel One Amsterdam-Waterlooplein") se tím nedotkne.
  const parts = name.split(/\s+[-–—]\s+/);
  if (parts.length > 1) {
    const rest = parts.slice(1).join(' - ').trim();
    if (NOTE_HINT.test(rest) || /\d/.test(rest)) {
      name = parts[0];
      note += (note ? ' · ' : '') + rest;
    }
  }
  name = name.replace(/\s{2,}/g, ' ').replace(/^[-–—\s.,:;]+|[-–—\s.,:;]+$/g, '').trim();
  return { name, note: note.trim() };
}

// Název, ve kterém je zjevně schovaná poznámka — pro záložku Kontrola adres.
const nameHasNote = (raw) => {
  const t = String(raw || '').trim();
  if (!t || !isRealName(t)) return false;
  const { name, note } = splitNameNote(t);
  return !!note || name !== t;
};

// Adresa rozbitá při importu: za koncovkou domény pokračuje text, protože se
// k ní nalepil začátek dalšího hotelu ("...@happyculture.com" + "Pointe").
// Také hlídá adresy bez zavináče, s víc zavináči nebo s mezerou.
const KNOWN_TLD = '(com|cz|sk|net|org|eu|de|at|it|fr|es|pt|pl|hu|si|hr|be|nl|uk|ie|dk|se|no|fi|ch|gr|ro|bg|ba|rs|me|al|mk|tr|ua|ru|lt|lv|ee|lu|is|mt|cy|br|us|ca|info|biz|travel|hotel)';
const BROKEN_TAIL_RE = new RegExp(`\\.${KNOWN_TLD}[a-zA-Z\\u00C0-\\u017F'’\\-]{2,}$`, 'i');
function emailProblem(email) {
  const e = String(email || '').trim();
  if (!e) return 'Prázdná adresa';
  if (/\s/.test(e)) return 'Adresa obsahuje mezeru';
  if ((e.match(/@/g) || []).length !== 1) return 'Adresa nemá právě jeden zavináč';
  const dom = e.slice(e.indexOf('@') + 1);
  if (!dom.includes('.')) return 'Doména bez tečky';
  if (BROKEN_TAIL_RE.test(dom)) return 'Slepená adresa z importu — za koncovkou domény pokračuje text';
  if (/[^a-zA-Z0-9._%+-]/.test(e.slice(0, e.indexOf('@')))) return 'Neplatný znak před zavináčem';
  return '';
}

const stripDia = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normName = (s) =>
  stripDia(String(s || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normCity = (s) =>
  stripDia(String(s || '').toLowerCase()).replace(/[^a-z0-9]/g, '');

const domainOf = (email) => {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return '';
  return email.slice(at + 1).toLowerCase().trim();
};

// Dva názvy jsou stejný hotel jen tehdy, když se shodují, nebo když je jeden
// CELÝ obsažený v druhém jako souvislé slovní spojení ("Ambassador" uvnitř
// "Ambassador Zlatá Husa"). Sdílená slova nestačí — jinak by se "Vienna House
// Diplomat" a "Vienna House Ernst Leitz" slily do jednoho hotelu, přestože
// jde o dva různé domy v jednom řetězci.
const sameName = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = ` ${a} `, pb = ` ${b} `;
  return pa.includes(pb) || pb.includes(pa);
};

const sameCity = (a, b) => !a || !b || a === b;

// Sestaví návrhy karet z řádků databáze, které ke kartě ještě nepatří.
// Vrací { green: [...], orange: [...] }; každá skupina = jedna budoucí karta.
function buildCardSuggestions(rows) {
  const pool = rows.filter(r => !r.cardId && r.email);

  // Vadné řádky se do návrhů vůbec nepustí — patří do záložky Kontrola adres.
  const broken = pool.filter(r => emailProblem(r.email));
  const clean  = pool.filter(r => !emailProblem(r.email));

  // Adresa, která leží na SHARED_EMAIL_MIN a víc řádcích, je rezervační
  // centrála. Nikdy nic nespojuje a smí být na libovolném počtu karet.
  const emailCount = new Map();
  for (const r of clean) {
    const e = String(r.email).toLowerCase();
    emailCount.set(e, (emailCount.get(e) || 0) + 1);
  }
  // Druhý signál, nezávislý na počtu: adresa na doméně, pod kterou v databázi
  // leží několik různých hotelů (accor.com, electrahotels.com), je rezervační
  // centrála řetězce, i když se v seznamu objeví jen dvakrát.
  const domainHotels = new Map();
  for (const r of clean) {
    const d = domainOf(r.email);
    if (!d || FREEMAIL.has(d)) continue;
    const n = isRealName(r.name) ? normName(splitNameNote(r.name).name) : '';
    if (!n) continue;
    if (!domainHotels.has(d)) domainHotels.set(d, new Set());
    domainHotels.get(d).add(n);
  }
  const chainDomain = (d) => (domainHotels.get(d)?.size || 0) >= 2;
  const isShared = (e) => {
    if ((emailCount.get(e) || 0) >= SHARED_EMAIL_MIN) return true;
    if ((emailCount.get(e) || 0) >= 2 && chainDomain(domainOf(e))) return true;
    return false;
  };

  const items = clean.map(r => ({
    row: r,
    email: String(r.email).toLowerCase(),
    domain: domainOf(r.email),
    nName: isRealName(r.name) ? normName(splitNameNote(r.name).name) : '',
    hasName: isRealName(r.name) && !!splitNameNote(r.name).name,
    nCity: normCity(r.city),
  }));

  // 1) Rozdělení podle domény. Freemail nemá vypovídající doménu, takže tam
  //    rozhoduje název a město — a řádek bez názvu zůstane sám za sebe.
  const buckets = new Map();
  for (const it of items) {
    const free = !it.domain || FREEMAIL.has(it.domain);
    const key = free
      ? (it.hasName ? `free|${it.nName}|${it.nCity}` : `solo|${it.row.id}`)
      : `dom|${it.domain}`;
    if (!buckets.has(key)) buckets.set(key, { free, domain: free ? '' : it.domain, items: [] });
    buckets.get(key).items.push(it);
  }

  // 2) Uvnitř domény rozdělíme podle názvu a města — jedna doména může patřit
  //    řetězci s několika hotely. Řádek bez názvu se nikdy nepřilepí k cizímu
  //    hotelu; spojí se jen se shodnou adresou.
  const sameRow = (a, b) => {
    if (a.email === b.email && !isShared(a.email)) return true;  // duplicita
    // Dva bezejmenné řádky se shodnou adresou i městem jsou tentýž záznam
    // zdvojený v databázi — spojit se musí, jinak zůstanou v seznamu dvakrát.
    if (!a.hasName && !b.hasName) return a.email === b.email && a.nCity === b.nCity;
    if (!a.hasName || !b.hasName) return false;                  // bez názvu nespojujeme
    return sameName(a.nName, b.nName) && sameCity(a.nCity, b.nCity);
  };

  const groups = [];
  for (const b of buckets.values()) {
    const subs = [];
    for (const it of b.items) {
      const hit = subs.find(sg => sg.items.some(x => sameRow(x, it)));
      if (hit) hit.items.push(it); else subs.push({ items: [it] });
    }
    for (const sg of subs) {
      groups.push({ items: sg.items, domain: b.domain, free: b.free, chain: !b.free && subs.length > 1 });
    }
  }

  const shape = (g) => {
    // Název bereme jen z řádků, které nějaký smysluplný mají; nejdelší je hlavní.
    const split = g.items.filter(i => i.hasName).map(i => splitNameNote(i.row.name));
    const names = [...new Set(split.map(x => x.name).filter(Boolean))];
    names.sort((a, b) => b.length - a.length);
    const notes = [...new Set(split.map(x => x.note).filter(Boolean))];
    const cities = [...new Set(g.items.map(i => i.row.city).filter(Boolean))];
    const emails = [...new Set(g.items.map(i => i.email))];
    return {
      key: g.items.map(i => i.row.id).sort().join('_'),
      name: names[0] || '(bez názvu) ' + emails[0],
      noName: names.length === 0,
      aliases: names.slice(1),
      notes,
      city: cities[0] || '',
      domain: g.domain,
      free: g.free,
      chain: !!g.chain,
      shared: emails.some(isShared),
      rows: g.items.map(i => i.row),
      reason: g.chain
        ? `Řetězec ${g.domain} — samostatný hotel, nespojuje se s ostatními`
        : g.free
          ? 'Freemailová adresa — spojeno podle názvu a města'
          : `Společná doména ${g.domain}`,
    };
  };

  const all = groups.map(shape);

  // 3) K rozhodnutí jde jen to, co stroj rozhodnout nemůže:
  //    (a) stejný název i město, ale jiná doména
  //    (b) stejná adresa, ale jiný název — jeden hotel, nebo sdílená centrála?
  const clusters = new Map();
  const put = (k, g, why) => {
    if (!clusters.has(k)) clusters.set(k, { groups: [], why });
    if (!clusters.get(k).groups.includes(g)) clusters.get(k).groups.push(g);
  };
  for (const g of all) {
    if (!g.noName) {
      const k = `n|${normName(g.name)}|${normCity(g.city)}`;
      if (k.replace(/[|]/g, '').trim()) put(k, g, 'name');
    }
    for (const r of g.rows) {
      const e = String(r.email).toLowerCase();
      if (!isShared(e)) put(`e|${e}`, g, 'email');
    }
  }

  const merge = [];
  const inMerge = new Set();
  for (const [k, c] of clusters) {
    if (c.groups.length < 2) continue;
    if (c.why === 'name' && new Set(c.groups.map(g => g.domain || 'free')).size < 2) continue;
    if (c.groups.some(g => inMerge.has(g.key))) continue;
    c.groups.forEach(g => inMerge.add(g.key));
    const names = c.groups.filter(g => !g.noName).map(g => g.name).sort((a, b) => b.length - a.length);
    merge.push({
      key: c.groups.map(g => g.key).join('+'),
      name: names[0] || c.groups[0].name,
      city: c.groups.find(g => g.city)?.city || '',
      why: c.why === 'email'
        ? `Stejná adresa ${k.slice(2)}, ale jiný název — jeden hotel, nebo adresa sdílená víc hotely?`
        : 'Stejný název i město, ale jiná emailová doména',
      groups: c.groups,
      rows: c.groups.flatMap(g => g.rows),
    });
  }

  // Skupiny bez názvu se do hromadného vytváření nepouštějí — vznikly by stovky
  // karet jménem "(bez názvu) h0747@accor.com". Nejdřív dostanou název
  // v Kontrole adres. Jednotlivě vytvořit je ale pořád jde.
  const rest = all.filter(g => !inMerge.has(g.key) && !g.noName);
  const unnamed = all.filter(g => !inMerge.has(g.key) && g.noName)
    .sort((a, b) => (a.city || '').localeCompare(b.city || ''));
  return {
    unnamed,
    green: rest.filter(g => !g.chain).sort((a, b) => b.rows.length - a.rows.length),
    chain: rest.filter(g => g.chain).sort((a, b) => (a.domain || '').localeCompare(b.domain || '') || (a.name || '').localeCompare(b.name || '')),
    merge: merge.sort((a, b) => (a.city || '').localeCompare(b.city || '')),
    broken,
    sharedEmails: [...emailCount.entries()].filter(([, n]) => n >= SHARED_EMAIL_MIN).map(([e, n]) => ({ email: e, count: n })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PODPISY
//
// Podpis se do textu emailu nevepisuje natvrdo — v šabloně je jen značka
// {{signature}} a doplní se až při odeslání, stejně jako název skupiny nebo
// termíny. Díky tomu se dá odesílatel přepnout, aniž by se sahalo do textu.
//
// Úprava podpisu = úprava `html` níže. Řádky se oddělují <br>.
// `logins` jsou emaily, podle kterých se podpis vybere sám po přihlášení.
// ─────────────────────────────────────────────────────────────────────────────
const COMPANY_LINES =
  `TOUR PRAGENSES, PRAGENSES s.r.o.<br>` +
  `Lipnická 688, Praha 9 - Kyje, Czech Republic<br>`;

const SIGNATURES = [
  {
    id: 'helena',
    label: 'Helena Dlasková',
    logins: ['helena.maria.brito@gmail.com'],
    html:
      `<b>Helena Dlasková, sales</b><br>` +
      COMPANY_LINES +
      `Tlf - whatsapp : +420 777 079 997<br>` +
      `VAT: CZ284 45 961`,
  },
  {
    id: 'filip',
    label: 'Filip Dlask',
    logins: ['filipdlask@gmail.com'],
    // Telefon je zatím společný s Helenou; až bude vlastní, změň tenhle řádek.
    html:
      `<b>Filip Dlask, sales</b><br>` +
      COMPANY_LINES +
      `Tlf - whatsapp : +420 777 079 997<br>` +
      `VAT: CZ284 45 961`,
  },
];

const DEFAULT_SIGNATURE = 'helena';

// Podle přihlášeného účtu vybere podpis. Když účet v seznamu není,
// zůstane výchozí — nikdy se nevrátí prázdno.
function signatureForLogin(email) {
  const e = String(email || '').toLowerCase().trim();
  const hit = SIGNATURES.find(s => s.logins.includes(e));
  return hit ? hit.id : DEFAULT_SIGNATURE;
}

const DEFAULT_TEMPLATE = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:650px">
<p>Dear Sir or Madam,</p>
<p>I am reaching out to inquire about the best possible rates and options for accommodating a group booking as outlined below:</p>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">GROUP DETAILS:</span></p>
<ul>
<li><b>Group Name:</b> {{groupName}}</li>
<li><b>Travel Dates:</b> {{checkIn}} – {{checkOut}}</li>
<li><b>Accommodation Needs:</b> 18 rooms in total ( 16 twin/dbl + 2 sngl )</li>
<li><b>Room Breakdown:</b> twin/dbl rooms and single rooms. Our groups need at least 50% of twin rooms with separated beds.</li>
<li>If available, please also provide pricing for triple rooms or double rooms with an extra bed as an alternative.</li>
</ul>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">SPECIAL REQUESTS:</span></p>
<ul>
<li><b>Complimentary Room:</b> 1 free guest for every {{freeRatio}} paying guests.</li>
<li><b>Porterage Service:</b> Please inform us if porterage is available, along with the associated pricing.</li>
<li><b>Meal Plan Options:</b>
  <ul>
    <li>BB: Please provide the rate.</li>
    <li>HB: If offered ( optional )</li>
  </ul>
</li>
</ul>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">BOOKING CONDITIONS:</span></p>
<ul>
<li>Cancellation policy (including free cancellation terms and partial cancellation conditions)</li>
<li>Deposit requirements and payment schedule</li>
</ul>

<p>Additionally, we would appreciate if you could hold this offer until ............</p>
<p>Thank you very much for your assistance. I look forward to your proposal and any further details you may require.</p>
<p>Best regards,<br>
--<br>
{{signature}}</p>
</div>`;

export default function Hotels({ navigate, colors, navParams }) {
  console.debug('Hotels v203-signature');
  const C = colors;
  const prefill = navParams?.prefill || null;
  const cityList = prefill?.cityList || null;
  const [tab, setTab] = useState(prefill ? 'compose' : 'import');
  const [activeCityPrefill, setActiveCityPrefill] = useState(null);

  const [hotels, setHotels]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [editRow, setEditRow]     = useState(null);
  const [showAdd, setShowAdd]     = useState(false);
  const [newHotel, setNewHotel]   = useState({ city: '', name: '', email: '' });

  const [importText, setImportText]   = useState('');
  const [importCity, setImportCity]   = useState('');
  const [parsed, setParsed]           = useState([]);
  const [importing, setImporting]     = useState(false);
  const [importDone, setImportDone]   = useState(null);
  const visualEditorRef = React.useRef(null);

  const [selected, setSelected]       = useState([]);
  const [composeCity, setComposeCity] = useState('');
  // Hledání v seznamu hotelů u poptávky. Je schválně oddělené od hledání
  // v záložce Databáze (`search`), aby se ty dva filtry navzájem nepřepisovaly.
  const [composeSearch, setComposeSearch] = useState('');
  const [groupName, setGroupName]     = useState(prefill?.groupName || '');
  const [prefillGroupName] = useState(prefill?.groupName || '');
  const [checkIn, setCheckIn]         = useState('');
  const [checkOut, setCheckOut]       = useState('');
  const [freeRatio, setFreeRatio]     = useState('20');
  const [emailBody, setEmailBody]     = useState(DEFAULT_TEMPLATE);
  const [editMode, setEditMode]       = useState('visual');

  const htmlToPlain = (html) => {
    // If stored as plain text (during editing), return as-is
    if (html.startsWith('<PLAIN>')) return html.slice(7, -8);
    return html
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>/gi, '')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '$1')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '$1')
    .replace(/<span[^>]*>(.*?)<\/span>/gi, '$1')
    .replace(/<div[^>]*>/gi, '').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  };

  const plainToHtml = (text) => {
    const lines = text.split('\n');
    const sectionHeaders = /^(GROUP DETAILS|SPECIAL REQUESTS|BOOKING CONDITIONS|MEAL PLAN OPTIONS|PROGRAM|WE KINDLY REQUEST)\s*:?\s*$/i;
    const dayMarker = /^(\d{1,2}[°º]?\s*DIA\s*[–\u2013:-]|DAY\s+\d{1,2}\s*[–\u2013:-]|\d{1,2}(st|nd|rd|th)?\s*DAY\s*[–\u2013:-]|\d{1,2}\s+[A-Za-zÀ-ÿ]{3,9}\s+\d{4}\s*[–\u2013:-]|[A-Za-z]{3,9}\s+\d{1,2}[,\s]+\d{4}\s*[–\u2013:-]|\d{1,2}\s+[A-Za-zÀ-ÿ]{3}\s+\([A-Za-zÀ-ÿ]{3}\)\s*-|📅)/i;
    // "Label: rest of the sentence" — bold just the label part
    const boldLabel = (s) => s.replace(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,30}?:)/, '<strong>$1</strong>');

    // Trim leading/trailing blank lines, and collapse blank lines that sit
    // BETWEEN two bullet ("• ") lines — those are just formatting artifacts
    // from the source template, not intended paragraph breaks.
    // Drop ALL blank lines entirely — this template is a compact inquiry
    // form, not prose, and every blank line in the source was just visual
    // formatting for the editor, never meant to become a visible email gap.
    const nonBlank = lines.map(l => l.trim()).filter(l => l);

    let html = '';
    let inList = false;
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

    nonBlank.forEach(line => {
      if (line.startsWith('• ')) {
        if (!inList) { html += '<ul style="margin:0;padding-left:20px">'; inList = true; }
        html += '<li style="margin:0;padding:1px 0;mso-line-height-rule:exactly">' + boldLabel(line.slice(2)) + '</li>';
        return;
      }
      closeList();
      if (dayMarker.test(line) || sectionHeaders.test(line)) {
        html += '<p style="margin:10px 0 2px 0;line-height:1.3;mso-line-height-rule:exactly;mso-margin-top-alt:10px;mso-margin-bottom-alt:2px"><strong style="background-color:#FFD700;padding:2px 6px">' + line + '</strong></p>';
      } else {
        html += '<p style="margin:2px 0;line-height:1.3;mso-line-height-rule:exactly;mso-margin-top-alt:2px;mso-margin-bottom-alt:2px">' + boldLabel(line) + '</p>';
      }
    });
    closeList();
    return '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.3;color:#222;max-width:650px">' + html + '</div>';
  };
  const [subject, setSubject]         = useState('GRP');
  const [senderFrom, setSenderFrom]   = useState('grupos');
  // Podpis se nastaví podle přihlášeného účtu, ale jde kdykoliv přepnout ručně.
  // Jakmile ho uživatel přepne, automatika už do toho nesahá.
  const [signatureId, setSignatureId] = useState(() => signatureForLogin(auth.currentUser?.email));
  const [signatureTouched, setSignatureTouched] = useState(false);
  React.useEffect(() => {
    // auth.currentUser bývá při prvním vykreslení ještě prázdný, než Firebase
    // dokončí přihlášení — proto se na změnu ještě jednou počká.
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!signatureTouched) setSignatureId(signatureForLogin(u?.email));
    });
    return unsub;
  }, [signatureTouched]);
  React.useEffect(() => {
    let s = 'GRP';
    if (groupName) s += ' / ' + groupName;
    if (composeCity) s += ' / ' + formatCity(composeCity);
    setSubject(s);
  }, [groupName, composeCity]);
  const [sendResult, setSendResult]   = useState(null);
  const [sending, setSending]           = useState(false);
  const [sendProgress, setSendProgress] = useState('');
  const [extraEmail, setExtraEmail]     = useState('');

  const [logs, setLogs]               = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const fetchHotels = useCallback(async () => {
    setLoading(true);
    const snap = await getDocs(collection(db, 'hotels'));
    setHotels(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, []);

  const [cards, setCards]           = useState([]);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [cardBusy, setCardBusy]     = useState('');
  const [cardSearch, setCardSearch] = useState('');
  const [showOrange, setShowOrange] = useState(true);
  const [fixEdit, setFixEdit]       = useState({});
  const [nameEdit, setNameEdit]     = useState({});

  const fetchCards = useCallback(async () => {
    setCardsLoading(true);
    const snap = await getDocs(collection(db, 'hotelCards'));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => (a.city || '').localeCompare(b.city || '') || (a.name || '').localeCompare(b.name || ''));
    setCards(items);
    setCardsLoading(false);
  }, []);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    const snap = await getDocs(collection(db, 'hotelEmailLog'));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => (b.sentAt?.seconds||0) - (a.sentAt?.seconds||0));
    setLogs(items);
    setLogsLoading(false);
  }, []);

  useEffect(() => { fetchHotels(); }, [fetchHotels]);
  useEffect(() => { if (tab === 'log') fetchLogs(); }, [tab, fetchLogs]);
  useEffect(() => { if (tab === 'cards') fetchCards(); }, [tab, fetchCards]);

  // Vytvoří JEDNU kartu ze skupiny řádků a napojí na ni ty řádky.
  // Řádky v `hotels` zůstávají beze změny až na přidané `cardId` — rozesílání
  // poptávek na ně sahá dál stejně jako dosud.
  const createCardFromGroup = async (g) => {
    const emails = [...new Set(g.rows.map(r => String(r.email || '').toLowerCase()).filter(Boolean))];
    const ref = await addDoc(collection(db, 'hotelCards'), {
      name: g.name,
      city: g.city || '',
      country: '',
      aliases: g.aliases || [],
      domain: g.free ? '' : (g.domain || ''),
      emails: emails.map((e, i) => ({ email: e, role: '', person: '', main: i === 0 })),
      // Poznámky vytažené z názvu ("neberou skupiny", "jen 27 pokojů") — na
      // kartě zůstanou jako interní poznámka, do názvu se nevrací.
      notes: (g.notes || []).join(' · '),
      // Původ údajů — odkud se karta vzala. Podrobné ⓘ u jednotlivých polí
      // přibude s detailem karty; tohle je jeho základ.
      source: { type: 'hotels-db', label: 'Z databáze hotelů', at: new Date().toISOString() },
      createdAt: serverTimestamp(),
    });
    for (const r of g.rows) {
      await updateDoc(doc(db, 'hotels', r.id), { cardId: ref.id });
    }
    return ref.id;
  };

  const handleCreateCard = async (g) => {
    setCardBusy(g.key);
    try {
      await createCardFromGroup(g);
      await Promise.all([fetchHotels(), fetchCards()]);
    } catch (e) {
      alert('Kartu se nepodařilo vytvořit: ' + e.message);
    }
    setCardBusy('');
  };

  const handleCreateAllGreen = async (list) => {
    if (!window.confirm(`Vytvořit ${list.length} karet z jistých shod?\n\nŘádky v databázi hotelů se nezmění, jen se napojí na kartu. Rozesílání poptávek to nijak neovlivní.`)) return;
    setCardBusy('ALL');
    let made = 0, failed = 0;
    for (const g of list) {
      try { await createCardFromGroup(g); made++; } catch { failed++; }
    }
    await Promise.all([fetchHotels(), fetchCards()]);
    setCardBusy('');
    alert(`Hotovo. Vytvořeno karet: ${made}${failed ? `, chyb: ${failed}` : ''}.`);
  };

  // Sporný případ: uživatel řekl "je to jeden hotel" → jedna karta ze všech řádků.
  const handleMergeGroups = async (m) => {
    setCardBusy(m.key);
    try {
      const names = [...new Set(m.groups.flatMap(g => [g.name, ...(g.aliases || [])]).filter(Boolean))];
      names.sort((a, b) => b.length - a.length);
      await createCardFromGroup({
        key: m.key, name: names[0], aliases: names.slice(1),
        city: m.city, domain: '', free: false, rows: m.rows,
      });
      await Promise.all([fetchHotels(), fetchCards()]);
    } catch (e) { alert('Nepodařilo se spojit: ' + e.message); }
    setCardBusy('');
  };

  // Sporný případ: uživatel řekl "jsou to dva hotely" → karta pro každou skupinu.
  const handleKeepSeparate = async (m) => {
    setCardBusy(m.key);
    try {
      for (const g of m.groups) await createCardFromGroup(g);
      await Promise.all([fetchHotels(), fetchCards()]);
    } catch (e) { alert('Nepodařilo se vytvořit karty: ' + e.message); }
    setCardBusy('');
  };

  // Oprava jedné vadné adresy přímo v databázi hotelů. Mění se jen ten jeden
  // řádek, na kartách ani na rozesílání se nic dalšího nedotýká.
  const handleFixEmail = async (row) => {
    const val = String(fixEdit[row.id] ?? row.email).trim().toLowerCase();
    if (!val) { alert('Adresa nesmí být prázdná.'); return; }
    const problem = emailProblem(val);
    if (problem) { alert('Takhle to pořád nesedí: ' + problem); return; }
    const newName = String(nameEdit[row.id] ?? row.name ?? '').trim();
    setCardBusy(row.id);
    try {
      const patch = { email: val };
      if (newName !== String(row.name || '').trim()) patch.name = newName;
      await updateDoc(doc(db, 'hotels', row.id), patch);
      setFixEdit(prev => { const n = { ...prev }; delete n[row.id]; return n; });
      setNameEdit(prev => { const n = { ...prev }; delete n[row.id]; return n; });
      await fetchHotels();
    } catch (e) { alert('Nepodařilo se uložit: ' + e.message); }
    setCardBusy('');
  };

  const handleDeleteRow = async (row) => {
    if (!window.confirm(`Smazat řádek "${row.name || '—'}" (${row.email}) z databáze hotelů?\n\nTohle je nevratné.`)) return;
    setCardBusy(row.id);
    try {
      await deleteDoc(doc(db, 'hotels', row.id));
      await fetchHotels();
    } catch (e) { alert('Nepodařilo se smazat: ' + e.message); }
    setCardBusy('');
  };

  // Rozpojení karty: karta se smaže a její řádky se vrátí mezi nezařazené.
  // Nic z databáze hotelů se přitom nemaže.
  const handleUnlinkCard = async (card) => {
    const linked = hotels.filter(h => h.cardId === card.id);
    if (!window.confirm(`Zrušit kartu "${card.name}"?\n\n${linked.length} řádků se vrátí mezi nezařazené. Žádný hotel ani email se nesmaže.`)) return;
    setCardBusy(card.id);
    try {
      for (const r of linked) await updateDoc(doc(db, 'hotels', r.id), { cardId: '' });
      await deleteDoc(doc(db, 'hotelCards', card.id));
      await Promise.all([fetchHotels(), fetchCards()]);
    } catch (e) {
      alert('Nepodařilo se zrušit kartu: ' + e.message);
    }
    setCardBusy('');
  };

  const handleParse = () => {
    const city = importCity.trim().toUpperCase();
    const raw = parseSimple(importText);
    setParsed(raw.map(h => ({ ...h, city: city || h.city || '?' })));
  };

  const handleImport = async () => {
    setImporting(true);
    const existingEmails = new Set(hotels.map(h => h.email?.toLowerCase()));
    let added = 0, skipped = 0;
    for (const h of parsed) {
      if (existingEmails.has(h.email.toLowerCase())) { skipped++; continue; }
      await addDoc(collection(db, 'hotels'), { city: h.city, name: h.name, email: h.email });
      added++;
    }
    setImportDone({ added, skipped });
    setImporting(false);
    setImportText(''); setParsed([]);
    fetchHotels();
  };

  const deleteHotel = async (id) => {
    if (!window.confirm('Smazat hotel?')) return;
    await deleteDoc(doc(db, 'hotels', id));
    setSelected(s => s.filter(x => x !== id));
    fetchHotels();
  };

  const saveEdit = async () => {
    await updateDoc(doc(db, 'hotels', editRow.id), { city: editRow.city, name: editRow.name, email: editRow.email });
    setEditRow(null);
    fetchHotels();
  };

  const addHotel = async () => {
    if (!newHotel.email.trim()) { alert('Email je povinný.'); return; }
    await addDoc(collection(db, 'hotels'), { city: newHotel.city.trim(), name: newHotel.name.trim(), email: newHotel.email.trim().toLowerCase() });
    setNewHotel({ city: '', name: '', email: '' });
    setShowAdd(false);
    fetchHotels();
  };

  // Convert YYYY-MM-DD (HTML date input format) to DD/MM/YYYY, since European
  // recipients read day-first dates and the ISO format was confusing them.
  const fmtDateEU = (d) => {
    if (!d) return '';
    const parts = d.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return d;
  };

  const buildBody = () => {
    const currentText = editMode === 'visual' && visualEditorRef.current
      ? visualEditorRef.current.value
      : null;
    const base = currentText ? plainToHtml(currentText) : (emailBody.startsWith('<PLAIN>') ? plainToHtml(emailBody.slice(7, -8)) : emailBody);
    return base
    .replace(/{{groupName}}/g, groupName||'[GROUP NAME]')
    .replace(/{{checkIn}}/g, fmtDateEU(checkIn)||'[CHECK-IN]')
    .replace(/{{checkOut}}/g, fmtDateEU(checkOut)||'[CHECK-OUT]')
    .replace(/{{freeRatio}}/g, freeRatio||'20')
    .replace(/{{signature}}/g, SIGNATURES.find(s => s.id === signatureId)?.html || '');
  };

  const toggleSelect = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const handleSend = async () => {
    if (!selected.length) { alert('Vyber alespoň jeden hotel.'); return; }
    // Poslední pojistka: kdyby se značka {{signature}} z textu ztratila, email
    // by odešel bez podpisu. Radši se zeptáme, než se rozešle na desítky hotelů.
    const sigHtml = SIGNATURES.find(s => s.id === signatureId)?.html || '';
    if (sigHtml && !buildBody().includes(sigHtml)) {
      if (!window.confirm('V textu emailu není podpis — značka {{signature}} chybí.\n\nOdeslat i tak, bez podpisu?')) return;
    }
    setSending(true);
    const body = buildBody();
    const sel = hotels.filter(h => selected.includes(h.id));
    setSendResult(null);
    setSendProgress(`Odesílám ${sel.length} emailů...`);
    let sent = 0, failed = 0;
    try {
      const res = await fetch('https://tour-pragenses.com/mailer.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [...sel.map(h => ({ email: h.email, name: h.name||h.email })), ...(extraEmail.trim() ? [{ email: extraEmail.trim(), name: 'Extra' }] : [])], subject, body, from: senderFrom }),
      });
      const data = await res.json();
      if (data.results) {
        for (let i = 0; i < sel.length; i++) {
          const h = sel[i];
          setSendProgress(`Zaznamenávám ${i+1}/${sel.length}`);
          if (data.results[i] && data.results[i].ok) {
            try {
              await addDoc(collection(db, 'hotelEmailLog'), {
                hotelId: h.id, hotelName: h.name||h.email, hotelCity: h.city,
                email: h.email, subject, groupName, checkIn, checkOut,
                sentAt: serverTimestamp(), status: 'sent',
              });
            } catch (logErr) {
              // The email itself was sent successfully (mailer.php confirmed it) —
              // a failure to write the log entry must never be reported as a
              // failed send.
              console.error('Failed to write hotelEmailLog entry (email was still sent):', logErr);
            }
            sent++;
          } else { failed++; }
        }
        // Count extra email result (no logging needed)
        if (extraEmail.trim() && data.results[sel.length]) {
          if (data.results[sel.length].ok) sent++; else failed++;
        }
      } else { alert('Chyba: ' + JSON.stringify(data)); failed = sel.length; }
    } catch (e) {
      alert('Chyba: ' + e.message); failed = sel.length;
    }
    setSending(false);
    setSendProgress('');
    if (sent > 0) {
      setSendResult({ sent, failed });
      setGroupName(''); setCheckIn(''); setCheckOut('');
      setSelected([]);
      setTab('log'); fetchLogs();
    } else {
      alert('Nepodařilo se odeslat žádný email. Chyby: ' + failed);
    }
  };

  const cities = [...new Set(hotels.map(h => h.city).filter(Boolean))].sort();
  const dbFiltered = hotels.filter(h => {
    const q = search.toLowerCase();
    return (!q || h.name?.toLowerCase().includes(q) || h.city?.toLowerCase().includes(q) || h.email?.toLowerCase().includes(q))
      && (!cityFilter || h.city === cityFilter);
  });
  // Seznam hotelů u poptávky: nejdřív město, pak textové hledání.
  // Hledá se v názvu, městě i adrese; slova se vyhodnocují jako "a zároveň",
  // takže "vienna prah" najde Vienna House v Praze. Diakritika se ignoruje.
  const composeBase = composeCity ? hotels.filter(h => h.city === composeCity) : hotels;
  const composeWords = stripDia(composeSearch.toLowerCase()).split(/\s+/).filter(Boolean);
  const composeHotels = composeWords.length === 0 ? composeBase : composeBase.filter(h => {
    const hay = stripDia(`${h.name || ''} ${h.city || ''} ${h.email || ''}`.toLowerCase());
    return composeWords.every(w => hay.includes(w));
  });
  // Zaškrtnutí se filtrem NIKDY neruší — hotel vybraný před hledáním zůstane
  // vybraný, i když ho filtr zrovna schová. Tady jen spočítáme, kolik jich je,
  // aby to uživatel viděl a neodeslal omylem víc, než čeká.
  const hiddenSelected = selected.filter(id => !composeHotels.some(h => h.id === id)).length;

  // Kontrola, jestli je v textu ještě značka pro podpis. Uživatel ji může
  // omylem smazat při úpravách — pak by email odešel bez podpisu.
  const currentBodyText = editMode === 'visual' && visualEditorRef.current
    ? visualEditorRef.current.value
    : emailBody;
  const signatureMarkerPresent = currentBodyText.includes('{{signature}}');

  const suggestions = React.useMemo(() => buildCardSuggestions(hotels), [hotels]);
  const unassignedCount = hotels.filter(h => !h.cardId).length;

  // Podklad pro záložku Kontrola adres — vadné adresy, chybějící názvy a duplicity.
  const cleanupRows = React.useMemo(() => {
    const counts = new Map();
    hotels.forEach(h => {
      const e = String(h.email || '').toLowerCase();
      if (e) counts.set(e, (counts.get(e) || 0) + 1);
    });
    const out = [];
    for (const h of hotels) {
      const e = String(h.email || '').toLowerCase();
      const problem = emailProblem(h.email);
      if (problem) { out.push({ row: h, kind: 'bad', problem }); continue; }
      if (!isRealName(h.name)) { out.push({ row: h, kind: 'name', problem: 'Chybí název hotelu — ve sloupci je ' + (h.name ? `"${h.name}"` : 'prázdno') }); continue; }
      if (nameHasNote(h.name)) {
        const sp = splitNameNote(h.name);
        out.push({ row: h, kind: 'note', problem: sp.name ? `V názvu je poznámka — hotel: "${sp.name}", poznámka: "${sp.note}"` : `Celý název je poznámka: "${sp.note}"` });
        continue;
      }
      const n = counts.get(e) || 0;
      if (n > 1 && n < SHARED_EMAIL_MIN) out.push({ row: h, kind: 'dup', problem: `Stejná adresa je na ${n} řádcích` });
    }
    const order = { bad: 0, name: 1, note: 2, dup: 3 };
    return out.sort((a, b) => order[a.kind] - order[b.kind] || (a.row.city || '').localeCompare(b.row.city || ''));
  }, [hotels]);
  const cardsFiltered = cards.filter(c => {
    const q = cardSearch.trim().toLowerCase();
    if (!q) return true;
    return (c.name || '').toLowerCase().includes(q)
      || (c.city || '').toLowerCase().includes(q)
      || (c.emails || []).some(e => (e.email || '').includes(q));
  });

  const thS = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${C.border}` };
  const tdS = { padding: '8px 12px', verticalAlign: 'middle', fontSize: 13 };
  const cardS = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '1.2rem' };
  const inp = (extra={}) => ({ width: '100%', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box', ...extra });
  const btn = (bg, fg='#fff') => ({ padding: '7px 18px', background: bg, color: fg, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'Georgia, serif', fontWeight: 600 });
  const smallBtn = (bg) => ({ padding: '3px 9px', background: bg, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 });

  return (
    <div style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto', fontFamily: 'Georgia, serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 22, color: C.primary, margin: 0, fontWeight: 600 }}>🏨 Hotels</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '4px 0 0' }}>Import · Databáze · Poptávky · Log · Karty · Kontrola</p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: '1.5rem', borderBottom: `1px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 18px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 14, fontFamily: 'Georgia, serif', color: tab===t.id ? C.primary : C.muted,
            fontWeight: tab===t.id ? 700 : 400,
            borderBottom: tab===t.id ? `2px solid ${C.accent}` : '2px solid transparent', marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── IMPORT ── */}
      {tab === 'import' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'start' }}>
          <div style={cardS}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Vložit text z Google Drive</h3>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Město</label>
              <input value={importCity} onChange={e => setImportCity(e.target.value)} placeholder="např. ST. MORITZ" style={inp()} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Text (copy-paste z Google Drive)</label>
              <textarea value={importText} onChange={e => setImportText(e.target.value)} rows={14}
                placeholder={"BERGHOTEL RANDOLINS\nwillkommen@randolins.ch\nGRAND HOTEL KEMPINSKI\ninfo.stmoritz@kempinski.com"}
                style={{ ...inp(), resize: 'vertical', lineHeight: 1.6 }} />
            </div>
            <button onClick={handleParse} style={btn(C.primary)}>🔍 Rozpoznat</button>
          </div>

          <div>
            {parsed.length > 0 && (
              <div style={cardS}>
                <h3 style={{ margin: '0 0 10px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Rozpoznáno: {parsed.length} hotelů</h3>
                <div style={{ maxHeight: 300, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 12 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead><tr style={{ background: C.bg }}>{['Město','Název','Email'].map(h=><th key={h} style={thS}>{h}</th>)}</tr></thead>
                    <tbody>
                      {parsed.map((h,i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={tdS}>{h.city||<span style={{color:'#e53'}}>?</span>}</td>
                          <td style={tdS}>{h.name||'—'}</td>
                          <td style={tdS}>{h.email}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <button onClick={handleImport} disabled={importing} style={btn(C.success)}>
                  {importing ? 'Importuji…' : `✓ Importovat ${parsed.length} hotelů`}
                </button>
              </div>
            )}
            {importDone && (
              <div style={{ ...cardS, marginTop: 12, background: '#e8f5e9' }}>
                <p style={{ margin: 0, color: C.success }}>✓ Přidáno: <strong>{importDone.added}</strong> · Přeskočeno: <strong>{importDone.skipped}</strong></p>
                <button onClick={() => { setImportDone(null); setTab('db'); }} style={{ marginTop: 10, ...btn(C.primary) }}>→ Databáze</button>
              </div>
            )}
            {!parsed.length && !importDone && (
              <div style={{ ...cardS, color: C.muted, fontSize: 13, lineHeight: 1.9 }}>
                <strong style={{ color: C.primary }}>Jak importovat:</strong><br/>
                1. Zadej město nahoře<br/>
                2. Vlož text z Google Drive<br/>
                3. Klikni Rozpoznat → Importovat
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DB ── */}
      {tab === 'db' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat…" style={{ flex: 1, minWidth: 180, ...inp() }} />
            <select value={cityFilter} onChange={e => setCityFilter(e.target.value)}
              style={{ padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif' }}>
              <option value="">Všechna města ({hotels.length})</option>
              {cities.map(c => <option key={c} value={c}>{c} ({hotels.filter(h=>h.city===c).length})</option>)}
            </select>
            <button onClick={() => { setShowAdd(true); setNewHotel({ city: cityFilter, name: '', email: '' }); }} style={btn(C.primary)}>+ Přidat ručně</button>
            {cityFilter && (
              <button onClick={async () => {
                if (!window.confirm('Smazat všechny hotely města ' + cityFilter + '? (' + hotels.filter(h => h.city === cityFilter).length + ' hotelů)')) return;
                if (!window.confirm('Jsi si jistá? Tato akce je nevratná.')) return;
                const toDelete = hotels.filter(h => h.city === cityFilter);
                for (const h of toDelete) await deleteDoc(doc(db, 'hotels', h.id));
                setCityFilter('');
                fetchHotels();
              }} style={btn(C.danger)}>🗑 Smazat město</button>
            )}
          </div>

          {showAdd && (
            <div style={{ ...cardS, marginBottom: '1rem', background: '#fffbf0', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              {[['Město', 'city'], ['Název', 'name'], ['Email *', 'email']].map(([label, key]) => (
                <div key={key} style={{ flex: 1, minWidth: 150 }}>
                  <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>{label}</label>
                  <input value={newHotel[key]} onChange={e => setNewHotel({...newHotel, [key]: e.target.value})} style={inp()} />
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={addHotel} style={btn(C.success)}>✓ Přidat</button>
                <button onClick={() => setShowAdd(false)} style={btn(C.muted)}>✕</button>
              </div>
            </div>
          )}

          {loading ? <p style={{ color: C.muted }}>Načítám…</p> : dbFiltered.length === 0 ? (
            <p style={{ color: C.muted }}>Žádné hotely. Použij Import nebo Přidat ručně.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: C.bg }}>
                  {['Město','Název','Email',''].map(h=><th key={h} style={thS}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {dbFiltered.map(h => (
                    editRow?.id === h.id ? (
                      <tr key={h.id} style={{ borderBottom: `1px solid ${C.border}`, background: '#fffbf0' }}>
                        <td style={tdS}><input value={editRow.city} onChange={e => setEditRow({...editRow, city: e.target.value})} style={inp({padding:'4px 6px'})} /></td>
                        <td style={tdS}><input value={editRow.name} onChange={e => setEditRow({...editRow, name: e.target.value})} style={inp({padding:'4px 6px'})} /></td>
                        <td style={tdS}><input value={editRow.email} onChange={e => setEditRow({...editRow, email: e.target.value})} style={inp({padding:'4px 6px'})} /></td>
                        <td style={tdS}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={saveEdit} style={smallBtn(C.success)}>✓</button>
                            <button onClick={() => setEditRow(null)} style={smallBtn(C.muted)}>✕</button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={h.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={tdS}>{h.city||'—'}</td>
                        <td style={tdS}>{h.name||'—'}</td>
                        <td style={tdS}><a href={`mailto:${h.email}`} style={{ color: C.primary }}>{h.email}</a></td>
                        <td style={tdS}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button onClick={() => setEditRow({id:h.id, city:h.city||'', name:h.name||'', email:h.email||''})} style={smallBtn(C.primary)}>✎</button>
                            <button onClick={() => deleteHotel(h.id)} style={smallBtn(C.danger)}>✕</button>
                          </div>
                        </td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{dbFiltered.length} hotelů</p>
            </div>
          )}
        </div>
      )}

      {/* ── CITY LIST Z OFFER ── */}
      {tab === 'compose' && cityList && cityList.length > 0 && !activeCityPrefill && (
        <div style={cardS}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>
            Města z itineráře — vyber město pro poptávku
          </h3>
          <p style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Skupina: <strong>{prefillGroupName}</strong></p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: C.bg }}>
              {['Město','Check-in','Check-out',''].map(h => <th key={h} style={thS}>{h}</th>)}
            </tr></thead>
            <tbody>
              {cityList.map((c, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={tdS}><strong>{c.city}</strong></td>
                  <td style={tdS}>{c.checkIn}</td>
                  <td style={tdS}>{c.checkOut}</td>
                  <td style={tdS}>
                    <button onClick={() => {
                      setActiveCityPrefill(c);
                      setGroupName(prefillGroupName);
                      setCheckIn(c.checkIn);
                      setCheckOut(c.checkOut);
                      setComposeCity(c.city);
                      setSelected([]);
                    }} style={{ padding: '4px 14px', background: C.primary, color: '#fff', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontFamily: 'Georgia, serif' }}>
                      ✉ Poslat
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── COMPOSE ── */}
      {tab === 'compose' && (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1.5rem', alignItems: 'start' }}>
          <div>
            <div style={cardS}>
              {cityList && activeCityPrefill && (
                <button onClick={() => setActiveCityPrefill(null)} style={{ fontSize: 12, color: C.primary, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', marginBottom: 10, display: 'block' }}>
                  ← Zpět na seznam měst
                </button>
              )}
              <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Skupina</h3>
              {[
                ['Název skupiny', groupName, setGroupName, 'text'],
                ['Check-in', checkIn, setCheckIn, 'date'],
                ['Check-out', checkOut, setCheckOut, 'date'],
                ['1 pokoj zdarma za X placených', freeRatio, setFreeRatio, 'number'],
              ].map(([label, val, setter, type]) => (
                <div key={label} style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>{label}</label>
                  <input type={type} value={val} onChange={e => setter(e.target.value)} style={inp()} />
                </div>
              ))}
            </div>
            <div style={{ ...cardS, marginTop: 12 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Hotely ({selected.length} vybráno)</h3>
              <select value={composeCity} onChange={e => { setComposeCity(e.target.value); setComposeSearch(''); setSelected([]); }} style={{ ...inp(), marginBottom: 8 }}>
                <option value="">Všechna města</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={{ position: 'relative', marginBottom: 8 }}>
                <input
                  value={composeSearch}
                  onChange={e => setComposeSearch(e.target.value)}
                  placeholder="🔍 Hledat hotel podle jména, města nebo adresy…"
                  style={inp({ paddingRight: 28 })} />
                {composeSearch && (
                  <button onClick={() => setComposeSearch('')} title="Zrušit hledání"
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: C.muted, fontSize: 14, lineHeight: 1, padding: 2 }}>✕</button>
                )}
              </div>
              {composeWords.length > 0 && (
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
                  Nalezeno {composeHotels.length} z {composeBase.length}
                  {hiddenSelected > 0 && <span style={{ color: '#e08a00' }}> · {hiddenSelected} vybraných je schovaných filtrem (odešlou se taky)</span>}
                </div>
              )}
              <div style={{ maxHeight: 280, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
                {composeHotels.map(h => (
                  <label key={h.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', cursor: 'pointer', borderBottom: `1px solid ${C.border}`, background: selected.includes(h.id) ? '#f0f7ff' : '#fff' }}>
                    <input type="checkbox" checked={selected.includes(h.id)} onChange={() => toggleSelect(h.id)} style={{ marginTop: 2 }} />
                    <div>
                      {h.name && <div style={{ fontSize: 12, fontWeight: 600 }}>{h.name}</div>}
                      <div style={{ fontSize: 11, color: C.muted }}>{h.city} · {h.email}</div>
                    </div>
                  </label>
                ))}
                {composeHotels.length === 0 && (
                  <p style={{ padding: 12, color: C.muted, fontSize: 12 }}>
                    {composeWords.length > 0 ? 'Hledání nic nenašlo — zkus jiné slovo nebo hledání zruš křížkem.' : 'Žádné hotely.'}
                  </p>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                {/* Přidává k výběru, nepřepisuje ho — jinak by při zapnutém hledání
                    tiše zmizely hotely vybrané předtím. Odznačit vše je vedle. */}
                <button onClick={() => setSelected(s => [...new Set([...s, ...composeHotels.map(h=>h.id)])])} style={{ fontSize: 11, color: C.primary, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>
                  {composeWords.length > 0 ? `Vybrat nalezené (${composeHotels.length})` : 'Vybrat vše'}
                </button>
                <button onClick={() => setSelected([])} style={{ fontSize: 11, color: C.muted, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>Odznačit</button>
              </div>
            </div>
          </div>

          <div style={cardS}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Email</h3>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Odesílat z</label>
              <select value={senderFrom} onChange={e => setSenderFrom(e.target.value)} style={inp()}>
                <option value="grupos">grupos@tour-pragenses.com</option>
                <option value="reservas3">reservas3@tour-pragenses.com</option>
                <option value="info">info@tour-pragenses.com</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Podpis</label>
              <select value={signatureId} onChange={e => { setSignatureId(e.target.value); setSignatureTouched(true); }} style={inp()}>
                {SIGNATURES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              {!signatureMarkerPresent && (
                <div style={{ fontSize: 11, color: '#e08a00', marginTop: 4 }}>
                  ⚠ V textu emailu chybí značka <code>{'{{signature}}'}</code> — podpis se nedoplní. Vrať ji na konec textu.
                </div>
              )}
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Předmět</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={inp()} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <label style={{ fontSize: 11, color: C.muted }}>Text emailu</label>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => setEditMode('visual')}
                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: `1px solid ${C.border}`, background: editMode === 'visual' ? C.primary : 'transparent', color: editMode === 'visual' ? '#fff' : C.muted, cursor: 'pointer' }}>
                    ✏️ Upravit
                  </button>
                  <button onClick={() => setEditMode('code')}
                    style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, border: `1px solid ${C.border}`, background: editMode === 'code' ? C.primary : 'transparent', color: editMode === 'code' ? '#fff' : C.muted, cursor: 'pointer' }}>
                    &lt;/&gt; HTML
                  </button>
                </div>
              </div>
              {editMode === 'visual' ? (
                <textarea
                  ref={visualEditorRef}
                  key={emailBody.slice(0, 50)}
                  defaultValue={htmlToPlain(emailBody)}
                  rows={30}
                  style={{ ...inp(), resize: 'vertical', lineHeight: 1.8, fontFamily: 'Georgia, serif' }}
                  placeholder="Napiš nebo uprav text emailu..."
                />
              ) : (
                <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={16} style={{ ...inp(), resize: 'vertical', lineHeight: 1.6, fontFamily: 'monospace', fontSize: 11 }} />
              )}
            </div>
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 12, color: C.primary, cursor: 'pointer' }}>Náhled s doplněnými údaji</summary>
              <pre style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: C.bg, padding: 12, borderRadius: 6, marginTop: 6 }}>{buildBody()}</pre>
            </details>
            {selected.length > 0 && (
              <div style={{ background: C.bg, borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
                <strong>Příjemci ({selected.length}):</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {hotels.filter(h=>selected.includes(h.id)).map(h => (
                    <li key={h.id} style={{ fontSize: 12 }}>{h.name||h.email} <span style={{ color: C.muted }}>· {h.email}</span></li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Odeslat také na (volitelné — např. testovací adresa)</label>
              <input type="email" value={extraEmail} onChange={e => setExtraEmail(e.target.value)}
                placeholder="test@mail-tester.com" style={{ ...inp() }} />
            </div>
            <button onClick={handleSend} disabled={!selected.length || sending} style={{ ...btn(selected.length && !sending ? C.primary : C.border, selected.length && !sending ? '#fff' : C.muted), fontSize: 15, padding: '10px 24px' }}>
              {sending ? sendProgress || 'Připravuji...' : `✉ Odeslat na ${selected.length} hotel${selected.length===1?'':selected.length<5?'y':'ů'}`}
            </button>
            <button onClick={async () => {
              const r = await fetch('https://tour-pragenses.com/mailer.php', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:'info@tour-pragenses.com',subject:'Test z aplikace',body:'Test'})});
              const d = await r.json();
              alert(JSON.stringify(d));
            }} style={{ ...btn('#888'), fontSize: 12, padding: '6px 12px' }}>🔧 Test</button>
            {sendResult && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: sendResult.failed ? '#fff3e0' : '#e8f5e9', borderRadius: 6, fontSize: 13 }}>
                {sendResult.sent > 0 && <div style={{ color: C.success }}>✓ Odesláno: <strong>{sendResult.sent}</strong> emailů</div>}
                {sendResult.failed > 0 && <div style={{ color: C.warning, marginTop: 4 }}>⚠ Nepodařilo se: <strong>{sendResult.failed}</strong> emailů</div>}
                <button onClick={() => setTab('log')} style={{ marginTop: 6, fontSize: 12, color: C.primary, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>→ Log</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── LOG ── */}
      {tab === 'log' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: 16, color: C.primary }}>Historie odeslaných poptávek</h3>
            <button onClick={fetchLogs} style={btn(C.primary)}>↻ Obnovit</button>
          </div>
          {logsLoading ? <p style={{ color: C.muted }}>Načítám…</p> : logs.length===0 ? <p style={{ color: C.muted }}>Zatím nic odesláno.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: C.bg }}>
                  {['Datum','Hotel','Město','Email','Skupina','Check-in','Check-out'].map(h=><th key={h} style={thS}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {logs.map(l => (
                    <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={tdS}>{fmt(l.sentAt)}</td>
                      <td style={tdS}><strong>{l.hotelName}</strong></td>
                      <td style={tdS}>{l.hotelCity||'—'}</td>
                      <td style={tdS}><a href={`mailto:${l.email}`} style={{ color: C.primary }}>{l.email}</a></td>
                      <td style={tdS}>{l.groupName||'—'}</td>
                      <td style={tdS}>{l.checkIn||'—'}</td>
                      <td style={tdS}>{l.checkOut||'—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{logs.length} záznamů</p>
            </div>
          )}
        </div>
      )}

      {/* ── KARTY ── */}
      {tab === 'cards' && (
        <div>
          <div style={{ ...cardS, marginBottom: '1.2rem', background: '#f8f9fb' }}>
            <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              Databáze hotelů má <strong>jeden řádek na emailovou adresu</strong>, takže jeden hotel se třemi
              adresami je v ní třikrát. Karta ty řádky spojí do <strong>jednoho hotelu</strong>.
              Původní řádky se nemažou ani nemění a rozesílání poptávek funguje dál úplně stejně.
              Nic se nespojí samo — každou kartu odklepneš ty a jde kdykoliv zrušit.
            </p>
          </div>

          {loading || cardsLoading ? <p style={{ color: C.muted }}>Načítám…</p> : (
            <>
              <div style={{ display: 'flex', gap: 10, marginBottom: '1.2rem', flexWrap: 'wrap' }}>
                <div style={{ ...cardS, flex: 1, minWidth: 140, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: C.primary }}>{cards.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>hotových karet</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 140, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#2e7d32' }}>{suggestions.green.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>jistých shod</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 140, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#b8860b' }}>{suggestions.chain.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>hotelů v řetězcích</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 140, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#e08a00' }}>{suggestions.merge.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>k rozhodnutí</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 140, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#b00020' }}>{suggestions.unnamed.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>bez názvu</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 140, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: C.muted }}>{unassignedCount}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>nezařazených řádků</div>
                </div>
              </div>

              {suggestions.broken.length > 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem', background: '#fdf3f3', borderColor: '#e0a0a0' }}>
                  <strong style={{ fontSize: 14 }}>🧹 {suggestions.broken.length} řádků má vadnou adresu</strong>
                  <p style={{ fontSize: 12, color: C.muted, margin: '4px 0 8px' }}>
                    Do karet se nepočítají, dokud je neopravíš — jinak by dělaly falešné skupiny.
                    Na tyhle adresy vám navíc poptávky nikdy nedošly.
                  </p>
                  <button onClick={() => setTab('clean')} style={smallBtn(C.primary)}>Otevřít kontrolu adres</button>
                </div>
              )}

              {suggestions.unnamed.length > 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem', background: '#fdf3f3', borderColor: '#e0a0a0' }}>
                  <strong style={{ fontSize: 14 }}>📝 {suggestions.unnamed.length} hotelů nemá název</strong>
                  <p style={{ fontSize: 12, color: C.muted, margin: '4px 0 8px' }}>
                    Do hromadného vytváření nejdou — vznikly by karty jménem „(bez názvu) h0747@accor.com".
                    Pojmenuj je v Kontrole adres a přesunou se mezi jisté shody. Jednotlivě vytvořit je jde i tak.
                  </p>
                  <button onClick={() => setTab('clean')} style={smallBtn(C.primary)}>Otevřít kontrolu adres</button>
                </div>
              )}

              {/* 🟠 K ROZHODNUTÍ — nahoře, protože jen tohle vyžaduje uživatele */}
              {suggestions.merge.length > 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem', borderColor: '#e0b060' }}>
                  <h3 style={{ margin: '0 0 6px', fontSize: 15, color: C.primary }}>🟠 K rozhodnutí ({suggestions.merge.length})</h3>
                  <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>
                    Buď stejný název pod dvěma doménami, nebo jedna adresa u dvou různých názvů.
                    Pokud je adresa společná rezervační centrála, dej „Nechat zvlášť" — adresa zůstane
                    na obou kartách, nikomu se neodebere.
                  </p>
                  <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                    {suggestions.merge.map(m => (
                      <div key={m.key} style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 10, background: '#fffdf5' }}>
                        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>
                          {m.name} <span style={{ fontWeight: 400, color: C.muted, fontSize: 12 }}>· {m.city || 'bez města'}</span>
                        </div>
                        <div style={{ fontSize: 11, color: '#a06800', marginBottom: 6 }}>{m.why}</div>
                        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                          {m.groups.map(g => (
                            <div key={g.key} style={{ fontSize: 12, minWidth: 200 }}>
                              <div style={{ color: C.muted }}>{g.domain || 'freemail'}</div>
                              {g.rows.map(r => <div key={r.id}>{r.email}</div>)}
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => handleMergeGroups(m)} disabled={!!cardBusy}
                            style={{ ...smallBtn('#2e7d32'), opacity: cardBusy ? 0.5 : 1 }}>
                            {cardBusy === m.key ? '…' : 'Spojit do jedné karty'}
                          </button>
                          <button onClick={() => handleKeepSeparate(m)} disabled={!!cardBusy}
                            style={{ ...smallBtn(C.muted), opacity: cardBusy ? 0.5 : 1 }}>
                            Nechat zvlášť
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 🟢 JISTÉ SHODY */}
              {suggestions.green.length > 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: C.primary }}>🟢 Jisté shody ({suggestions.green.length})</h3>
                    <button onClick={() => handleCreateAllGreen(suggestions.green)} disabled={!!cardBusy}
                      style={{ ...btn('#2e7d32'), opacity: cardBusy ? 0.5 : 1 }}>
                      {cardBusy === 'ALL' ? 'Vytvářím…' : `Vytvořit všechny (${suggestions.green.length})`}
                    </button>
                  </div>
                  <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr>
                        <th style={thS}>Hotel</th><th style={thS}>Město</th>
                        <th style={thS}>Adresy</th><th style={thS}>Proč</th><th style={thS}></th>
                      </tr></thead>
                      <tbody>
                        {suggestions.green.map(g => (
                          <tr key={g.key} style={{ borderBottom: `1px solid ${C.border}` }}>
                            <td style={tdS}>
                              <strong>{g.name}</strong>
                              {g.aliases.length > 0 && <div style={{ fontSize: 11, color: C.muted }}>také jako: {g.aliases.join(' · ')}</div>}
                              {g.noName && <div style={{ fontSize: 11, color: '#b00020' }}>chybí název — doplň v Kontrole adres</div>}
                            </td>
                            <td style={tdS}>{g.city || '—'}</td>
                            <td style={tdS}>{g.rows.map(r => <div key={r.id} style={{ fontSize: 12 }}>{r.email}</div>)}</td>
                            <td style={{ ...tdS, fontSize: 11, color: C.muted }}>
                              {g.reason}
                              {g.shared && <div style={{ color: '#e08a00' }}>sdílená adresa — je i na jiných hotelech</div>}
                            </td>
                            <td style={{ ...tdS, textAlign: 'right' }}>
                              <button onClick={() => handleCreateCard(g)} disabled={!!cardBusy}
                                style={{ ...smallBtn('#2e7d32'), opacity: cardBusy ? 0.5 : 1 }}>
                                {cardBusy === g.key ? '…' : 'Vytvořit'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 🟡 HOTELY V ŘETĚZCÍCH */}
              {suggestions.chain.length > 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: C.primary }}>🟡 Hotely v řetězcích ({suggestions.chain.length})</h3>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button onClick={() => setShowOrange(v => !v)}
                        style={{ background: 'none', border: 'none', color: C.primary, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
                        {showOrange ? 'skrýt' : 'zobrazit'}
                      </button>
                      <button onClick={() => handleCreateAllGreen(suggestions.chain)} disabled={!!cardBusy}
                        style={{ ...btn('#b8860b'), opacity: cardBusy ? 0.5 : 1 }}>
                        {cardBusy === 'ALL' ? 'Vytvářím…' : `Vytvořit všechny (${suggestions.chain.length})`}
                      </button>
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>
                    Sdílejí doménu řetězce (accor.com, hilton.com…), ale <strong>každý je samostatný hotel</strong> a
                    dostane vlastní kartu. Nic se tu nespojuje — vypsané jsou zvlášť jen proto, abys je viděl.
                  </p>
                  {showOrange && (
                    <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={thS}>Hotel</th><th style={thS}>Město</th>
                          <th style={thS}>Adresy</th><th style={thS}>Řetězec</th><th style={thS}></th>
                        </tr></thead>
                        <tbody>
                          {suggestions.chain.map(g => (
                            <tr key={g.key} style={{ borderBottom: `1px solid ${C.border}` }}>
                              <td style={tdS}>
                                <strong>{g.name}</strong>
                                {g.aliases.length > 0 && <div style={{ fontSize: 11, color: C.muted }}>také jako: {g.aliases.join(' · ')}</div>}
                              </td>
                              <td style={tdS}>{g.city || '—'}</td>
                              <td style={tdS}>{g.rows.map(r => <div key={r.id} style={{ fontSize: 12 }}>{r.email}</div>)}</td>
                              <td style={{ ...tdS, fontSize: 11, color: C.muted }}>{g.domain}</td>
                              <td style={{ ...tdS, textAlign: 'right' }}>
                                <button onClick={() => handleCreateCard(g)} disabled={!!cardBusy}
                                  style={{ ...smallBtn('#b8860b'), opacity: cardBusy ? 0.5 : 1 }}>
                                  {cardBusy === g.key ? '…' : 'Vytvořit'}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {suggestions.green.length === 0 && suggestions.chain.length === 0 && suggestions.merge.length === 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem', textAlign: 'center', color: C.muted, fontSize: 13 }}>
                  Všechny řádky databáze jsou zařazené na kartu. Nic ke zpracování.
                </div>
              )}

              {/* HOTOVÉ KARTY */}
              <div style={cardS}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 15, color: C.primary }}>🗂 Karty hotelů ({cards.length})</h3>
                  <input value={cardSearch} onChange={e => setCardSearch(e.target.value)}
                    placeholder="Hledat kartu…" style={inp({ width: 220 })} />
                </div>
                {cards.length === 0 ? (
                  <p style={{ color: C.muted, fontSize: 13, margin: 0 }}>Zatím žádné karty. Vytvoř je ze seznamu nahoře.</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={thS}>Hotel</th><th style={thS}>Město</th>
                      <th style={thS}>Adresy</th><th style={thS}>Původ</th><th style={thS}></th>
                    </tr></thead>
                    <tbody>
                      {cardsFiltered.map(c => (
                        <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={tdS}>
                            <strong>{c.name}</strong>
                            {(c.aliases || []).length > 0 && <div style={{ fontSize: 11, color: C.muted }}>také jako: {c.aliases.join(' · ')}</div>}
                          </td>
                          <td style={tdS}>{c.city || '—'}</td>
                          <td style={tdS}>
                            {(c.emails || []).map(e => (
                              <div key={e.email} style={{ fontSize: 12 }}>
                                <a href={`mailto:${e.email}`} style={{ color: C.primary }}>{e.email}</a>
                                {e.main && <span style={{ fontSize: 10, color: C.muted }}> · hlavní</span>}
                              </div>
                            ))}
                          </td>
                          <td style={{ ...tdS, fontSize: 11, color: C.muted }}
                              title={c.source?.at ? `Zapsáno ${new Date(c.source.at).toLocaleDateString('cs-CZ')}` : ''}>
                            ⓘ {c.source?.label || 'Zdroj neznámý'}
                          </td>
                          <td style={{ ...tdS, textAlign: 'right' }}>
                            <button onClick={() => handleUnlinkCard(c)} disabled={!!cardBusy}
                              style={{ ...smallBtn('#b00020'), opacity: cardBusy ? 0.5 : 1 }}>
                              {cardBusy === c.id ? '…' : 'Zrušit'}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── KONTROLA ADRES ── */}
      {tab === 'clean' && (
        <div>
          <div style={{ ...cardS, marginBottom: '1.2rem', background: '#f8f9fb' }}>
            <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              Sem se sesypalo všechno, co v databázi hotelů nesedí — slepené adresy z importu,
              řádky bez názvu a duplicity. Opravuje se přímo v databázi, po jednom řádku.
              Dokud tu adresa visí, do karet se nepočítá.
            </p>
          </div>

          {loading ? <p style={{ color: C.muted }}>Načítám…</p> : cleanupRows.length === 0 ? (
            <div style={{ ...cardS, textAlign: 'center', color: C.muted, fontSize: 13 }}>
              Databáze je čistá. Není co opravovat.
            </div>
          ) : (
            <div style={cardS}>
              <h3 style={{ margin: '0 0 4px', fontSize: 15, color: C.primary }}>
                K opravě ({cleanupRows.length})
              </h3>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>
                🔴 vadná adresa · 🟠 chybí název · 🟡 v názvu je poznámka · ⚪ duplicita
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thS}>Hotel</th><th style={thS}>Město</th>
                  <th style={thS}>Adresa</th><th style={thS}>Co je špatně</th><th style={thS}></th>
                </tr></thead>
                <tbody>
                  {cleanupRows.map(({ row, kind, problem }) => (
                    <tr key={row.id} style={{ borderBottom: `1px solid ${C.border}`, background: kind === 'bad' ? '#fdf3f3' : (kind === 'name' || kind === 'note') ? '#fffdf5' : 'transparent' }}>
                      <td style={tdS}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span>{kind === 'bad' ? '🔴' : kind === 'name' ? '🟠' : kind === 'note' ? '🟡' : '⚪'}</span>
                          <input
                            value={nameEdit[row.id] ?? row.name ?? ''}
                            onChange={e => setNameEdit(prev => ({ ...prev, [row.id]: e.target.value }))}
                            placeholder="název hotelu"
                            style={inp({ minWidth: 200, fontSize: 12 })} />
                        </div>
                        {(kind === 'note' || kind === 'name') && splitNameNote(row.name).name
                          && splitNameNote(row.name).name !== (nameEdit[row.id] ?? row.name) && (
                          <button
                            onClick={() => setNameEdit(prev => ({ ...prev, [row.id]: splitNameNote(row.name).name }))}
                            style={{ marginTop: 4, background: 'none', border: 'none', color: C.primary, cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}>
                            použít „{splitNameNote(row.name).name}"
                          </button>
                        )}
                      </td>
                      <td style={tdS}>{row.city || '—'}</td>
                      <td style={tdS}>
                        <input
                          value={fixEdit[row.id] ?? row.email ?? ''}
                          onChange={e => setFixEdit(prev => ({ ...prev, [row.id]: e.target.value }))}
                          style={inp({ minWidth: 260, fontSize: 12 })} />
                      </td>
                      <td style={{ ...tdS, fontSize: 11, color: kind === 'bad' ? '#b00020' : C.muted }}>{problem}</td>
                      <td style={{ ...tdS, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={() => handleFixEmail(row)} disabled={!!cardBusy}
                          style={{ ...smallBtn('#2e7d32'), opacity: cardBusy ? 0.5 : 1, marginRight: 6 }}>
                          {cardBusy === row.id ? '…' : 'Uložit'}
                        </button>
                        <button onClick={() => handleDeleteRow(row)} disabled={!!cardBusy}
                          style={{ ...smallBtn('#b00020'), opacity: cardBusy ? 0.5 : 1 }}>
                          Smazat
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
                Uložit zapíše obojí najednou — název i adresu. Poznámky vytažené z názvu se při
                zakládání karty neztratí, uloží se na kartu jako interní poznámka.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
