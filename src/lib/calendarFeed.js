// Kalendáře pro telefon a počítač (Mac / iPhone / Google) – soubory .ics.
//
// Čistý JavaScript bez Reactu a bez Firebase: dostane nabídky a zakázky,
// vrátí hotový text kalendářů. Termíny bere ze stejných pravidel jako
// Dashboard a Kalendář v aplikaci (deadlines.js), aby si nikdy neodporovaly.
//
// Kalendáře jsou jen ke čtení – zdrojem pravdy zůstává aplikace.

import { collectDeadlines, isClosedOffer, daysFrom } from './deadlines.js';

export const APP_URL = 'https://pragenses.github.io/roteiros-europa/';

// Jak daleko do minulosti se kalendáře ukazují (dopředu vždy všechno).
export const MONTHS_BACK = 3;

// Seznam kalendářů. key = název souboru, name = jak se jmenuje v telefonu.
export const FEEDS = [
  { key: 'nabidky',          name: 'RE – Nabídky' },
  { key: 'zakazky',          name: 'RE – Zakázky' },
  { key: 'storna',           name: 'RE – Storna' },
  { key: 'alternativy',      name: 'RE – Alternativy' },
  { key: 'ukoly-HD',         name: 'RE – Úkoly Helena',       who: 'HD' },
  { key: 'ukoly-FD',         name: 'RE – Úkoly Filip',        who: 'FD' },
  { key: 'ukoly-HS',         name: 'RE – Úkoly Helena Š.',    who: 'HŠ' },
  { key: 'ukoly-neprirazene', name: 'RE – Úkoly nepřiřazené', who: '' },
];

// Klíč člověka pro názvy dokumentů a souborů (HŠ → HS).
export const personKey = (code) => String(code || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Kde soubor kalendáře leží v úložišti Firebase a jakou má veřejnou adresu.
// Adresa obsahuje tajný kód (token) – kdo ji nezná, kalendář neuvidí.
export const feedPath = (token, key) => `calendars/${token}/${key}.ics`;
export const feedUrl = (bucket, token, key) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(feedPath(token, key))}?alt=media&token=${token}`;

// Kalendáře, které daný člověk dostane (omezený uživatel nevidí zakázky).
export const feedsFor = (viewer) => FEEDS.filter(f => !(viewer && viewer.limited && f.key === 'zakazky'));

// Upozornění (schválila Helena 2026-10-10). Celodenní událost začíná o půlnoci,
// takže „7 dní předem v 9:00“ = 6 dní a 15 hodin před začátkem.
const ALARM_7D_9 = '-P6DT15H';
const ALARM_1D_9 = '-PT15H';
const ALARM_SAMEDAY_9 = 'PT9H';

// ---------------------------------------------------------------------------
// Pomocníci pro formát .ics (RFC 5545)

const esc = (s) => String(s == null ? '' : s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n');

// Řádky delší než 75 bajtů se zalamují (s mezerou na začátku dalšího řádku).
const fold = (line) => {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (curBytes + b > limit) { out.push(cur); cur = ''; curBytes = 0; }
    cur += ch; curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
};

const icsDate = (ymdStr) => ymdStr.replace(/-/g, '');

const addDay = (ymdStr) => {
  const d = new Date(Date.UTC(+ymdStr.slice(0, 4), +ymdStr.slice(5, 7) - 1, +ymdStr.slice(8, 10) + 1));
  return d.toISOString().slice(0, 10);
};

const stamp = (now) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const offerLink = (offerId) => `${APP_URL}#offer-detail/${offerId}`;
const orderLink = (orderId) => `${APP_URL}#order-detail/${orderId}`;

// Jedna celodenní událost.
const vevent = ({ uid, date, title, description, url, alarms = [], now }) => {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}@roteiros-europa`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART;VALUE=DATE:${icsDate(date)}`,
    `DTEND;VALUE=DATE:${icsDate(addDay(date))}`,
    `SUMMARY:${esc(title)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${esc(description)}`);
  if (url) lines.push(`URL:${url}`);
  lines.push('TRANSP:TRANSPARENT');
  alarms.forEach(trigger => {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, `TRIGGER:${trigger}`, 'END:VALARM');
  });
  lines.push('END:VEVENT');
  return lines;
};

const calendar = (name, events) => {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tour Pragenses//Roteiros Europa//CS',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
    'X-WR-TIMEZONE:Europe/Prague',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
    'X-PUBLISHED-TTL:PT15M',
    ...events.flat(),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
};

// ---------------------------------------------------------------------------

const fmtDate = (ymdStr) => {
  if (!ymdStr) return '';
  const [y, m, d] = ymdStr.split('-');
  return `${parseInt(d, 10)}. ${parseInt(m, 10)}. ${y}`;
};

const OFFER_STATUS = { draft: 'Draft', check: 'Ke kontrole', sent: 'Odesláno', returned: 'Vráceno k úpravě', won: 'Potvrzeno', lost: 'Zamítnuto' };

const pragueToday = (now) => {
  // Datum v Praze (ne v UTC) – kvůli dnešním souhrnným událostem.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return parts; // YYYY-MM-DD
};

const monthsBack = (todayYmd, n) => {
  const y = +todayYmd.slice(0, 4), m = +todayYmd.slice(5, 7) - 1, d = +todayYmd.slice(8, 10);
  const dt = new Date(Date.UTC(y, m - n, d));
  return dt.toISOString().slice(0, 10);
};

// Vyrobí všechny kalendáře pro jednoho člověka.
// viewer: { code, limited, email } – omezený uživatel vidí jen své nabídky.
// Vrací { [key]: textIcs }.
export const buildFeeds = ({ offers, orders, viewer, now = new Date() }) => {
  const today = pragueToday(now);
  const from = monthsBack(today, MONTHS_BACK);

  const visibleOffers = (offers || []).filter(o =>
    !viewer || !viewer.limited || (o.allowedUsers || []).includes(viewer.email));
  const byId = Object.fromEntries(visibleOffers.map(o => [o.id, o]));
  const deadlines = collectDeadlines(visibleOffers);
  const ev = Object.fromEntries(FEEDS.map(f => [f.key, []]));

  // Nabídky – den odjezdu.
  visibleOffers.forEach(o => {
    if (isClosedOffer(o) || !o.startDate || o.startDate.slice(0, 10) < from) return;
    const start = o.startDate.slice(0, 10);
    const title = `📋 ${[o.offerNumber, o.name].filter(Boolean).join(' · ') || '(bez názvu)'} – odjezd`;
    const desc = [
      o.clientName && `Klient: ${o.clientName}`,
      `Termín: ${fmtDate(start)}${o.endDate ? ' – ' + fmtDate(o.endDate.slice(0, 10)) : ''}`,
      `Stav: ${OFFER_STATUS[o.status || 'draft'] || o.status}`,
      o.responsible && `Odpovědný: ${o.responsible}`,
      '', `Otevřít v aplikaci: ${offerLink(o.id)}`,
    ].filter(x => x !== false && x !== undefined && x !== null).join('\n');
    ev.nabidky.push(vevent({ uid: `offer-${o.id}`, date: start, title, description: desc, url: offerLink(o.id), now }));
  });

  // Zakázky – den odjezdu. Omezený uživatel zakázky nevidí (stejně jako v aplikaci).
  if (!viewer || !viewer.limited) {
    (orders || []).forEach(o => {
      if (!o.startDate || o.startDate.slice(0, 10) < from) return;
      const start = o.startDate.slice(0, 10);
      const title = `🚌 ${[o.offerNumber, o.name].filter(Boolean).join(' · ') || '(bez názvu)'} – odjezd`;
      const desc = [
        o.clientName && `Klient: ${o.clientName}`,
        `Termín: ${fmtDate(start)}${o.endDate ? ' – ' + fmtDate(o.endDate.slice(0, 10)) : ''}`,
        o.paxCount && `Počet osob: ${o.paxCount}`,
        '', `Otevřít v aplikaci: ${orderLink(o.id)}`,
      ].filter(x => x !== false && x !== undefined && x !== null && x !== 0).join('\n');
      ev.zakazky.push(vevent({ uid: `order-${o.id}`, date: start, title, description: desc, url: orderLink(o.id), now }));
    });
  }

  // Storna a alternativy.
  deadlines.filter(d => d.kind === 'storno' && d.date >= from).forEach(d => {
    const title = d.alt
      ? `⚠ ALTERNATIVA storno · ${d.hotel} · ${d.offerNumber || d.offerName}`
      : `✂ Storno · ${d.hotel} · ${d.offerNumber || d.offerName}`;
    const desc = [
      `Nabídka: ${d.offerLabel}`, d.clientName && `Klient: ${d.clientName}`,
      `Hotel: ${d.hotel}`, `Bezplatné storno do: ${fmtDate(d.date)}`,
      d.alt && 'Potvrzený hotel MIMO výběr – zrušit, pokud ho klient nechce.',
      '', `Otevřít v aplikaci: ${offerLink(d.offerId)}`,
    ].filter(Boolean).join('\n');
    ev[d.alt ? 'alternativy' : 'storna'].push(vevent({
      uid: `storno-${d.offerId}-${d.itemId}`, date: d.date, title, description: desc,
      url: offerLink(d.offerId), alarms: [ALARM_7D_9, ALARM_1D_9], now,
    }));
  });

  // Chybějící storno lhůty – JEDNA souhrnná událost na dnešek (jen zájezdy,
  // které ještě neodjely). Program běží pravidelně, takže se posouvá den po dni.
  const missing = deadlines.filter(d => d.kind === 'missing_storno' && (() => {
    const o = byId[d.offerId];
    return !o || !o.startDate || o.startDate.slice(0, 10) >= today;
  })());
  if (missing.length) {
    const groups = {};
    missing.forEach(d => { (groups[d.offerId] = groups[d.offerId] || { label: d.offerLabel, list: [] }).list.push(d.hotel + (d.alt ? ' (alternativa)' : '')); });
    const offerIds = Object.keys(groups);
    const desc = offerIds.map(id => `${groups[id].label}\n${groups[id].list.map(h => '  • ' + h).join('\n')}\n  ${offerLink(id)}`).join('\n\n');
    ev.storna.push(vevent({
      uid: `missing-storno-${today}`, date: today,
      title: `⚠ Chybí storno lhůta – ${offerIds.length} ${offerIds.length === 1 ? 'nabídka' : (offerIds.length < 5 ? 'nabídky' : 'nabídek')} (${missing.length} hotelů)`,
      description: `Potvrzené hotely bez vyplněné storno lhůty:\n\n${desc}`,
      alarms: [ALARM_SAMEDAY_9], now,
    }));
  }

  // Úkoly – každý člověk svůj kalendář.
  FEEDS.filter(f => f.who !== undefined).forEach(f => {
    const mine = deadlines.filter(d => d.kind === 'task' && d.who === f.who);
    mine.filter(d => d.date >= from).forEach(d => {
      const desc = [
        `Nabídka: ${d.offerLabel}`, d.clientName && `Klient: ${d.clientName}`,
        !d.assigned && d.who && 'Úkol nemá přiřazenou osobu – patří odpovědnému za nabídku.',
        '', `Otevřít v aplikaci: ${offerLink(d.offerId)}`,
      ].filter(Boolean).join('\n');
      ev[f.key].push(vevent({
        uid: `task-${d.offerId}-${d.taskId}`, date: d.date,
        title: `✅ ${d.text} · ${d.offerNumber || d.offerName}`,
        description: desc, url: offerLink(d.offerId), alarms: [ALARM_SAMEDAY_9], now,
      }));
    });
    // Prošlé nesplněné úkoly – jedna souhrnná událost na dnešek.
    const overdue = mine.filter(d => d.date < today).sort((a, b) => a.date.localeCompare(b.date));
    if (overdue.length) {
      const desc = overdue.map(d => `${fmtDate(d.date)} · ${d.text} · ${d.offerNumber || d.offerName}\n  ${offerLink(d.offerId)}`).join('\n');
      ev[f.key].push(vevent({
        uid: `overdue-${f.key}-${today}`, date: today,
        title: `⏰ Prošlé úkoly: ${overdue.length}`,
        description: `Nesplněné úkoly po termínu (nejstarší nahoře):\n\n${desc}`,
        alarms: [ALARM_SAMEDAY_9], now,
      }));
    }
  });

  const result = {};
  FEEDS.forEach(f => { result[f.key] = calendar(f.name, ev[f.key]); });
  return result;
};
