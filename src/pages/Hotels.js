// force-rebuild-extraemail
import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// TLD deliberately restricted to lowercase letters only: when hotel entries are pasted with
// no separator at all between them (e.g. "...info@hotel.hrHotel Next Name – info@..."), an
// unbounded TLD would swallow the start of the next hotel's name. Real TLDs are lowercase.
const GLOBAL_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,10}/g;
const SAME_LINE_SEP_TRIM_RE = /[:–—-]\s*$/;

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

// Dva názvy považujeme za stejný hotel, když se po očištění shodují, jeden
// obsahuje druhý, nebo mají většinu slov společných ("Ambassador Zlatá Husa"
// vs "Ambassador"). Prázdný název se nikdy nespáruje s ničím.
const sameName = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wa = a.split(' ').filter(Boolean);
  const wb = b.split(' ').filter(Boolean);
  if (!wa.length || !wb.length) return false;
  const shared = wa.filter(w => w.length > 2 && wb.includes(w)).length;
  return shared > 0 && shared >= Math.min(wa.length, wb.length) / 2;
};

const sameCity = (a, b) => !a || !b || a === b;

// Sestaví návrhy karet z řádků databáze, které ke kartě ještě nepatří.
// Vrací { green: [...], orange: [...] }; každá skupina = jedna budoucí karta.
function buildCardSuggestions(rows) {
  const items = rows
    .filter(r => !r.cardId && r.email)
    .map(r => ({
      row: r,
      email: String(r.email).toLowerCase(),
      domain: domainOf(r.email),
      nName: normName(r.name),
      nCity: normCity(r.city),
    }));

  // 1) Rozdělení podle domény (freemail dostane vlastní přihrádku podle názvu).
  const buckets = new Map();
  for (const it of items) {
    const free = !it.domain || FREEMAIL.has(it.domain);
    const key = free ? `free|${it.nName}|${it.nCity}` : `dom|${it.domain}`;
    if (!buckets.has(key)) buckets.set(key, { free, domain: free ? '' : it.domain, items: [] });
    buckets.get(key).items.push(it);
  }

  // 2) Uvnitř přihrádky rozdělíme podle názvu a města — jedna doména může patřit
  //    řetězci s několika hotely.
  const groups = [];
  for (const b of buckets.values()) {
    const subs = [];
    for (const it of b.items) {
      const hit = subs.find(s => s.items.some(x => sameName(x.nName, it.nName) && sameCity(x.nCity, it.nCity)));
      if (hit) hit.items.push(it); else subs.push({ items: [it] });
    }
    for (const s of subs) {
      groups.push({
        items: s.items,
        domain: b.domain,
        free: b.free,
        chain: !b.free && subs.length > 1,   // jedna doména, víc hotelů = řetězec
      });
    }
  }

  // 3) Skupiny se stejným názvem i městem, ale jinou doménou → návrh ke spojení.
  const byNameCity = new Map();
  for (const g of groups) {
    const k = `${g.items[0].nName}|${g.items[0].nCity}`;
    if (!k.replace('|', '')) continue;
    if (!byNameCity.has(k)) byNameCity.set(k, []);
    byNameCity.get(k).push(g);
  }
  for (const list of byNameCity.values()) {
    if (list.length > 1) list.forEach(g => { g.crossDomain = true; });
  }

  const shape = (g) => {
    // Nejčastější / nejdelší název bereme jako hlavní, ostatní jako aliasy.
    const names = [...new Set(g.items.map(i => i.row.name).filter(Boolean))];
    names.sort((a, b) => b.length - a.length);
    const cities = [...new Set(g.items.map(i => i.row.city).filter(Boolean))];
    return {
      key: g.items.map(i => i.row.id).sort().join('_'),
      name: names[0] || g.items[0].email,
      aliases: names.slice(1),
      city: cities[0] || '',
      domain: g.domain,
      free: g.free,
      chain: !!g.chain,
      crossDomain: !!g.crossDomain,
      rows: g.items.map(i => i.row),
      reason: g.chain
        ? `Doména ${g.domain} patří víc hotelům — zkontroluj, jestli je to řetězec`
        : g.crossDomain
          ? 'Stejný název a město, ale jiná doména — možná jeden hotel'
          : g.free
            ? 'Freemailová adresa — spojeno podle názvu a města'
            : `Společná doména ${g.domain}`,
    };
  };

  const all = groups.map(shape);
  return {
    green: all.filter(g => !g.chain && !g.crossDomain).sort((a, b) => b.rows.length - a.rows.length),
    orange: all.filter(g => g.chain || g.crossDomain).sort((a, b) => (a.city || '').localeCompare(b.city || '')),
  };
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
<b>Helena Dlasková, sales</b><br>
TOUR PRAGENSES, PRAGENSES s.r.o.<br>
Lipnická 688, Praha 9 - Kyje, Czech Republic<br>
Tlf - whatsapp : +420 777 079 997<br>
VAT: CZ284 45 961</p>
</div>`;

export default function Hotels({ navigate, colors, navParams }) {
  console.debug('Hotels v200-fix-extraemail');
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
  const [subject, setSubject]         = useState('Group Accommodation Request');
  const [senderFrom, setSenderFrom]   = useState('grupos');
  React.useEffect(() => {
    let s = 'Group Accommodation Request';
    if (groupName) s += ' / ' + groupName;
    if (composeCity) s += ' / ' + composeCity;
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
    .replace(/{{freeRatio}}/g, freeRatio||'20');
  };

  const toggleSelect = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const handleSend = async () => {
    if (!selected.length) { alert('Vyber alespoň jeden hotel.'); return; }
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
  const composeHotels = composeCity ? hotels.filter(h => h.city === composeCity) : hotels;

  const suggestions = React.useMemo(() => buildCardSuggestions(hotels), [hotels]);
  const unassignedCount = hotels.filter(h => !h.cardId).length;
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
        <p style={{ fontSize: 13, color: C.muted, margin: '4px 0 0' }}>Import · Databáze · Poptávky · Log · Karty</p>
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
              <select value={composeCity} onChange={e => { setComposeCity(e.target.value); setSelected([]); }} style={{ ...inp(), marginBottom: 8 }}>
                <option value="">Všechna města</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
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
                {composeHotels.length === 0 && <p style={{ padding: 12, color: C.muted, fontSize: 12 }}>Žádné hotely.</p>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button onClick={() => setSelected(composeHotels.map(h=>h.id))} style={{ fontSize: 11, color: C.primary, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>Vybrat vše</button>
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
                <div style={{ ...cardS, flex: 1, minWidth: 150, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: C.primary }}>{cards.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>hotových karet</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 150, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#2e7d32' }}>{suggestions.green.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>jistých shod</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 150, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#e08a00' }}>{suggestions.orange.length}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>ke kontrole</div>
                </div>
                <div style={{ ...cardS, flex: 1, minWidth: 150, padding: '0.8rem 1rem' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: C.muted }}>{unassignedCount}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>nezařazených řádků</div>
                </div>
              </div>

              {/* JISTÉ SHODY */}
              {suggestions.green.length > 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: C.primary }}>🟢 Jisté shody ({suggestions.green.length})</h3>
                    <button
                      onClick={() => handleCreateAllGreen(suggestions.green)}
                      disabled={!!cardBusy}
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
                              {g.aliases.length > 0 && (
                                <div style={{ fontSize: 11, color: C.muted }}>také jako: {g.aliases.join(' · ')}</div>
                              )}
                            </td>
                            <td style={tdS}>{g.city || '—'}</td>
                            <td style={tdS}>
                              {g.rows.map(r => <div key={r.id} style={{ fontSize: 12 }}>{r.email}</div>)}
                            </td>
                            <td style={{ ...tdS, fontSize: 11, color: C.muted }}>{g.reason}</td>
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

              {/* KE KONTROLE */}
              {suggestions.orange.length > 0 && (
                <div style={{ ...cardS, marginBottom: '1.2rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <h3 style={{ margin: 0, fontSize: 15, color: C.primary }}>🟠 Ke kontrole ({suggestions.orange.length})</h3>
                    <button onClick={() => setShowOrange(v => !v)}
                      style={{ background: 'none', border: 'none', color: C.primary, cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>
                      {showOrange ? 'skrýt' : 'zobrazit'}
                    </button>
                  </div>
                  {showOrange && (
                    <>
                      <p style={{ fontSize: 12, color: C.muted, marginTop: 0 }}>
                        Tyhle projdi po jednom. Buď jde o řetězec (jedna doména, víc hotelů), nebo o jeden
                        hotel psaný pod dvěma doménami. Hromadné tlačítko tu schválně není.
                      </p>
                      <div style={{ maxHeight: 460, overflowY: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead><tr>
                            <th style={thS}>Hotel</th><th style={thS}>Město</th>
                            <th style={thS}>Adresy</th><th style={thS}>Proč je sporný</th><th style={thS}></th>
                          </tr></thead>
                          <tbody>
                            {suggestions.orange.map(g => (
                              <tr key={g.key} style={{ borderBottom: `1px solid ${C.border}`, background: '#fffdf5' }}>
                                <td style={tdS}>
                                  <strong>{g.name}</strong>
                                  {g.aliases.length > 0 && (
                                    <div style={{ fontSize: 11, color: C.muted }}>také jako: {g.aliases.join(' · ')}</div>
                                  )}
                                </td>
                                <td style={tdS}>{g.city || '—'}</td>
                                <td style={tdS}>
                                  {g.rows.map(r => <div key={r.id} style={{ fontSize: 12 }}>{r.email}</div>)}
                                </td>
                                <td style={{ ...tdS, fontSize: 11, color: '#a06800' }}>{g.reason}</td>
                                <td style={{ ...tdS, textAlign: 'right' }}>
                                  <button onClick={() => handleCreateCard(g)} disabled={!!cardBusy}
                                    style={{ ...smallBtn('#e08a00'), opacity: cardBusy ? 0.5 : 1 }}>
                                    {cardBusy === g.key ? '…' : 'Vytvořit'}
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              )}

              {suggestions.green.length === 0 && suggestions.orange.length === 0 && (
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
                            {(c.aliases || []).length > 0 && (
                              <div style={{ fontSize: 11, color: C.muted }}>také jako: {c.aliases.join(' · ')}</div>
                            )}
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
    </div>
  );
}
