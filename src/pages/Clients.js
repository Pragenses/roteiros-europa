import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc } from 'firebase/firestore';
import { parseClientText, aiFillClientFree } from '../lib/ai';
import { CURRENCIES } from '../lib/offerCalc';

const CLIENT_COLORS = ['#E6F1FB','#FAEEDA','#EAF3DE','#EEEDFE','#FCEBEB','#F1EFE8'];
const CLIENT_TEXT = ['#0C447C','#633806','#27500A','#534AB7','#791F1F','#444441'];

export default function Clients({ navigate, colors }) {
  const [clients, setClients] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [paymentFormFor, setPaymentFormFor] = useState(null);
  const [newPayment, setNewPayment] = useState({ date: '', amount: '', currency: 'EUR', note: '' });
  const [showArchived, setShowArchived] = useState(false);
  const [contacts, setContacts] = useState([{ name: '', role: '', email: '', phone: '' }]);
  const [clientColor, setClientColor] = useState('#FAEEDA');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiName, setAiName] = useState('');
  const [parseLoading, setParseLoading] = useState(false);
  const [parseText, setParseText] = useState('');
  const formRef = useRef(null);

  const fetchData = useCallback(async () => {
    const [snap, ordSnap] = await Promise.all([
      getDocs(collection(db, 'clients')),
      getDocs(collection(db, 'orders'))
    ]);
    setClients(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    setOrders(ordSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const addContact = () => setContacts(c => [...c, { name: '', role: '', email: '', phone: '' }]);
  const removeContact = (i) => setContacts(c => c.filter((_, idx) => idx !== i));
  const updateContact = (i, field, val) => setContacts(c => c.map((ct, idx) => idx === i ? { ...ct, [field]: val } : ct));

  const applyParsed = (parsed) => {
    const f = formRef.current; if (!f) return;
    if (parsed.name) f.cname.value = parsed.name;
    if (parsed.country) f.country.value = parsed.country;
    if (parsed.state) f.state.value = parsed.state;
    if (parsed.notes) f.notes.value = parsed.notes;
    if (parsed.billingCompany) f.billingCompany.value = parsed.billingCompany;
    if (parsed.billingAddress) f.billingAddress.value = parsed.billingAddress;
    if (parsed.billingCity) f.billingCity.value = parsed.billingCity;
    if (parsed.billingZip) f.billingZip.value = parsed.billingZip;
    if (parsed.billingCountry) f.billingCountry.value = parsed.billingCountry;
    if (parsed.billingVat) f.billingVat.value = parsed.billingVat;
    if (parsed.billingIco) f.billingIco.value = parsed.billingIco;
    if (parsed.billingEmail) f.billingEmail.value = parsed.billingEmail;
    if (Array.isArray(parsed.contacts) && parsed.contacts.length > 0) {
      const valid = parsed.contacts.filter(c => c.name);
      if (valid.length > 0) setContacts(valid.map(c => ({ name: c.name || '', role: c.role || '', email: c.email || '', phone: c.phone || '' })));
    }
  };

  const handleAiFill = async () => {
    const name = formRef.current?.cname?.value || aiName;
    if (!name) { alert('Please enter an agency name first.'); return; }
    setAiLoading(true);
    try {
      const parsed = await aiFillClientFree(name);
      applyParsed(parsed);
    } catch (err) {
      console.error(err);
      alert('Could not find data automatically (' + err.message + '). Please use "Find" or "Parse from text".');
    }
    setAiLoading(false);
  };

  const handleParseText = async () => {
    if (!parseText.trim()) { alert('Paste some text first.'); return; }
    setParseLoading(true);
    try {
      const parsed = await parseClientText(parseText);
      applyParsed(parsed);
    } catch (err) {
      console.error(err);
      alert('Could not parse this text. Please fill in manually.');
    }
    setParseLoading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const f = formRef.current;
    const data = {
      name: f.cname.value, country: f.country.value, state: f.state.value, notes: f.notes.value,
      contacts, color: clientColor,
      billing: {
        company: f.billingCompany.value, address: f.billingAddress.value,
        city: f.billingCity.value, zip: f.billingZip.value,
        country: f.billingCountry.value, vat: f.billingVat.value,
        ico: f.billingIco.value, email: f.billingEmail.value,
        currency: f.billingCurrency.value,
      }
    };
    if (editingId) {
      await updateDoc(doc(db, 'clients', editingId), data);
    } else {
      await addDoc(collection(db, 'clients'), { ...data, createdAt: new Date().toISOString() });
    }
    setShowForm(false); setEditingId(null);
    setContacts([{ name: '', role: '', email: '', phone: '' }]);
    setParseText('');
    fetchData();
  };

  const handleEdit = (c) => {
    setEditingId(c.id);
    setContacts(c.contacts?.length ? c.contacts : [{ name: '', role: '', email: '', phone: '' }]);
    setClientColor(c.color || '#FAEEDA');
    setShowForm(true);
    setParseText('');
    setTimeout(() => {
      const f = formRef.current; if (!f) return;
      f.cname.value = c.name || ''; f.country.value = c.country || 'Brazil';
      f.state.value = c.state || '';
      f.notes.value = c.notes || '';
      f.billingCompany.value = c.billing?.company || '';
      f.billingAddress.value = c.billing?.address || '';
      f.billingCity.value = c.billing?.city || '';
      f.billingZip.value = c.billing?.zip || '';
      f.billingCountry.value = c.billing?.country || '';
      f.billingVat.value = c.billing?.vat || '';
      f.billingIco.value = c.billing?.ico || '';
      f.billingEmail.value = c.billing?.email || '';
      f.billingCurrency.value = c.billing?.currency || 'EUR';
    }, 50);
  };

  const handleArchive = async (id) => {
    if (window.confirm('Přesunout tohoto klienta do archivu? (dá se kdykoliv vrátit zpět)')) {
      await updateDoc(doc(db, 'clients', id), { archived: true });
      fetchData();
    }
  };

  const handleRestore = async (id) => {
    await updateDoc(doc(db, 'clients', id), { archived: false });
    fetchData();
  };

  const handlePermanentDelete = async (client) => {
    const typed = window.prompt(`Tato akce je NEVRATNÁ a smaže i všechny platby. Pro potvrzení napiš přesný název klienta:\n\n${client.name}`);
    if (typed === null) return;
    if (typed.trim() !== client.name) { alert('Název nesouhlasí, smazání zrušeno.'); return; }
    await deleteDoc(doc(db, 'clients', client.id));
    fetchData();
  };

  const toggleExpand = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }));

  const addPayment = async (client) => {
    if (!newPayment.amount || isNaN(parseFloat(newPayment.amount))) { alert('Zadej platnou částku.'); return; }
    const entry = {
      id: Date.now() + Math.random(),
      date: newPayment.date || new Date().toISOString().slice(0, 10),
      amount: parseFloat(newPayment.amount),
      currency: newPayment.currency,
      note: newPayment.note.trim(),
    };
    const updatedPayments = [...(client.payments || []), entry];
    await updateDoc(doc(db, 'clients', client.id), { payments: updatedPayments });
    setNewPayment({ date: '', amount: '', currency: newPayment.currency, note: '' });
    setPaymentFormFor(null);
    fetchData();
  };

  const deletePayment = async (client, paymentId) => {
    if (!window.confirm('Smazat tento záznam platby?')) return;
    const updatedPayments = (client.payments || []).filter(p => p.id !== paymentId);
    await updateDoc(doc(db, 'clients', client.id), { payments: updatedPayments });
    fetchData();
  };

  const sumByCurrency = (payments) => {
    const sums = {};
    (payments || []).forEach(p => { sums[p.currency] = (sums[p.currency] || 0) + p.amount; });
    return sums;
  };

  const getOrdersFor = (client) => orders
    .filter(o => o.clientId === client.id || o.clientName === client.name)
    .sort((a, b) => new Date(a.startDate || 0) - new Date(b.startDate || 0));

  const iStyle = { width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const lbl = (t) => <label style={{ fontSize: 12, color: colors.muted, display: 'block', marginBottom: 4 }}>{t}</label>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Clients</h1>
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>Brazilian tour operators</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowArchived(a => !a)}
            style={{ padding: '9px 16px', background: showArchived ? colors.primary : 'transparent', color: showArchived ? colors.white : colors.muted, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            📦 Archiv {clients.filter(c => c.archived).length ? `(${clients.filter(c => c.archived).length})` : ''}
          </button>
          <button onClick={() => { setShowForm(true); setEditingId(null); setContacts([{ name: '', role: '', email: '', phone: '' }]); setParseText(''); setTimeout(() => formRef.current?.reset(), 50); }}
            style={{ padding: '9px 18px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            + New client
          </button>
        </div>
      </div>

      {showForm && (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: '1rem' }}>{editingId ? 'Edit client' : 'New client'}</div>

          <div style={{ background: '#f0ede8', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1rem', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: colors.primary, fontWeight: 500 }}>✨ AI search (free)</div>
            <input type="text" placeholder="Type agency name and click search..." value={aiName} onChange={e => setAiName(e.target.value)}
              style={{ flex: 1, minWidth: 200, padding: '7px 10px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif' }} />
            <button type="button" onClick={handleAiFill} disabled={aiLoading}
              style={{ padding: '7px 16px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: aiLoading ? 0.6 : 1 }}>
              {aiLoading ? 'Searching...' : '✨ Fill automatically'}
            </button>
          </div>

          <div style={{ background: '#f0ede8', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: 13, color: colors.primary, fontWeight: 500, marginBottom: 6 }}>📋 Paste company info to auto-fill</div>
            <textarea value={parseText} onChange={e => setParseText(e.target.value)} rows={3}
              placeholder="Paste any text here — website content, email signature, CNPJ registry entry — and AI will extract the fields below."
              style={{ width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 }} />
            <button type="button" onClick={handleParseText} disabled={parseLoading}
              style={{ padding: '7px 16px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: parseLoading ? 0.6 : 1 }}>
              {parseLoading ? 'Parsing...' : '📋 Parse into fields'}
            </button>
          </div>

          <form ref={formRef} onSubmit={handleSubmit}>
            <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Basic info</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>{lbl('Agency name *')}<input name="cname" type="text" placeholder="e.g. UNEWORLD" required style={iStyle} /></div>
              <div>
                {lbl('Cor do cliente (para lista de ofertas)')}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                  {['#FAEEDA','#FFD699','#FFE0B2','#E6F1FB','#EAF3DE','#FCEBEB','#FCE4EC','#E0F7FA','#FFF8E7','#F3E5F5','#FFF9C4','#D4EDDA',
                    '#F4A9A8','#F6C453','#7FB3D5','#A9DFBF','#D7A9E3','#85C1E9','#F8C471','#82E0AA','#BB8FCE','#F1948A','#76D7C4','#F0B27A','#C39BD3','#7DCEA0'].map(c => (
                    <div key={c} onClick={() => setClientColor(c)}
                      style={{ width: 28, height: 28, borderRadius: 6, background: c, cursor: 'pointer', border: clientColor === c ? '3px solid #333' : '2px solid #ccc' }} />
                  ))}
                </div>
              </div>
              <div>{lbl('Country')}<input name="country" type="text" defaultValue="Brazil" style={iStyle} /></div>
              <div>{lbl('State / Province (Estado)')}<input name="state" type="text" placeholder="e.g. SP, RJ" style={iStyle} /></div>
              <div style={{ gridColumn: '1 / -1' }}>{lbl('Notes')}<textarea name="notes" rows={2} style={{ ...iStyle, resize: 'vertical' }} /></div>
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, borderTop: `2px solid ${colors.border}`, paddingTop: 16 }}>
              Contact persons
            </div>
            {contacts.map((ct, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 32px', gap: 8, marginBottom: 8 }}>
                <div>{i === 0 && lbl('Name')}<input type="text" value={ct.name} onChange={e => updateContact(i, 'name', e.target.value)} placeholder="Ana Silva" style={iStyle} /></div>
                <div>{i === 0 && lbl('Role / department')}<input type="text" value={ct.role} onChange={e => updateContact(i, 'role', e.target.value)} placeholder="Groups" style={iStyle} /></div>
                <div>{i === 0 && lbl('Email')}<input type="email" value={ct.email} onChange={e => updateContact(i, 'email', e.target.value)} placeholder="ana@agency.com" style={iStyle} /></div>
                <div>{i === 0 && lbl('Phone / WhatsApp')}<input type="text" value={ct.phone} onChange={e => updateContact(i, 'phone', e.target.value)} placeholder="+55 11 9999" style={iStyle} /></div>
                <div style={{ display: 'flex', alignItems: i === 0 ? 'flex-end' : 'center' }}>
                  {contacts.length > 1 && <button type="button" onClick={() => removeContact(i)} style={{ padding: '7px 8px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', color: '#7f1d1d', fontSize: 12 }}>✕</button>}
                </div>
              </div>
            ))}
            <button type="button" onClick={addContact} style={{ padding: '6px 14px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit', marginBottom: 16 }}>
              + Add contact
            </button>

            <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, borderTop: `2px solid ${colors.border}`, paddingTop: 16 }}>
              Billing details
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div>{lbl('Company name (billing)')}<input name="billingCompany" type="text" placeholder="Uneworld Viagens Ltda" style={iStyle} /></div>
              <div>{lbl('VAT number')}<input name="billingVat" type="text" placeholder="BR12345678" style={iStyle} /></div>
              <div>{lbl('CNPJ / company ID')}<input name="billingIco" type="text" placeholder="12.345.678/0001-99" style={iStyle} /></div>
              <div>{lbl('Billing email')}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input name="billingEmail" type="email" placeholder="financeiro@agency.com" style={iStyle} />
                  <button type="button" onClick={() => {
                    const name = formRef.current?.cname?.value || '';
                    window.open(`https://www.google.com/search?q=${encodeURIComponent(`"${name}" contato email`)}`, '_blank');
                  }} style={{ padding: '7px 10px', background: '#f0ede8', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                    🔍 Find
                  </button>
                </div>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>{lbl('Address')}<input name="billingAddress" type="text" placeholder="Rua das Flores, 123" style={iStyle} /></div>
              <div>{lbl('City')}<input name="billingCity" type="text" placeholder="São Paulo" style={iStyle} /></div>
              <div>{lbl('ZIP / postal code')}<input name="billingZip" type="text" placeholder="01310-100" style={iStyle} /></div>
              <div>{lbl('Country (billing)')}<input name="billingCountry" type="text" placeholder="Brazil" style={iStyle} /></div>
              <div>{lbl('Billing currency')}
                <select name="billingCurrency" style={iStyle}>
                  {['EUR','GBP','CHF','CZK','PLN','USD','BRL'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                {editingId ? 'Save changes' : 'Create client'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditingId(null); setContacts([{ name: '', role: '', email: '', phone: '' }]); setParseText(''); }}
                style={{ padding: '9px 20px', background: 'transparent', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div> :
        clients.filter(c => showArchived ? c.archived : !c.archived).length === 0 ? (
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '3rem', textAlign: 'center', color: colors.muted, fontSize: 14 }}>
            {showArchived ? 'Žádní archivovaní klienti.' : 'No clients yet. Add your first client.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {clients.filter(c => showArchived ? c.archived : !c.archived).map((c, i) => {
              const clientOrders = getOrdersFor(c);
              return (
              <div key={c.id} style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '1rem 1.25rem', cursor: 'pointer' }} onClick={() => toggleExpand(c.id)}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: CLIENT_COLORS[i % 6], color: CLIENT_TEXT[i % 6], display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                    {c.name?.charAt(0) || '?'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: colors.muted }}>
                      {c.country || 'Brazil'}{c.state ? ` (${c.state})` : ''}
                      {c.contacts?.length ? ` · ${c.contacts.filter(ct => ct.name).length} contact(s)` : ''}
                      {c.billing?.vat ? ` · VAT: ${c.billing.vat}` : ''}
                      {clientOrders.length ? ` · ${clientOrders.length} order(s)` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: colors.muted }}>{expanded[c.id] ? '▲' : '▼'}</span>
                </div>

                {expanded[c.id] && (
                  <div style={{ borderTop: `1px solid ${colors.border}`, padding: '1rem 1.25rem' }}>
                    {c.contacts?.filter(ct => ct.name).length > 0 && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Contacts</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8, marginBottom: 16 }}>
                          {c.contacts.filter(ct => ct.name).map((ct, ci) => (
                            <div key={ci} style={{ background: '#f7f6f3', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
                              <div style={{ fontWeight: 600, color: colors.text }}>{ct.name}</div>
                              {ct.role && <div style={{ color: colors.muted, fontSize: 12 }}>{ct.role}</div>}
                              {ct.email && <div style={{ fontSize: 12 }}><a href={`mailto:${ct.email}`} style={{ color: '#0C447C', textDecoration: 'none' }}>✉ {ct.email}</a></div>}
                              {ct.phone && <div style={{ color: colors.muted, fontSize: 12 }}>✆ {ct.phone}</div>}
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {c.billing?.company && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Billing</div>
                        <div style={{ fontSize: 13, color: colors.text, marginBottom: 16 }}>
                          <div>{c.billing.company}</div>
                          {c.billing.address && <div style={{ color: colors.muted }}>{c.billing.address}, {c.billing.city} {c.billing.zip}, {c.billing.country}{c.state ? ` (${c.state})` : ''}</div>}
                          {c.billing.vat && <div style={{ color: colors.muted }}>VAT: {c.billing.vat}</div>}
                          {c.billing.ico && <div style={{ color: colors.muted }}>CNPJ: {c.billing.ico}</div>}
                          {c.billing.email && <div><a href={`mailto:${c.billing.email}`} style={{ color: '#0C447C', textDecoration: 'none' }}>✉ {c.billing.email}</a></div>}
                          {c.billing.currency && <div style={{ color: colors.muted }}>Currency: {c.billing.currency}</div>}
                        </div>
                      </>
                    )}

                    {c.notes && <div style={{ fontSize: 13, color: colors.muted, fontStyle: 'italic', marginBottom: 12 }}>{c.notes}</div>}

                    {clientOrders.length > 0 && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Orders ({clientOrders.length})</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                          {clientOrders.map(o => (
                            <div key={o.id} onClick={() => navigate('order-detail', { orderId: o.id })}
                              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f7f6f3', borderRadius: 7, cursor: 'pointer', fontSize: 12 }}>
                              <div style={{ fontWeight: 600, color: colors.primary, width: 80, flexShrink: 0 }}>{o.startDate || '—'}</div>
                              <div style={{ flex: 1, fontWeight: 600, color: colors.text }}>{o.name}</div>
                              <div style={{ color: colors.muted }}>{o.paxCount ? `${o.paxCount} pax` : ''}</div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* Payments ledger — simple running record of money received, no forced order-matching */}
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                          💰 Platby {c.payments?.length ? `(${c.payments.length})` : ''}
                        </div>
                        <button onClick={() => { setPaymentFormFor(paymentFormFor === c.id ? null : c.id); setNewPayment({ date: '', amount: '', currency: 'EUR', note: '' }); }}
                          style={{ fontSize: 11, color: colors.primary, background: 'none', border: `1px solid ${colors.border}`, borderRadius: 5, padding: '3px 10px', cursor: 'pointer' }}>
                          {paymentFormFor === c.id ? '✕ Zavřít' : '+ Přidat platbu'}
                        </button>
                      </div>

                      {Object.keys(sumByCurrency(c.payments)).length > 0 && (
                        <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, marginBottom: 8 }}>
                          Celkem přijato: {Object.entries(sumByCurrency(c.payments)).map(([cur, sum]) => `${sum.toFixed(2)} ${cur}`).join(' · ')}
                        </div>
                      )}

                      {paymentFormFor === c.id && (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap', background: '#f7f6f3', borderRadius: 7, padding: 10, marginBottom: 8 }}>
                          <div>
                            <div style={{ fontSize: 10, color: colors.muted, marginBottom: 3 }}>Datum</div>
                            <input type="date" value={newPayment.date} onChange={e => setNewPayment(p => ({ ...p, date: e.target.value }))}
                              style={{ padding: '5px 7px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12 }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: colors.muted, marginBottom: 3 }}>Částka</div>
                            <input type="text" inputMode="decimal" value={newPayment.amount} onChange={e => setNewPayment(p => ({ ...p, amount: e.target.value.replace(',', '.') }))}
                              placeholder="0.00" style={{ padding: '5px 7px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12, width: 90 }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 10, color: colors.muted, marginBottom: 3 }}>Měna</div>
                            <select value={newPayment.currency} onChange={e => setNewPayment(p => ({ ...p, currency: e.target.value }))}
                              style={{ padding: '5px 7px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12 }}>
                              {CURRENCIES.map(cur => <option key={cur} value={cur}>{cur}</option>)}
                            </select>
                          </div>
                          <div style={{ flex: 1, minWidth: 140 }}>
                            <div style={{ fontSize: 10, color: colors.muted, marginBottom: 3 }}>Poznámka</div>
                            <input type="text" value={newPayment.note} onChange={e => setNewPayment(p => ({ ...p, note: e.target.value }))}
                              placeholder="např. záloha, doplatek Grupo X" style={{ padding: '5px 7px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12, width: '100%', boxSizing: 'border-box' }} />
                          </div>
                          <button onClick={() => addPayment(c)} style={{ padding: '6px 14px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: 'pointer' }}>Uložit</button>
                        </div>
                      )}

                      {c.payments?.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {[...c.payments].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(p => (
                            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12 }}>
                              <div style={{ color: colors.muted, width: 85, flexShrink: 0 }}>{p.date}</div>
                              <div style={{ fontWeight: 700, color: colors.primary, width: 100, flexShrink: 0 }}>{p.amount.toFixed(2)} {p.currency}</div>
                              <div style={{ flex: 1, color: colors.text }}>{p.note}</div>
                              <button onClick={() => deletePayment(c, p.id)} style={{ background: 'none', border: 'none', color: '#7f1d1d', cursor: 'pointer', fontSize: 12, padding: 0 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      {!c.archived ? (
                        <>
                          <button onClick={() => handleEdit(c)} style={{ padding: '7px 14px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: colors.muted }}>✏ Edit</button>
                          <button onClick={() => handleArchive(c.id)} style={{ padding: '7px 14px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#854f0b' }}>📦 Archive</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => handleRestore(c.id)} style={{ padding: '7px 14px', background: colors.success || '#2d6a4f', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>↩ Obnovit</button>
                          <button onClick={() => handlePermanentDelete(c)} style={{ padding: '7px 14px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#7f1d1d' }}>🗑 Smazat natrvalo</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )
      }
    </div>
  );
}
