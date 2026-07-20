import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { translateToEnglish } from '../lib/ai';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// TLD deliberately restricted to lowercase letters only: when busCompany entries are pasted with
// no separator at all between them (e.g. "...info@busCompany.hrBusCompany Next Name – info@..."), an
// unbounded TLD would swallow the start of the next busCompany's name. Real TLDs are lowercase.
const GLOBAL_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,10}/g;
const SAME_LINE_SEP_TRIM_RE = /[:–—-]\s*$/;

function parseSimple(text) {
  // If the pasted text has no line breaks between busCompany entries at all, force a break
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
];

const DEFAULT_TEMPLATE = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:650px">
<p>Dear Sir or Madam,</p>
<p>We are a Czech DMC specializing in group travel across Europe (Tour Pragenses / Orbis Europa DMC) and we would like to request a quotation for coach transport for the following group:</p>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">GROUP DETAILS:</span></p>
<ul>
<li><b>Group Name:</b> {{groupName}}</li>
<li><b>Travel Dates:</b> {{checkIn}} – {{checkOut}}</li>
<li><b>Number of Passengers:</b> approximately 30–35 pax + 1 driver + 1 guide</li>
</ul>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">PROGRAM / ITINERARY:</span></p>
<p>{{program}}</p>

<p><span style="background-color:#FFD700;font-weight:bold;padding:2px 6px">WE KINDLY REQUEST:</span></p>
<ul>
<li>Price per day / per km (please specify)</li>
<li>Type and capacity of the vehicle</li>
<li>Availability for the above dates</li>
<li>Cancellation and payment conditions</li>
</ul>

<p>We look forward to your prompt reply.</p>
<p>Best regards,<br/>Helena Dlasková<br/>Managing Director<br/>Tour Pragenses / Orbis Europa DMC<br/>grupos@tour-pragenses.com</p>
</div>`;

export default function Bus({ navigate, colors, navParams }) {
  const C = colors;
  const prefill = navParams?.prefill || null;
  const routeList = prefill?.routeList || null;
  const [tab, setTab] = useState(prefill ? 'compose' : 'import');
  const [activeCityPrefill, setActiveCityPrefill] = useState(null);

  const [busCompanies, setBusCompanies]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [routeFilter, setCityFilter] = useState('');
  const [editRow, setEditRow]     = useState(null);
  const [showAdd, setShowAdd]     = useState(false);
  const [newBusCompany, setNewBusCompany]   = useState({ city: '', name: '', email: '' });

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
  const [checkIn, setCheckIn]         = useState(prefill?.startDate || '');
  const [checkOut, setCheckOut]       = useState(prefill?.endDate || '');
  const [freeRatio, setFreeRatio]     = useState('20');
  const [programText, setProgramText] = useState(prefill?.programText || '');
  const [translating, setTranslating] = useState(false);

  const handleTranslate = async () => {
    console.log('handleTranslate called, programText length:', programText.length, 'first 100:', programText.slice(0, 100));
    if (!programText.trim()) { alert('Není k dispozici žádný program k překladu. Přijdi sem přes tlačítko "Poslat poptávku bus" z nabídky.'); return; }
    setTranslating(true);
    try {
      const translated = await translateToEnglish(programText);
      console.log('translated length:', translated.length, 'first 100:', translated.slice(0, 100));
      if (!translated) throw new Error('Překlad vrátil prázdný výsledek');
      setProgramText(translated);
    } catch (err) {
      console.error('Translation error:', err);
      alert('Překlad selhal: ' + (err.message || JSON.stringify(err)));
    }
    setTranslating(false);
  };
  const [emailBody, setEmailBody]     = useState(DEFAULT_TEMPLATE);
  const [editMode, setEditMode]       = useState('visual'); // 'visual' or 'code'

  // Convert HTML email body to plain editable text (strip tags, preserve structure)
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

  // Convert plain text back to HTML for sending
  const plainToHtml = (text) => {
    const lines = text.split('\n');
    return '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:650px">' +
      lines.map(l => {
        const line = l.trim();
        if (!line) return '<p style="margin:6px 0">&nbsp;</p>';
        const isDay = /^(\d{1,2}[°º]\s*DIA\s*[–\u2013-]|DAY\s+\d{1,2}\s*[–\u2013:-]|\d{1,2}(st|nd|rd|th)?\s*DAY\s*[–\u2013:-]|\d{1,2}\s+[A-Za-zÀ-ÿ\xC0-\xFF]{3,9}\s+\d{4}\s*[–\u2013:-]|[A-Za-zÀ-ÿ]{3,9}\s+\d{1,2}[,\s]+\d{4}\s*[–\u2013:-]|\d{1,2}\s+[A-Za-zÀ-ÿ\xC0-\xFF]{3}\s+\([A-Za-zÀ-ÿ\xC0-\xFF]{3}\)\s*-|📅)/i.test(line);
        if (isDay) return '<p style="margin:8px 0 2px 0"><strong style="background-color:#FFD700;padding:2px 6px">' + line + '</strong></p>';
        if (line.startsWith('• ')) return '<li>' + line.slice(2) + '</li>';
        return '<p style="margin:4px 0">' + line + '</p>';
      }).filter(Boolean).join('') +
    '</div>';
  };
  const [subject, setSubject]         = useState('Group Transport Inquiry');
  const [senderFrom, setSenderFrom]   = useState('grupos');
  React.useEffect(() => {
    let s = 'Group Transport Inquiry';
    if (groupName) s += ' / ' + groupName;
    if (composeCity) s += ' / ' + composeCity;
    setSubject(s);
  }, [groupName, composeCity]);

  React.useEffect(() => {
    if (navParams?.prefill?.programText) {
      setProgramText(navParams.prefill.programText);
    }
  }, [navParams]);
  const [sendResult, setSendResult]   = useState(null);
  const [sending, setSending]           = useState(false);
  const [sendProgress, setSendProgress] = useState('');
  const [extraEmail, setExtraEmail]     = useState('');

  const [logs, setLogs]               = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const fetchBus = useCallback(async () => {
    setLoading(true);
    const snap = await getDocs(collection(db, 'busCompanies'));
    setBusCompanies(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, []);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    const snap = await getDocs(collection(db, 'busEmailLog'));
    const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    items.sort((a, b) => (b.sentAt?.seconds||0) - (a.sentAt?.seconds||0));
    setLogs(items);
    setLogsLoading(false);
  }, []);

  useEffect(() => { fetchBus(); }, [fetchBus]);
  useEffect(() => { if (tab === 'log') fetchLogs(); }, [tab, fetchLogs]);

  const handleParse = () => {
    const city = importCity.trim().toUpperCase();
    const raw = parseSimple(importText);
    setParsed(raw.map(h => ({ ...h, city: city || h.city || '?' })));
  };

  const handleImport = async () => {
    setImporting(true);
    const existingEmails = new Set(busCompanies.map(h => h.email?.toLowerCase()));
    let added = 0, skipped = 0;
    for (const h of parsed) {
      if (existingEmails.has(h.email.toLowerCase())) { skipped++; continue; }
      await addDoc(collection(db, 'busCompanies'), { city: h.city, name: h.name, email: h.email });
      added++;
    }
    setImportDone({ added, skipped });
    setImporting(false);
    setImportText(''); setParsed([]);
    fetchBus();
  };

  const deleteBusCompany = async (id) => {
    if (!window.confirm('Smazat busCompany?')) return;
    await deleteDoc(doc(db, 'busCompanies', id));
    setSelected(s => s.filter(x => x !== id));
    fetchBus();
  };

  const saveEdit = async () => {
    await updateDoc(doc(db, 'busCompanies', editRow.id), { city: editRow.city, name: editRow.name, email: editRow.email });
    setEditRow(null);
    fetchBus();
  };

  const addBusCompany = async () => {
    if (!newBusCompany.email.trim()) { alert('Email je povinný.'); return; }
    await addDoc(collection(db, 'busCompanies'), { city: newBusCompany.city.trim(), name: newBusCompany.name.trim(), email: newBusCompany.email.trim().toLowerCase() });
    setNewBusCompany({ city: '', name: '', email: '' });
    setShowAdd(false);
    fetchBus();
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
      : (emailBody.startsWith('<PLAIN>') ? emailBody.slice(7, -8) : null);
    const base = currentText ? plainToHtml(currentText) : (emailBody.startsWith('<PLAIN>') ? plainToHtml(emailBody.slice(7, -8)) : emailBody);
    return base
    .replace(/{{groupName}}/g, groupName||'[GROUP NAME]')
    .replace(/{{checkIn}}/g, fmtDateEU(checkIn)||'[DATE FROM]')
    .replace(/{{checkOut}}/g, fmtDateEU(checkOut)||'[DATE TO]')
    .replace(/{{freeRatio}}/g, freeRatio||'20')
    .replace(/{{program}}/g, programText
      ? programText.split('\n').filter(l => l.trim()).map(l => {
          const line = l.trim();
          const isDay = /^(\d{1,2}[°º]\s*DIA\s*[\u2013–-]|DAY\s+\d{1,2}\s*[\u2013–:-]|\d{1,2}(st|nd|rd|th)?\s*DAY\s*[\u2013–:-]|\d{1,2}\s+[A-Za-zÀ-ÿ\xC0-\xFF]{3,9}\s+\d{4}\s*[\u2013–:-]|[A-Za-zÀ-ÿ]{3,9}\s+\d{1,2}[,\s]+\d{4}\s*[\u2013–:-]|\d{1,2}\s+[A-Za-zÀ-ÿ\xC0-\xFF]{3}\s+\([A-Za-zÀ-ÿ\xC0-\xFF]{3}\)\s*-|📅)/i.test(line);
          return isDay
            ? `<p style="margin:8px 0 2px 0"><strong style="background-color:#FFD700;padding:2px 6px">${line}</strong></p>`
            : `<p style="margin:2px 0 4px 0">${line}</p>`;
        }).join('')
      : '[PROGRAM TO BE ADDED]');
  };

  const toggleSelect = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const handleSend = async () => {
    if (!selected.length) { alert('Vyber alespoň jeden busCompany.'); return; }
    setSending(true);
    const body = buildBody();
    const sel = busCompanies.filter(h => selected.includes(h.id));
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
            await addDoc(collection(db, 'busEmailLog'), {
              busCompanyId: h.id, busCompanyName: h.name||h.email, busCompanyCity: h.city,
              email: h.email, subject, groupName, checkIn, checkOut,
              sentAt: serverTimestamp(), status: 'sent',
            });
            sent++;
          } else { failed++; }
        }
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

  const cities = [...new Set(busCompanies.map(h => h.city).filter(Boolean))].sort();
  const dbFiltered = busCompanies.filter(h => {
    const q = search.toLowerCase();
    return (!q || h.name?.toLowerCase().includes(q) || h.city?.toLowerCase().includes(q) || h.email?.toLowerCase().includes(q))
      && (!routeFilter || h.city === routeFilter);
  });
  const composeBus = composeCity ? busCompanies.filter(h => h.city === composeCity) : busCompanies;

  const thS = { padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${C.border}` };
  const tdS = { padding: '8px 12px', verticalAlign: 'middle', fontSize: 13 };
  const cardS = { background: C.white, border: `1px solid ${C.border}`, borderRadius: 10, padding: '1.2rem' };
  const inp = (extra={}) => ({ width: '100%', padding: '6px 10px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box', ...extra });
  const btn = (bg, fg='#fff') => ({ padding: '7px 18px', background: bg, color: fg, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontFamily: 'Georgia, serif', fontWeight: 600 });
  const smallBtn = (bg) => ({ padding: '3px 9px', background: bg, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 });

  return (
    <div style={{ padding: '2rem', maxWidth: 1100, margin: '0 auto', fontFamily: 'Georgia, serif' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 22, color: C.primary, margin: 0, fontWeight: 600 }}>🏨 Bus</h1>
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
              <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>Trasa</label>
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
                <h3 style={{ margin: '0 0 10px', fontSize: 15, color: C.primary, fontWeight: 600 }}>Rozpoznáno: {parsed.length} busCompanyů</h3>
                <div style={{ maxHeight: 300, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 12 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead><tr style={{ background: C.bg }}>{['Trasa','Název','Email'].map(h=><th key={h} style={thS}>{h}</th>)}</tr></thead>
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
                  {importing ? 'Importuji…' : `✓ Importovat ${parsed.length} busCompanyů`}
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
            <select value={routeFilter} onChange={e => setCityFilter(e.target.value)}
              style={{ padding: '7px 12px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif' }}>
              <option value="">Všechna města ({busCompanies.length})</option>
              {cities.map(c => <option key={c} value={c}>{c} ({busCompanies.filter(h=>h.city===c).length})</option>)}
            </select>
            <button onClick={() => { setShowAdd(true); setNewBusCompany({ city: routeFilter, name: '', email: '' }); }} style={btn(C.primary)}>+ Přidat ručně</button>
            {routeFilter && (
              <button onClick={async () => {
                if (!window.confirm('Smazat všechny busCompanyy města ' + routeFilter + '? (' + busCompanies.filter(h => h.city === routeFilter).length + ' busCompanyů)')) return;
                if (!window.confirm('Jsi si jistá? Tato akce je nevratná.')) return;
                const toDelete = busCompanies.filter(h => h.city === routeFilter);
                for (const h of toDelete) await deleteDoc(doc(db, 'busCompanies', h.id));
                setCityFilter('');
                fetchBus();
              }} style={btn(C.danger)}>🗑 Smazat město</button>
            )}
          </div>

          {showAdd && (
            <div style={{ ...cardS, marginBottom: '1rem', background: '#fffbf0', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              {[['Trasa', 'route'], ['Název', 'name'], ['Email *', 'email']].map(([label, key]) => (
                <div key={key} style={{ flex: 1, minWidth: 150 }}>
                  <label style={{ fontSize: 11, color: C.muted, display: 'block', marginBottom: 3 }}>{label}</label>
                  <input value={newBusCompany[key]} onChange={e => setNewBusCompany({...newBusCompany, [key]: e.target.value})} style={inp()} />
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={addBusCompany} style={btn(C.success)}>✓ Přidat</button>
                <button onClick={() => setShowAdd(false)} style={btn(C.muted)}>✕</button>
              </div>
            </div>
          )}

          {loading ? <p style={{ color: C.muted }}>Načítám…</p> : dbFiltered.length === 0 ? (
            <p style={{ color: C.muted }}>Žádné busCompanyy. Použij Import nebo Přidat ručně.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: C.bg }}>
                  {['Trasa','Název','Email',''].map(h=><th key={h} style={thS}>{h}</th>)}
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
                            <button onClick={() => deleteBusCompany(h.id)} style={smallBtn(C.danger)}>✕</button>
                          </div>
                        </td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>{dbFiltered.length} busCompanyů</p>
            </div>
          )}
        </div>
      )}

      {/* ── CITY LIST Z OFFER ── */}
      {tab === 'compose' && routeList && routeList.length > 0 && !activeCityPrefill && (
        <div style={cardS}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, color: C.primary, fontWeight: 600 }}>
            Města z itineráře — vyber město pro poptávku
          </h3>
          <p style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>Skupina: <strong>{prefillGroupName}</strong></p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ background: C.bg }}>
              {['Trasa','Check-in','Check-out',''].map(h => <th key={h} style={thS}>{h}</th>)}
            </tr></thead>
            <tbody>
              {routeList.map((c, i) => (
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
              {routeList && activeCityPrefill && (
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
              <h3 style={{ margin: '0 0 10px', fontSize: 15, color: C.primary, fontWeight: 600 }}>BusCompanyy ({selected.length} vybráno)</h3>
              <select value={composeCity} onChange={e => { setComposeCity(e.target.value); setSelected([]); }} style={{ ...inp(), marginBottom: 8 }}>
                <option value="">Všechna města</option>
                {cities.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={{ maxHeight: 280, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: 6 }}>
                {composeBus.map(h => (
                  <label key={h.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', cursor: 'pointer', borderBottom: `1px solid ${C.border}`, background: selected.includes(h.id) ? '#f0f7ff' : '#fff' }}>
                    <input type="checkbox" checked={selected.includes(h.id)} onChange={() => toggleSelect(h.id)} style={{ marginTop: 2 }} />
                    <div>
                      {h.name && <div style={{ fontSize: 12, fontWeight: 600 }}>{h.name}</div>}
                      <div style={{ fontSize: 11, color: C.muted }}>{h.city} · {h.email}</div>
                    </div>
                  </label>
                ))}
                {composeBus.length === 0 && <p style={{ padding: 12, color: C.muted, fontSize: 12 }}>Žádné busCompanyy.</p>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button onClick={() => setSelected(composeBus.map(h=>h.id))} style={{ fontSize: 11, color: C.primary, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>Vybrat vše</button>
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
              {programText && (
                <div style={{ background: '#f0f7ff', borderRadius: 6, padding: '8px 12px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 12, color: C.primary }}>Program je v původním jazyce.</span>
                  <button onClick={handleTranslate} disabled={translating}
                    style={{ padding: '5px 14px', background: translating ? C.border : C.primary, color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: translating ? 'default' : 'pointer', fontWeight: 500 }}>
                    {translating ? '⏳ Překládám…' : '🌐 Přeložit do angličtiny'}
                  </button>
                </div>
              )}
              {!programText && (
                <div style={{ background: '#fff3e0', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 12, color: '#854f0b' }}>
                  ⚠ Program není k dispozici — přijď sem přes tlačítko "🚌 Poslat poptávku bus" z nabídky
                </div>
              )}
              {editMode === 'visual' ? (
                <textarea
                  ref={visualEditorRef}
                  key={emailBody.slice(0, 50) + programText.slice(0, 20)}
                  defaultValue={htmlToPlain(emailBody).replace('{{program}}', programText || '[PROGRAM]').replace('{{groupName}}', groupName || '').replace('{{checkIn}}', checkIn || '').replace('{{checkOut}}', checkOut || '')}
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
                  {busCompanies.filter(h=>selected.includes(h.id)).map(h => (
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
              {sending ? sendProgress || 'Připravuji...' : `✉ Odeslat na ${selected.length} dopravce`}
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
                  {['Datum','BusCompany','Trasa','Email','Skupina','Check-in','Check-out'].map(h=><th key={h} style={thS}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {logs.map(l => (
                    <tr key={l.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={tdS}>{fmt(l.sentAt)}</td>
                      <td style={tdS}><strong>{l.busCompanyName}</strong></td>
                      <td style={tdS}>{l.busCompanyCity||'—'}</td>
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
