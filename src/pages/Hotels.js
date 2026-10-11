// force-rebuild-ai-propojeni
import React, { useState, useEffect, useCallback } from 'react';
import { db, auth } from '../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, setDoc, serverTimestamp, writeBatch, getDoc } from 'firebase/firestore';
import { looksGlued, planEmailFix, planNameFix } from '../lib/hotelAutoFix';
import { nameFromWeb, verifyOfferHotel, judgeMatches, webCheckCard, EMAIL_TYPES } from '../lib/hotelAi';
import { findDuplicateGroups, buildMerged } from '../lib/hotelMerge';
import { collectLinks, cardSummary, newEmailsForCard, groupMaybe, cityKey, normName as linkNormName, nameMatches } from '../lib/hotelLinks';
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
  // Do databáze se k městu píše i země ("Paris, France"). Do předmětu patří
  // jen město, proto se bere část před první čárkou. Uložená hodnota se tím
  // nemění — podle ní se dál filtrují hotely.
  return String(raw).split(',')[0].trim().split(/(\s+)/).map((part, idx) => {
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
  // looksGlued navíc pozná skutečné dlouhé koncovky (.travel, .design, .group…),
  // které by jinak vypadaly jako slepené (".tr" + "avel").
  if (BROKEN_TAIL_RE.test(dom) && looksGlued(dom)) return 'Slepená adresa z importu — za koncovkou domény pokračuje text';
  if (/[^a-zA-Z0-9._%+-]/.test(e.slice(0, e.indexOf('@')))) return 'Neplatný znak před zavináčem';
  return '';
}

// Problém adresy konkrétního řádku.
function rowEmailProblem(r) {
  const p = emailProblem(r?.email);
  // `emailVerified` nastavuje jen automatika na kopii řádku v paměti (doména
  // ověřená na internetu) — do databáze se nezapisuje.
  if (p && p.startsWith('Slepená') && r?.emailVerified) return '';
  return p;
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
  const broken = pool.filter(r => rowEmailProblem(r));
  const clean  = pool.filter(r => !rowEmailProblem(r));

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
    // Poznámky z názvu + poznámky, které už automatická oprava z názvu
    // přesunula do pole `nameNote`.
    const notes = [...new Set([
      ...split.map(x => x.note),
      ...g.items.map(i => String(i.row.nameNote || '').trim()),
    ].filter(Boolean))];
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
    // Vlastní rozpis řádků — schválně nepoužívá COMPANY_LINES, aby šel
    // Filipův podpis měnit bez dopadu na Helenin.
    html:
      `<b>Filip Dlask</b><br>` +
      `<b>TOUR PRAGENSES | PRAGENSES s.r.o.</b><br>` +
      `Lipnická 688, Prague 9 – Kyje<br>` +
      `Czech Republic<br>` +
      `<br>` +
      `Tel. / WhatsApp: +420 777 079 997<br>` +
      `Alt. WhatsApp: +420 776 007 593<br>` +
      `<br>` +
      `VAT ID: CZ28445961`,
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

<p>Additionally, we would appreciate if you could hold this offer until {{optionDate}}, so we can communicate the offer with our client.</p>
<p>Thank you very much for your assistance. I look forward to your proposal and any further details you may require.</p>
<p>Best regards,<br>
--<br>
{{signature}}</p>
</div>`;

const TPL_OPTION_DATE = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:650px">
<p>Dear Sir or Madam,</p>
<p>Thank you very much for your offer for the group below.</p>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">GROUP DETAILS:</span></p>
<ul>
<li><b>Group Name:</b> {{groupName}}</li>
<li><b>Travel Dates:</b> {{checkIn}} – {{checkOut}}</li>
</ul>

<p>We are currently presenting your proposal to our client and would kindly ask you to hold the offer until {{optionDate}}.</p>
<p>Please confirm whether this is possible. We will come back to you with a firm answer as soon as we hear from our client.</p>
<p>Best regards,<br>
--<br>
{{signature}}</p>
</div>`;

const TPL_DATE_CHANGE = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:650px">
<p>Dear Sir or Madam,</p>
<p>We refer to our request for the group below.</p>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">GROUP DETAILS:</span></p>
<ul>
<li><b>Group Name:</b> {{groupName}}</li>
<li><b>New Travel Dates:</b> {{checkIn}} – {{checkOut}}</li>
</ul>

<p>Our client has changed the itinerary and we would kindly ask whether you could move the stay to the new dates above, keeping the same room breakdown and conditions.</p>
<p>Please confirm availability and whether the agreed rates remain valid. If the new dates are not available, please let us know the closest alternative.</p>
<p>We would appreciate if you could hold this offer until {{optionDate}}.</p>
<p>Best regards,<br>
--<br>
{{signature}}</p>
</div>`;

const TPL_CANCELLATION = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:650px">
<p>Dear Sir or Madam,</p>
<p>We regret to inform you that we have to cancel the booking for the group below.</p>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">GROUP DETAILS:</span></p>
<ul>
<li><b>Group Name:</b> {{groupName}}</li>
<li><b>Travel Dates:</b> {{checkIn}} – {{checkOut}}</li>
</ul>

<p>Please confirm the cancellation in writing and let us know whether any charges apply under the agreed cancellation policy.</p>
<p>We are sorry for the inconvenience and hope to work with you again soon.</p>
<p>Best regards,<br>
--<br>
{{signature}}</p>
</div>`;

// Výchozí šablony. Zapíšou se do databáze jen tehdy, když je kolekce
// `emailTemplates` prázdná — jakmile si je uživatel upraví, nic je nepřepíše.
// Pevná `id` zajistí, že se při opakovaném založení nevytvoří duplicity.
const BUILTIN_TEMPLATES = [
  { id: 'first-inquiry', name: 'První poptávka',   order: 1, subjectSuffix: '',                body: DEFAULT_TEMPLATE },
  { id: 'option-date',   name: 'Option date',      order: 2, subjectSuffix: 'OPTION DATE',     body: TPL_OPTION_DATE },
  { id: 'date-change',   name: 'Změna dat',        order: 3, subjectSuffix: 'CHANGE OF DATES', body: TPL_DATE_CHANGE },
  { id: 'cancellation',  name: 'Zrušení / storno', order: 4, subjectSuffix: 'CANCELLATION',    body: TPL_CANCELLATION },
];

// Internetové údaje na kartě (pořadí a popisky v detailu).
const WEB_FIELDS = [
  ['name', 'Oficiální název'], ['address', 'Adresa'], ['city', 'Město'], ['country', 'Země'],
  ['website', 'Web'], ['phone', 'Telefon'], ['stars', 'Hvězdičky'], ['rooms', 'Počet pokojů'],
  ['groups', 'Bere skupiny'], ['groupPolicy', 'Podmínky pro skupiny'], ['google', 'Hodnocení Google'], ['booking', 'Hodnocení Booking'],
];
const fieldVal = (c, k) => { const f = c && c.webInfo && c.webInfo.fields && c.webInfo.fields[k]; return f && !f.deleted ? f.value : null; };
const webValue = (k, v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (k === 'website') return <a href={/^https?:/.test(String(v)) ? v : `https://${v}`} target="_blank" rel="noreferrer">{String(v)}</a>;
  if (k === 'groups') return v === true ? 'ano' : v === false ? 'ne' : String(v);
  if (k === 'stars') return `${'★'.repeat(Math.min(5, Math.round(Number(v) || 0)))} (${v})`;
  if (k === 'google' || k === 'booking') {
    if (typeof v !== 'object') return String(v);
    return `${v.score ?? '—'}${k === 'google' ? ' / 5' : ' / 10'}${v.count ? ` · ${Number(v.count).toLocaleString('cs-CZ')} recenzí` : ''}`;
  }
  return String(v);
};

// Popisky pro detail karty (stejné jako v nabídce a zakázce).
const LINE_STATUS = {
  '': 'Stav?', requested: '🟡 Poptáno', negotiating: '🟠 V jednání', preapproved: '🔵 Předschváleno',
  ordered: '📨 Objednáno', confirmed: '🟢 Potvrzeno', cancelled: '🔴 Zrušeno',
};
const RESULT_LABEL = { realized: '🧭 Realizace', won: '✅ Vyhráno', lost: '❌ Prohráno', open: '⏳ Otevřená' };
const OFFER_STATUS_LABEL = {
  draft: 'Draft', check: 'Ke kontrole', sent: 'Odesláno klientovi', returned: 'Vráceno k úpravě',
  won: 'Won → confirmed', lost: 'Lost / declined',
};
const SERVICE_STATUS_LABEL = {
  enquired: 'Enquired', confirmed: 'Confirmed', option: 'Option', deposit_paid: 'Deposit paid', contract: 'Contract', paid: 'Paid',
};
const fmtD = (v) => {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return s;
};

export default function Hotels({ navigate, colors, navParams }) {
  console.debug('Hotels v222-internet-kontrola');
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
  // Číslo nabídky z nabídky, ze které se sem přišlo. Dá se dopsat i ručně,
  // když se poptávka otevře napřímo přes menu.
  const [offerNumber, setOfferNumber] = useState(prefill?.offerNumber || '');
  const [checkIn, setCheckIn]         = useState('');
  const [checkOut, setCheckOut]       = useState('');
  // Datum, do kdy má hotel nabídku držet. Propisuje se do textu jako
  // {{optionDate}}, aby se nemuselo dopisovat ručně.
  const [optionDate, setOptionDate]   = useState('');
  const [freeRatio, setFreeRatio]     = useState('20');
  const [emailBody, setEmailBody]     = useState(DEFAULT_TEMPLATE);
  const [editMode, setEditMode]       = useState('visual');
  // Šablony emailů uložené v databázi (kolekce `emailTemplates`).
  // Kdyby se načtení nepovedlo, zůstane zabudovaná výchozí šablona a poptávka
  // půjde odeslat normálně — jen se nedá přepínat a ukládat.
  const [templates, setTemplates]         = useState([]);
  const [templateId, setTemplateId]       = useState('first-inquiry');
  const [templatesError, setTemplatesError] = useState('');
  const [templateBusy, setTemplateBusy]   = useState(false);

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
  const subjectSuffix = templates.find(t => t.id === templateId)?.subjectSuffix || '';
  React.useEffect(() => {
    let s = 'GRP';
    if (groupName) s += ' / ' + groupName;
    if (offerNumber) s += ' / ' + offerNumber.trim();
    if (composeCity) s += ' / ' + formatCity(composeCity);
    if (subjectSuffix) s += ' — ' + subjectSuffix;
    setSubject(s);
  }, [groupName, offerNumber, composeCity, subjectSuffix]);
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

  const fetchTemplates = useCallback(async (selectId) => {
    try {
      let snap = await getDocs(collection(db, 'emailTemplates'));
      // Úplně první spuštění (nebo smazání všech šablon) — založí se výchozí sada.
      if (snap.empty) {
        for (const t of BUILTIN_TEMPLATES) {
          await setDoc(doc(db, 'emailTemplates', t.id), {
            name: t.name, order: t.order, subjectSuffix: t.subjectSuffix, body: t.body,
            builtin: true, createdAt: serverTimestamp(),
          });
        }
        snap = await getDocs(collection(db, 'emailTemplates'));
      }
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => (a.order || 99) - (b.order || 99) || (a.name || '').localeCompare(b.name || ''));
      setTemplates(items);
      setTemplatesError('');
      // Která šablona má po načtení zůstat vybraná: po uložení ta samá,
      // po smazání první zbylá, při prvním otevření ta výchozí.
      const pick = items.find(t => t.id === selectId) || items[0];
      if (pick) { setTemplateId(pick.id); setEmailBody(pick.body || DEFAULT_TEMPLATE); }
    } catch (e) {
      // Nevadí — pracuje se dál se zabudovanou šablonou.
      setTemplatesError(e.message || 'Šablony se nepodařilo načíst');
    }
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
  useEffect(() => { if (tab === 'compose' && templates.length === 0 && !templatesError) fetchTemplates(); }, [tab, templates.length, templatesError, fetchTemplates]);
  useEffect(() => { if (tab === 'cards') fetchCards(); }, [tab, fetchCards]);

  // Vytvoří JEDNU kartu ze skupiny řádků a napojí na ni ty řádky.
  // Řádky v `hotels` zůstávají beze změny až na přidané `cardId` — rozesílání
  // poptávek na ně sahá dál stejně jako dosud.
  const cardDataFromGroup = (g, source) => {
    const emails = [...new Set(g.rows.map(r => String(r.email || '').toLowerCase()).filter(Boolean))];
    return {
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
      source: source || { type: 'hotels-db', label: 'Z databáze hotelů', at: new Date().toISOString() },
      createdAt: serverTimestamp(),
    };
  };

  const createCardFromGroup = async (g) => {
    const ref = await addDoc(collection(db, 'hotelCards'), cardDataFromGroup(g));
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

  // ── 🤖 AUTOMATICKÉ ZPRACOVÁNÍ (etapa 1, bez AI) ─────────────────────────────
  // Zapisuje JEN DO KARET. Databáze hotelů (`hotels`) i rozesílání poptávek
  // zůstávají beze změny — řádek dostane jen štítek `cardId`, stejně jako při
  // ručním zakládání karty. Opravy (adresa, název, poznámka) se počítají
  // "nanečisto" na kopii řádku a uloží se jen na kartu, i s původní hodnotou.
  // Až budou karty spolehlivé, stanou se novou databází (samostatný krok).
  //
  // Zpracují se jen řádky, které ještě nemají kartu, takže opakované spuštění
  // pokračuje tam, kde se skončilo. Celý běh jde vrátit v přehledu níže,
  // jednotlivé karty tlačítkem Zrušit v záložce Karty.
  const [autoBusy, setAutoBusy]   = useState('');
  const [fixLog, setFixLog]       = useState([]);
  const [fixLogAll, setFixLogAll] = useState(false);

  const fetchFixLog = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'hotelAutoFixes'));
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      setFixLog(items);
    } catch (e) {
      console.error('Přehled automatických běhů se nepodařilo načíst:', e);
    }
  }, []);
  useEffect(() => { if (tab === 'clean') fetchFixLog(); }, [tab, fetchFixLog]);

  // Zápis po dávkách. Jedna "jednotka" = karta + štítky na jejích řádcích;
  // jednotka se nikdy nerozdělí do dvou dávek.
  const commitUnits = async (units, label) => {
    let batch = writeBatch(db), n = 0, done = 0;
    for (const ops of units) {
      if (n > 0 && n + ops.length > 450) {
        await batch.commit();
        batch = writeBatch(db); n = 0;
        setAutoBusy(`${label}: ${done} z ${units.length}…`);
      }
      for (const o of ops) {
        if (o.t === 'set') batch.set(o.ref, o.data);
        else if (o.t === 'update') batch.update(o.ref, o.data);
        else batch.delete(o.ref);
      }
      n += ops.length; done++;
    }
    if (n) await batch.commit();
  };

  const handleAutoRun = async () => {
    if (!window.confirm(
      '🤖 Automatické zakládání karet\n\n' +
      'Zapisuje se JEN do karet. Databáze hotelů a rozesílání poptávek zůstanou beze změny.\n\n' +
      'Na kartách:\n' +
      '• slepené adresy budou opravené (doména ověřená na internetu), původní adresa zůstane vidět\n' +
      '• poznámky z názvů se přesunou do poznámky karty\n' +
      '• duplicitní řádky se spojí do jedné karty\n\n' +
      'Sporné případy nechá na vás. Celý běh jde vrátit.\n\nPokračovat?')) return;
    const by = auth.currentUser?.email || '';
    const at = new Date().toISOString();
    const runId = at;
    const stats = { email: 0, verify: 0, name: 0, emailReview: 0, nameReview: 0 };
    try {
      setAutoBusy('Načítám databázi…');
      const snap = await getDocs(collection(db, 'hotels'));
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => !r.cardId);

      // 1) Adresy — ověření domény chvíli trvá, proto po pěti najednou.
      const todo = rows.filter(r => r.email);
      const plans = new Map();
      let idx = 0, checked = 0;
      setAutoBusy(`Kontroluji adresy 0 z ${todo.length}…`);
      const worker = async () => {
        while (idx < todo.length) {
          const r = todo[idx++];
          try { plans.set(r.id, await planEmailFix(r.email, { needsAttention: !!emailProblem(r.email) })); }
          catch { plans.set(r.id, null); }
          checked++;
          if (checked % 25 === 0) setAutoBusy(`Kontroluji adresy ${checked} z ${todo.length}…`);
        }
      };
      await Promise.all([1, 2, 3, 4, 5].map(worker));

      // 2) Opravená kopie každého řádku — jen v paměti, do databáze se nezapisuje.
      const fixesByRow = new Map();
      const uncertain = new Set();
      const virtual = rows.map(r => {
        const v = { ...r };
        const fx = [];
        const pe = plans.get(r.id);
        if (pe?.action === 'fix') {
          fx.push({ kind: 'email', from: r.email, to: pe.email, reason: pe.reason });
          v.email = pe.email; stats.email++;
        } else if (pe?.action === 'verify') {
          v.emailVerified = true; stats.verify++;
        } else if (pe?.action === 'review') {
          stats.emailReview++;
        }
        if (String(r.name || '').trim()) {
          const pn = planNameFix(r.name, { splitNameNote, stripLead, NOTE_HINT });
          if (pn?.action === 'fix') {
            const prev = String(r.nameNote || '').trim();
            const note = pn.note && !prev.includes(pn.note) ? (prev ? `${prev} · ${pn.note}` : pn.note) : prev;
            fx.push({ kind: 'name', from: r.name, to: pn.name, note: pn.note, reason: pn.reason });
            v.name = pn.name; v.nameNote = note; stats.name++;
          } else if (pn?.action === 'review') {
            uncertain.add(r.id); stats.nameReview++;
          }
        }
        if (fx.length) fixesByRow.set(r.id, fx);
        return v;
      });

      // 3) Návrhy karet z opravených kopií. Skupina, ve které je nejistý název,
      //    se automaticky nezakládá — zůstane v Kartách k ručnímu odkliknutí.
      setAutoBusy('Zakládám karty…');
      const sug = buildCardSuggestions(virtual);
      const candidates = [...sug.green, ...sug.chain];
      // Automaticky jen JISTÉ skupiny: žádný nejistý název a všechny řádky se
      // stejným názvem. Spojení podle "obsaženého" názvu ("Ibis" + "Ibis
      // Wenceslas") je odhad — může jít o dva hotely, tak zůstane k ručnímu
      // odkliknutí v Kartách.
      const toCreate = candidates.filter(g => {
        if (g.rows.some(r => uncertain.has(r.id))) return false;
        const names = new Set(g.rows.map(r => normName(splitNameNote(r.name).name)).filter(Boolean));
        return names.size <= 1;
      });
      const cardIds = [];
      let rowsLinked = 0, cardsWithFix = 0;
      const units = toCreate.map(g => {
        const ref = doc(collection(db, 'hotelCards'));
        cardIds.push(ref.id);
        rowsLinked += g.rows.length;
        const autoFixes = g.rows.flatMap(r => (fixesByRow.get(r.id) || []).map(f => ({ ...f, rowId: r.id })));
        if (autoFixes.length) cardsWithFix++;
        const data = cardDataFromGroup(g, { type: 'auto', label: '🤖 Automaticky z databáze hotelů', at, runId });
        data.emails = data.emails.map(e => {
          const f = autoFixes.find(x => x.kind === 'email' && x.to === e.email);
          return f ? { ...e, original: f.from, auto: true } : e;
        });
        data.autoFixes = autoFixes;
        return [
          { t: 'set', ref, data },
          ...g.rows.map(r => ({ t: 'update', ref: doc(db, 'hotels', r.id), data: { cardId: ref.id } })),
        ];
      });
      if (units.length) {
        await commitUnits(units, 'Zakládám karty');
        await setDoc(doc(collection(db, 'hotelAutoFixes')), {
          runId, at, by, kind: 'cards', cardIds, undone: false,
          label: `${cardIds.length} karet z ${rowsLinked} řádků`,
          reason: `Opravené adresy: ${stats.email} · vyčištěné názvy: ${stats.name} · karet s opravou: ${cardsWithFix}`,
        });
      }

      await Promise.all([fetchHotels(), fetchCards(), fetchFixLog()]);
      setAutoBusy('');
      const left = (candidates.length - toCreate.length) + sug.merge.length + sug.unnamed.length;
      alert(
        '🤖 Hotovo. Databáze hotelů zůstala beze změny.\n\n' +
        `Karet vytvořeno: ${cardIds.length} (spojeno ${rowsLinked} řádků databáze)\n` +
        `  – z toho s opravenou adresou nebo názvem: ${cardsWithFix}\n` +
        `Adres opraveno: ${stats.email}\n` +
        `Adres ověřeno jako v pořádku: ${stats.verify}\n` +
        `Názvů vyčištěno: ${stats.name}\n\n` +
        `Zůstává k vašemu rozhodnutí: ${left} hotelů (sporné spojení, bez názvu, nejistý název)\n` +
        `Neopravitelné adresy: ${stats.emailReview}\n\n` +
        'Celý běh jde vrátit v přehledu „🤖 Automatické běhy".');
    } catch (e) {
      setAutoBusy('');
      await Promise.all([fetchHotels(), fetchCards(), fetchFixLog()]);
      alert('Zpracování se přerušilo: ' + e.message + '\n\nDatabáze hotelů se nezměnila. Co se stihlo, jsou hotové karty; můžete spustit znovu — pokračuje se tam, kde to skončilo.');
    }
  };

  // ↩ Vrátit celý běh: smaže karty, které běh založil, a odebere štítky
  // z řádků. Databáze hotelů je pak přesně jako před během.
  const handleUndoFix = async (f) => {
    if (f.kind === 'merge' || f.kind === 'web-check') return handleUndoSpecial(f);
    const n = (f.cardIds || []).length;
    const m = (f.added || []).length;
    const l = (f.linkKeys || []).length;
    if (!window.confirm(`Vrátit celý běh?\n\nZruší se ${n} karet, které běh založil${m ? `, z ${m} existujících karet se odeberou adresy, které běh přidal` : ''}${l ? `, a ${l} propojení s nabídkami` : ''}. Databáze hotelů zůstane beze změny.`)) return;
    setAutoBusy('Vracím…');
    try {
      const ids = new Set(f.cardIds || []);
      const addedTo = new Set((f.added || []).map(a => a.cardId));
      const rowIds = new Set(f.rowIds || []);
      const snap = await getDocs(collection(db, 'hotels'));
      const units = [];
      snap.docs.forEach(d => {
        const cid = d.data().cardId;
        if (ids.has(cid) || (rowIds.has(d.id) && addedTo.has(cid))) units.push([{ t: 'update', ref: d.ref, data: { cardId: '' } }]);
      });
      for (const a of (f.added || [])) {
        const cs = await getDoc(doc(db, 'hotelCards', a.cardId));
        if (!cs.exists()) continue;
        const drop = new Set(a.emails || []);
        units.push([{ t: 'update', ref: cs.ref, data: { emails: (cs.data().emails || []).filter(e => !drop.has(e.email)) } }]);
      }
      ids.forEach(id => units.push([{ t: 'delete', ref: doc(db, 'hotelCards', id) }]));
      // Propojení, která běh zapsal (AI shody, hotely z nabídek).
      (f.linkKeys || []).forEach(k => units.push([{ t: 'delete', ref: doc(db, 'hotelCardLinks', encodeURIComponent(k).slice(0, 1400)) }]));
      await commitUnits(units, 'Vracím');
      await updateDoc(doc(db, 'hotelAutoFixes', f.id), { undone: true, undoneAt: new Date().toISOString(), undoneBy: auth.currentUser?.email || '' });
      await Promise.all([fetchHotels(), fetchCards(), fetchFixLog()]);
      if ((f.linkKeys || []).length || f.kind === 'orphan-cards') loadSystemData();
    } catch (e) {
      alert('Nepodařilo se vrátit: ' + e.message);
    }
    setAutoBusy('');
  };

  // ↩ Vrátit sloučení / internetovou kontrolu.
  const handleUndoSpecial = async (f) => {
    const what = f.kind === 'merge' ? 'sloučení karet (karty se obnoví tak, jak byly)' : `internetovou kontrolu ${(f.webCardIds || []).length} karet (údaje z internetu se vrátí na předchozí stav)`;
    if (!window.confirm(`Vrátit ${what}?`)) return;
    setAutoBusy('Vracím…');
    try {
      const units = [];
      if (f.kind === 'merge') {
        const m = f.merge || {};
        units.push([{ t: 'set', ref: doc(db, 'hotelCards', m.primaryId), data: m.primaryBefore }]);
        (m.others || []).forEach(o => units.push([{ t: 'set', ref: doc(db, 'hotelCards', o.id), data: o.data }]));
        (m.rows || []).forEach(r => units.push([{ t: 'update', ref: doc(db, 'hotels', r.id), data: { cardId: r.from } }]));
        (m.links || []).forEach(l => units.push([{ t: 'update', ref: doc(db, 'hotelCardLinks', encodeURIComponent(l.key).slice(0, 1400)), data: { cardId: l.from } }]));
      } else {
        for (const id of (f.webCardIds || [])) {
          const cs = await getDoc(doc(db, 'hotelCards', id));
          if (!cs.exists()) continue;
          const c = cs.data();
          const emails = (c.emails || []).map(e => (e.typeManual || e.typePrev === undefined) ? e : { ...e, type: e.typePrev || '' });
          units.push([{ t: 'update', ref: cs.ref, data: { webInfo: (c.webInfo && c.webInfo.prev) || null, emails } }]);
        }
      }
      await commitUnits(units, 'Vracím');
      await updateDoc(doc(db, 'hotelAutoFixes', f.id), { undone: true, undoneAt: new Date().toISOString(), undoneBy: auth.currentUser?.email || '' });
      await Promise.all([fetchHotels(), fetchCards(), fetchFixLog()]);
      loadSystemData();
    } catch (e) {
      alert('Nepodařilo se vrátit: ' + e.message);
    }
    setAutoBusy('');
  };

  // ✏ Úpravy přímo na kartě. Ručně upravená hodnota se označí (`manual`),
  // aby ji pozdější automatika (AI v etapě 2) nikdy nepřepsala.
  // ✏ Město na kartě (např. „Amesterdão“ → „AMSTERDAM“). Jen karta, databáze beze změny.
  const handleEditCardCity = async (card) => {
    const v = window.prompt('Město na kartě:', card.city || '');
    if (v == null || !v.trim()) return;
    try {
      await updateDoc(doc(db, 'hotelCards', card.id), { city: v.trim(), cityManual: true });
      await fetchCards();
    } catch (e) { alert('Nepodařilo se uložit: ' + e.message); }
  };

  const handleEditCardName = async (card) => {
    const v = window.prompt('Název hotelu na kartě:', card.name || '');
    if (v == null || !v.trim()) return;
    try {
      await updateDoc(doc(db, 'hotelCards', card.id), { name: v.trim(), nameManual: true });
      await fetchCards();
    } catch (e) { alert('Nepodařilo se uložit: ' + e.message); }
  };

  const handleEditCardEmail = async (card, email) => {
    const v = window.prompt('Adresa na kartě:', email);
    if (v == null) return;
    const val = v.trim().toLowerCase();
    const problem = emailProblem(val);
    if (problem) { alert('Takhle to pořád nesedí: ' + problem); return; }
    try {
      const emails = (card.emails || []).map(e => e.email === email ? { ...e, email: val, manual: true, auto: false } : e);
      await updateDoc(doc(db, 'hotelCards', card.id), { emails });
      await fetchCards();
    } catch (e) { alert('Nepodařilo se uložit: ' + e.message); }
  };

  // ── 🤖 ETAPA 2a: AI DOPLNÍ CHYBĚJÍCÍ NÁZVY ─────────────────────────────────
  // Řádky bez názvu (jen adresa + město) projde AI: nejdřív levně z adresy,
  // nejisté pak s hledáním na internetu. Výsledek jde JEN DO KARET (databáze
  // hotelů beze změny, řádek dostane jen štítek `cardId`).
  // Každý výsledek AI se hned ukládá do `hotelAiAttempts`, takže za stejnou
  // adresu se neplatí dvakrát a přerušený běh pokračuje, kde skončil.
  // Nejisté návrhy zůstávají v Kontrole adres s tlačítkem „Založit kartu".
  const [aiBusy, setAiBusy]         = useState('');
  const [aiLimit, setAiLimit]       = useState('500');
  const [aiAttempts, setAiAttempts] = useState({});
  // ⏹ Zastavit — běh se dokončí u rozpracované adresy a pak skončí; co je
  // hotové, z toho se rovnou založí karty.
  const aiStopRef = React.useRef(false);

  const aiKey = (email, city) => `${String(email || '').trim().toLowerCase()}|${normCity(city)}`;
  const aiDocId = (k) => encodeURIComponent(k).slice(0, 1400);
  const fmtKc = (n) => (Math.round(n * 100) / 100).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fetchAiAttempts = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'hotelAiAttempts'));
      const m = {};
      snap.docs.forEach(d => { const a = d.data(); if (a.key) m[a.key] = a; });
      setAiAttempts(m);
    } catch (e) {
      console.error('Výsledky AI se nepodařilo načíst:', e);
    }
  }, []);
  useEffect(() => { if (tab === 'clean') fetchAiAttempts(); }, [tab, fetchAiAttempts]);

  // Řádek bez použitelného názvu, s platnou adresou a bez karty.
  const needsAiName = (r) => !r.cardId && r.email && !emailProblem(r.email)
    && !(isRealName(r.name) && splitNameNote(r.name).name);

  const aiTargetCount = React.useMemo(() => {
    const keys = new Set();
    hotels.forEach(r => { if (needsAiName(r)) keys.add(aiKey(r.email, r.city)); });
    return keys.size;
  }, [hotels]);

  const handleAiNames = async (maxKeys) => {
    let limit = Number(String(aiLimit).replace(',', '.')) || 500;
    if (!window.confirm(
      `🤖 AI doplní chybějící názvy hotelů${maxKeys ? ` — ZKOUŠKA na ${maxKeys} adresách` : ''}.\n\n` +
      '• každou adresu ověří chytřejší model na internetu (cca 2 Kč za adresu)\n' +
      '• kartu založí JEN když webová stránka potvrdí hotel — s odkazem na zdroj\n' +
      '• nejisté zůstanou v Kontrole s návrhem, rozhodnete vy\n' +
      '• výsledek se zapíše JEN do karet, databáze hotelů zůstane beze změny\n\n' +
      `Limit útraty: ${limit} Kč. Po jeho vyčerpání se zpracování zastaví a zeptá se na nový limit.\n\nPokračovat?`)) return;
    const by = auth.currentUser?.email || '';
    const at = new Date().toISOString();
    const runId = at;
    let spent = 0, stopped = false;
    aiStopRef.current = false;
    const stats = { web: 0, unsure: 0, ready: 0, newCards: 0, addedTo: 0 };

    // Hlídání limitu. window.prompt zastaví i ostatní souběžná volání.
    const budgetOk = () => {
      if (aiStopRef.current) { stopped = true; return false; }
      while (spent >= limit) {
        const v = window.prompt(
          `Utraceno ${fmtKc(spent)} Kč — limit ${limit} Kč je vyčerpaný.\n\n` +
          'Zadejte nový limit v Kč a zpracování bude pokračovat.\nZrušit = zastavit (hotová práce se uloží).',
          String(Math.round(limit * 2)));
        if (v == null) { stopped = true; return false; }
        const n = Number(String(v).replace(',', '.'));
        if (n > limit) { limit = n; setAiLimit(String(n)); }
      }
      return !stopped;
    };

    try {
      setAiBusy('Načítám…');
      const [hSnap, aSnap, cSnap] = await Promise.all([
        getDocs(collection(db, 'hotels')),
        getDocs(collection(db, 'hotelAiAttempts')),
        getDocs(collection(db, 'hotelCards')),
      ]);
      const rows = hSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const attempts = new Map();
      aSnap.docs.forEach(d => { const a = d.data(); if (a.key) attempts.set(a.key, a); });

      // Jedinečné adresy (stejná adresa ve stejném městě = jeden hotel).
      const byKey = new Map();
      rows.filter(needsAiName).forEach(r => {
        const k = aiKey(r.email, r.city);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(r);
      });
      let keys = [...byKey.keys()];
      // Nejdřív ty, na které se AI ještě neptala.
      keys.sort((a, b) => (attempts.has(a) ? 1 : 0) - (attempts.has(b) ? 1 : 0));
      if (maxKeys) keys = keys.slice(0, maxKeys);

      // Každou adresu ověří chytřejší model na internetu. Kartu založí jen
      // tehdy, když webová stránka potvrdí, že adresa patří tomu hotelu
      // v tom městě — a uloží odkaz na zdroj. Hotové (jisté) výsledky se už
      // znovu neplatí; nejisté ze starších pokusů se ověří znovu přísněji (v2).
      const need = keys.filter(k => { const a = attempts.get(k); return !a || (!a.sure && a.v !== 2); });
      let idx = 0, done = 0;
      const worker = async () => {
        while (!stopped && idx < need.length) {
          if (!budgetOk()) return;
          const k = need[idx++];
          const r0 = byKey.get(k)[0];
          const a0 = attempts.get(k) || { key: k, email: String(r0.email).trim().toLowerCase(), city: r0.city || '' };
          const r = await nameFromWeb(a0.email, a0.city, a0.name || '');
          spent += r.cost;
          const a = {
            key: k, email: a0.email, city: a0.city,
            name: r.name, sure: r.sure, how: 'web', source: r.source, evidence: r.evidence,
            web: true, v: 2, model: r.model, at: new Date().toISOString(), by,
          };
          attempts.set(k, a);
          await setDoc(doc(db, 'hotelAiAttempts', aiDocId(k)), a);
          done++;
          if (a.sure) stats.web++; else stats.unsure++;
          if (!aiStopRef.current) setAiBusy(`Ověřuji na internetu: ${done} z ${need.length} · utraceno ${fmtKc(spent)} Kč`);
        }
      };
      if (need.length) {
        setAiBusy(`Ověřuji na internetu: 0 z ${need.length} · utraceno ${fmtKc(spent)} Kč`);
        await Promise.all([1, 2, 3].map(worker));
      }

      // 3) Karty z jistých výsledků. Když už karta se stejným názvem a městem
      //    existuje, adresa se přidá k ní (žádná duplicitní karta).
      setAiBusy('Zakládám karty…');
      const cardIndex = new Map();
      cSnap.docs.forEach(d => {
        const c = { id: d.id, ...d.data() };
        const n = normName(c.name);
        if (n) cardIndex.set(`${n}|${normCity(c.city)}`, c);
      });
      const groups = new Map();
      for (const k of keys) {
        const a = attempts.get(k);
        if (!a) continue;
        if (!a.sure || !a.name) continue;
        stats.ready++;
        const rowsK = byKey.get(k).filter(r => !r.cardId);
        if (!rowsK.length || !normName(a.name)) continue;
        const gk = `${normName(a.name)}|${normCity(rowsK[0].city)}`;
        if (!groups.has(gk)) groups.set(gk, { name: a.name, city: rowsK[0].city || '', rows: [], attempts: [] });
        const g = groups.get(gk);
        g.rows.push(...rowsK);
        g.attempts.push(a);
      }

      const cardIds = [], added = [], rowIds = [];
      const units = [];
      for (const [gk, g] of groups) {
        const emails = [...new Set(g.rows.map(r => String(r.email).trim().toLowerCase()))];
        const notes = [...new Set(g.rows.flatMap(r => [splitNameNote(r.name).note, String(r.nameNote || '').trim()]).filter(Boolean))];
        const web = g.attempts.find(a => a.how === 'web');
        const aiInfo = { value: g.name, how: web ? 'web' : 'domain', source: web?.source || '', model: (web || g.attempts[0]).model, at };
        const existing = cardIndex.get(gk);
        let cardId;
        if (existing) {
          const have = new Set((existing.emails || []).map(e => e.email));
          const extra = emails.filter(e => !have.has(e));
          cardId = existing.id;
          if (extra.length) {
            const newEmails = [...(existing.emails || []), ...extra.map(e => ({ email: e, role: '', person: '', main: false, ai: true }))];
            existing.emails = newEmails;
            units.push([{ t: 'update', ref: doc(db, 'hotelCards', existing.id), data: { emails: newEmails } }]);
            added.push({ cardId: existing.id, emails: extra });
            stats.addedTo++;
          }
        } else {
          const ref = doc(collection(db, 'hotelCards'));
          cardId = ref.id;
          cardIds.push(ref.id);
          stats.newCards++;
          const data = {
            name: g.name, city: g.city, country: '', aliases: [], domain: '',
            emails: emails.map((e, i) => ({ email: e, role: '', person: '', main: i === 0 })),
            notes: notes.join(' · '),
            source: { type: 'ai', label: web ? '🤖 AI — ověřeno na webu' : '🤖 AI — název z e-mailové adresy', at, runId },
            ai: { name: aiInfo },
            createdAt: serverTimestamp(),
          };
          units.push([{ t: 'set', ref, data }]);
          cardIndex.set(gk, { id: ref.id, ...data });
        }
        g.rows.forEach(r => { rowIds.push(r.id); units.push([{ t: 'update', ref: doc(db, 'hotels', r.id), data: { cardId } }]); });
      }
      if (units.length) await commitUnits(units, 'Zakládám karty');
      if (cardIds.length || added.length) {
        await setDoc(doc(collection(db, 'hotelAutoFixes')), {
          runId, at, by, kind: 'ai-names', cardIds, added, rowIds, costCzk: Math.round(spent * 100) / 100, undone: false,
          label: `AI názvy: ${cardIds.length} nových karet, ${added.length} doplněno do existujících`,
          reason: `Ověřeno na internetu: ${stats.web} · nejisté: ${stats.unsure} · útrata ${fmtKc(spent)} Kč`,
        });
      }
      await Promise.all([fetchHotels(), fetchCards(), fetchFixLog(), fetchAiAttempts()]);
      setAiBusy('');
      alert(
        (stopped ? '⏹ Zastaveno. Z hotové práce jsou založené karty, zbytek pokračuje při dalším spuštění.\n\n' : '🤖 Hotovo. Databáze hotelů zůstala beze změny.\n\n') +
        `Ověřeno na internetu teď: ${stats.web}\n` +
        `Nejisté (zůstávají v Kontrole s návrhem AI): ${stats.unsure}\n\n` +
        `Nových karet: ${stats.newCards}\n` +
        `Adresy přidané k existující kartě: ${stats.addedTo}\n\n` +
        `Útrata: ${fmtKc(spent)} Kč`);
    } catch (e) {
      setAiBusy('');
      await Promise.all([fetchHotels(), fetchCards(), fetchFixLog(), fetchAiAttempts()]);
      alert(`AI se přerušila: ${e.message}\n\nUtraceno ${fmtKc(spent)} Kč. Výsledky AI jsou uložené — při dalším spuštění se za ně znovu neplatí a pokračuje se, kde to skončilo.`);
    }
  };

  // Kontrola adres: ruční založení karty pro řádek bez názvu — s názvem,
  // který napíšete, nebo s návrhem AI. Databáze hotelů se nemění.
  const handleCardFromRow = async (row) => {
    const sugg = aiAttempts[aiKey(row.email, row.city)];
    const typed = String(nameEdit[row.id] ?? '').trim();
    const name = typed && typed !== String(row.name || '').trim() ? typed : (sugg?.name || '');
    if (!name) { alert('Napište název hotelu do políčka vlevo.'); return; }
    setCardBusy(row.id);
    try {
      const k = aiKey(row.email, row.city);
      const rowsK = hotels.filter(h => !h.cardId && aiKey(h.email, h.city) === k);
      const ref = doc(collection(db, 'hotelCards'));
      const fromAi = !!sugg && name === sugg.name;
      const units = [[
        { t: 'set', ref, data: {
          name, city: row.city || '', country: '', aliases: [], domain: '',
          emails: [{ email: String(row.email).trim().toLowerCase(), role: '', person: '', main: true }],
          notes: [...new Set(rowsK.flatMap(r => [splitNameNote(r.name).note, String(r.nameNote || '').trim()]).filter(Boolean))].join(' · '),
          nameManual: true,
          source: { type: 'manual', label: fromAi ? '✋ Návrh AI potvrzený ručně' : '✋ Název zadaný ručně', at: new Date().toISOString() },
          ...(fromAi ? { ai: { name: { value: sugg.name, how: sugg.how, source: sugg.source || '', model: sugg.model || '', at: sugg.at || '' } } } : {}),
          createdAt: serverTimestamp(),
        } },
        ...rowsK.map(r => ({ t: 'update', ref: doc(db, 'hotels', r.id), data: { cardId: ref.id } })),
      ]];
      await commitUnits(units, 'Zakládám kartu');
      setNameEdit(prev => { const n = { ...prev }; delete n[row.id]; return n; });
      await Promise.all([fetchHotels(), fetchCards()]);
    } catch (e) { alert('Kartu se nepodařilo založit: ' + e.message); }
    setCardBusy('');
  };

  // ── 📊 KARTY ↔ VÁŠ SYSTÉM (etapa 3, krok 1) ─────────────────────────────────
  // Data z nabídek, starých zakázek a logu poptávek se načtou při otevření
  // záložky Karty a propojí s kartami ŽIVĚ (nic se nekopíruje). Zapisuje se
  // jen: potvrzení / odmítnutí možné shody (`hotelCardLinks`), e-maily přidané
  // ke kartám a nové karty pro hotely z nabídek — vše jen v kartách, databáze
  // hotelů beze změny, a každý hromadný krok jde vrátit.
  const [sysRaw, setSysRaw]       = useState(null);   // { offers, orders, emailLog }
  const [sysLoading, setSysLoading] = useState(false);
  const [sysError, setSysError]   = useState('');
  const [decisions, setDecisions] = useState({});
  const [detailId, setDetailId]   = useState('');
  const [onlyUsed, setOnlyUsed]   = useState(false);
  const [sysPanel, setSysPanel]   = useState('');     // '' | 'maybe' | 'orphans'
  const [sysBusy, setSysBusy]     = useState('');

  const loadSystemData = useCallback(async () => {
    setSysLoading(true); setSysError('');
    try {
      const [offSnap, ordSnap, logSnap, decSnap] = await Promise.all([
        getDocs(collection(db, 'offers')),
        getDocs(collection(db, 'orders')),
        getDocs(collection(db, 'hotelEmailLog')),
        getDocs(collection(db, 'hotelCardLinks')),
      ]);
      const orders = await Promise.all(ordSnap.docs.map(async d => {
        const s = await getDocs(collection(db, 'orders', d.id, 'services'));
        return { id: d.id, ...d.data(), services: s.docs.map(x => ({ id: x.id, ...x.data() })) };
      }));
      const dec = {};
      decSnap.docs.forEach(d => { const v = d.data(); if (v.key) dec[v.key] = v; });
      setDecisions(dec);
      setSysRaw({
        offers: offSnap.docs.map(d => ({ id: d.id, ...d.data() })),
        orders,
        emailLog: logSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      });
    } catch (e) {
      setSysError(e.message || 'Data se nepodařilo načíst');
    }
    setSysLoading(false);
  }, []);
  useEffect(() => { if (tab === 'cards' && !sysRaw && !sysLoading) loadSystemData(); }, [tab, sysRaw, sysLoading, loadSystemData]);

  const sys = React.useMemo(() => {
    if (!sysRaw || !cards.length) return null;
    return collectLinks({ cards, hotelRows: hotels, ...sysRaw, decisions });
  }, [sysRaw, cards, hotels, decisions]);

  const summaryOf = (cardId) => (sys && sys.links.has(cardId) ? cardSummary(sys.links.get(cardId)) : null);
  const emailsToAdd = React.useMemo(() => {
    if (!sys) return [];
    const out = [];
    for (const [cardId, b] of sys.links) {
      const card = cards.find(c => c.id === cardId);
      const list = newEmailsForCard(card, b);
      if (list.length) out.push({ card, list });
    }
    return out;
  }, [sys, cards]);
  const emailsToAddCount = emailsToAdd.reduce((n, x) => n + x.list.length, 0);

  const linkDocId = (key) => encodeURIComponent(key).slice(0, 1400);
  // Rozhodnutí o možné shodě platí pro celou skupinu (stejný název, město
  // a kandidáti) — všechny výskyty se zapíšou najednou.
  const saveDecision = async (group, decision, cardId) => {
    const by = auth.currentUser?.email || '', at = new Date().toISOString();
    const rejected = decision === 'no' ? group.candidates.map(c => c.id) : [];
    const docs = group.lines.map(line => ({
      key: line.key, decision, cardId: cardId || '', rejected,
      label: `${line.name} · ${line.city}`, source: line.source || '', by, at,
    }));
    setSysBusy(group.key);
    try {
      await commitUnits(docs.map(v => [{ t: 'set', ref: doc(db, 'hotelCardLinks', linkDocId(v.key)), data: v }]), 'Ukládám');
      setDecisions(prev => { const n = { ...prev }; docs.forEach(v => { n[v.key] = v; }); return n; });
    } catch (e) { alert('Nepodařilo se uložit: ' + e.message); }
    setSysBusy('');
  };
  const maybeGroups = React.useMemo(() => (sys ? groupMaybe(sys.maybe) : []), [sys]);

  // E-maily ze servisních karet → karty hotelů. Jen u JISTÝCH vazeb.
  const emailEntry = (email, src) => ({
    email, role: '', person: '', main: false, fromService: true,
    source: { type: src.type, offerId: src.offerId || '', orderId: src.orderId || '', offerNumber: src.offerNumber || '', group: src.group || '' },
  });
  const handleAddEmails = async (items) => {
    const total = items.reduce((n, x) => n + x.list.length, 0);
    if (!total) return;
    if (!window.confirm(`Přidat ${total} e-mailů ze servisních karet (nabídky, zakázky) k ${items.length} kartám hotelů?\n\nJen u hotelů, které jsou s kartou propojené jistě. Databáze hotelů se nemění. Jde vrátit.`)) return;
    setSysBusy('emails');
    const at = new Date().toISOString();
    try {
      const units = [], added = [];
      for (const { card, list } of items) {
        const emails = [...(card.emails || []), ...list.map(x => emailEntry(x.email, x.src))];
        units.push([{ t: 'update', ref: doc(db, 'hotelCards', card.id), data: { emails } }]);
        added.push({ cardId: card.id, emails: list.map(x => x.email) });
      }
      await commitUnits(units, 'Přidávám e-maily');
      await setDoc(doc(collection(db, 'hotelAutoFixes')), {
        runId: at, at, by: auth.currentUser?.email || '', kind: 'emails', cardIds: [], added, rowIds: [], undone: false,
        label: `E-maily ze servisních karet: ${total} adres u ${items.length} karet`,
        reason: 'Z nabídek a starých zakázek, jen u jistě propojených hotelů',
      });
      await Promise.all([fetchCards(), fetchFixLog()]);
    } catch (e) { alert('Nepodařilo se přidat: ' + e.message); }
    setSysBusy('');
  };

  // Hotely z nabídek / zakázek, které nemají kartu → nová karta.
  const handleCreateOrphans = async (list) => {
    if (!list.length) return;
    if (list.length > 1 && !window.confirm(`Založit ${list.length} karet pro hotely z nabídek a zakázek, které kartu nemají?\n\nDatabáze hotelů se nemění. Jde vrátit.`)) return;
    setSysBusy(list.length > 1 ? 'orphans' : list[0].key);
    const at = new Date().toISOString();
    try {
      const cardIds = [];
      const units = list.map(o => {
        const ref = doc(collection(db, 'hotelCards'));
        cardIds.push(ref.id);
        const { name, note } = splitNameNote(o.name);
        // Výskyty v nabídkách / zakázkách se s novou kartou rovnou propojí.
        const links = o.sources.filter(src => src.key).map(src => ({ t: 'set', ref: doc(db, 'hotelCardLinks', linkDocId(src.key)), data: {
          key: src.key, decision: 'yes', cardId: ref.id, rejected: [], label: `${o.name} · ${o.city}`,
          source: src.type, by: auth.currentUser?.email || '', at,
        } }));
        return [...links, { t: 'set', ref, data: {
          name: name || o.name, city: cityFromCards(o.city), country: '', aliases: [], domain: '',
          emails: o.emails.map((e, i) => ({ email: e, role: '', person: '', main: i === 0, fromService: true })),
          notes: note || '',
          source: { type: 'services', label: '📄 Z nabídek / zakázek', at },
          createdAt: serverTimestamp(),
        } }];
      });
      await commitUnits(units, 'Zakládám karty');
      const decSnap = await getDocs(collection(db, 'hotelCardLinks'));
      const dec = {};
      decSnap.docs.forEach(d => { const v = d.data(); if (v.key) dec[v.key] = v; });
      setDecisions(dec);
      await setDoc(doc(collection(db, 'hotelAutoFixes')), {
        runId: at, at, by: auth.currentUser?.email || '', kind: 'orphan-cards', cardIds, added: [], rowIds: [], undone: false,
        label: `${cardIds.length} karet pro hotely z nabídek / zakázek`,
        reason: 'Hotely, které byly v nabídkách nebo zakázkách, ale neměly kartu',
      });
      await Promise.all([fetchCards(), fetchFixLog()]);
    } catch (e) { alert('Nepodařilo se založit: ' + e.message); }
    setSysBusy('');
  };

  // ── 🤖 AI pro propojení: hotely bez karty a možné shody ─────────────────────
  // Výsledky AI se ukládají (`hotelOrphanChecks`, `hotelMatchChecks`), takže se
  // za stejnou věc neplatí dvakrát. Jisté výsledky AI provede sama (🤖, jde
  // vrátit celý běh), nejisté zůstanou s návrhem k ručnímu rozhodnutí.
  const [orphanChecks, setOrphanChecks] = useState({});
  const [matchChecks, setMatchChecks]   = useState({});
  const [showNotHotel, setShowNotHotel] = useState(false);

  const fetchAiChecks = useCallback(async () => {
    try {
      const [o, m] = await Promise.all([getDocs(collection(db, 'hotelOrphanChecks')), getDocs(collection(db, 'hotelMatchChecks'))]);
      const oc = {}, mc = {};
      o.docs.forEach(d => { const v = d.data(); if (v.key) oc[v.key] = v; });
      m.docs.forEach(d => { const v = d.data(); if (v.key) mc[v.key] = v; });
      setOrphanChecks(oc); setMatchChecks(mc);
    } catch (e) { console.error('Výsledky AI kontrol se nepodařilo načíst:', e); }
  }, []);
  useEffect(() => { if (tab === 'cards') fetchAiChecks(); }, [tab, fetchAiChecks]);

  // Město zapsané stejně jako na ostatních kartách ("Amsterdã" → "AMSTERDAM").
  const cityFromCards = (city) => {
    const k = cityKey(city);
    const counts = new Map();
    cards.forEach(c => { if (cityKey(c.city) === k && c.city) counts.set(c.city, (counts.get(c.city) || 0) + 1); });
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : String(city || '').toUpperCase();
  };

  // Rozpočet jednoho AI běhu: limit, dotaz na nový limit, ⏹ Zastavit.
  const makeBudget = () => {
    let limit = Number(String(aiLimit).replace(',', '.')) || 500;
    let spent = 0, stopped = false;
    aiStopRef.current = false;
    return {
      add: (c) => { spent += c || 0; },
      spent: () => spent,
      stopped: () => stopped,
      ok: () => {
        if (aiStopRef.current) { stopped = true; return false; }
        while (spent >= limit) {
          const v = window.prompt(`Utraceno ${fmtKc(spent)} Kč — limit ${limit} Kč je vyčerpaný.\n\nZadejte nový limit v Kč a zpracování bude pokračovat.\nZrušit = zastavit (hotová práce se uloží).`, String(Math.round(limit * 2)));
          if (v == null) { stopped = true; return false; }
          const n = Number(String(v).replace(',', '.'));
          if (n > limit) { limit = n; setAiLimit(String(n)); }
        }
        return !stopped;
      },
    };
  };
  const checkDocId = (key) => encodeURIComponent(key).slice(0, 1400);

  // Hotel z nabídek patří k existující kartě (vybráno ručně) → propojit
  // všechny jeho výskyty. Databáze hotelů beze změny.
  const handleLinkOrphan = async (o, cardId) => {
    const by = auth.currentUser?.email || '', at = new Date().toISOString();
    const docs = o.sources.filter(s => s.key).map(s => ({
      key: s.key, decision: 'yes', cardId, rejected: [], label: `${o.name} · ${o.city}`, source: s.type, by, at,
    }));
    if (!docs.length) return;
    setSysBusy(o.key);
    try {
      await commitUnits(docs.map(v => [{ t: 'set', ref: doc(db, 'hotelCardLinks', linkDocId(v.key)), data: v }]), 'Propojuji');
      setDecisions(prev => { const n = { ...prev }; docs.forEach(v => { n[v.key] = v; }); return n; });
    } catch (e) { alert('Nepodařilo se propojit: ' + e.message); }
    setSysBusy('');
  };
  // Karty, ke kterým by hotel z nabídky mohl patřit (podle názvu od AI i jak je psáno).
  const orphanCardCandidates = (o, ch) => {
    if (!sys) return [];
    const found = [
      ...(ch && ch.name ? nameMatches(sys.idx, ch.name, ch.city || o.city) : []),
      ...(ch && ch.name ? nameMatches(sys.idx, ch.name, o.city) : []),
      ...nameMatches(sys.idx, o.name, o.city),
    ];
    return [...new Map(found.map(c => [c.id, c])).values()].slice(0, 6);
  };

  // ➕ Hotely z nabídek bez karty → AI ověří na internetu → karta / propojení.
  const pendingOrphans = React.useMemo(() => (sys ? sys.orphans.filter(o => !orphanChecks[o.key]) : []), [sys, orphanChecks]);
  const handleAiOrphans = async () => {
    const list = pendingOrphans;
    if (!list.length) return;
    if (!window.confirm(
      `🤖 AI ověří ${list.length} hotelů z nabídek, které nemají kartu.\n\n` +
      '• na internetu zjistí, jestli je to opravdu hotel, jeho oficiální název a město\n' +
      '• když už pro něj kartu máme, propojí ho s ní; jinak založí novou kartu — JEN se zdrojem\n' +
      '• lodě, agentury a nesmysly odloží stranou, nejisté nechá na vás\n\n' +
      `Cca 2 Kč za hotel. Limit útraty: ${aiLimit} Kč. Databáze hotelů se nemění. Celý běh jde vrátit.\n\nPokračovat?`)) return;
    const by = auth.currentUser?.email || '', at = new Date().toISOString();
    const budget = makeBudget();
    const results = new Map();
    try {
      let idx = 0, done = 0;
      setAiBusy(`Ověřuji hotely: 0 z ${list.length}`);
      const worker = async () => {
        while (idx < list.length) {
          if (!budget.ok()) return;
          const o = list[idx++];
          const groups = [...new Set(o.sources.map(s => s.group).filter(Boolean))];
          const r = await verifyOfferHotel({ name: o.name, city: o.city, emails: o.emails, groups });
          budget.add(r.cost);
          const check = { key: o.key, typedName: o.name, typedCity: o.city, ...r, at: new Date().toISOString(), by };
          delete check.cost;
          await setDoc(doc(db, 'hotelOrphanChecks', checkDocId(o.key)), check);
          results.set(o.key, check);
          done++;
          if (!aiStopRef.current) setAiBusy(`Ověřuji hotely: ${done} z ${list.length} · utraceno ${fmtKc(budget.spent())} Kč`);
        }
      };
      await Promise.all([1, 2, 3].map(worker));

      // Jisté hotely → propojit s existující kartou, nebo založit novou.
      setAiBusy('Zakládám karty a propojuji…');
      const units = [], cardIds = [], linkKeys = [];
      const madeNow = new Map();   // stejný hotel z více řádků → jedna karta
      const stats = { linked: 0, created: 0, notHotel: 0, unsure: 0 };
      const linkSources = (o, cardId) => o.sources.filter(s => s.key).forEach(s => {
        linkKeys.push(s.key);
        units.push([{ t: 'set', ref: doc(db, 'hotelCardLinks', linkDocId(s.key)), data: {
          key: s.key, decision: 'yes', cardId, rejected: [], label: `${o.name} · ${o.city}`, source: s.type, ai: true, by, at,
        } }]);
      });
      for (const o of list) {
        const r = results.get(o.key);
        if (!r) continue;
        if (!r.isHotel) { stats.notHotel++; continue; }
        if (!r.sure) { stats.unsure++; continue; }
        const city = r.city || o.city;
        const gk = `${linkNormName(r.name)}|${cityKey(city)}`;
        if (madeNow.has(gk)) { linkSources(o, madeNow.get(gk)); stats.linked++; continue; }
        const existing = [...nameMatches(sys.idx, r.name, city), ...nameMatches(sys.idx, r.name, o.city)];
        const uniq = [...new Map(existing.map(c => [c.id, c])).values()];
        if (uniq.length === 1) { linkSources(o, uniq[0].id); madeNow.set(gk, uniq[0].id); stats.linked++; continue; }
        if (uniq.length > 1) { stats.unsure++; continue; }
        const ref = doc(collection(db, 'hotelCards'));
        cardIds.push(ref.id); madeNow.set(gk, ref.id); stats.created++;
        units.push([{ t: 'set', ref, data: {
          name: r.name, city: cityFromCards(city), country: r.country || '', aliases: [], domain: '',
          web: r.website || '',
          emails: o.emails.map((e, i) => ({ email: e, role: '', person: '', main: i === 0, fromService: true })),
          notes: linkNormName(o.name) !== linkNormName(r.name) ? `V nabídce psáno: ${o.name}` : '',
          source: { type: 'ai', label: '🤖 AI — ověřeno na webu (hotel z nabídek)', at },
          ai: { name: { value: r.name, how: 'web', source: r.source, evidence: r.evidence, model: r.model, at } },
          createdAt: serverTimestamp(),
        } }]);
        linkSources(o, ref.id);
      }
      if (units.length) await commitUnits(units, 'Zakládám karty');
      if (units.length) {
        await setDoc(doc(collection(db, 'hotelAutoFixes')), {
          runId: at, at, by, kind: 'ai-orphans', cardIds, linkKeys, added: [], rowIds: [], undone: false,
          costCzk: Math.round(budget.spent() * 100) / 100,
          label: `AI hotely z nabídek: ${stats.created} nových karet, ${stats.linked} propojeno s existující kartou`,
          reason: `Není hotel: ${stats.notHotel} · nejisté: ${stats.unsure} · útrata ${fmtKc(budget.spent())} Kč`,
        });
      }
      await Promise.all([fetchCards(), fetchFixLog(), fetchAiChecks(), loadSystemData()]);
      setAiBusy('');
      alert(
        (budget.stopped() ? '⏹ Zastaveno. Hotová práce je uložená.\n\n' : '🤖 Hotovo. Databáze hotelů zůstala beze změny.\n\n') +
        `Nových karet (ověřeno na webu): ${stats.created}\n` +
        `Propojeno s existující kartou: ${stats.linked}\n` +
        `Není hotel (odloženo stranou): ${stats.notHotel}\n` +
        `Nejisté (zůstávají s návrhem AI): ${stats.unsure}\n\n` +
        `Útrata: ${fmtKc(budget.spent())} Kč`);
    } catch (e) {
      setAiBusy('');
      await Promise.all([fetchAiChecks(), loadSystemData()]);
      alert(`AI se přerušila: ${e.message}\n\nUtraceno ${fmtKc(budget.spent())} Kč. Ověřené hotely jsou uložené — příště se za ně neplatí.`);
    }
  };

  // 🔶 Možné shody → AI rozhodne (bez internetu, porovná názvy, města, adresy).
  const pendingMaybe = React.useMemo(() => maybeGroups.filter(g => !matchChecks[g.key]), [maybeGroups, matchChecks]);
  const handleAiMaybe = async () => {
    const groups = pendingMaybe;
    if (!groups.length) return;
    if (!window.confirm(
      `🤖 AI posoudí ${groups.length} možných shod (hotel z nabídky ↔ karta).\n\n` +
      'Jisté shody propojí sama, jisté neshody pošle mezi hotely bez karty, nejisté nechá na vás s návrhem.\n' +
      `Cca 0,30 Kč za shodu. Limit útraty: ${aiLimit} Kč. Celý běh jde vrátit.\n\nPokračovat?`)) return;
    const by = auth.currentUser?.email || '', at = new Date().toISOString();
    const budget = makeBudget();
    const cardById = new Map(cards.map(c => [c.id, c]));
    const stats = { yes: 0, no: 0, unsure: 0, failed: 0 };
    const units = [], linkKeys = [];
    try {
      for (let i = 0; i < groups.length; i += 6) {
        if (!budget.ok()) break;
        if (!aiStopRef.current) setAiBusy(`Posuzuji shody: ${i} z ${groups.length} · utraceno ${fmtKc(budget.spent())} Kč`);
        const chunk = groups.slice(i, i + 6);
        const items = chunk.map((g, j) => ({
          i: j, name: g.name, city: g.city, emails: g.emails.slice(0, 4),
          candidates: g.candidates.map(c => ({ id: c.id, name: c.name, city: c.city, emails: ((cardById.get(c.id) || {}).emails || []).slice(0, 4).map(e => e.email) })),
        }));
        let r;
        try { r = await judgeMatches(items); }
        catch (err) { console.error('AI posouzení dávky selhalo:', err); stats.failed += chunk.length; continue; }
        budget.add(r.cost);
        if (!r.results.length) { stats.failed += chunk.length; continue; }
        const batch = writeBatch(db);
        chunk.forEach((g, j) => {
          const res = r.results.find(x => Number(x.i) === j);
          if (!res) { stats.failed++; return; }
          const match = g.candidates.some(c => c.id === res.match) ? res.match : '';
          const check = { key: g.key, match, sure: res.sure === true, model: r.model, at: new Date().toISOString(), by };
          batch.set(doc(db, 'hotelMatchChecks', checkDocId(g.key)), check);
          if (!check.sure) { stats.unsure++; return; }
          const decision = match ? 'yes' : 'no';
          if (match) stats.yes++; else stats.no++;
          g.lines.forEach(line => {
            linkKeys.push(line.key);
            units.push([{ t: 'set', ref: doc(db, 'hotelCardLinks', linkDocId(line.key)), data: {
              key: line.key, decision, cardId: match, rejected: match ? [] : g.candidates.map(c => c.id),
              label: `${line.name} · ${line.city}`, source: line.source || '', ai: true, by, at,
            } }]);
          });
        });
        await batch.commit();
      }
      if (units.length) {
        await commitUnits(units, 'Ukládám propojení');
        await setDoc(doc(collection(db, 'hotelAutoFixes')), {
          runId: at, at, by, kind: 'ai-links', cardIds: [], linkKeys, added: [], rowIds: [], undone: false,
          costCzk: Math.round(budget.spent() * 100) / 100,
          label: `AI shody: ${stats.yes} propojeno, ${stats.no} odmítnuto`,
          reason: `Nejisté: ${stats.unsure} · útrata ${fmtKc(budget.spent())} Kč`,
        });
      }
      await Promise.all([fetchFixLog(), fetchAiChecks(), loadSystemData()]);
      setAiBusy('');
      alert(
        (budget.stopped() ? '⏹ Zastaveno. Hotová práce je uložená.\n\n' : '🤖 Hotovo.\n\n') +
        `Propojeno (jistá shoda): ${stats.yes}\n` +
        `Odmítnuto (jistě jiný hotel → mezi hotely bez karty): ${stats.no}\n` +
        `Nejisté (zůstávají s návrhem AI): ${stats.unsure}\n` +
        (stats.failed ? `Nepodařilo se posoudit (zkuste tlačítko znovu): ${stats.failed}\n` : '') + '\n' +
        `Útrata: ${fmtKc(budget.spent())} Kč`);
    } catch (e) {
      setAiBusy('');
      await Promise.all([fetchAiChecks(), loadSystemData()]);
      alert(`AI se přerušila: ${e.message}\n\nUtraceno ${fmtKc(budget.spent())} Kč.`);
    }
  };

  // ── 🌐 INTERNETOVÁ KONTROLA KARET + SLUČOVÁNÍ DUPLICIT ──────────────────────
  // Údaje se ukládají jen na kartu do `webInfo` (každý se zdrojem). Ručně
  // upravené nebo smazané údaje (`manual`) AI nikdy nepřepíše. Předchozí stav
  // se uloží do `webInfo.prev`, takže celý běh jde vrátit.
  const [mergeNo, setMergeNo] = useState({});
  const [showDup, setShowDup] = useState(false);
  const fetchMergeNo = useCallback(async () => {
    try {
      const snap = await getDocs(collection(db, 'hotelMergeDecisions'));
      const m = {}; snap.docs.forEach(d => { const v = d.data(); if (v.key) m[v.key] = v; });
      setMergeNo(m);
    } catch (e) { console.error(e); }
  }, []);
  useEffect(() => { if (tab === 'cards') fetchMergeNo(); }, [tab, fetchMergeNo]);

  const workingIds = React.useMemo(() => {
    const s = new Set();
    if (sys) for (const [id, b] of sys.links) if (b.offerLines.length || b.orderLines.length) s.add(id);
    return s;
  }, [sys]);
  // K hotelům z nabídek se přiberou i jejich pravděpodobné duplicity (stejné
  // město a stejná vlastní doména e-mailu, nebo stejný název bez slov jako
  // Groups / Reservations) — jinak by se karty jednoho hotelu nemohly sloučit.
  const workSet = React.useMemo(() => {
    const out = new Set(workingIds);
    if (!workingIds.size) return out;
    const DEPT = /\b(groups?|grupos?|reservations?|reservas?|booking|conference|events?|mice|sales|leisure|meetings?|front ?desk|info)\b/g;
    const baseName = (n) => linkNormName(String(n || '').toLowerCase().replace(DEPT, ' '));
    const domains = (c) => (c.emails || []).map(e => String(e.email || '').toLowerCase().split('@')[1]).filter(d => d && !FREEMAIL.has(d));
    const byCity = new Map();
    cards.forEach(c => { const k = cityKey(c.city); if (!byCity.has(k)) byCity.set(k, []); byCity.get(k).push(c); });
    cards.filter(c => workingIds.has(c.id)).forEach(w => {
      const ds = new Set(domains(w));
      const bn = baseName(w.name);
      (byCity.get(cityKey(w.city)) || []).forEach(o => {
        if (out.has(o.id)) return;
        if (domains(o).some(d => ds.has(d)) || (bn.length >= 4 && baseName(o.name) === bn)) out.add(o.id);
      });
    });
    return out;
  }, [workingIds, cards]);
  const webPendingWork = cards.filter(c => workSet.has(c.id) && !(c.webInfo && c.webInfo.checkedAt));
  const webPendingAll = cards.filter(c => !(c.webInfo && c.webInfo.checkedAt));

  // Kolik karet sdílí stejnou adresu — sdílená adresa = nejspíš centrála.
  const emailShare = React.useMemo(() => {
    const m = new Map();
    cards.forEach(c => (c.emails || []).forEach(e => {
      const k = String(e.email || '').toLowerCase();
      if (k) m.set(k, (m.get(k) || 0) + 1);
    }));
    return m;
  }, [cards]);
  const emailBadge = (e) => {
    const k = String(e.email || '').toLowerCase();
    if (e.type) return { text: EMAIL_TYPES[e.type] || e.type, central: e.type === 'central', ai: !e.typeManual };
    const n = emailShare.get(k) || 0;
    if (n >= 2) return { text: `🏢 sdílená (${n} karet) — nejspíš centrála`, central: true, ai: false };
    return null;
  };

  const mergeCandidates = React.useMemo(() => findDuplicateGroups(cards).filter(g => !mergeNo[g.key]), [cards, mergeNo]);

  const applyWebResult = (card, r) => {
    const old = card.webInfo || null;
    const fields = {};
    const oldFields = (old && old.fields) || {};
    Object.entries(oldFields).forEach(([k, f]) => { if (f && f.manual) fields[k] = f; });
    Object.entries(r.fields).forEach(([k, f]) => { if (!fields[k]) fields[k] = { ...f, ai: true }; });
    const prev = old ? { ...old } : null;
    if (prev) delete prev.prev;
    const emails = (card.emails || []).map(e => {
      const t = r.emailTypes[String(e.email || '').toLowerCase()];
      if (!t || e.typeManual) return e;
      return { ...e, typePrev: e.type || '', type: t };
    });
    return {
      webInfo: { checkedAt: new Date().toISOString(), model: r.model, sure: r.sure, evidence: r.evidence, fields, prev },
      emails,
    };
  };

  const runMerge = async (group, by, auto) => {
    const list = group.ids.map(id => cards.find(c => c.id === id)).filter(Boolean);
    if (list.length < 2) return false;
    const { primary, others, data } = buildMerged(list);
    const otherIds = new Set(others.map(c => c.id));
    const rows = hotels.filter(h => otherIds.has(h.cardId)).map(h => ({ id: h.id, from: h.cardId }));
    const links = Object.values(decisions).filter(v => v.decision === 'yes' && otherIds.has(v.cardId)).map(v => ({ key: v.key, from: v.cardId }));
    const strip = ({ id, ...rest }) => rest;
    const units = [
      [{ t: 'set', ref: doc(db, 'hotelCards', primary.id), data: { ...strip(primary), ...data } }],
      ...others.map(c => [{ t: 'delete', ref: doc(db, 'hotelCards', c.id) }]),
      ...rows.map(r => [{ t: 'update', ref: doc(db, 'hotels', r.id), data: { cardId: primary.id } }]),
      ...links.map(l => [{ t: 'update', ref: doc(db, 'hotelCardLinks', linkDocId(l.key)), data: { cardId: primary.id } }]),
    ];
    await commitUnits(units, 'Slučuji');
    const at = new Date().toISOString();
    await setDoc(doc(collection(db, 'hotelAutoFixes')), {
      runId: at, at, by, kind: 'merge', undone: false, cardIds: [], added: [], rowIds: [],
      label: `${auto ? '🤖 ' : ''}Sloučeno: ${data.name} (${list.length} karty → 1)`,
      reason: `${group.reason} · ${list.map(c => c.name).join(' + ')}`,
      merge: { primaryId: primary.id, primaryBefore: strip(primary), others: others.map(c => ({ id: c.id, data: strip(c) })), rows, links },
    });
    return true;
  };

  const handleMergeDecision = async (group, merge) => {
    setSysBusy(group.key);
    try {
      if (merge) {
        await runMerge(group, auth.currentUser?.email || '', false);
      } else {
        const v = { key: group.key, decision: 'no', by: auth.currentUser?.email || '', at: new Date().toISOString() };
        await setDoc(doc(db, 'hotelMergeDecisions', encodeURIComponent(group.key).slice(0, 1400)), v);
      }
      await Promise.all([fetchCards(), fetchHotels(), fetchFixLog(), fetchMergeNo(), loadSystemData()]);
    } catch (e) { alert('Nepodařilo se: ' + e.message); }
    setSysBusy('');
  };

  const handleWebCheck = async (list, label) => {
    if (!list.length) return;
    if (list.length > 1 && !window.confirm(
      `🌐 Internetová kontrola: ${label} (${list.length} karet).\n\n` +
      '• AI na internetu dohledá adresu, web, telefon, hvězdičky, pokoje, skupiny a hodnocení — každý údaj se zdrojem\n' +
      '• u každého e-mailu určí, jestli je to hotel, skupiny, rezervace, sales nebo 🏢 centrála\n' +
      '• karty se stejnou adresou nebo stránkou hotelu jistě sloučí (🤖, jde vrátit), nejisté nechá na vás\n' +
      '• ručně zadané údaje nepřepíše; databáze hotelů se nemění\n\n' +
      `Cca 3 Kč za kartu. Limit útraty: ${aiLimit} Kč.\n\nPokračovat?`)) return;
    if (list.length === 1 && !window.confirm(`🌐 Zkontrolovat „${list[0].name}“ na internetu? (cca 3 Kč)`)) return;
    const by = auth.currentUser?.email || '', at = new Date().toISOString();
    const budget = makeBudget();
    const stats = { ok: 0, unsure: 0, failed: 0, merged: 0, dupLeft: 0 };
    const doneIds = [];
    try {
      let idx = 0, done = 0;
      setAiBusy(`Internetová kontrola: 0 z ${list.length}`);
      const worker = async () => {
        while (idx < list.length) {
          if (!budget.ok()) return;
          const card = list[idx++];
          try {
            const r = await webCheckCard(card);
            budget.add(r.cost);
            await updateDoc(doc(db, 'hotelCards', card.id), applyWebResult(card, r));
            doneIds.push(card.id);
            if (r.sure) stats.ok++; else stats.unsure++;
          } catch (err) {
            console.error('Internetová kontrola karty selhala:', card.name, err);
            stats.failed++;
          }
          done++;
          if (!aiStopRef.current) setAiBusy(`Internetová kontrola: ${done} z ${list.length} · utraceno ${fmtKc(budget.spent())} Kč`);
        }
      };
      await Promise.all([1, 2, 3].map(worker));
      if (doneIds.length) {
        await setDoc(doc(collection(db, 'hotelAutoFixes')), {
          runId: at, at, by, kind: 'web-check', undone: false, cardIds: [], webCardIds: doneIds, added: [], rowIds: [],
          costCzk: Math.round(budget.spent() * 100) / 100,
          label: `🌐 Internetová kontrola: ${doneIds.length} karet`,
          reason: `Jisté: ${stats.ok} · nejisté: ${stats.unsure} · chyba: ${stats.failed} · útrata ${fmtKc(budget.spent())} Kč`,
        });
      }
      // Sloučení jistých duplicit — z čerstvých karet.
      setAiBusy('Hledám duplicitní karty…');
      const fresh = (await getDocs(collection(db, 'hotelCards'))).docs.map(d => ({ id: d.id, ...d.data() }));
      setCards(fresh);
      const groups = findDuplicateGroups(fresh).filter(g => !mergeNo[g.key]);
      const touched = new Set(doneIds);
      for (const g of groups) {
        if (!g.ids.some(id => touched.has(id))) continue;
        if (!g.sure) { stats.dupLeft++; continue; }
        // runMerge pracuje se stavem `cards` — vezmeme karty z čerstvého načtení.
        const list2 = g.ids.map(id => fresh.find(c => c.id === id)).filter(Boolean);
        const { primary, others, data } = buildMerged(list2);
        const otherIds = new Set(others.map(c => c.id));
        const rows = hotels.filter(h => otherIds.has(h.cardId)).map(h => ({ id: h.id, from: h.cardId }));
        const links = Object.values(decisions).filter(v => v.decision === 'yes' && otherIds.has(v.cardId)).map(v => ({ key: v.key, from: v.cardId }));
        const strip = ({ id, ...rest }) => rest;
        await commitUnits([
          [{ t: 'set', ref: doc(db, 'hotelCards', primary.id), data: { ...strip(primary), ...data } }],
          ...others.map(c => [{ t: 'delete', ref: doc(db, 'hotelCards', c.id) }]),
          ...rows.map(r => [{ t: 'update', ref: doc(db, 'hotels', r.id), data: { cardId: primary.id } }]),
          ...links.map(l => [{ t: 'update', ref: doc(db, 'hotelCardLinks', linkDocId(l.key)), data: { cardId: primary.id } }]),
        ], 'Slučuji');
        const at2 = new Date().toISOString();
        await setDoc(doc(collection(db, 'hotelAutoFixes')), {
          runId: at2, at: at2, by, kind: 'merge', undone: false, cardIds: [], added: [], rowIds: [],
          label: `🤖 Sloučeno: ${data.name} (${list2.length} karty → 1)`,
          reason: `${g.reason} · ${list2.map(c => c.name).join(' + ')}`,
          merge: { primaryId: primary.id, primaryBefore: strip(primary), others: others.map(c => ({ id: c.id, data: strip(c) })), rows, links },
        });
        stats.merged++;
      }
      await Promise.all([fetchCards(), fetchHotels(), fetchFixLog(), fetchMergeNo(), loadSystemData()]);
      setAiBusy('');
      alert(
        (budget.stopped() ? '⏹ Zastaveno. Hotová práce je uložená.\n\n' : '🌐 Hotovo. Databáze hotelů zůstala beze změny.\n\n') +
        `Zkontrolováno — jisté: ${stats.ok}\n` +
        `Zkontrolováno — nejisté (údaje uložené, zkontrolujte): ${stats.unsure}\n` +
        (stats.failed ? `Nepodařilo se (zkuste znovu): ${stats.failed}\n` : '') +
        `\nSloučeno duplicitních karet (jisté): ${stats.merged}\n` +
        `Možné duplicity k vašemu rozhodnutí: ${stats.dupLeft}\n\n` +
        `Útrata: ${fmtKc(budget.spent())} Kč`);
    } catch (e) {
      setAiBusy('');
      await Promise.all([fetchCards(), fetchFixLog()]);
      alert(`Kontrola se přerušila: ${e.message}\n\nUtraceno ${fmtKc(budget.spent())} Kč. Hotové karty jsou uložené.`);
    }
  };

  // ✏ / 🗑 internetový údaj na kartě — ruční hodnota má vždy přednost.
  const handleEditWebField = async (card, key, label) => {
    const cur = card.webInfo?.fields?.[key];
    const curVal = cur && !cur.deleted ? (typeof cur.value === 'object' && cur.value ? JSON.stringify(cur.value) : String(cur.value ?? '')) : '';
    const v = window.prompt(`${label}:`, curVal);
    if (v == null) return;
    let value = v.trim();
    if (['stars', 'rooms'].includes(key) && value !== '') value = Number(value.replace(',', '.')) || value;
    if (key === 'groups') value = /^(a|ano|y|yes|true|1)$/i.test(value) ? true : /^(n|ne|no|false|0)$/i.test(value) ? false : value;
    if (['google', 'booking'].includes(key) && value) { try { value = JSON.parse(value); } catch { value = { score: value, count: null }; } }
    try {
      await updateDoc(doc(db, 'hotelCards', card.id), { [`webInfo.fields.${key}`]: { value, source: '', manual: true, by: auth.currentUser?.email || '', at: new Date().toISOString() } });
      await fetchCards();
    } catch (e) { alert('Nepodařilo se uložit: ' + e.message); }
  };
  const handleDeleteWebField = async (card, key, label) => {
    if (!window.confirm(`Smazat údaj „${label}“ z karty? AI ho při další kontrole znovu nedoplní.`)) return;
    try {
      await updateDoc(doc(db, 'hotelCards', card.id), { [`webInfo.fields.${key}`]: { deleted: true, manual: true, by: auth.currentUser?.email || '', at: new Date().toISOString() } });
      await fetchCards();
    } catch (e) { alert('Nepodařilo se smazat: ' + e.message); }
  };
  const handleEmailType = async (card, email) => {
    const opts = Object.entries(EMAIL_TYPES).map(([k, v]) => `${k} = ${v}`).join('\n');
    const v = window.prompt(`Typ adresy ${email}:\n\n${opts}\n\nNapište zkratku (např. groups):`, (card.emails || []).find(e => e.email === email)?.type || '');
    if (v == null) return;
    const t = v.trim().toLowerCase();
    if (t && !EMAIL_TYPES[t]) { alert('Neznámý typ: ' + t); return; }
    try {
      const emails = (card.emails || []).map(e => e.email === email ? { ...e, type: t, typeManual: true } : e);
      await updateDoc(doc(db, 'hotelCards', card.id), { emails });
      await fetchCards();
    } catch (e) { alert('Nepodařilo se uložit: ' + e.message); }
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
      if (newName !== String(row.name || '').trim()) {
        patch.name = newName;
        // Poznámka, která byla schovaná v původním názvu ("neberou skupiny"),
        // se při přepsání názvu nesmí ztratit — uloží se do `nameNote` a při
        // zakládání karty se z ní stane interní poznámka.
        const oldNote = splitNameNote(row.name).note;
        if (oldNote && !newName.includes(oldNote)) {
          const prev = String(row.nameNote || '').trim();
          if (!prev.includes(oldNote)) patch.nameNote = prev ? `${prev} · ${oldNote}` : oldNote;
        }
      }
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
    // Název skupiny se v textu vypisuje i s číslem zakázky ("Grupo X / BV-27004").
    // Dřív se to řešilo ručním dopsáním čísla do názvu skupiny; teď to dělá
    // aplikace, takže to funguje ve všech šablonách bez jejich úpravy.
    // Samotné číslo je k dispozici i zvlášť jako {{offerNumber}}.
    .replace(/{{groupName}}/g, [groupName, offerNumber.trim()].filter(Boolean).join(' / ')||'[GROUP NAME]')
    .replace(/{{checkIn}}/g, fmtDateEU(checkIn)||'[CHECK-IN]')
    .replace(/{{checkOut}}/g, fmtDateEU(checkOut)||'[CHECK-OUT]')
    .replace(/{{offerNumber}}/g, offerNumber.trim()||'[REFERENCE]')
    .replace(/{{optionDate}}/g, fmtDateEU(optionDate)||'[OPTION DATE]')
    .replace(/{{freeRatio}}/g, freeRatio||'20')
    .replace(/{{signature}}/g, SIGNATURES.find(s => s.id === signatureId)?.html || '');
  };

  // Aktuální text editoru převedený do HTML — v režimu "Upravit" se bere
  // z textového pole, v režimu HTML přímo ze stavu.
  const currentTemplateHtml = () => {
    const t = editMode === 'visual' && visualEditorRef.current ? visualEditorRef.current.value : null;
    return t !== null ? plainToHtml(t) : emailBody;
  };

  // Porovnává se čistý text, ne HTML — převod tam a zpět mění formátování,
  // takže porovnání HTML by hlásilo změnu i u nedotčené šablony.
  const isTemplateDirty = () => {
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return false;
    if (editMode === 'visual' && visualEditorRef.current) {
      return visualEditorRef.current.value.trim() !== htmlToPlain(tpl.body || '').trim();
    }
    return String(emailBody).trim() !== String(tpl.body || '').trim();
  };

  const selectTemplate = (id) => {
    if (id === templateId) return;
    if (isTemplateDirty() && !window.confirm('Text emailu je upravený a neuložený.\n\nPřepnutím šablony se úpravy ztratí. Přepnout?')) return;
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    setTemplateId(id);
    setEmailBody(tpl.body || DEFAULT_TEMPLATE);
  };

  const saveTemplate = async () => {
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return;
    if (!window.confirm(`Přepsat šablonu „${tpl.name}" aktuálním textem?`)) return;
    setTemplateBusy(true);
    try {
      const body = currentTemplateHtml();
      await updateDoc(doc(db, 'emailTemplates', tpl.id), { body, updatedAt: serverTimestamp() });
      setEmailBody(body);
      await fetchTemplates(tpl.id);
    } catch (e) { alert('Šablonu se nepodařilo uložit: ' + e.message); }
    setTemplateBusy(false);
  };

  const saveTemplateAsNew = async () => {
    const name = window.prompt('Název nové šablony:', '');
    if (!name || !name.trim()) return;
    setTemplateBusy(true);
    try {
      const maxOrder = templates.reduce((m, t) => Math.max(m, t.order || 0), 0);
      const ref = await addDoc(collection(db, 'emailTemplates'), {
        name: name.trim(), order: maxOrder + 1, subjectSuffix: '',
        body: currentTemplateHtml(), builtin: false, createdAt: serverTimestamp(),
      });
      await fetchTemplates(ref.id);
    } catch (e) { alert('Šablonu se nepodařilo založit: ' + e.message); }
    setTemplateBusy(false);
  };

  const deleteTemplate = async () => {
    const tpl = templates.find(t => t.id === templateId);
    if (!tpl) return;
    if (templates.length <= 1) { alert('Poslední šablonu smazat nejde.'); return; }
    if (!window.confirm(`Smazat šablonu „${tpl.name}"?\n\nTohle je nevratné.`)) return;
    setTemplateBusy(true);
    try {
      await deleteDoc(doc(db, 'emailTemplates', tpl.id));
      const next = templates.find(t => t.id !== tpl.id);
      await fetchTemplates(next?.id);
    } catch (e) { alert('Šablonu se nepodařilo smazat: ' + e.message); }
    setTemplateBusy(false);
  };

  const toggleSelect = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  // Ručně zadané adresy z pole „Poslat sem". Oddělovat jde čárkou, středníkem
  // i mezerou, takže se dá vložit víc adres najednou.
  const extraParsed  = extraEmail.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  const extraValid   = extraParsed.filter(e => EMAIL_RE.test(e));
  const extraInvalid = extraParsed.filter(e => !EMAIL_RE.test(e));
  // Odeslat jde i bez vybraného hotelu — stačí vyplněná adresa v „Poslat sem".
  const canSend = (selected.length > 0 || extraValid.length > 0) && extraInvalid.length === 0;
  const sendLabel = (() => {
    const parts = [];
    if (selected.length) parts.push(`${selected.length} hotel${selected.length===1?'':selected.length<5?'y':'ů'}`);
    if (extraValid.length) parts.push(`${extraValid.length} adres${extraValid.length===1?'u':extraValid.length<5?'y':''}`);
    return parts.length ? '✉ Odeslat na ' + parts.join(' + ') : '✉ Odeslat';
  })();

  const handleSend = async () => {
    if (!selected.length && extraValid.length === 0) {
      alert('Vyber alespoň jeden hotel ze seznamu, nebo vyplň adresu v poli „Poslat sem".');
      return;
    }
    if (extraInvalid.length) {
      alert('Tohle nevypadá jako platná emailová adresa:\n\n' + extraInvalid.join('\n') + '\n\nOprav ji, nebo smaž.');
      return;
    }
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
    setSendProgress(`Odesílám ${sel.length + extraValid.length} emailů...`);
    let sent = 0, failed = 0;
    try {
      const res = await fetch('https://tour-pragenses.com/mailer.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: [...sel.map(h => ({ email: h.email, name: h.name||h.email })), ...extraValid.map(e => ({ email: e, name: e }))], subject, body, from: senderFrom }),
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
                email: h.email, subject, groupName, offerNumber, checkIn, checkOut,
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
        // Ručně zadané adresy se zapisují do logu taky — musí být dohledatelné,
        // že se email odeslal. Nemají hotelId, protože v databázi hotelů nejsou;
        // příznak `manual` je v logu odliší od poptávek na hotely ze seznamu.
        for (let j = 0; j < extraValid.length; j++) {
          const e = extraValid[j];
          const r = data.results[sel.length + j];
          if (r && r.ok) {
            try {
              await addDoc(collection(db, 'hotelEmailLog'), {
                hotelId: '', hotelName: e, hotelCity: '', manual: true,
                email: e, subject, groupName, offerNumber, checkIn, checkOut,
                sentAt: serverTimestamp(), status: 'sent',
              });
            } catch (logErr) {
              console.error('Failed to write hotelEmailLog entry (email was still sent):', logErr);
            }
            sent++;
          } else { failed++; }
        }
      } else { alert('Chyba: ' + JSON.stringify(data)); failed = sel.length + extraValid.length; }
    } catch (e) {
      alert('Chyba: ' + e.message); failed = sel.length + extraValid.length;
    }
    setSending(false);
    setSendProgress('');
    if (sent > 0) {
      setSendResult({ sent, failed });
      setGroupName(''); setCheckIn(''); setCheckOut(''); setOptionDate('');
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
      // Řádek, který už patří ke kartě, je vyřešený na kartě (tam je
      // i opravená adresa). Databáze se nemění, jen se tu dál nezobrazuje.
      if (h.cardId) continue;
      const e = String(h.email || '').toLowerCase();
      const problem = rowEmailProblem(h);
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
    if (onlyUsed) { const sm = summaryOf(c.id); if (!sm || !(sm.offers || sm.orders)) return false; }
    const q = cardSearch.trim().toLowerCase();
    if (!q) return true;
    return (c.name || '').toLowerCase().includes(q)
      || (c.city || '').toLowerCase().includes(q)
      || (c.emails || []).some(e => (e.email || '').includes(q));
  });

  if (onlyUsed) {
    const score = (c) => { const s = summaryOf(c.id); return s ? s.offers * 3 + s.requests + s.realized * 5 : 0; };
    cardsFiltered.sort((a, b) => score(b) - score(a));
  }

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
                ['ID zakázky', offerNumber, setOfferNumber, 'text'],
                ['Check-in', checkIn, setCheckIn, 'date'],
                ['Check-out', checkOut, setCheckOut, 'date'],
                ['Option date (do kdy držet nabídku)', optionDate, setOptionDate, 'date'],
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
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Šablona</label>
              {templates.length > 0 ? (
                <select value={templateId} onChange={e => selectTemplate(e.target.value)} style={inp()}>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              ) : (
                <div style={{ fontSize: 12, color: C.muted }}>
                  {templatesError
                    ? `⚠ Šablony se nenačetly (${templatesError}) — pracuje se se zabudovaným textem, odesílání funguje normálně.`
                    : 'Načítám…'}
                </div>
              )}
            </div>
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
              {/* Klíč pole obsahuje i název šablony: všechny šablony začínají
                  stejnou hlavičkou, takže podle prvních 50 znaků by se pole
                  při přepnutí šablony nepřekreslilo. */}
              {editMode === 'visual' ? (
                <textarea
                  ref={visualEditorRef}
                  key={`${templateId}|${emailBody.length}|${emailBody.slice(0, 50)}`}
                  defaultValue={htmlToPlain(emailBody)}
                  rows={30}
                  style={{ ...inp(), resize: 'vertical', lineHeight: 1.8, fontFamily: 'Georgia, serif' }}
                  placeholder="Napiš nebo uprav text emailu..."
                />
              ) : (
                <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={16} style={{ ...inp(), resize: 'vertical', lineHeight: 1.6, fontFamily: 'monospace', fontSize: 11 }} />
              )}
              {templates.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button onClick={saveTemplate} disabled={templateBusy}
                    style={{ fontSize: 11, color: C.primary, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', opacity: templateBusy ? 0.5 : 1 }}>
                    💾 Uložit do šablony
                  </button>
                  <button onClick={saveTemplateAsNew} disabled={templateBusy}
                    style={{ fontSize: 11, color: C.primary, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer', opacity: templateBusy ? 0.5 : 1 }}>
                    ＋ Uložit jako novou
                  </button>
                  <button onClick={deleteTemplate} disabled={templateBusy || templates.length <= 1}
                    style={{ fontSize: 11, color: '#b00020', background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 10px', cursor: (templateBusy || templates.length <= 1) ? 'default' : 'pointer', opacity: (templateBusy || templates.length <= 1) ? 0.4 : 1 }}>
                    🗑 Smazat šablonu
                  </button>
                  <span style={{ fontSize: 11, color: C.muted }}>
                    Úpravy bez uložení platí jen pro tento email.
                  </span>
                </div>
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
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>
                Poslat sem (adresa mimo seznam, kopie sobě, test — víc adres oddělte čárkou)
              </label>
              <input type="text" value={extraEmail} onChange={e => setExtraEmail(e.target.value)}
                placeholder="hotel@example.com, grupos@tour-pragenses.com" style={{ ...inp() }} />
              {extraInvalid.length > 0 && (
                <div style={{ fontSize: 11, color: '#b00020', marginTop: 4 }}>
                  ⚠ Tohle nevypadá jako adresa: {extraInvalid.join(', ')}
                </div>
              )}
              {extraValid.length > 0 && extraInvalid.length === 0 && (
                <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                  Odejde také na: {extraValid.join(', ')}
                </div>
              )}
            </div>
            <button onClick={handleSend} disabled={canSend ? sending : true} style={{ ...btn(canSend && !sending ? C.primary : C.border, canSend && !sending ? '#fff' : C.muted), fontSize: 15, padding: '10px 24px' }}>
              {sending ? sendProgress || 'Připravuji...' : sendLabel}
            </button>
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
                  {['Datum','ID zakázky','Hotel','Město','Email','Skupina','Check-in','Check-out'].map(h=><th key={h} style={thS}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {logs.map(l => (
                    <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={tdS}>{fmt(l.sentAt)}</td>
                      {/* U záznamů odeslaných před touhle úpravou číslo chybí — proto pomlčka. */}
                      <td style={tdS}>{l.offerNumber || '—'}</td>
                      <td style={tdS}>
                        <strong>{l.hotelName}</strong>
                        {l.manual && <span style={{ fontSize: 10, color: C.muted, marginLeft: 6, border: `1px solid ${C.border}`, borderRadius: 3, padding: '1px 4px' }}>ručně</span>}
                      </td>
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
              Jisté shody umí založit i tlačítko 🤖 Zpracovat automaticky v Kontrole adres; každá karta jde kdykoliv zrušit.
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

              {/* 📊 PROPOJENÍ S VAŠÍM SYSTÉMEM */}
              <div style={{ ...cardS, marginBottom: '1.2rem', borderColor: '#9fc9b0', background: '#f4fbf6' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 260 }}>
                    <strong style={{ fontSize: 15, color: '#2e6b45' }}>📊 Propojení s nabídkami, zakázkami a poptávkami</strong>
                    <p style={{ fontSize: 12, color: C.muted, margin: '4px 0 0', lineHeight: 1.5 }}>
                      Karty se živě propojí se vším, kde se hotel v aplikaci objevil — jistě podle e-mailu,
                      podle názvu jen jako „možná shoda“, kterou potvrdíte. Klikněte na název hotelu v seznamu
                      a uvidíte jeho historii, ceny, podmínky a poznámky.
                    </p>
                  </div>
                  <button onClick={loadSystemData} disabled={sysLoading}
                    style={{ ...smallBtn('#2e6b45'), opacity: sysLoading ? 0.5 : 1 }}>
                    {sysLoading ? '⏳ Načítám…' : '↻ Načíst znovu'}
                  </button>
                </div>
                {sysError && <div style={{ marginTop: 8, fontSize: 12, color: '#b00020' }}>Chyba: {sysError}</div>}
                {aiBusy && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: '#5b3fa0' }}>
                    ⏳ {aiBusy} <span style={{ color: C.muted, fontSize: 12 }}>— nechte stránku otevřenou</span>
                    <button onClick={() => { aiStopRef.current = true; setAiBusy('Zastavuji — dokončuji rozpracované a ukládám…'); }} style={smallBtn('#b00020')}>⏹ Zastavit</button>
                  </div>
                )}
                {sys && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, padding: 8, background: '#eef5fb', borderRadius: 6, fontSize: 12 }}>
                    <strong style={{ color: '#1f5f8b' }}>🌐 Internetová kontrola:</strong>
                    <button onClick={() => handleWebCheck(webPendingWork, 'hotely z nabídek a zakázek')} disabled={!!aiBusy || !!sysBusy || !webPendingWork.length}
                      style={{ ...smallBtn('#1f5f8b'), opacity: (aiBusy || sysBusy || !webPendingWork.length) ? 0.5 : 1 }}>
                      hotely z nabídek a zakázek ({webPendingWork.length})
                    </button>
                    <button onClick={() => handleWebCheck(webPendingAll, 'všechny karty')} disabled={!!aiBusy || !!sysBusy || !webPendingAll.length}
                      style={{ ...smallBtn('#41698a'), opacity: (aiBusy || sysBusy || !webPendingAll.length) ? 0.5 : 1 }}>
                      všechny karty ({webPendingAll.length})
                    </button>
                    <span style={{ color: C.muted }}>cca 3 Kč za kartu · limit</span>
                    <input value={aiLimit} onChange={e => setAiLimit(e.target.value)} disabled={!!aiBusy}
                      style={inp({ width: 70, fontSize: 12, padding: '2px 6px' })} /> <span style={{ color: C.muted }}>Kč</span>
                    <button onClick={() => setShowDup(v => !v)}
                      style={smallBtn(mergeCandidates.length ? '#8a4b1f' : C.muted)}>
                      🔗 Možné duplicitní karty ({mergeCandidates.length})
                    </button>
                  </div>
                )}
                {sys && showDup && (
                  <div style={{ marginTop: 12, maxHeight: 520, overflowY: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
                    <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>
                      Karty, u kterých internetová kontrola našla stejnou adresu nebo stránku hotelu. Sloučení spojí e-maily,
                      názvy („také jako“), poznámky i propojení s nabídkami do jedné karty — jde vrátit.
                    </p>
                    {mergeCandidates.length === 0 ? <p style={{ fontSize: 13, color: C.muted }}>Žádné duplicity k rozhodnutí.</p> : mergeCandidates.map(g => {
                      const list = g.ids.map(id => cards.find(c => c.id === id)).filter(Boolean);
                      return (
                        <div key={g.key} style={{ borderBottom: `1px solid ${C.border}`, padding: '8px 0', fontSize: 12 }}>
                          <div style={{ color: '#8a4b1f', marginBottom: 4 }}>{g.reason}{g.sure ? ' · jisté' : ''}</div>
                          {list.map(c => (
                            <div key={c.id}>
                              <strong style={{ cursor: 'pointer', color: C.primary }} onClick={() => setDetailId(c.id)}>{c.name}</strong> · {c.city}
                              <span style={{ color: C.muted }}> — {c.webInfo?.fields?.address?.value || ''} {c.webInfo?.fields?.website?.value ? `· ${c.webInfo.fields.website.value}` : ''} · {(c.emails || []).map(e => e.email).join(', ')}</span>
                            </div>
                          ))}
                          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                            <button onClick={() => handleMergeDecision(g, true)} disabled={!!sysBusy} style={{ ...smallBtn('#2e7d32'), opacity: sysBusy ? 0.5 : 1 }}>🔗 Sloučit do jedné karty</button>
                            <button onClick={() => handleMergeDecision(g, false)} disabled={!!sysBusy} style={{ ...smallBtn(C.muted), opacity: sysBusy ? 0.5 : 1 }}>Nechat zvlášť</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {sys && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, fontSize: 12 }}>
                    {(() => {
                      let works = 0, onlyAsked = 0;
                      for (const b of sys.links.values()) {
                        if (b.offerLines.length || b.orderLines.length) works++; else if (b.requests.length) onlyAsked++;
                      }
                      return (
                        <span style={{ padding: '5px 10px', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 6 }}
                          title="Pracujeme = hotel byl v nabídce nebo zakázce. Jen poptané = dostal jen (hromadnou) poptávku.">
                          🏨 pracujeme: <strong>{works}</strong> · 📨 jen poptané: <strong>{onlyAsked}</strong>
                        </span>
                      );
                    })()}
                    <button onClick={() => handleAddEmails(emailsToAdd)} disabled={!emailsToAddCount || !!sysBusy}
                      style={{ ...smallBtn('#2e6b45'), opacity: (!emailsToAddCount || sysBusy) ? 0.5 : 1 }}
                      title="E-maily z nabídek a zakázek, které na kartě hotelu ještě nejsou">
                      {sysBusy === 'emails' ? '…' : `📇 Přidat e-maily ze servisních karet (${emailsToAddCount})`}
                    </button>
                    <button onClick={() => setSysPanel(p => p === 'maybe' ? '' : 'maybe')}
                      style={smallBtn(maybeGroups.length ? '#c27c0e' : C.muted)}>
                      🔶 Možné shody k potvrzení ({maybeGroups.length})
                    </button>
                    <button onClick={() => setSysPanel(p => p === 'orphans' ? '' : 'orphans')}
                      style={smallBtn(sys.orphans.some(o => !(orphanChecks[o.key] && !orphanChecks[o.key].isHotel)) ? '#5b3fa0' : C.muted)}>
                      ➕ Hotely z nabídek bez karty ({sys.orphans.filter(o => !(orphanChecks[o.key] && !orphanChecks[o.key].isHotel)).length})
                    </button>
                  </div>
                )}

                {sys && sysPanel === 'maybe' && (
                  <div style={{ marginTop: 12, maxHeight: 520, overflowY: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
                    <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>
                      Hotel z nabídky / zakázky, který má podobný název nebo sdílenou adresu s kartou. Dokud to nepotvrdíte,
                      nikam se nepočítá. ✅ propojí, ❌ nechá zvlášť (pak se objeví mezi hotely bez karty).
                    </p>
                    {pendingMaybe.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8, padding: 8, background: '#f8f5fe', borderRadius: 6 }}>
                        <button onClick={handleAiMaybe} disabled={!!aiBusy || !!sysBusy}
                          style={{ ...smallBtn('#5b3fa0'), opacity: (aiBusy || sysBusy) ? 0.5 : 1 }}>
                          🤖 Nechat AI posoudit ({pendingMaybe.length})
                        </button>
                        <span style={{ fontSize: 12, color: C.muted }}>
                          jisté propojí / odmítne sama, nejisté nechá s návrhem · cca 0,30 Kč za shodu · limit
                        </span>
                        <input value={aiLimit} onChange={e => setAiLimit(e.target.value)} disabled={!!aiBusy}
                          style={inp({ width: 70, fontSize: 12, padding: '2px 6px' })} /> <span style={{ fontSize: 12, color: C.muted }}>Kč</span>
                      </div>
                    )}
                    {maybeGroups.length === 0 ? <p style={{ fontSize: 13, color: C.muted }}>Nic k potvrzení.</p> : maybeGroups.map(g => (
                      <div key={g.key} style={{ borderBottom: `1px solid ${C.border}`, padding: '8px 0', fontSize: 12 }}>
                        <div>
                          <strong>{g.name}</strong> · {g.city || '—'}
                          <span style={{ color: C.muted }}> — {g.lines.length}× v {[...new Set(g.lines.map(l => `${l.source === 'order' ? 'zakázka ' : ''}${l.offerNumber || l.group}`).filter(Boolean))].slice(0, 5).join(', ')}{g.lines.length > 5 ? '…' : ''}</span>
                          {g.emails.length > 0 && <div style={{ color: C.muted }}>{g.emails.join(', ')}</div>}
                          {matchChecks[g.key] && !matchChecks[g.key].sure && (
                            <div style={{ color: '#5b3fa0' }}>
                              🤖 AI si není jistá{matchChecks[g.key].match ? ` — spíš „${(g.candidates.find(c => c.id === matchChecks[g.key].match) || {}).name || ''}“` : ' — spíš žádná z karet'}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                          {g.candidates.map(c => (
                            <button key={c.id} onClick={() => saveDecision(g, 'yes', c.id)} disabled={!!sysBusy}
                              style={{ ...smallBtn('#2e7d32'), opacity: sysBusy ? 0.5 : 1 }}>
                              ✅ je to „{c.name}“ ({c.city})
                            </button>
                          ))}
                          <button onClick={() => saveDecision(g, 'no')} disabled={!!sysBusy}
                            style={{ ...smallBtn('#b00020'), opacity: sysBusy ? 0.5 : 1 }}>❌ žádná z nich</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {sys && sysPanel === 'orphans' && (
                  <div style={{ marginTop: 12, maxHeight: 520, overflowY: 'auto', background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, padding: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>
                        Hotely, které byly v nabídkách nebo zakázkách, ale žádná karta jim neodpovídá.
                      </p>
                    </div>
                    {pendingOrphans.length > 0 && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0', padding: 8, background: '#f8f5fe', borderRadius: 6 }}>
                        <button onClick={handleAiOrphans} disabled={!!aiBusy || !!sysBusy}
                          style={{ ...smallBtn('#5b3fa0'), opacity: (aiBusy || sysBusy) ? 0.5 : 1 }}>
                          🤖 Ověřit AI a založit karty ({pendingOrphans.length})
                        </button>
                        <span style={{ fontSize: 12, color: C.muted }}>
                          ověří na internetu, propojí s existující kartou nebo založí novou se zdrojem · cca 2 Kč za hotel · limit
                        </span>
                        <input value={aiLimit} onChange={e => setAiLimit(e.target.value)} disabled={!!aiBusy}
                          style={inp({ width: 70, fontSize: 12, padding: '2px 6px' })} /> <span style={{ fontSize: 12, color: C.muted }}>Kč</span>
                      </div>
                    )}
                    {(() => {
                      const notHotel = sys.orphans.filter(o => orphanChecks[o.key] && !orphanChecks[o.key].isHotel);
                      const shown = sys.orphans.filter(o => !(orphanChecks[o.key] && !orphanChecks[o.key].isHotel));
                      const row = (o) => {
                        const ch = orphanChecks[o.key];
                        return (
                          <div key={o.key} style={{ borderBottom: `1px solid ${C.border}`, padding: '8px 0', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <div>
                              <strong>{o.name}</strong> · {o.city || '—'}
                              <span style={{ color: C.muted }}> — {o.sources.length}× v {[...new Set(o.sources.map(s => s.offerNumber || s.group).filter(Boolean))].slice(0, 4).join(', ')}</span>
                              {o.emails.length > 0 && <div style={{ color: C.muted }}>{o.emails.join(', ')}</div>}
                              {ch && (
                                <div style={{ color: '#5b3fa0' }}>
                                  🤖 {!ch.isHotel ? 'podle AI to není hotel' : ch.sure ? 'ověřeno' : 'AI si není jistá'}
                                  {ch.name ? ` — „${ch.name}“${ch.city ? `, ${ch.city}` : ''}` : ''}
                                  {ch.source && <> · <a href={ch.source} target="_blank" rel="noreferrer" style={{ color: '#5b3fa0' }}>zdroj</a></>}
                                  {ch.evidence && <span style={{ color: C.muted }}> · {ch.evidence}</span>}
                                </div>
                              )}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignSelf: 'center' }}>
                              {(() => {
                                const cand = orphanCardCandidates(o, ch);
                                if (!cand.length) return null;
                                return (
                                  <>
                                    <span style={{ fontSize: 11, color: C.muted }}>Patří ke kartě:</span>
                                    {cand.map(c => (
                                      <button key={c.id} onClick={() => handleLinkOrphan(o, c.id)} disabled={!!sysBusy}
                                        title="Propojit všechny výskyty tohoto hotelu s touto kartou"
                                        style={{ ...smallBtn('#2e7d32'), opacity: sysBusy ? 0.5 : 1 }}>
                                        ✅ {c.name} ({c.city})
                                      </button>
                                    ))}
                                    <span style={{ fontSize: 11, color: C.muted }}>nebo nová karta:</span>
                                  </>
                                );
                              })()}
                              {ch && ch.isHotel && ch.name && linkNormName(ch.name) !== linkNormName(o.name) && (
                                <button onClick={() => handleCreateOrphans([{ ...o, name: ch.name, city: ch.city || o.city }])} disabled={!!sysBusy}
                                  style={{ ...smallBtn('#5b3fa0'), opacity: sysBusy ? 0.5 : 1 }}>
                                  Založit jako „{ch.name}“
                                </button>
                              )}
                              <button onClick={() => handleCreateOrphans([o])} disabled={!!sysBusy}
                                style={{ ...smallBtn(C.muted), opacity: sysBusy ? 0.5 : 1 }}>
                                {sysBusy === o.key ? '…' : ch && ch.isHotel && ch.name && linkNormName(ch.name) !== linkNormName(o.name) ? 'Založit jak je psáno' : 'Založit kartu'}
                              </button>
                            </div>
                          </div>
                        );
                      };
                      return (
                        <>
                          {shown.length === 0 ? <p style={{ fontSize: 13, color: C.muted }}>Všechny hotely z nabídek mají kartu.</p> : shown.map(row)}
                          {notHotel.length > 0 && (
                            <div style={{ marginTop: 8 }}>
                              <button onClick={() => setShowNotHotel(v => !v)}
                                style={{ background: 'none', border: 'none', color: C.primary, cursor: 'pointer', fontSize: 12, textDecoration: 'underline', padding: 0 }}>
                                {showNotHotel ? '▾' : '▸'} Podle AI to nejsou hotely ({notHotel.length})
                              </button>
                              {showNotHotel && notHotel.map(row)}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
                {sys && <p style={{ fontSize: 11, color: C.muted, margin: '8px 0 0' }}>Přidané e-maily i založené karty jde vrátit v 🧹 Kontrola adres → 🤖 Automatické běhy.</p>}
              </div>

              {/* HOTOVÉ KARTY */}
              <div style={cardS}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 15, color: C.primary }}>🗂 Karty hotelů ({onlyUsed || cardSearch ? `${cardsFiltered.length} z ${cards.length}` : cards.length})</h3>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 12, color: C.muted, display: 'inline-flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={onlyUsed} onChange={e => setOnlyUsed(e.target.checked)} disabled={!sys} />
                      Jen hotely z nabídek a zakázek
                    </label>
                    <input value={cardSearch} onChange={e => setCardSearch(e.target.value)}
                      placeholder="Hledat kartu…" style={inp({ width: 220 })} />
                  </div>
                </div>
                {cards.length === 0 ? (
                  <p style={{ color: C.muted, fontSize: 13, margin: 0 }}>Zatím žádné karty. Vytvoř je ze seznamu nahoře.</p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={thS}>Hotel</th><th style={thS}>Město</th>
                      <th style={thS}>Adresy</th><th style={thS}>Historie</th><th style={thS}>Původ</th><th style={thS}></th>
                    </tr></thead>
                    <tbody>
                      {cardsFiltered.map(c => (
                        <tr key={c.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={tdS}>
                            <strong onClick={() => setDetailId(c.id)} title="Otevřít detail karty"
                              style={{ cursor: 'pointer', color: C.primary, textDecoration: 'underline', textDecorationColor: '#c9d3e6' }}>{c.name}</strong>
                            <button onClick={() => handleEditCardName(c)} title="Upravit název na kartě"
                              style={{ marginLeft: 6, background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, padding: 0 }}>✏</button>
                            {(c.aliases || []).length > 0 && <div style={{ fontSize: 11, color: C.muted }}>také jako: {c.aliases.join(' · ')}</div>}
                            {(c.autoFixes || []).filter(f => f.kind === 'name').map((f, i) => (
                              <div key={i} style={{ fontSize: 11, color: C.muted }} title={f.reason}>
                                🤖 původně „{f.from}“{f.note ? ` · poznámka: ${f.note}` : ''}
                              </div>
                            ))}
                            {c.ai?.name && (
                              <div style={{ fontSize: 11, color: '#5b3fa0' }}>
                                🤖 název od AI · {c.ai.name.how === 'web' ? 'ověřeno na internetu' : 'z e-mailové adresy'}
                                {c.ai.name.source && <> · <a href={c.ai.name.source} target="_blank" rel="noreferrer" style={{ color: '#5b3fa0' }}>zdroj</a></>}
                              </div>
                            )}
                            {c.notes && <div style={{ fontSize: 11, color: '#7a5c00' }}>📝 {c.notes}</div>}
                            {c.webInfo?.checkedAt && (
                              <div style={{ fontSize: 11, color: '#1f5f8b' }}>
                                🌐{c.webInfo.sure ? '' : ' ⚠'}
                                {fieldVal(c, 'stars') ? ` · ${'★'.repeat(Math.min(5, Math.round(Number(fieldVal(c, 'stars')) || 0)))}` : ''}
                                {fieldVal(c, 'google')?.score ? ` · G ${fieldVal(c, 'google').score}` : ''}
                                {fieldVal(c, 'booking')?.score ? ` · B ${fieldVal(c, 'booking').score}` : ''}
                                {fieldVal(c, 'groups') === true ? ' · 👥 skupiny ano' : fieldVal(c, 'groups') === false ? ' · 👥 skupiny ne' : ''}
                              </div>
                            )}
                          </td>
                          <td style={tdS}>
                            {c.city || '—'}
                            <button onClick={() => handleEditCardCity(c)} title="Upravit město na kartě"
                              style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0 }}>✏</button>
                          </td>
                          <td style={tdS}>
                            {(c.emails || []).map(e => (
                              <div key={e.email} style={{ fontSize: 12 }}>
                                <a href={`mailto:${e.email}`} style={{ color: C.primary }}>{e.email}</a>
                                {e.main && <span style={{ fontSize: 10, color: C.muted }}> · hlavní</span>}
                                {(() => { const bdg = emailBadge(e); return bdg ? <span style={{ fontSize: 10, color: bdg.central ? '#8a4b1f' : '#1f5f8b' }}> · {bdg.text}</span> : null; })()}
                                <button onClick={() => handleEditCardEmail(c, e.email)} title="Upravit adresu na kartě"
                                  style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0 }}>✏</button>
                                {e.auto && e.original && (
                                  <div style={{ fontSize: 10, color: C.muted }}
                                       title={(c.autoFixes || []).find(f => f.kind === 'email' && f.to === e.email)?.reason || ''}>
                                    🤖 opraveno · v databázi: {e.original}
                                  </div>
                                )}
                                {e.manual && <div style={{ fontSize: 10, color: '#2e7d32' }}>✏ upraveno ručně</div>}
                              </div>
                            ))}
                          </td>
                          <td style={{ ...tdS, fontSize: 11, whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={() => setDetailId(c.id)}>
                            {(() => {
                              const sm = summaryOf(c.id);
                              if (!sm) return <span style={{ color: C.muted }}>{sys ? '—' : ''}</span>;
                              return (
                                <span title="Poptáno · v nabídkách · potvrzeno · realizováno">
                                  📨 {sm.requests} · 📄 {sm.offers} · 🟢 {sm.confirmed} · 🧭 {sm.realized}
                                </span>
                              );
                            })()}
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
              {/* 🏨 DETAIL KARTY */}
              {detailId && (() => {
                const c = cards.find(x => x.id === detailId);
                if (!c) return null;
                const b = sys ? sys.links.get(c.id) : null;
                const sm = b ? cardSummary(b) : null;
                const extra = b ? newEmailsForCard(c, b) : [];
                const allNotes = [];
                if (c.notes) allNotes.push({ where: 'Karta', text: c.notes });
                (b?.offerLines || []).forEach(l => l.notes.forEach(n => allNotes.push({ where: `${l.offerNumber || ''} ${l.group}`.trim(), stamp: n.stamp, text: n.text })));
                (b?.orderLines || []).forEach(l => { if (l.notes) allNotes.push({ where: `zakázka ${l.group}`, text: l.notes }); });
                const sec = { margin: '18px 0 6px', fontSize: 14, color: C.primary };
                const th2 = { ...thS, padding: '6px 8px' };
                const td2 = { ...tdS, padding: '6px 8px', fontSize: 12, verticalAlign: 'top' };
                return (
                  <div onClick={() => setDetailId('')}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '3vh 12px', overflowY: 'auto' }}>
                    <div onClick={e => e.stopPropagation()}
                      style={{ background: C.white, borderRadius: 10, padding: '1.2rem 1.4rem', width: '100%', maxWidth: 1100, boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                        <div>
                          <h2 style={{ margin: 0, fontSize: 20, color: C.primary }}>🏨 {c.name}</h2>
                          <div style={{ fontSize: 13, color: C.muted }}>
                            {c.city || '—'}
                            <button onClick={() => handleEditCardCity(c)} title="Upravit město na kartě"
                              style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0 }}>✏</button>
                            {' · ⓘ '}{c.source?.label || 'Zdroj neznámý'}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => handleWebCheck([c], 'jedna karta')} disabled={!!aiBusy}
                            style={{ ...smallBtn('#1f5f8b'), opacity: aiBusy ? 0.5 : 1 }}>
                            {aiBusy ? '⏳ …' : c.webInfo?.checkedAt ? '🌐 Zkontrolovat znovu' : '🌐 Zkontrolovat na internetu'}
                          </button>
                          <button onClick={() => setDetailId('')} style={smallBtn(C.muted)}>✕ Zavřít</button>
                        </div>
                      </div>

                      {!sys && <p style={{ fontSize: 13, color: C.muted }}>{sysLoading ? '⏳ Načítám data ze systému…' : 'Data ze systému nejsou načtená.'}</p>}

                      {sys && (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                          {[
                            ['📨 Poptáno', sm?.requests || 0],
                            ['📄 V nabídkách', sm?.offers || 0],
                            ['🟢 Potvrzeno', sm?.confirmed || 0],
                            ['🧭 Realizováno', sm?.realized || 0],
                            ['🔴 Zrušeno', sm?.cancelled || 0],
                            ['🕓 Naposledy', sm?.last ? fmtD(sm.last) : '—'],
                          ].map(([l, v]) => (
                            <div key={l} style={{ padding: '6px 12px', background: '#f8f9fb', border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}>
                              {l}: <strong>{v}</strong>
                            </div>
                          ))}
                        </div>
                      )}

                      <h3 style={sec}>📇 Kontakty</h3>
                      {(c.emails || []).map(e => (
                        <div key={e.email} style={{ fontSize: 12 }}>
                          <a href={`mailto:${e.email}`} style={{ color: C.primary }}>{e.email}</a>
                          {e.main && <span style={{ color: C.muted }}> · hlavní</span>}
                          {(() => { const bdg = emailBadge(e); return bdg ? <span style={{ color: bdg.central ? '#8a4b1f' : '#1f5f8b' }}> · {bdg.ai && e.type ? '🤖 ' : ''}{bdg.text}</span> : null; })()}
                          <button onClick={() => handleEmailType(c, e.email)} title="Určit typ adresy (hotel / skupiny / rezervace / centrála…)"
                            style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 0 }}>🏷</button>
                          {e.fromService && <span style={{ color: C.muted }}> · 📄 ze servisní karty{e.source?.offerNumber ? ` ${e.source.offerNumber}` : ''}{e.source?.group ? ` (${e.source.group})` : ''}</span>}
                          {e.auto && e.original && <span style={{ color: C.muted }}> · 🤖 opraveno, v databázi: {e.original}</span>}
                        </div>
                      ))}
                      {extra.length > 0 && (
                        <div style={{ marginTop: 6, padding: 8, background: '#f4fbf6', border: '1px dashed #9fc9b0', borderRadius: 6, fontSize: 12 }}>
                          Nové ze servisních karet: {extra.map(x => x.email).join(', ')}
                          <button onClick={() => handleAddEmails([{ card: c, list: extra }])} disabled={!!sysBusy}
                            style={{ ...smallBtn('#2e6b45'), marginLeft: 8, opacity: sysBusy ? 0.5 : 1 }}>Přidat ke kartě</button>
                        </div>
                      )}

                      <h3 style={sec}>🌐 Z internetu {c.webInfo?.checkedAt ? <span style={{ fontSize: 11, color: C.muted, fontWeight: 400 }}>· zkontrolováno {fmtD(c.webInfo.checkedAt)}{c.webInfo.sure ? '' : ' · ⚠ AI si nebyla jistá, zkontrolujte'}</span> : null}</h3>
                      {!c.webInfo?.checkedAt && <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>Karta zatím nebyla zkontrolovaná na internetu.</p>}
                      {c.webInfo?.checkedAt && (
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <tbody>
                            {WEB_FIELDS.map(([k, label]) => {
                              const f = c.webInfo.fields?.[k];
                              if (!f) return null;
                              return (
                                <tr key={k} style={{ borderBottom: `1px solid ${C.border}` }}>
                                  <td style={{ ...td2, color: C.muted, width: 170 }}>{label}</td>
                                  <td style={td2}>
                                    {f.deleted ? <span style={{ color: C.muted }}>— smazáno —</span> : webValue(k, f.value)}
                                    {f.manual && !f.deleted && <span style={{ color: '#2e7d32', fontSize: 10 }}> · ✏ ručně</span>}
                                    {f.source && <> · <a href={f.source} target="_blank" rel="noreferrer" style={{ color: '#1f5f8b', fontSize: 11 }}>zdroj</a></>}
                                  </td>
                                  <td style={{ ...td2, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                    <button onClick={() => handleEditWebField(c, k, label)} title="Upravit" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}>✏</button>
                                    {!f.deleted && <button onClick={() => handleDeleteWebField(c, k, label)} title="Smazat" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12 }}>🗑</button>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                      {c.webInfo?.evidence && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>🤖 {c.webInfo.evidence}</div>}

                      {sys && (
                        <>
                          <h3 style={sec}>📄 V nabídkách ({b?.offerLines.length || 0})</h3>
                          {!b?.offerLines.length ? <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>Hotel zatím nebyl v žádné nabídce (nebo čeká na potvrzení možné shody).</p> : (
                            <div style={{ overflowX: 'auto' }}>
                              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead><tr>
                                  <th style={th2}>Nabídka</th><th style={th2}>Termín</th><th style={th2}>Stav hotelu</th><th style={th2}>Výsledek</th>
                                  <th style={th2}>DBL / SNGL za pokoj a noc</th><th style={th2}>City tax</th><th style={th2}>Podmínky</th>
                                </tr></thead>
                                <tbody>
                                  {b.offerLines.map(l => (
                                    <tr key={l.key} style={{ borderBottom: `1px solid ${C.border}` }}>
                                      <td style={td2}>
                                        <a href={`#offer-detail/${l.offerId}`} target="_blank" rel="noreferrer" style={{ color: C.primary, fontWeight: 600 }}>{l.offerNumber || 'nabídka'}</a>
                                        <div>{l.group}</div>
                                        <div style={{ color: C.muted }}>{l.client}</div>
                                        {l.how === 'confirmed' && <div style={{ color: C.muted, fontSize: 10 }}>✅ potvrzená shoda</div>}
                                      </td>
                                      <td style={td2}>{fmtD(l.dateFrom)}{l.dateTo ? ` – ${fmtD(l.dateTo)}` : ''}{l.nights ? <div style={{ color: C.muted }}>{l.nights} nocí</div> : null}</td>
                                      <td style={td2}>
                                        {LINE_STATUS[l.bookingStatus] || '—'}
                                        {!l.inPrice && <div style={{ color: C.muted }}>{l.isAlt ? 'alternativa' : 'mimo kalkulaci'}</div>}
                                      </td>
                                      <td style={td2}>{RESULT_LABEL[l.result]}<div style={{ color: C.muted }}>{OFFER_STATUS_LABEL[l.offerStatus] || l.offerStatus}</div></td>
                                      <td style={td2}>
                                        {l.priceDbl !== '' ? <>{l.priceDbl}</> : '—'} / {l.priceSngl !== '' ? l.priceSngl : '—'} {l.currency}
                                        {l.trpl && <div style={{ color: C.muted }}>TRPL: {l.trpl.price} {l.trpl.type}</div>}
                                      </td>
                                      <td style={td2}>{l.cityTaxSngl !== '' ? `SNGL ${l.cityTaxSngl} · ` : ''}{l.cityTax !== '' ? `DBL ${l.cityTax}` : '—'}</td>
                                      <td style={td2}>
                                        {l.optionDate && <div>Opce do {fmtD(l.optionDate)}</div>}
                                        {l.cancellationDeadline && <div>Storno zdarma do {fmtD(l.cancellationDeadline)}</div>}
                                        {l.depositTerms && <div>Zálohy: {l.depositTerms}</div>}
                                        {l.deposits.length > 0 && <div style={{ color: C.muted }}>{l.deposits.length}× záloha</div>}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}

                          <h3 style={sec}>📨 Poptávky ({b?.requests.length || 0})</h3>
                          {!b?.requests.length ? <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>Z aplikace jsme hotel zatím nepoptali.</p> : (
                            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                              {b.requests.map(r => (
                                <div key={r.id} style={{ fontSize: 12, borderBottom: `1px solid ${C.border}`, padding: '3px 0' }}>
                                  {fmtD(r.at)} · <strong>{r.group || '—'}</strong>{r.offerNumber ? ` · ${r.offerNumber}` : ''}
                                  {r.checkIn ? ` · ${fmtD(r.checkIn)}–${fmtD(r.checkOut)}` : ''} <span style={{ color: C.muted }}>→ {r.email}</span>
                                </div>
                              ))}
                            </div>
                          )}

                          {(b?.orderLines.length || 0) > 0 && (
                            <>
                              <h3 style={sec}>🗂 Staré zakázky ({b.orderLines.length})</h3>
                              {b.orderLines.map(l => (
                                <div key={l.key} style={{ fontSize: 12, borderBottom: `1px solid ${C.border}`, padding: '4px 0' }}>
                                  <a href={`#order-detail/${l.orderId}`} target="_blank" rel="noreferrer" style={{ color: C.primary, fontWeight: 600 }}>{l.group || 'zakázka'}</a>
                                  {' · '}{fmtD(l.dateFrom)}{l.dateTo ? `–${fmtD(l.dateTo)}` : ''} · {SERVICE_STATUS_LABEL[l.serviceStatus] || l.serviceStatus || '—'}
                                  {' · '}DBL {l.priceDbl || '—'} / SNGL {l.priceSngl || '—'} {l.currency}
                                  {(l.rooms.dbl || l.rooms.sngl) ? <span style={{ color: C.muted }}> · pokoje DBL {l.rooms.dbl || 0} / SNGL {l.rooms.sngl || 0}{l.rooms.twn ? ` / TWN ${l.rooms.twn}` : ''}{l.rooms.trpl ? ` / TRPL ${l.rooms.trpl}` : ''}</span> : null}
                                  {l.cancellationDays && <span style={{ color: C.muted }}> · storno {l.cancellationDays} dní</span>}
                                </div>
                              ))}
                            </>
                          )}

                          <h3 style={sec}>📝 Poznámky ({allNotes.length})</h3>
                          {!allNotes.length ? <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>Žádné poznámky.</p> : allNotes.map((n, i) => (
                            <div key={i} style={{ fontSize: 12, borderBottom: `1px solid ${C.border}`, padding: '4px 0', whiteSpace: 'pre-wrap' }}>
                              <span style={{ color: C.muted }}>{n.where}{n.stamp ? ` · ${n.stamp}` : ''}:</span> {n.text}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* ── KONTROLA ADRES ── */}
      {tab === 'clean' && (
        <div>
          <div style={{ ...cardS, marginBottom: '1.2rem', background: '#f8f9fb' }}>
            <p style={{ margin: 0, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              Sem se sesypalo všechno, co v databázi hotelů nesedí a ještě nepatří ke kartě —
              slepené adresy z importu, řádky bez názvu a duplicity. Řádky, které už mají kartu,
              tu nejsou: jejich opravy jsou na kartě. Ruční Uložit / Smazat mění přímo databázi.
            </p>
          </div>

          {/* 🤖 AUTOMATICKÉ ZPRACOVÁNÍ */}
          <div style={{ ...cardS, marginBottom: '1.2rem', borderColor: '#9fb7e0', background: '#f5f8fe' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <strong style={{ fontSize: 15, color: C.primary }}>🤖 Zpracovat automaticky</strong>
                <p style={{ fontSize: 12, color: C.muted, margin: '4px 0 0', lineHeight: 1.5 }}>
                  Založí karty pro jisté shody a rovnou na nich opraví slepené adresy (doménu ověří
                  na internetu), přesune poznámky z názvů a spojí duplicity. <strong>Zapisuje jen do karet</strong> —
                  databáze hotelů a rozesílání poptávek zůstanou beze změny. Sporné případy nechá na vás.
                  Celý běh jde vrátit ↩. Zdarma, bez AI.
                </p>
              </div>
              <button onClick={handleAutoRun} disabled={!!autoBusy || !!cardBusy || loading}
                style={{ ...btn('#2f5fb3'), opacity: (autoBusy || cardBusy || loading) ? 0.6 : 1 }}>
                {autoBusy ? '⏳ Pracuji…' : '🤖 Zpracovat automaticky'}
              </button>
            </div>
            {autoBusy && (
              <div style={{ marginTop: 10, fontSize: 13, color: '#2f5fb3' }}>
                ⏳ {autoBusy} <span style={{ color: C.muted, fontSize: 12 }}>— nechte stránku otevřenou</span>
              </div>
            )}
          </div>

          {/* 🤖 ETAPA 2a — AI DOPLNÍ NÁZVY */}
          <div style={{ ...cardS, marginBottom: '1.2rem', borderColor: '#b9a2e0', background: '#f8f5fe' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <strong style={{ fontSize: 15, color: '#5b3fa0' }}>🤖 AI: doplnit chybějící názvy ({aiTargetCount} adres)</strong>
                <p style={{ fontSize: 12, color: C.muted, margin: '4px 0 0', lineHeight: 1.5 }}>
                  U řádků, kde je jen adresa a město, dohledá AI na internetu, kterému hotelu adresa patří
                  (cca 2 Kč za adresu). Kartu založí <strong>jen s potvrzením z webové stránky</strong> a odkazem
                  na zdroj; nejisté zůstanou níže s návrhem. <strong>Jen do karet</strong>, databáze hotelů beze změny.
                  Za potvrzenou adresu se nikdy neplatí dvakrát.
                </p>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: C.muted }}>
                  Limit útraty:
                  <input value={aiLimit} onChange={e => setAiLimit(e.target.value)} disabled={!!aiBusy}
                    style={inp({ width: 80, fontSize: 12, padding: '3px 6px' })} /> Kč
                </label>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => handleAiNames(20)} disabled={!!aiBusy || !!autoBusy || !!cardBusy || loading || aiTargetCount === 0}
                  style={{ ...btn('#7b5fc4'), opacity: (aiBusy || autoBusy || cardBusy || loading || aiTargetCount === 0) ? 0.6 : 1 }}>
                  Vyzkoušet na 20
                </button>
                {aiBusy ? (
                  <button onClick={() => { aiStopRef.current = true; setAiBusy('Zastavuji — dokončuji rozpracované adresy a zakládám karty…'); }}
                    style={btn('#b00020')}>
                    ⏹ Zastavit
                  </button>
                ) : (
                  <button onClick={() => handleAiNames(0)} disabled={!!autoBusy || !!cardBusy || loading || aiTargetCount === 0}
                    style={{ ...btn('#5b3fa0'), opacity: (autoBusy || cardBusy || loading || aiTargetCount === 0) ? 0.6 : 1 }}>
                    {`Zpracovat vše (${aiTargetCount})`}
                  </button>
                )}
              </div>
            </div>
            {aiBusy && (
              <div style={{ marginTop: 10, fontSize: 13, color: '#5b3fa0' }}>
                ⏳ {aiBusy} <span style={{ color: C.muted, fontSize: 12 }}>— nechte stránku otevřenou</span>
              </div>
            )}
          </div>

          {loading ? <p style={{ color: C.muted }}>Načítám…</p> : cleanupRows.length === 0 ? (
            <div style={{ ...cardS, textAlign: 'center', color: C.muted, fontSize: 13 }}>
              Nic k ručnímu řešení — všechny řádky jsou v pořádku nebo už vyřešené na kartách.
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
                      <td style={{ ...tdS, fontSize: 11, color: kind === 'bad' ? '#b00020' : C.muted }}>
                        {problem}
                        {(() => {
                          const a = aiAttempts[aiKey(row.email, row.city)];
                          if (!a || !a.name) return null;
                          return (
                            <div style={{ marginTop: 4, color: '#5b3fa0' }}>
                              🤖 návrh AI: <strong>{a.name}</strong> {a.sure ? '' : '(nejisté)'}
                              {a.source && <> · <a href={a.source} target="_blank" rel="noreferrer" style={{ color: '#5b3fa0' }}>zdroj</a></>}
                            </div>
                          );
                        })()}
                      </td>
                      <td style={{ ...tdS, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {kind === 'name' && (
                          <button onClick={() => handleCardFromRow(row)} disabled={!!cardBusy}
                            title="Založí kartu s názvem z políčka vlevo (nebo s návrhem AI). Databáze hotelů se nezmění."
                            style={{ ...smallBtn('#5b3fa0'), opacity: cardBusy ? 0.5 : 1, marginRight: 6 }}>
                            Založit kartu
                          </button>
                        )}
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
                <strong>Založit kartu</strong> vytvoří kartu s názvem z políčka (nebo s návrhem AI) — databáze hotelů se nezmění.
                <strong> Uložit</strong> zapíše název i adresu přímo do databáze hotelů. Poznámky vytažené z názvu se
                neztratí, uloží se na kartu jako interní poznámka.
              </p>
            </div>
          )}

          {/* 🤖 PŘEHLED AUTOMATICKÝCH BĚHŮ */}
          {fixLog.length > 0 && (
            <div style={{ ...cardS, marginTop: '1.2rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                <h3 style={{ margin: 0, fontSize: 15, color: C.primary }}>🤖 Automatické běhy ({fixLog.length})</h3>
                {fixLog.length > 20 && (
                  <button onClick={() => setFixLogAll(v => !v)}
                    style={{ background: 'none', border: 'none', color: C.primary, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
                    {fixLogAll ? 'zobrazit jen posledních 20' : `zobrazit všech ${fixLog.length}`}
                  </button>
                )}
              </div>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>
                ↩ Vrátit zruší všechny karty, které daný běh založil (u AI běhu i adresy přidané k existujícím kartám). Jednotlivou kartu zrušíte nebo upravíte ✏ v záložce 🗂 Karty.
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={thS}>Kdy</th><th style={thS}>Kdo</th><th style={thS}>Výsledek</th><th style={thS}></th>
                </tr></thead>
                <tbody>
                  {(fixLogAll ? fixLog : fixLog.slice(0, 20)).map(f => (
                    <tr key={f.id} style={{ borderBottom: `1px solid ${C.border}`, opacity: f.undone ? 0.5 : 1 }}>
                      <td style={{ ...tdS, fontSize: 12, whiteSpace: 'nowrap' }}>
                        {f.at ? new Date(f.at).toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                      </td>
                      <td style={{ ...tdS, fontSize: 12 }}>{f.by || '—'}</td>
                      <td style={{ ...tdS, fontSize: 12 }}>
                        <strong>{f.label}</strong>
                        <div style={{ fontSize: 11, color: C.muted }}>{f.reason}</div>
                        {f.undone && <div style={{ fontSize: 11, color: '#b00020' }}>↩ vráceno</div>}
                      </td>
                      <td style={{ ...tdS, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {!f.undone && ['cards', 'ai-names', 'emails', 'orphan-cards', 'ai-orphans', 'ai-links', 'merge', 'web-check'].includes(f.kind) && (
                          <button onClick={() => handleUndoFix(f)} disabled={!!autoBusy}
                            style={{ ...smallBtn(C.muted), opacity: autoBusy ? 0.5 : 1 }}>↩ Vrátit</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
