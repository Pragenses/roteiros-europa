import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp
} from 'firebase/firestore';

const fmt = (ts) => {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('cs-CZ') + ' ' + d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
};

const TABS = [
  { id: 'db',      label: '🏨 Databáze hotelů' },
  { id: 'compose', label: '✉ Sestavit poptávku' },
  { id: 'log',     label: '📋 Log odeslaného' },
];

const DEFAULT_TEMPLATE = `Dear Reservations Team,

We would like to request availability and group rates for the following:

Group: {{groupName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Rooms: {{rooms}}

Please confirm availability and provide your best group rates including:
- Room rate per night (double / single supplement)
- 1 complimentary room per {{freeRatio}} paid rooms
- Breakfast included
- Group payment conditions

We look forward to your reply.

Kind regards,
Helena Čejková
Orbis Europa DMC
helena@orbiseuropa.cz`;

export default function Hotels({ navigate, colors }) {
  const C = colors;
  const [tab, setTab] = useState('db');
  const [hotels, setHotels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [search, setSearch] = useState('');
  const [cityFilter, setCityFilter] = useState('');
  const [hName, setHName] = useState('');
  const [hCity, setHCity] = useState('');
  const [hCountry, setHCountry] = useState('');
  const [hEmail, setHEmail] = useState('');
  const [hEmail2, setHEmail2] = useState('');
  const [hPhone, setHPhone] = useState('');
  const [hWebsite, setHWebsite] = useState('');
  const [hStars, setHStars] = useState('');
  const [hNotes, setHNotes] = useState('');
  const [selected, setSelected] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [rooms, setRooms] = useState('');
  const [freeRatio, setFreeRatio] = useState('20');
  const [emailBody, setEmailBody] = useState(DEFAULT_TEMPLATE);
  const [subject, setSubject] = useState('Group Accommodation Request');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);
  const [logs, setLogs] = useState([]);
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
    items.sort((a, b) => (b.sentAt?.seconds || 0) - (a.sentAt?.seconds || 0));
    setLogs(items);
    setLogsLoading(false);
  }, []);

  useEffect(() => { fetchHotels(); }, [fetchHotels]);
  useEffect(() => { if (tab === 'log') fetchLogs(); }, [tab, fetchLogs]);

  const resetForm = () => {
    setHName(''); setHCity(''); setHCountry(''); setHEmail(''); setHEmail2('');
    setHPhone(''); setHWebsite(''); setHStars(''); setHNotes('');
    setEditingId(null); setShowForm(false);
  };

  const openEdit = (h) => {
    setHName(h.name||''); setHCity(h.city||''); setHCountry(h.country||'');
    setHEmail(h.email||''); setHEmail2(h.email2||''); setHPhone(h.phone||'');
    setHWebsite(h.website||''); setHStars(h.stars||''); setHNotes(h.notes||'');
    setEditingId(h.id); setShowForm(true);
  };

  const saveHotel = async () => {
    if (!hName.trim() || !hEmail.trim()) { alert('Název a email jsou povinné.'); return; }
    const data = { name: hName.trim(), city: hCity.trim(), country: hCountry.trim(),
      email: hEmail.trim(), email2: hEmail2.trim(), phone: hPhone.trim(),
      website: hWebsite.trim(), stars: hStars, notes: hNotes.trim() };
    if (editingId) await updateDoc(doc(db, 'hotels', editingId), data);
    else await addDoc(collection(db, 'hotels'), data);
    resetForm(); fetchHotels();
  };

  const deleteHotel = async (id) => {
    if (!window.confirm('Smazat hotel?')) return;
    await deleteDoc(doc(db, 'hotels', id));
    setSelected(s => s.filter(x => x !== id));
    fetchHotels();
  };

  const buildBody = () => emailBody
    .replace(/{{groupName}}/g, groupName||'[GROUP NAME]')
    .replace(/{{checkIn}}/g, checkIn||'[CHECK-IN]')
    .replace(/{{checkOut}}/g, checkOut||'[CHECK-OUT]')
    .replace(/{{rooms}}/g, rooms||'[ROOMS]')
    .replace(/{{freeRatio}}/g, freeRatio||'20');

  const toggleSelect = (id) =>
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const handleSend = async () => {
    if (selected.length === 0) { alert('Vyber alespoň jeden hotel.'); return; }
    const body = buildBody();
    const selectedHotels = hotels.filter(h => selected.includes(h.id));
    await Promise.all(selectedHotels.map(h =>
      addDoc(collection(db, 'hotelEmailLog'), {
        hotelId: h.id, hotelName: h.name, hotelCity: h.city,
        email: h.email, subject, groupName, checkIn, checkOut, rooms,
        sentAt: serverTimestamp(), status: 'mailto',
      })
    ));
    const emails = selectedHotels.map(h => h.email).join(',');
    window.open(`mailto:${emails}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
    setSendResult({ count: selectedHotels.length });
    setSending(false);
    setTab('log'); fetchLogs();
  };

  const cities = [...new Set(hotels.map(h => h.city).filter(Boolean))].sort();
  const filtered = hotels.filter(h => {
    const q = search.toLowerCase();
    return (!q || h.name?.toLowerCase().includes(q) || h.city?.toLowerCase().includes(q) || h.email?.toLowerCase().includes(q))
      && (!cityFilter || h.city === cityFilter);
  });

  const thS = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${C.border}` };
  const tdS = { padding: '9px 12px', verticalAlign: 'top' };
  const cardS = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '1.2rem' };
  const inp = { width: '100%', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };

  return (
    <div style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto', fontFamily: 'Georgia, serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 22, color: C.primary, margin: 0, fontWeight: 600 }}>🏨 Hotels</h1>
        <p style={{ fontSize: 13, color: C.muted, margin: '4px 0 0' }}>Databáze hotelů · Hromadné poptávky · Log</p>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: '1.5rem', borderBottom: `1px solid ${C.border}` }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '8px 18px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 14, fontFamily: 'Georgia, serif', color: tab === t.id ? C.primary : C.muted,
            fontWeight: tab === t.id ? 700 : 400,
            borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent', marginBottom: -1,
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'db' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat hotel, město, email…" style={{ flex: 1, minWidth: 200, ...inp }} />
            <select value={cityFilter} onChange={e => setCityFilter(e.target.value)}
              style={{ padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', color: C.text }}>
              <option value="">Všechna města</option>
              {cities.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={() => { resetForm(); setShowForm(true); }} style={{ padding: '7px 16px', background: C.primary, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'Georgia, serif' }}>+ Přidat hotel</button>
          </div>

          {showForm && (
            <div style={{ ...cardS, marginBottom: '1.5rem' }}>
              <h3 style={{ margin: '0 0 1rem', fontSize: 16, color: C.primary }}>{editingId ? 'Upravit hotel' : 'Nový hotel'}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                {[['Název hotelu *',hName,setHName,'text'],['Hvězdičky',hStars,setHStars,'number'],['Město',hCity,setHCity,'text'],['Země',hCountry,setHCountry,'text'],['Email (hlavní) *',hEmail,setHEmail,'email'],['Email (rezervace)',hEmail2,setHEmail2,'email'],['Telefon',hPhone,setHPhone,'tel'],['Web',hWebsite,setHWebsite,'text']].map(([label,val,setter,type]) => (
                  <div key={label}>
                    <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 4 }}>{label}</label>
                    <input type={type} value={val} onChange={e => setter(e.target.value)} style={inp} />
                  </div>
                ))}
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 4 }}>Poznámky</label>
                  <textarea value={hNotes} onChange={e => setHNotes(e.target.value)} rows={2} style={{ ...inp, resize: 'vertical' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button onClick={saveHotel} style={{ padding: '7px 20px', background: C.success, color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'Georgia, serif' }}>{editingId ? '✓ Uložit změny' : '+ Přidat'}</button>
                <button onClick={resetForm} style={{ padding: '7px 16px', background: 'none', border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'Georgia, serif', color: C.muted }}>Zrušit</button>
              </div>
            </div>
          )}

          {loading ? <p style={{ color: C.muted }}>Načítám…</p> : filtered.length === 0 ? <p style={{ color: C.muted }}>Žádné hotely.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: C.bg }}>{['Hotel','Město / Země','Email','Tel.','⭐',''].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                <tbody>
                  {filtered.map(h => (
                    <tr key={h.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={tdS}><strong>{h.name}</strong>{h.notes && <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{h.notes}</div>}</td>
                      <td style={tdS}>{h.city}{h.country ? `, ${h.country}` : ''}</td>
                      <td style={tdS}><a href={`mailto:${h.email}`} style={{ color: C.primary }}>{h.email}</a>{h.email2 && <div style={{ fontSize: 11, color: C.muted }}>{h.email2}</div>}</td>
                      <td style={tdS}>{h.phone||'—'}</td>
                      <td style={tdS}>{h.stars ? '★'.repeat(Math.min(5,parseInt(h.stars))) : '—'}</td>
                      <td style={tdS}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => openEdit(h)} style={{ padding: '3px 8px', background: C.primary, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>✎</button>
                          <button onClick={() => deleteHotel(h.id)} style={{ padding: '3px 8px', background: C.danger, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{filtered.length} hotelů</p>
            </div>
          )}
        </div>
      )}

      {tab === 'compose' && (
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '1.5rem', alignItems: 'start' }}>
          <div>
            <div style={cardS}>
              <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Detaily skupiny</h3>
              {[['Název skupiny',groupName,setGroupName,'text'],['Check-in',checkIn,setCheckIn,'date'],['Check-out',checkOut,setCheckOut,'date'],['Počet pokojů (např. 14 DBL + 2 SGL)',rooms,setRooms,'text'],['1 pokoj zdarma za každých X placených',freeRatio,setFreeRatio,'number']].map(([label,val,setter,type]) => (
                <div key={label} style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>{label}</label>
                  <input type={type} value={val} onChange={e => setter(e.target.value)} style={inp} />
                </div>
              ))}
            </div>
            <div style={{ ...cardS, marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 style={{ margin: 0, fontSize: 15, color: C.primary, fontWeight: 600 }}>Vybrat hotely ({selected.length})</h3>
                <button onClick={() => setTab('db')} style={{ fontSize: 11, color: C.primary, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>spravovat DB</button>
              </div>
              <input placeholder="Filtr…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inp, marginBottom: 8, fontSize: 12 }} />
              <div style={{ maxHeight: 260, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
                {hotels.filter(h => !search || h.name?.toLowerCase().includes(search.toLowerCase()) || h.city?.toLowerCase().includes(search.toLowerCase())).map(h => (
                  <label key={h.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', cursor: 'pointer', borderBottom: `1px solid ${C.border}`, background: selected.includes(h.id) ? '#f0f7ff' : '#fff' }}>
                    <input type="checkbox" checked={selected.includes(h.id)} onChange={() => toggleSelect(h.id)} style={{ marginTop: 2 }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{h.name}</div>
                      <div style={{ fontSize: 11, color: C.muted }}>{h.city} · {h.email}</div>
                    </div>
                  </label>
                ))}
                {hotels.length === 0 && <p style={{ padding: 12, color: C.muted, fontSize: 12 }}>Přidej hotely v záložce Databáze hotelů.</p>}
              </div>
            </div>
          </div>

          <div style={cardS}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Email</h3>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Předmět</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={inp} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Text emailu</label>
              <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={16} style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }} />
            </div>
            <details style={{ marginBottom: 12 }}>
              <summary style={{ fontSize: 12, color: C.primary, cursor: 'pointer' }}>Náhled s doplněnými údaji</summary>
              <pre style={{ fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', background: C.bg, padding: 12, borderRadius: 6, marginTop: 6, color: C.text }}>{buildBody()}</pre>
            </details>
            {selected.length > 0 && (
              <div style={{ background: C.bg, borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
                <strong>Příjemci ({selected.length}):</strong>
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {hotels.filter(h => selected.includes(h.id)).map(h => <li key={h.id}>{h.name} — <span style={{ color: C.muted }}>{h.email}</span></li>)}
                </ul>
              </div>
            )}
            <button onClick={handleSend} disabled={sending||selected.length===0} style={{ padding: '10px 28px', background: selected.length>0 ? C.primary : C.border, color: selected.length>0 ? '#fff' : C.muted, border: 'none', borderRadius: 7, cursor: selected.length>0 ? 'pointer' : 'default', fontSize: 15, fontFamily: 'Georgia, serif', fontWeight: 600 }}>
              {sending ? 'Připravuji…' : `✉ Odeslat na ${selected.length} hotel${selected.length===1?'':selected.length<5?'y':'ů'}`}
            </button>
            {sendResult && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: '#e8f5e9', borderRadius: 6, fontSize: 13, color: C.success }}>
                ✓ Emailový klient otevřen pro {sendResult.count} hotelů. Záznam uložen v logu.
                <br /><button onClick={() => setTab('log')} style={{ marginTop: 6, fontSize: 12, color: C.primary, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>→ Zobrazit log</button>
              </div>
            )}
            <p style={{ fontSize: 11, color: C.muted, marginTop: 12 }}>ℹ Otevře Outlook/Gmail s připravenými emaily. Automatické SMTP odesílání bude přidáno v další verzi.</p>
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0, fontSize: 16, color: C.primary }}>Historie odeslaných poptávek</h3>
            <button onClick={fetchLogs} style={{ fontSize: 12, color: C.primary, background: 'none', border: `1px solid ${C.border}`, borderRadius: 5, padding: '5px 12px', cursor: 'pointer', fontFamily: 'Georgia, serif' }}>↻ Obnovit</button>
          </div>
          {logsLoading ? <p style={{ color: C.muted }}>Načítám…</p> : logs.length===0 ? <p style={{ color: C.muted }}>Zatím nebyla odeslána žádná poptávka.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: C.bg }}>{['Datum','Hotel','Město','Email','Skupina','Check-in','Check-out','Předmět'].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
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
                      <td style={tdS}>{l.subject||'—'}</td>
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
