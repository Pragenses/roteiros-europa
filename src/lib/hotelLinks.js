// ─────────────────────────────────────────────────────────────────────────────
// KARTY HOTELŮ ↔ VÁŠ SYSTÉM (etapa 3, krok 1) — bez AI, zdarma.
//
// Karta hotelu se ŽIVĚ propojí se vším, kde se hotel v aplikaci objevil:
//   • log poptávek (hotelEmailLog)     → kolikrát a kdy jsme hotel poptali
//   • nabídky (offers.items, hotely)   → stav řádku, výsledek, ceny, podmínky, poznámky
//   • staré zakázky (orders/services)  → stav, ceny, kontakty
// Nic se nekopíruje — vše se počítá při zobrazení z aktuálních dat.
//
// Pravidla propojení (správnost má přednost):
//   1) řádek nabídky má `hotelCardId` (vybráno z karty)          → jisté
//   2) potvrzené ručně v `hotelCardLinks` (✅ / ❌)               → podle rozhodnutí
//   3) e-mail kontaktu patří jen JEDNÉ kartě                      → jisté
//      (sdílená adresa centrály → rozhodne až název + město)
//   4) shodný název + město                                       → jen „možná shoda“
//      (potvrzuje člověk, do té doby se nikam nepočítá)
// ─────────────────────────────────────────────────────────────────────────────

import { effectiveDeposits } from './deposits';
export const OWN_EMAIL_RE = [
  /@tour-pragenses\.com$/i,
  /^helena\.maria\.brito@gmail\.com$/i,
  /^filipdlask@gmail\.com$/i,
];
export const isOwnEmail = (e) => OWN_EMAIL_RE.some(re => re.test(String(e || '').trim()));

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
export const cleanEmail = (e) => String(e || '').trim().toLowerCase().replace(/^mailto:/, '');
export const usableEmail = (e) => { const c = cleanEmail(e); return EMAIL_OK.test(c) && !isOwnEmail(c) ? c : ''; };

const stripDia = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const NAME_NOISE = /\b(hotel|hotell|hotels|hotel[eé]?is|h[oôó]tel|penzion|pension|pension[ae]t|hostel|hostal|garni|resort|spa|apartments?|apartm[aá]ny?|apart|residence|rezidence|guesthouse|guest|house|the|and|amp)\b/g;
export const normName = (s) =>
  stripDia(String(s || '').toLowerCase())
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s[-–—]\s.*$/, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Města se v nabídkách píšou portugalsky, v databázi česky / anglicky / velkými
// písmeny a někdy se zemí ("BOLZANO, ITALY"). Pro porovnání se vezme část před
// čárkou a známé varianty se převedou na jeden tvar.
const CITY_ALIASES = [
  ['praha', 'praga', 'prague', 'prag'],
  ['viden', 'viena', 'wien', 'vienna', 'vienne'],
  ['mnichov', 'munique', 'munchen', 'muenchen', 'munich'],
  ['rim', 'roma', 'rome'],
  ['benatky', 'veneza', 'venezia', 'venice', 'venise'],
  ['florencie', 'florenca', 'firenze', 'florence'],
  ['milan', 'milao', 'milano', 'mailand'],
  ['neapol', 'napoles', 'napoli', 'naples'],
  ['janov', 'genova', 'genoa', 'genes'],
  ['turin', 'turim', 'torino'],
  ['bolona', 'bolonha', 'bologna'],
  ['assisi', 'assis'],
  ['lisabon', 'lisboa', 'lisbon', 'lissabon'],
  ['brusel', 'bruxelas', 'bruxelles', 'brussels', 'brussel'],
  ['bruggy', 'bruges', 'brugge'],
  ['antverpy', 'antuerpia', 'antwerpen', 'antwerp'],
  ['varsava', 'varsovia', 'warszawa', 'warsaw'],
  ['krakov', 'cracovia', 'krakow', 'cracow'],
  ['budapest', 'budapeste'],
  ['bern', 'berna', 'berne'],
  ['basilej', 'basileia', 'basel', 'bale'],
  ['bratislava', 'bratislavia'],
  ['dubrovnik', 'dubrovnique'],
  ['split', 'esplit'],
  ['lyon', 'lyons', 'lione'],
  ['strasburk', 'estrasburgo', 'strasbourg', 'strassburg'],
  ['frankfurt', 'frankfurt am main', 'francoforte'],
  ['heidelberg', 'heidelberga'],
  ['verona', 'verona'],
  ['siena', 'sienna'],
  ['pisa', 'pisa'],
  ['granada', 'granada'],
  ['sofie', 'sofia'],
  ['tallinn', 'tallin'],
  ['vilnius', 'vilna'],
  ['oslo', 'oslo'],
  ['dublin', 'dublim'],
  ['bordeaux', 'bordeus'],
  ['marseille', 'marselha', 'marseilles'],
  ['tbilisi', 'tbilissi', 'tiflis'],
  ['tirana', 'tirane'],
  ['berlin', 'berlim'],
  ['londyn', 'londres', 'london'],
  ['pariz', 'paris'],
  ['zeneva', 'genebra', 'geneve', 'geneva', 'genf'],
  ['curych', 'zurique', 'zurich'],
  ['lucern', 'lucerna', 'luzern', 'lucerne'],
  ['salcburk', 'salzburgo', 'salzburg'],
  ['kolin nad rynem', 'colonia', 'koln', 'cologne'],
  ['norimberk', 'nuremberga', 'nurnberg', 'nuremberg', 'nuernberg'],
  ['drazdany', 'dresda', 'dresden'],
  ['hamburk', 'hamburgo', 'hamburg'],
  ['athény', 'atheny', 'atenas', 'athens', 'athina'],
  ['lublan', 'liubliana', 'ljubljana'],
  ['belehrad', 'belgrado', 'beograd', 'belgrade'],
  ['zahreb', 'zagrabia', 'zagreb'],
  ['kodan', 'copenhague', 'kobenhavn', 'copenhagen'],
  ['stockholm', 'estocolmo'],
  ['helsinky', 'helsinque', 'helsinki'],
  ['amsterdam', 'amsterda'],
  ['edinburgh', 'edimburgo'],
  ['istanbul', 'istambul'],
  ['bukurest', 'bucareste', 'bucuresti', 'bucharest'],
  ['sevilla', 'sevilha', 'seville'],
  ['madrid', 'madri'],
  ['nice', 'nizza', 'nica'],
  ['skopje', 'escopia'],
  ['pristina', 'prishtina', 'prishtine'],
  ['cesky krumlov', 'krumlov'],
  ['karlovy vary', 'karlsbad'],
  ['monako', 'monaco', 'monte carlo'],
];
const CITY_CANON = new Map();
CITY_ALIASES.forEach(list => list.forEach(v => CITY_CANON.set(stripDia(v).replace(/[^a-z]/g, ''), list[0])));
export const cityKey = (s) => {
  const first = stripDia(String(s || '').toLowerCase()).split(/[,/(]/)[0];
  const k = first.replace(/[^a-z]/g, '');
  return CITY_CANON.get(k) || k;
};

// Dva názvy = tentýž hotel jen při shodě, nebo když je jeden CELÝ obsažený
// v druhém jako slovní spojení (stejné pravidlo jako u slučování karet).
export const sameName = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = ` ${a} `, pb = ` ${b} `;
  return pa.includes(pb) || pb.includes(pa);
};

// Rejstřík karet: e-mail → karty, řádek databáze → karta, název+město → karty.
export function buildCardIndex(cards, hotelRows) {
  const byEmail = new Map();
  const byNameCity = new Map();   // cityKey → [{ card, n }]
  const byId = new Map();
  for (const c of cards || []) {
    byId.set(c.id, c);
    for (const e of (c.emails || [])) {
      const k = cleanEmail(e.email);
      if (!k) continue;
      if (!byEmail.has(k)) byEmail.set(k, new Set());
      byEmail.get(k).add(c.id);
    }
    const ck = cityKey(c.city);
    const names = [c.name, ...(c.aliases || [])].map(normName).filter(n => n && n.length >= 3);
    if (!byNameCity.has(ck)) byNameCity.set(ck, []);
    names.forEach(n => byNameCity.get(ck).push({ card: c, n }));
  }
  const rowCard = new Map();
  (hotelRows || []).forEach(r => { if (r.cardId) rowCard.set(r.id, r.cardId); });
  return { byEmail, byNameCity, byId, rowCard };
}

// Karty, jejichž název odpovídá (ve stejném městě).
export function nameMatches(idx, name, city) {
  const n = normName(name);
  if (!n || n.length < 3) return [];
  const list = idx.byNameCity.get(cityKey(city)) || [];
  const out = new Map();
  list.forEach(({ card, n: cn }) => { if (sameName(n, cn)) out.set(card.id, card); });
  return [...out.values()];
}

// Najde kartu pro jeden záznam (řádek nabídky, službu zakázky, log poptávky).
// Vrací { cardId, how: 'card'|'confirmed'|'email' } — jistá vazba,
//    nebo { how: 'maybe', candidates: [karty] } — člověk vybere / odmítne,
//    nebo null — žádná karta nepřichází v úvahu.
export function resolveCard(idx, { cardId, emails, name, city, linkKey }, decisions) {
  if (cardId && idx.byId.has(cardId)) return { cardId, how: 'card' };
  const dec = linkKey && decisions ? decisions[linkKey] : null;
  if (dec && dec.decision === 'yes' && idx.byId.has(dec.cardId)) return { cardId: dec.cardId, how: 'confirmed' };
  const rejected = dec && dec.decision === 'no' ? new Set([dec.cardId, ...(dec.rejected || [])]) : new Set();

  const byMail = new Set();
  (emails || []).forEach(e => {
    const k = usableEmail(e);
    if (k && idx.byEmail.has(k)) idx.byEmail.get(k).forEach(id => byMail.add(id));
  });
  rejected.forEach(id => byMail.delete(id));
  if (byMail.size === 1) return { cardId: [...byMail][0], how: 'email' };

  const byName = nameMatches(idx, name, city).filter(c => !rejected.has(c.id));
  if (byMail.size > 1) {
    // Sdílená adresa (centrála řetězce) — rozhodne název.
    const both = byName.filter(c => byMail.has(c.id));
    if (both.length === 1) return { cardId: both[0].id, how: 'email' };
    // Jinak vybere člověk z karet, které adresu sdílejí (+ shody podle názvu).
    const cand = new Map();
    [...byMail].forEach(id => cand.set(id, idx.byId.get(id)));
    byName.forEach(c => cand.set(c.id, c));
    return { how: 'maybe', candidates: [...cand.values()].slice(0, 8) };
  }
  if (byName.length) return { how: 'maybe', candidates: byName.slice(0, 8) };
  return null;
}

// ── Výpis jednoho řádku nabídky ─────────────────────────────────────────────
const isHotelItem = (it) => !!it && it.subType === 'hotel';
const itemEmails = (it) => (it.contactEmails || (it.contactEmail ? [it.contactEmail] : [])).map(usableEmail).filter(Boolean);
const noteList = (entries, legacy) => {
  if (Array.isArray(entries)) return entries.filter(e => String(e.text || '').trim());
  const t = String(legacy || '').trim();
  return t ? [{ id: 'legacy', stamp: '', text: t }] : [];
};

export const offerResult = (offer) => {
  if (!offer) return 'open';
  if (offer.realization && offer.realization.status === 'active') return 'realized';
  if (offer.status === 'won') return 'won';
  if (offer.declined || offer.status === 'lost') return 'lost';
  return 'open';
};

// Všechny vazby z celé aplikace: { links: Map(cardId → {...}), maybe: [...], orphans: [...] }
//   maybe   = možné shody podle názvu (k potvrzení)
//   orphans = hotely z nabídek/zakázek bez karty (s kontakty)
export function collectLinks({ cards, hotelRows, offers, orders, emailLog, decisions }) {
  const idx = buildCardIndex(cards, hotelRows);
  const links = new Map();
  const get = (id) => {
    if (!links.has(id)) links.set(id, { requests: [], offerLines: [], orderLines: [], emails: new Map() });
    return links.get(id);
  };
  const maybe = [];
  const orphans = new Map();
  const addEmails = (bucket, emails, src) => emails.forEach(e => {
    if (!bucket.emails.has(e)) bucket.emails.set(e, src);
  });
  const addOrphan = (name, city, emails, src) => {
    if (!String(name || '').trim()) return;
    const k = `${normName(name)}|${cityKey(city)}`;
    if (!normName(name)) return;
    if (!orphans.has(k)) orphans.set(k, { key: k, name: String(name).trim(), city: String(city || '').trim(), emails: new Set(), sources: [] });
    const o = orphans.get(k);
    emails.forEach(e => o.emails.add(e));
    o.sources.push(src);
  };

  // Log poptávek
  for (const l of emailLog || []) {
    // Log zapisuje jen úspěšně odeslané poptávky (status 'sent'); kdyby se
    // objevil jiný stav (chyba), nepočítá se.
    if (l.status && l.status !== 'sent') continue;
    let cardId = l.hotelId ? idx.rowCard.get(l.hotelId) : null;
    if (!cardId) {
      const r = resolveCard(idx, { emails: [l.email], name: l.hotelName, city: l.hotelCity });
      cardId = r && r.cardId ? r.cardId : null;
    }
    if (!cardId) continue;
    get(cardId).requests.push({
      id: l.id, at: l.sentAt?.seconds ? new Date(l.sentAt.seconds * 1000).toISOString() : (l.sentAt || ''),
      email: cleanEmail(l.email), group: l.groupName || '', offerNumber: l.offerNumber || '',
      checkIn: l.checkIn || '', checkOut: l.checkOut || '', subject: l.subject || '',
    });
  }

  // Nabídky
  for (const o of offers || []) {
    const result = offerResult(o);
    for (const it of (o.items || [])) {
      if (!isHotelItem(it) || !(it.name || itemEmails(it).length)) continue;
      const linkKey = `offer:${o.id}:${it.id}`;
      const emails = itemEmails(it);
      const r = resolveCard(idx, { cardId: it.hotelCardId, emails, name: it.name, city: it.city, linkKey }, decisions);
      const line = {
        key: linkKey, offerId: o.id, itemId: it.id,
        offerNumber: o.offerNumber || '', group: o.name || '', client: o.clientName || '',
        offerStatus: o.status || '', result, startDate: o.startDate || '',
        name: it.name || '', city: it.city || '', dateFrom: it.dateFrom || '', dateTo: it.dateTo || '', nights: it.nights || '',
        bookingStatus: it.cancelled ? 'cancelled' : (it.bookingStatus || ''),
        inPrice: it.enabled !== false, isAlt: !!it.isAlt,
        priceDbl: it.pricePerNightDbl ?? '', priceSngl: it.pricePerNightSngl ?? '',
        cityTax: it.cityTax ?? '', cityTaxSngl: it.cityTaxSngl ?? '', currency: it.currency || '',
        trpl: it.trplOffer ? { type: it.trplType || '', price: it.trplPrice ?? '' } : null,
        optionDate: it.optionDate || '', cancellationDeadline: it.cancellationDeadline || '',
        depositTerms: it.depositTerms || '', deposits: effectiveDeposits(o, it),
        notes: noteList(it.noteEntries, it.note),
        emails, updatedAt: o.updatedAt || o.createdAt || '',
      };
      if (r && r.cardId) {
        line.how = r.how;
        const b = get(r.cardId);
        b.offerLines.push(line);
        addEmails(b, emails, { type: 'offer', offerId: o.id, offerNumber: o.offerNumber || '', group: o.name || '' });
      } else if (r && r.how === 'maybe') {
        maybe.push({ ...line, candidates: r.candidates.map(c => ({ id: c.id, name: c.name, city: c.city })), source: 'offer' });
      } else {
        addOrphan(it.name, it.city, emails, { key: linkKey, type: 'offer', offerId: o.id, offerNumber: o.offerNumber || '', group: o.name || '' });
      }
    }
  }

  // Staré zakázky (jen hotelové služby)
  for (const ord of orders || []) {
    for (const s of (ord.services || [])) {
      if (s.type !== 'hotel') continue;
      const name = s.name || s.providerName || '';
      const emails = [s.providerEmail, s.providerEmail2].map(usableEmail).filter(Boolean);
      if (!name && !emails.length) continue;
      const linkKey = `order:${ord.id}:${s.id}`;
      const r = resolveCard(idx, { cardId: s.hotelCardId, emails, name, city: s.city, linkKey }, decisions);
      const line = {
        key: linkKey, orderId: ord.id, serviceId: s.id,
        offerNumber: ord.offerNumber || '', group: ord.name || '', client: ord.clientName || '',
        orderStatus: ord.status || '', serviceStatus: s.status || '',
        name, city: s.city || '', dateFrom: s.dateFrom || '', dateTo: s.dateTo || '', nights: s.nights || '',
        priceDbl: s.pricePerDblRoom ?? '', priceSngl: s.pricePerSnglRoom ?? '', priceTwn: s.pricePerTwnRoom ?? '', priceTrpl: s.pricePerTrplRoom ?? '',
        rooms: { dbl: s.dblRooms || '', sngl: s.snglRooms || '', twn: s.twnRooms || '', trpl: s.trplRooms || '' },
        cityTax: s.cityTax ?? '', currency: s.currency || '',
        optionDate: s.optionDate || '', cancellationDays: s.cancellationDays || '', cancellationDate: s.cancellationDate || '',
        notes: String(s.notes || '').trim(), website: s.providerWebsite || '', phone: s.providerPhone || '',
        emails,
      };
      if (r && r.cardId) {
        line.how = r.how;
        const b = get(r.cardId);
        b.orderLines.push(line);
        addEmails(b, emails, { type: 'order', orderId: ord.id, group: ord.name || '' });
      } else if (r && r.how === 'maybe') {
        maybe.push({ ...line, candidates: r.candidates.map(c => ({ id: c.id, name: c.name, city: c.city })), source: 'order' });
      } else {
        addOrphan(name, s.city, emails, { key: linkKey, type: 'order', orderId: ord.id, group: ord.name || '' });
      }
    }
  }

  // Seřadit
  for (const b of links.values()) {
    b.requests.sort((a, c) => String(c.at).localeCompare(String(a.at)));
    b.offerLines.sort((a, c) => String(c.dateFrom || c.startDate).localeCompare(String(a.dateFrom || a.startDate)));
    b.orderLines.sort((a, c) => String(c.dateFrom).localeCompare(String(a.dateFrom)));
  }
  return {
    idx, links, maybe,
    orphans: [...orphans.values()].map(o => ({ ...o, emails: [...o.emails] })).sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name)),
  };
}

// Souhrn pro kartu: poptáno, nabídek, potvrzeno, realizováno, naposledy.
export function cardSummary(b) {
  if (!b) return null;
  const offerIds = new Set(b.offerLines.map(l => l.offerId));
  const confirmed = b.offerLines.filter(l => l.bookingStatus === 'confirmed').length
    + b.orderLines.filter(l => ['confirmed', 'deposit_paid', 'contract', 'paid'].includes(l.serviceStatus)).length;
  const realized = new Set(b.offerLines.filter(l => l.inPrice && l.bookingStatus !== 'cancelled' && (l.result === 'realized' || l.result === 'won')).map(l => l.offerId)).size
    + b.orderLines.length;
  const dates = [
    ...b.requests.map(r => r.at),
    ...b.offerLines.map(l => l.updatedAt),
  ].filter(Boolean).map(String).sort();
  return {
    requests: b.requests.length,
    offers: offerIds.size,
    confirmed,
    realized,
    cancelled: b.offerLines.filter(l => l.bookingStatus === 'cancelled').length,
    orders: b.orderLines.length,
    last: dates.length ? dates[dates.length - 1] : '',
  };
}

// E-maily ze servisních karet, které na kartě hotelu ještě nejsou.
export function newEmailsForCard(card, b) {
  if (!card || !b) return [];
  const have = new Set((card.emails || []).map(e => cleanEmail(e.email)));
  return [...b.emails.entries()].filter(([e]) => !have.has(e)).map(([email, src]) => ({ email, src }));
}

// Možné shody seskupené podle stejně napsaného názvu, města a stejných
// kandidátů — jedno rozhodnutí platí pro všechny výskyty téhož hotelu.
export function groupMaybe(maybe) {
  const groups = new Map();
  for (const m of maybe || []) {
    const k = `${normName(m.name)}|${cityKey(m.city)}|${m.candidates.map(c => c.id).sort().join(',')}`;
    if (!groups.has(k)) groups.set(k, { key: k, name: m.name, city: m.city, candidates: m.candidates, lines: [], emails: new Set() });
    const g = groups.get(k);
    g.lines.push(m);
    m.emails.forEach(e => g.emails.add(e));
  }
  return [...groups.values()].map(g => ({ ...g, emails: [...g.emails] }))
    .sort((a, b) => b.lines.length - a.lines.length || String(a.city).localeCompare(String(b.city)));
}
