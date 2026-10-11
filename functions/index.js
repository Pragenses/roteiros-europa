// Kalendáře do telefonu a počítače (Mac / iPhone / Google).
//
// Co tu běží (ve Firebase, ne na GitHub Pages):
// 1) calendarTick – spouští se každých 5 minut, ale skutečně kalendáře obnoví
//    jen když od poslední obnovy uplynul interval z Nastavení (výchozí 15 min).
//    Většinou tedy jen přečte jeden dokument a skončí.
// 2) calendarAction – tlačítka v aplikaci (Nastavení → Kalendáře):
//    „Aktualizovat teď“ a „Vytvořit nové odkazy“.
//
// Hotové kalendáře (.ics) se ukládají do úložiště Firebase do složky
// calendars/<tajný kód>/. Telefon si je stahuje sám přes tajnou adresu.
// Do databáze se NIC nezapisuje kromě nastavení kalendářů – nabídky se jen čtou.
//
// Pravidla termínů jsou ve složce shared/ – při nasazení se sem kopírují
// z src/lib (deadlines.js, calendarFeed.js, people.js), aby aplikace
// i kalendáře počítaly vždy totéž.

import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions, logger } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import crypto from 'node:crypto';
import { buildFeeds, feedsFor, feedPath, personKey } from './shared/calendarFeed.js';
import { PEOPLE } from './shared/people.js';

setGlobalOptions({ region: 'europe-west1', memory: '512MiB', timeoutSeconds: 120, maxInstances: 2 });

initializeApp();
const db = getFirestore();

// Musí odpovídat ALLOWED_EMAILS a USER_ROLES v src/App.js.
const ALLOWED_EMAILS = ['helena.maria.brito@gmail.com', 'filipdlask@gmail.com', 'grupos@tour-pragenses.com', 'skorkovska@gmail.com'];
const LIMITED_EMAILS = ['skorkovska@gmail.com'];

const SETTINGS_DOC = db.doc('settings/calendarFeeds');
const DEFAULT_INTERVAL = 15; // minut
const tokenDoc = (code) => db.doc(`calendarFeeds/${personKey(code)}`);
const newToken = () => crypto.randomBytes(24).toString('hex');

// Zajistí, že každý člověk má svůj tajný kód (vytvoří se jen poprvé).
const ensureTokens = async () => {
  const out = [];
  for (const p of PEOPLE) {
    const ref = tokenDoc(p.code);
    const snap = await ref.get();
    let token = snap.exists ? snap.data().token : '';
    if (!token) {
      token = newToken();
      await ref.set({ code: p.code, email: p.email, token, createdAt: new Date().toISOString() }, { merge: true });
    }
    out.push({ ...p, token, limited: LIMITED_EMAILS.includes(p.email) });
  }
  return out;
};

const uploadFeed = async (bucket, token, key, text) => {
  await bucket.file(feedPath(token, key)).save(Buffer.from(text, 'utf8'), {
    resumable: false,
    contentType: 'text/calendar; charset=utf-8',
    metadata: {
      cacheControl: 'no-cache, max-age=0',
      // Pevný token ke stažení = adresa kalendáře se nemění.
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });
};

// Vyrobí a nahraje kalendáře pro všechny lidi.
const generateAll = async (reason) => {
  const started = new Date();
  const [offSnap, ordSnap] = await Promise.all([db.collection('offers').get(), db.collection('orders').get()]);
  const offers = offSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const orders = ordSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const people = await ensureTokens();
  const bucket = getStorage().bucket();
  for (const p of people) {
    const viewer = { code: p.code, limited: p.limited, email: p.email };
    const feeds = buildFeeds({ offers, orders, viewer, now: started });
    for (const f of feedsFor(viewer)) await uploadFeed(bucket, p.token, f.key, feeds[f.key]);
  }
  const info = { lastRunAt: started.toISOString(), lastRunReason: reason, lastError: '', lastDurationMs: Date.now() - started.getTime() };
  await SETTINGS_DOC.set(info, { merge: true });
  logger.info('Kalendáře obnoveny', { reason, offers: offers.length, orders: orders.length });
  return info;
};

const recordError = async (err) => {
  logger.error('Obnova kalendářů selhala', err);
  try { await SETTINGS_DOC.set({ lastError: String(err && err.message || err), lastErrorAt: new Date().toISOString() }, { merge: true }); } catch (e) { /* nic */ }
};

// 1) Pravidelná obnova.
export const calendarTick = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Prague' }, async () => {
  const snap = await SETTINGS_DOC.get();
  const s = snap.exists ? snap.data() : {};
  const interval = Math.max(5, Number(s.intervalMinutes) || DEFAULT_INTERVAL);
  const last = s.lastRunAt ? new Date(s.lastRunAt).getTime() : 0;
  // Minuta rezervy, aby „každých 15 minut“ nevycházelo na 20.
  if (Date.now() - last < (interval - 1) * 60000) return;
  try { await generateAll('plán'); } catch (e) { await recordError(e); }
});

// 2) Tlačítka v aplikaci.
export const calendarAction = onCall(async (request) => {
  const email = String(request.auth?.token?.email || '').toLowerCase();
  if (!email || !ALLOWED_EMAILS.includes(email)) throw new HttpsError('permission-denied', 'Tento účet nemá přístup.');
  const action = request.data?.action;

  if (action === 'refresh') {
    try { return { ok: true, ...(await generateAll('tlačítko ' + email)) }; }
    catch (e) { await recordError(e); throw new HttpsError('internal', 'Obnova se nepodařila: ' + (e.message || e)); }
  }

  if (action === 'newLinks') {
    // Nový tajný kód jen pro přihlášeného člověka; staré soubory se smažou,
    // takže staré odkazy přestanou fungovat.
    const me = PEOPLE.find(p => p.email === email);
    if (!me) throw new HttpsError('failed-precondition', 'Tento účet nemá vlastní kalendáře.');
    const ref = tokenDoc(me.code);
    const snap = await ref.get();
    const old = snap.exists ? snap.data().token : '';
    await ref.set({ code: me.code, email: me.email, token: newToken(), createdAt: new Date().toISOString() }, { merge: true });
    if (old) await getStorage().bucket().deleteFiles({ prefix: `calendars/${old}/` }).catch(e => logger.warn('Mazání starých kalendářů', e));
    try { return { ok: true, ...(await generateAll('nové odkazy ' + email)) }; }
    catch (e) { await recordError(e); throw new HttpsError('internal', 'Obnova se nepodařila: ' + (e.message || e)); }
  }

  throw new HttpsError('invalid-argument', 'Neznámá akce.');
});
