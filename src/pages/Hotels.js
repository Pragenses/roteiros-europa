import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
];

const DEFAULT_TEMPLATE = `<p>Dear Sir or Madam,</p>
<p>I am reaching out to inquire about the best possible rates and options for accommodating a group booking as outlined below:</p>
<p><b>GROUP DETAILS:</b><br>
<b>- Group Name: {{groupName}}</b><br>
<b>- Travel Dates: {{checkIn}} – {{checkOut}}</b><br>
<b>- Accommodation Needs: 18 rooms in total ( 16 twin/dbl + 2 sngl )</b><br>
<b>- Room Breakdown: twin/dbl rooms and single rooms. Our groups need at least 50% of twin rooms with separated beds.</b><br>
<b>- If available, please also provide pricing for triple rooms or double rooms with an extra bed as an alternative.</b></p>
<p>SPECIAL REQUESTS:<br>
- Complimentary Room: 1 free guest per {{freeRatio}} paid rooms<br>
- Porterage Service: Please inform us if porterage is available, along with the associated pricing.<br>
- Meal Plan Options:<br>
&nbsp;&nbsp;- BB: Please provide the rate.<br>
&nbsp;&nbsp;- HB: if offered ( not requested in this moment )</p>
<p>BOOKING CONDITIONS:<br>
- Cancellation policy (including free cancellation terms and partial cancellation conditions)<br>
- Deposit requirements and payment schedule</p>
<p>Additionally, we would appreciate if you could hold this offer until the date ............</p>
<p>Thank you very much for your assistance. I look forward to your proposal and any further details you may require.</p>
<p>Best regards,<br>
--<br>
Helena Dlasková, sales<br>
TOUR PRAGENSES, PRAGENSES s.r.o.<br>
Lipnická 688, Praha 9 - Kyje, Czech Republic<br>
Tlf - whatsapp : +420 777 079 997<br>
VAT: CZ284 45 961</p>`;

export default function Hotels({ navigate, colors, navParams }) {
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

  const [selected, setSelected]       = useState([]);
  const [composeCity, setComposeCity] = useState('');
  const [groupName, setGroupName]     = useState(prefill?.groupName || '');
  const [prefillGroupName] = useState(prefill?.groupName || '');
  const [checkIn, setCheckIn]         = useState('');
  const [checkOut, setCheckOut]       = useState('');
  const [freeRatio, setFreeRatio]     = useState('20');
  const [emailBody, setEmailBody]     = useState(DEFAULT_TEMPLATE);
  const [subject, setSubject]         = useState('Group Accommodation Request');
  React.useEffect(() => {
    let s = 'Group Accommodation Request';
    if (groupName) s += ' / ' + groupName;
    if (composeCity) s += ' / ' + composeCity;
    setSubject(s);
  }, [groupName, composeCity]);
  const [sendResult, setSendResult]   = useState(null);
  const [sending, setSending]           = useState(false);
  const [sendStatus, setSendStatus]     = useState('');

  const [logs, setLogs]               = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

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

  const buildBody = () => emailBody
    .replace(/{{groupName}}/g, groupName||'[GROUP NAME]')
    .replace(/{{checkIn}}/g, checkIn||'[CHECK-IN]')
    .replace(/{{checkOut}}/g, checkOut||'[CHECK-OUT]')
    .replace(/{{freeRatio}}/g, freeRatio||'20');

  const toggleSelect = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const handleSend = async () => {
    if (!selected.length) { alert('Vyber alespoň jeden hotel.'); return; }
    setSending(true);
    setSendStatus('Odesílám...');
    const body = buildBody();
    const sel = hotels.filter(h => selected.includes(h.id));
    setSendResult(null);
    let sent = 0, failed = 0;
    for (const h of sel) {
      try {
        const res = await fetch('https://tour-pragenses.com/mailer.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: h.email, subject, body }),
        });
        const data = await res.json();
        if (data.ok) {
          await addDoc(collection(db, 'hotelEmailLog'), {
            hotelId: h.id, hotelName: h.name||h.email, hotelCity: h.city,
            email: h.email, subject, groupName, checkIn, checkOut,
            sentAt: serverTimestamp(), status: 'sent',
          });
          sent++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
    }
    setSendResult({ sent, failed });
    setGroupName(''); setCheckIn(''); setCheckOut('');
    setSelected([]);
    setTab('log'); fetchLogs();
  };

  const cities = [...new Set(hotels.map(h => h.city).filter(Boolean))].sort();
  const dbFiltered = hotels.filter(h => {
    const q = search.toLowerCase();
    return (!q || h.name?.toLowerCase().includes(q) || h.city?.toLowerCase().includes(q) || h.email?.toLowerCase().includes(q))
      && (!cityFilter || h.city === cityFilter);
  });
  const composeHotels = composeCity ? hotels.filter(h => h.city === composeCity) : hotels;

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
        <p style={{ fontSize: 13, color: C.muted, margin: '4px 0 0' }}>Import · Databáze · Poptávky · Log</p>
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
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Předmět</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={inp()} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Text emailu</label>
              <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={16} style={{ ...inp(), resize: 'vertical', lineHeight: 1.6 }} />
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
            <button onClick={handleSend} disabled={!selected.length} style={{ ...btn(selected.length ? C.primary : C.border, selected.length ? '#fff' : C.muted), fontSize: 15, padding: '10px 24px' }}>
              ✉ Odeslat na {selected.length} hotel{selected.length===1?'':selected.length<5?'y':'ů'}
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
