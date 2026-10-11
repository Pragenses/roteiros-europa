import React, { useEffect, useState } from 'react';
import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, auth } from '../lib/firebase';
import { PEOPLE } from '../lib/people';
import { feedsFor, feedUrl, personKey } from '../lib/calendarFeed';

// Nastavení → „📅 Kalendáře do telefonu a počítače“.
// Odkazy jsou osobní (každý vidí jen své). Kalendáře obnovuje Firebase
// samo podle intervalu; tlačítko „Aktualizovat teď“ je obnoví hned.
// Kalendáře v telefonu jsou JEN KE ČTENÍ – data se mění jen v aplikaci.

const LIMITED_EMAILS = ['skorkovska@gmail.com']; // jako USER_ROLES v App.js
const INTERVALS = [5, 15, 30, 60];

const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export default function CalendarFeedsSettings({ colors, canEdit }) {
  const email = String(auth.currentUser?.email || '').toLowerCase();
  const me = PEOPLE.find(p => p.email === email) || null;
  const viewer = me ? { code: me.code, email, limited: LIMITED_EMAILS.includes(email) } : null;

  const [token, setToken] = useState(undefined);
  const [settings, setSettings] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');

  const load = async () => {
    const [s, t] = await Promise.all([
      getDoc(doc(db, 'settings', 'calendarFeeds')),
      me ? getDoc(doc(db, 'calendarFeeds', personKey(me.code))) : Promise.resolve(null),
    ]);
    setSettings(s.exists() ? s.data() : {});
    setToken(t && t.exists() ? (t.data().token || '') : '');
  };
  useEffect(() => { load().catch(e => { setMsg('❌ Nastavení kalendářů se nepodařilo načíst: ' + (e.message || e)); setToken(''); }); }, []);

  const call = async (action, okText) => {
    setBusy(action); setMsg('');
    try {
      const fn = httpsCallable(getFunctions(getApp(), 'europe-west1'), 'calendarAction');
      await fn({ action });
      await load();
      setMsg('✓ ' + okText);
    } catch (e) {
      setMsg('❌ ' + (e.message || e));
    }
    setBusy('');
  };

  const setInterval_ = async (minutes) => {
    setMsg('');
    try {
      await setDoc(doc(db, 'settings', 'calendarFeeds'), { intervalMinutes: minutes }, { merge: true });
      setSettings(s => ({ ...s, intervalMinutes: minutes }));
      setMsg(`✓ Kalendáře se budou obnovovat každých ${minutes} minut.`);
    } catch (e) { setMsg('❌ ' + (e.message || e)); }
  };

  const copy = async (key, url) => {
    try { await navigator.clipboard.writeText(url); setCopied(key); setTimeout(() => setCopied(''), 2000); }
    catch (e) { setMsg('❌ Kopírování se nepodařilo – označte odkaz ručně.'); }
  };

  if (token === undefined) return null;
  const bucket = getApp().options.storageBucket;
  const interval = Number(settings.intervalMinutes) || 15;
  const btn = (bg, fg = '#fff', border = 'none') => ({ padding: '5px 11px', background: bg, color: fg, border, borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' });

  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', maxWidth: 1000, marginTop: '1.5rem' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: 8 }}>📅 Kalendáře do telefonu a počítače</div>
      <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1rem', lineHeight: 1.5 }}>
        Odjezdy, storna potvrzených hotelů, alternativy a úkoly se dají odebírat v Kalendáři na Macu a iPhonu i v Google Kalendáři.
        Kalendáře jsou jen ke čtení – měnit se dá jen tady v aplikaci. Odkazy jsou osobní a tajné: neposílejte je dál.
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: '1rem', fontSize: 13 }}>
        <button type="button" disabled={!!busy} onClick={() => call('refresh', 'Kalendáře jsou aktualizované. V telefonu je obnovíte stažením seznamu dolů, na Macu v menu Kalendář → Obnovit kalendáře.')}
          style={btn(colors.primary)}>{busy === 'refresh' ? 'Aktualizuji…' : '🔄 Aktualizovat kalendáře teď'}</button>
        <span style={{ color: colors.muted }}>Naposledy: <b style={{ color: colors.text }}>{fmtTime(settings.lastRunAt)}</b></span>
        {canEdit ? (
          <label style={{ color: colors.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
            Obnovovat automaticky každých
            <select value={interval} onChange={e => setInterval_(Number(e.target.value))}
              style={{ padding: '3px 6px', borderRadius: 6, border: `1px solid ${colors.border}`, fontFamily: 'inherit', fontSize: 13 }}>
              {INTERVALS.map(m => <option key={m} value={m}>{m} minut</option>)}
            </select>
          </label>
        ) : (
          <span style={{ color: colors.muted }}>Automaticky každých {interval} minut</span>
        )}
      </div>

      {settings.lastError && (
        <div style={{ background: '#FCEBEB', color: '#791F1F', borderRadius: 8, padding: '6px 10px', fontSize: 12, marginBottom: 10 }}>
          Poslední obnova se nepodařila ({fmtTime(settings.lastErrorAt)}): {settings.lastError}
        </div>
      )}
      {msg && <div style={{ fontSize: 13, marginBottom: 10, color: msg.startsWith('❌') ? '#791F1F' : '#27500A' }}>{msg}</div>}

      {!me && (
        <div style={{ fontSize: 13, color: colors.muted }}>Tento účet nemá vlastní kalendáře – přihlaste se svým osobním účtem.</div>
      )}
      {me && !token && (
        <div style={{ fontSize: 13, color: colors.muted }}>Vaše odkazy ještě nejsou vytvořené. Klikněte na „🔄 Aktualizovat kalendáře teď“.</div>
      )}
      {me && token && (
        <>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 6 }}>
            Vaše kalendáře ({me.short}). „Přidat do Kalendáře“ otevře Kalendář na Macu / iPhonu. Pro Google zkopírujte odkaz a vložte ho v Google Kalendáři do „Další kalendáře → Z URL“.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {feedsFor(viewer).map(f => {
              const url = feedUrl(bucket, token, f.key);
              return (
                <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${colors.border}`, fontSize: 13, flexWrap: 'wrap' }}>
                  <span style={{ flex: 1, minWidth: 180, fontWeight: 600, color: colors.text }}>{f.name}</span>
                  <a href={url.replace(/^https:/, 'webcal:')} style={{ ...btn('#EAF3DE', '#27500A', '1px solid #27500A33'), textDecoration: 'none' }}>🍎 Přidat do Kalendáře</a>
                  <button type="button" onClick={() => copy(f.key, url)} style={btn('transparent', colors.primary, `1px solid ${colors.border}`)}>
                    {copied === f.key ? '✓ Zkopírováno' : '📋 Kopírovat odkaz'}
                  </button>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="button" disabled={!!busy}
              onClick={() => { if (window.confirm('Vytvořit nové odkazy? Staré přestanou fungovat a kalendáře bude potřeba v telefonu a počítači přidat znovu.')) call('newLinks', 'Nové odkazy jsou vytvořené. Staré už nefungují.'); }}
              style={btn('transparent', '#791F1F', '1px solid #791F1F55')}>
              {busy === 'newLinks' ? 'Vytvářím…' : '🔑 Vytvořit nové odkazy (když se ty staré dostaly ven)'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
