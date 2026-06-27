import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp
} from 'firebase/firestore';

// ── parser ────────────────────────────────────────────────────────────────────
// Rozezná: MĚSTO, NÁZEV HOTELU, email@hotel.com
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseHotelText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = []; // { city, name, email }
  let currentCity = '';
  let pendingName = '';

  for (const line of lines) {
    const clean = line.replace(/^[-–—*•]\s*/, '');
    if (EMAIL_RE.test(clean)) {
      results.push({ city: currentCity, name: pendingName || clean, email: clean });
      pendingName = '';
    } else if (clean === clean.toUpperCase() && clean.length > 2) {
      // Velká písmena = buď město nebo název hotelu
      if (!currentCity || results.length === 0 || results[results.length - 1].city === currentCity) {
        // Pokud ještě nemáme email po předchozím názvu, je to město
        if (!pendingName) {
          currentCity = clean.replace(/^HOTEL[YS]?\s+/i, '').replace(/^HOTEIS\s+/i, '');
        } else {
          pendingName = clean;
        }
      } else {
        currentCity = clean;
        pendingName = '';
      }
      if (!pendingName) pendingName = '';
      // Zkusíme detekovat jestli je to název hotelu (obsahuje HOTEL, GRAND, PALACE atd.)
      if (/HOTEL|GRAND|PALACE|RESORT|INN|SUITES|BERGHOTEL|BOUTIQUE|ROMANTIK|HAUSER|CRYSTAL|ALBANA|CERVUS/i.test(clean)) {
        pendingName = clean;
      } else if (!currentCity) {
        currentCity = clean;
      }
    } else {
      pendingName = clean;
    }
  }
  return results;
}

// Jednodušší a spolehlivější parser
function parseHotelTextV2(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const results = [];
  let currentCity = '';
  let lastNonEmail = '';

  for (const line of lines) {
    const clean = line.replace(/^[-–—*•]\s*/, '').replace(/\[([^\]]+)\]\([^)]+\)/, '$1').trim();
    if (!clean) continue;

    if (EMAIL_RE.test(clean)) {
      results.push({
        city: currentCity,
        name: lastNonEmail && lastNonEmail !== currentCity ? lastNonEmail : '',
        email: clean.toLowerCase(),
      });
      lastNonEmail = '';
    } else {
      // Je to město nebo název hotelu
      const isAllCaps = clean === clean.toUpperCase() && /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(clean);
      if (isAllCaps && results.length === 0) {
        currentCity = clean;
        lastNonEmail = '';
      } else if (isAllCaps && lastNonEmail === '' && results.length > 0 && results[results.length-1].city === currentCity) {
        // nové město nebo nový hotel name
        lastNonEmail = clean;
        // pokud příští řádek není email, bude to město
      } else {
        lastNonEmail = clean;
      }
    }
  }
  return results.filter(r => r.email);
}

// Parser — město je řádek s HOTELY/HOTELS/HOTEIS nebo první text před prvním emailem
// Název hotelu = řádek těsně před emailem
function parseSimple(text) {
  const lines = text.split('\n').map(l =>
    l.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim()
  ).filter(Boolean);

  const results = [];
  let city = '';
  let pendingName = '';
  let foundFirstEmail = false;

  for (const line of lines) {
    if (EMAIL_RE.test(line)) {
      foundFirstEmail = true;
      results.push({ city, name: pendingName, email: line.toLowerCase() });
      pendingName = '';
    } else if (/^HOTELY\s+|^HOTELS\s+|^HOTEIS\s+/i.test(line)) {
      // Explicitní označení města
      city = line.replace(/^HOTELY\s+/i,'').replace(/^HOTELS\s+/i,'').replace(/^HOTEIS\s+/i,'').trim();
      pendingName = '';
    } else if (!foundFirstEmail && !city) {
      // Před prvním emailem bez města — toto je město
      city = line;
      pendingName = '';
    } else {
      // Název hotelu
      pendingName = line;
    }
  }
  return results.filter(r => r.email);
}

// ── fmt ───────────────────────────────────────────────────────────────────────
const fmt = (ts) => {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('cs-CZ') + ' ' + d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
};

const TABS = [
  { id: 'import',  label: '📥 Import hotelů' },
  { id: 'db',      label: '🏨 Databáze' },
  { id: 'compose', label: '✉ Poptávka' },
  { id: 'log',     label: '📋 Log' },
];

const DEFAULT_TEMPLATE = `Dear Reservations Team,

We would like to request availability and rates for a group:

Group: {{groupName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Rooms: {{rooms}}

Please provide your best group rates including:
- Room rate per night (DBL / SGL supplement)
- 1 complimentary room per {{freeRatio}} paid rooms
- Breakfast included
- Group payment conditions

We look forward to your reply.

Kind regards,
Helena Čejková
Orbis Europa DMC
grupos@tour-pragenses.com`;

// ═══════════════════════════════════════════════════════════════════════════════
export default function Hotels({ navigate, colors }) {
  const C = colors;
  const [tab, setTab] = useState('import');

  // ── DB ───────────────────────────────────────────────────────────────────────
  const [hotels, setHotels]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [cityFilter, setCityFilter] = useState('');

  // ── Import ───────────────────────────────────────────────────────────────────
  const [importText, setImportText]     = useState('');
  const [parsed, setParsed]             = useState([]);
  const [importCity, setImportCity]     = useState('');
  const [importing, setImporting]       = useState(false);
  const [importDone, setImportDone]     = useState(null);

  // ── Compose ──────────────────────────────────────────────────────────────────
  const [selected, setSelected]     = useState([]);
  const [composeCity, setComposeCity] = useState('');
  const [groupName, setGroupName]   = useState('');
  const [checkIn, setCheckIn]       = useState('');
  const [checkOut, setCheckOut]     = useState('');
  const [rooms, setRooms]           = useState('');
  const [freeRatio, setFreeRatio]   = useState('20');
  const [emailBody, setEmailBody]   = useState(DEFAULT_TEMPLATE);
  const [subject, setSubject]       = useState('Group Accommodation Request');
  const [sendResult, setSendResult] = useState(null);

  // ── Log ──────────────────────────────────────────────────────────────────────
  const [logs, setLogs]             = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // ── Fetch ─────────────────────────────────────────────────────────────────────
  const fetchHotels = useCallback(async () => {
    setLoading(true);
    const snap = await getDocs(collection(db, 'hotels'));
    setHotels(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
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

  // ── Import logic ──────────────────────────────────────────────────────────────
  const handleParse = () => {
    const city = importCity.trim().toUpperCase();
    const raw = parseSimple(importText);
    // Pokud je zadané město ručně, použij ho vždy (přepíše i to co parser našel)
    const withCity = raw.map(h => ({ ...h, city: city || h.city || '?' }));
    setParsed(withCity);
  };

  const handleImport = async () => {
    if (!parsed.length) return;
    setImporting(true);
    // Existující emaily pro deduplikaci
    const existingEmails = new Set(hotels.map(h => h.email?.toLowerCase()));
    let added = 0, skipped = 0;
    for (const h of parsed) {
      if (existingEmails.has(h.email.toLowerCase())) { skipped++; continue; }
      await addDoc(collection(db, 'hotels'), {
        city: h.city, name: h.name, email: h.email, email2: '', phone: '', website: '', stars: '', notes: '',
      });
      added++;
    }
    setImportDone({ added, skipped });
    setImporting(false);
    setImportText('');
    setParsed([]);
    fetchHotels();
  };

  const deleteHotel = async (id) => {
    if (!window.confirm('Smazat hotel?')) return;
    await deleteDoc(doc(db, 'hotels', id));
    setSelected(s => s.filter(x => x !== id));
    fetchHotels();
  };

  // ── Compose logic ─────────────────────────────────────────────────────────────
  const buildBody = () => emailBody
    .replace(/{{groupName}}/g, groupName||'[GROUP NAME]')
    .replace(/{{checkIn}}/g, checkIn||'[CHECK-IN]')
    .replace(/{{checkOut}}/g, checkOut||'[CHECK-OUT]')
    .replace(/{{rooms}}/g, rooms||'[ROOMS]')
    .replace(/{{freeRatio}}/g, freeRatio||'20');

  const toggleSelect = (id) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const handleSend = async () => {
    if (!selected.length) { alert('Vyber alespoň jeden hotel.'); return; }
    const body = buildBody();
    const sel = hotels.filter(h => selected.includes(h.id));
    await Promise.all(sel.map(h =>
      addDoc(collection(db, 'hotelEmailLog'), {
        hotelId: h.id, hotelName: h.name||h.email, hotelCity: h.city,
        email: h.email, subject, groupName, checkIn, checkOut, rooms,
        sentAt: serverTimestamp(), status: 'mailto',
      })
    ));
    const emails = sel.map(h => h.email).join(',');
    window.open(`mailto:${emails}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
    setSendResult({ count: sel.length });
    setTab('log'); fetchLogs();
  };

  // ── Derived ───────────────────────────────────────────────────────────────────
  const cities = [...new Set(hotels.map(h => h.city).filter(Boolean))].sort();

  const dbFiltered = hotels.filter(h => {
    const q = search.toLowerCase();
    return (!q || h.name?.toLowerCase().includes(q) || h.city?.toLowerCase().includes(q) || h.email?.toLowerCase().includes(q))
      && (!cityFilter || h.city === cityFilter);
  });

  const composeHotels = composeCity ? hotels.filter(h => h.city === composeCity) : hotels;

  // ── Styles ────────────────────────────────────────────────────────────────────
  const thS = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${C.border}` };
  const tdS = { padding: '8px 12px', verticalAlign: 'top', fontSize: 13 };
  const cardS = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '1.2rem' };
  const inp = { width: '100%', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const btn = (bg, fg='#fff') => ({ padding: '7px 18px', background: bg, color: fg, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'Georgia, serif', fontWeight: 600 });

  // ═══════════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto', fontFamily: 'Georgia, serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 22, color: C.primary, margin: 0, fontWeight: 600 }}>🏨 Hotels</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '4px 0 0' }}>Import · Databáze · Poptávky · Log</p>
      </div>

      {/* Tabs */}
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
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>
                Město (pokud není v textu)
              </label>
              <input value={importCity} onChange={e => setImportCity(e.target.value)}
                placeholder="např. ST. MORITZ" style={inp} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>
                Text z Google Drive (copy-paste)
              </label>
              <textarea value={importText} onChange={e => setImportText(e.target.value)}
                rows={14} placeholder={`HOTELY ST. MORITZ\nBERGHOTEL RANDOLINS\nwillkommen@randolins.ch\nGRAND HOTEL KEMPINSKI\ninfo.stmoritz@kempinski.com\n\nnebo jen:\n\nwillkommen@randolins.ch\ninfo.stmoritz@kempinski.com\nwelcome@gracestmoritz.ch`}
                style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }} />
            </div>
            <button onClick={handleParse} style={btn(C.primary)}>🔍 Rozpoznat</button>
          </div>

          <div>
            {parsed.length > 0 && (
              <div style={cardS}>
                <h3 style={{ margin: '0 0 10px', fontSize: 15, color: C.primary, fontWeight: 600 }}>
                  Rozpoznáno: {parsed.length} hotelů
                </h3>
                <div style={{ maxHeight: 320, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 12 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead><tr style={{ background: C.bg }}>
                      {['Město','Název','Email'].map(h => <th key={h} style={thS}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {parsed.map((h, i) => (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={tdS}>{h.city||<span style={{color:'#e53'}}>?</span>}</td>
                          <td style={tdS}>{h.name||<span style={{color:C.muted}}>—</span>}</td>
                          <td style={tdS}>{h.email}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
                  Duplicitní emaily (již v databázi) budou přeskočeny.
                </p>
                <button onClick={handleImport} disabled={importing} style={btn(C.success)}>
                  {importing ? 'Importuji…' : `✓ Importovat ${parsed.length} hotelů`}
                </button>
              </div>
            )}
            {importDone && (
              <div style={{ ...cardS, marginTop: 12, background: '#e8f5e9' }}>
                <p style={{ margin: 0, fontSize: 14, color: C.success }}>
                  ✓ Přidáno: <strong>{importDone.added}</strong> hotelů &nbsp;·&nbsp; Přeskočeno (duplicity): <strong>{importDone.skipped}</strong>
                </p>
                <button onClick={() => setTab('db')} style={{ marginTop: 10, ...btn(C.primary) }}>→ Zobrazit databázi</button>
              </div>
            )}
            {parsed.length === 0 && !importDone && (
              <div style={{ ...cardS, color: C.muted, fontSize: 13, lineHeight: 1.8 }}>
                <strong style={{ color: C.primary }}>Jak to funguje:</strong><br/>
                1. Zkopíruj text z Google Drive (hotely jednoho nebo více měst)<br/>
                2. Klikni "Rozpoznat" — aplikace najde všechny emaily<br/>
                3. Zkontroluj výsledek a klikni "Importovat"<br/><br/>
                Funguje pro formát:<br/>
                <code style={{ fontSize: 12, background: C.bg, padding: '2px 6px', borderRadius: 4 }}>NÁZEV HOTELU<br/>email@hotel.com</code><br/><br/>
                i pro samotné emaily bez názvu.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── DB ── */}
      {tab === 'db' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat…" style={{ flex: 1, minWidth: 200, ...inp }} />
            <select value={cityFilter} onChange={e => setCityFilter(e.target.value)}
              style={{ padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif' }}>
              <option value="">Všechna města ({hotels.length})</option>
              {cities.map(c => <option key={c} value={c}>{c} ({hotels.filter(h=>h.city===c).length})</option>)}
            </select>
            <button onClick={() => setTab('import')} style={btn(C.primary)}>+ Import</button>
          </div>

          {loading ? <p style={{ color: C.muted }}>Načítám…</p> : dbFiltered.length === 0 ? (
            <p style={{ color: C.muted }}>Žádné hotely. Použij záložku Import.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: C.bg }}>
                  {['Město','Název','Email',''].map(h => <th key={h} style={thS}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {dbFiltered.map(h => (
                    <tr key={h.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={tdS}>{h.city||'—'}</td>
                      <td style={tdS}>{h.name||<span style={{color:C.muted}}>—</span>}</td>
                      <td style={tdS}><a href={`mailto:${h.email}`} style={{ color: C.primary }}>{h.email}</a></td>
                      <td style={tdS}>
                        <button onClick={() => deleteHotel(h.id)} style={{ padding: '2px 8px', background: C.danger, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{dbFiltered.length} hotelů</p>
            </div>
          )}
        </div>
      )}

      {/* ── COMPOSE ── */}
      {tab === 'compose' && (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1.5rem', alignItems: 'start' }}>
          <div>
            <div style={cardS}>
              <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Skupina</h3>
              {[
                ['Název skupiny', groupName, setGroupName, 'text'],
                ['Check-in', checkIn, setCheckIn, 'date'],
                ['Check-out', checkOut, setCheckOut, 'date'],
                ['Počet pokojů', rooms, setRooms, 'text'],
                ['1 pokoj zdarma za X placených', freeRatio, setFreeRatio, 'number'],
              ].map(([label, val, setter, type]) => (
                <div key={label} style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>{label}</label>
                  <input type={type} value={val} onChange={e => setter(e.target.value)} style={inp} />
                </div>
              ))}
            </div>

            <div style={{ ...cardS, marginTop: 12 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Hotely ({selected.length} vybráno)</h3>
              <select value={composeCity} onChange={e => { setComposeCity(e.target.value); setSelected([]); }}
                style={{ ...inp, marginBottom: 8 }}>
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
                {composeHotels.length === 0 && <p style={{ padding: 12, color: C.muted, fontSize: 12 }}>Žádné hotely. Nejdřív importuj.</p>}
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
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Předmět</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={inp} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>
                Text <span style={{ color: '#aaa' }}>(&#123;&#123;groupName&#125;&#125; &#123;&#123;checkIn&#125;&#125; &#123;&#123;checkOut&#125;&#125; &#123;&#123;rooms&#125;&#125; &#123;&#123;freeRatio&#125;&#125;)</span>
              </label>
              <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={14}
                style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }} />
            </div>
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 12, color: C.primary, cursor: 'pointer' }}>Náhled s doplněnými údaji</summary>
              <pre style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: C.bg, padding: 12, borderRadius: 6, marginTop: 6, color: C.text }}>{buildBody()}</pre>
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
            <button onClick={handleSend} disabled={!selected.length} style={{ ...btn(selected.length ? C.primary : C.border, selected.length ? '#fff' : C.muted), fontSize: 15, padding: '10px 24px' }}>
              ✉ Odeslat na {selected.length} hotel{selected.length===1?'':selected.length<5?'y':'ů'}
            </button>
            {sendResult && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: '#e8f5e9', borderRadius: 6, fontSize: 13, color: C.success }}>
                ✓ Otevřen emailový klient pro {sendResult.count} hotelů.
                <button onClick={() => setTab('log')} style={{ marginLeft: 12, fontSize: 12, color: C.primary, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>→ Log</button>
              </div>
            )}
            <p style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>ℹ Otevře Outlook s připraveným emailem. Přímé SMTP odesílání bude přidáno v další verzi.</p>
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
    </div>
  );
}
