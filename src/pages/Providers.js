import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { parseProviderText, aiFillProviderFree, translateToEnglish } from '../lib/ai';

const PROVIDER_TYPES = [
  { value: 'hotel', label: 'Hotel', icon: '🏨' },
  { value: 'transport', label: 'Transport', icon: '🚌' },
  { value: 'guide', label: 'Guide', icon: '👤' },
  { value: 'attraction', label: 'Attraction / ticket', icon: '🎟' },
  { value: 'restaurant', label: 'Restaurant', icon: '🍽' },
  { value: 'other', label: 'Other', icon: '📋' },
];

export default function Providers({ navigate, colors, navParams }) {
  const [providers, setProviders] = useState([]);
  const [allOrders, setAllOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState([{ name: '', role: '', email: '', phone: '' }]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiName, setAiName] = useState('');
  const [parseLoading, setParseLoading] = useState(false);
  const [parseText, setParseText] = useState('');
  const formRef = useRef(null);

  // Poptávka (compose/send inquiry email) — works for any provider type, standalone or
  // prefilled from an Offer via navParams.prefill
  const [tab, setTab] = useState(navParams?.prefill ? 'compose' : 'list');
  const [composeSelected, setComposeSelected] = useState([]);
  const [composeTypeFilter, setComposeTypeFilter] = useState('all');
  const [senderFrom, setSenderFrom] = useState('grupos');
  const [subject, setSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [translateEnabled, setTranslateEnabled] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [originalProgramText, setOriginalProgramText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState('');
  const [sendResult, setSendResult] = useState(null);

  const fetchData = useCallback(async () => {
    const [provSnap, ordSnap] = await Promise.all([
      getDocs(collection(db, 'providers')),
      getDocs(collection(db, 'orders'))
    ]);
    setProviders(provSnap.docs.map(d => ({ id: d.id, ...d.data() })));

    // Fetch services for every order to build bookings index
    const orders = ordSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const ordersWithServices = await Promise.all(orders.map(async (o) => {
      const svcSnap = await getDocs(collection(db, 'orders', o.id, 'services'));
      return { ...o, services: svcSnap.docs.map(s => ({ id: s.id, ...s.data() })) };
    }));
    setAllOrders(ordersWithServices);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (navParams?.expandProviderName && providers.length > 0) {
      const target = navParams.expandProviderName.toLowerCase().trim();
      const match = providers.find(p => p.name.toLowerCase().trim() === target);
      if (match) {
        setExpanded(e => ({ ...e, [match.id]: true }));
        setSearch(match.name);
      }
    }
  }, [navParams, providers]);

  useEffect(() => {
    if (navParams?.prefill) {
      const { groupName, programText, startDate, endDate, destinations } = navParams.prefill;
      setTab('compose');
      setSubject(`Group Transport Inquiry / ${groupName || ''}`);
      setOriginalProgramText(programText || '');
      const dateLine = startDate && endDate ? `Dates: ${startDate} - ${endDate}\n` : '';
      const destLine = destinations ? `Destinations: ${destinations}\n` : '';
      setEmailBody(
        `Dear Sir/Madam,\n\nWe kindly request a quotation for the following group:\n\nGroup: ${groupName || ''}\n${dateLine}${destLine}\n` +
        `Program:\n${programText || ''}\n\nPlease let us know your availability and rates.\n\nBest regards,\nTour Pragenses / Orbis Europa DMC`
      );
    }
  }, [navParams]);

  const addContact = () => setContacts(c => [...c, { name: '', role: '', email: '', phone: '' }]);
  const removeContact = (i) => setContacts(c => c.filter((_, idx) => idx !== i));
  const updateContact = (i, field, val) => setContacts(c => c.map((ct, idx) => idx === i ? { ...ct, [field]: val } : ct));

  const applyParsed = (parsed) => {
    const f = formRef.current; if (!f) return;
    if (parsed.name) f.provName.value = parsed.name;
    if (parsed.type && PROVIDER_TYPES.find(t => t.value === parsed.type)) f.provType.value = parsed.type;
    if (parsed.address) f.address.value = parsed.address;
    if (parsed.city) f.city.value = parsed.city;
    if (parsed.zip) f.zip.value = parsed.zip;
    if (parsed.country) f.country.value = parsed.country;
    if (parsed.vat) f.vat.value = parsed.vat;
    if (parsed.ico) f.ico.value = parsed.ico;
    if (parsed.phone) f.phone.value = parsed.phone;
    if (parsed.website) f.website.value = parsed.website;
    if (parsed.notes) f.notes.value = parsed.notes;
    if (parsed.email) f.email.value = parsed.email;
    if ((parsed.email || parsed.phone) && !contacts[0].name) {
      setContacts([{ name: 'Reservations', role: 'Groups / Reservations', email: parsed.email || '', phone: parsed.phone || '' }]);
    }
  };

  const handleAiFill = async () => {
    const name = formRef.current?.provName?.value || aiName;
    if (!name) { alert('Please enter a provider name first.'); return; }
    setAiLoading(true);
    try {
      const parsed = await aiFillProviderFree(name);
      applyParsed(parsed);
    } catch (err) {
      console.error(err);
      alert('Could not find data automatically (' + err.message + '). Please use "Find" or fill in manually.');
    }
    setAiLoading(false);
  };

  const handleParseText = async () => {
    if (!parseText.trim()) { alert('Paste some text first.'); return; }
    setParseLoading(true);
    try {
      const parsed = await parseProviderText(parseText);
      applyParsed(parsed);
      // If phone/website weren't in the text, try to fill them via web search
      if ((!parsed.phone || !parsed.website) && parsed.name) {
        try {
          const webInfo = await aiFillProviderFree(parsed.name);
          const f = formRef.current;
          if (!parsed.phone && webInfo.phone && f.phone && !f.phone.value) f.phone.value = webInfo.phone;
          if (!parsed.website && webInfo.website && f.website && !f.website.value) f.website.value = webInfo.website;
          if (!parsed.email && webInfo.email && f.email && !f.email.value) f.email.value = webInfo.email;
        } catch (webErr) {
          console.error('Web lookup failed:', webErr);
        }
      }
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
      name: f.provName.value, type: f.provType.value,
      address: f.address.value, city: f.city.value,
      zip: f.zip.value, country: f.country.value,
      vat: f.vat.value, ico: f.ico.value,
      email: f.email.value, phone: f.phone.value,
      website: f.website.value, iban: f.iban.value,
      billingEmail: f.billingEmail.value,
      notes: f.notes.value, contacts,
    };
    if (editingId) {
      await updateDoc(doc(db, 'providers', editingId), data);
    } else {
      await addDoc(collection(db, 'providers'), { ...data, createdAt: new Date().toISOString() });
    }
    setShowForm(false); setEditingId(null);
    setContacts([{ name: '', role: '', email: '', phone: '' }]);
    setParseText('');
    fetchData();
  };

  const handleEdit = (p) => {
    setEditingId(p.id);
    setContacts(p.contacts?.length ? p.contacts : [{ name: '', role: '', email: '', phone: '' }]);
    setShowForm(true);
    setParseText('');
    setTimeout(() => {
      const f = formRef.current; if (!f) return;
      f.provName.value = p.name || ''; f.provType.value = p.type || 'hotel';
      f.address.value = p.address || ''; f.city.value = p.city || '';
      f.zip.value = p.zip || ''; f.country.value = p.country || '';
      f.vat.value = p.vat || ''; f.ico.value = p.ico || '';
      f.email.value = p.email || ''; f.phone.value = p.phone || '';
      f.website.value = p.website || ''; f.iban.value = p.iban || '';
      f.billingEmail.value = p.billingEmail || '';
      f.notes.value = p.notes || '';
    }, 50);
  };

  const handleDelete = async (id) => {
    if (window.confirm('Delete this provider?')) {
      await deleteDoc(doc(db, 'providers', id)); fetchData();
    }
  };

  const toggleExpand = (id) => setExpanded(e => ({ ...e, [id]: !e[id] }));

  const toggleComposeSelect = (id) => setComposeSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const handleTranslate = async () => {
    if (!originalProgramText.trim()) { alert('Není k dispozici žádný program k překladu.'); return; }
    setTranslating(true);
    try {
      const translated = await translateToEnglish(originalProgramText);
      setEmailBody(body => body.replace(originalProgramText, translated));
      setOriginalProgramText(translated); // subsequent clicks won't re-translate already-translated text
    } catch (err) {
      alert('Překlad selhal: ' + err.message);
    }
    setTranslating(false);
  };

  const composeProviders = providers.filter(p => composeTypeFilter === 'all' || p.type === composeTypeFilter);

  const handleSendInquiry = async () => {
    if (!composeSelected.length) { alert('Vyber alespoň jednoho dodavatele.'); return; }
    setSending(true);
    setSendResult(null);
    const sel = providers.filter(p => composeSelected.includes(p.id));
    const recipients = [];
    sel.forEach(p => (p.contacts || []).forEach(c => { if (c.email) recipients.push({ email: c.email, name: c.name || p.name, providerId: p.id, providerName: p.name }); }));
    if (!recipients.length) { alert('Vybraní dodavatelé nemají žádný email v kontaktech.'); setSending(false); return; }
    setSendProgress(`Odesílám ${recipients.length} emailů...`);
    let sent = 0, failed = 0;
    try {
      const res = await fetch('https://tour-pragenses.com/mailer.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients: recipients.map(r => ({ email: r.email, name: r.name })), subject, body: emailBody, from: senderFrom }),
      });
      const data = await res.json();
      if (data.results) {
        for (let i = 0; i < data.results.length; i++) {
          const r = recipients[i];
          if (data.results[i].ok) {
            await addDoc(collection(db, 'providerEmailLog'), {
              providerId: r.providerId, providerName: r.providerName, email: r.email,
              subject, sentAt: serverTimestamp(), status: 'sent',
            });
            sent++;
          } else { failed++; }
        }
      } else if (data.error) {
        alert('Chyba: ' + data.error);
        failed = recipients.length;
      }
    } catch (err) {
      alert('Odeslání selhalo: ' + err.message);
      failed = recipients.length;
    }
    setSendResult({ sent, failed });
    setSending(false);
    setSendProgress('');
  };

  // Find bookings (orders) that use this provider by exact name match (case-insensitive)
  const getBookingsFor = (provider) => {
    const results = [];
    const pName = (provider.name || '').toLowerCase().trim();
    if (!pName) return results;
    allOrders.forEach(o => {
      (o.services || []).forEach(s => {
        const sName = (s.providerName || s.name || '').toLowerCase().trim();
        if (sName && sName === pName) {
          results.push({ order: o, service: s });
        }
      });
    });
    return results.sort((a, b) => new Date(a.order.startDate || 0) - new Date(b.order.startDate || 0));
  };

  const filtered = providers.filter(p => {
    const matchType = filter === 'all' || p.type === filter;
    const s = search.toLowerCase();
    const matchSearch = !s || p.name?.toLowerCase().includes(s) || p.city?.toLowerCase().includes(s);
    return matchType && matchSearch;
  });

  const iStyle = { width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const lbl = (t) => <label style={{ fontSize: 12, color: colors.muted, display: 'block', marginBottom: 4 }}>{t}</label>;
  const SectionHead = ({ title }) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, borderTop: `2px solid ${colors.border}`, paddingTop: 14, marginTop: 4 }}>{title}</div>
  );

  return (
    <div>
      {navParams?.fromOrderId && (
        <div style={{ marginBottom: '1rem' }}>
          <button onClick={() => navigate('order-detail', { orderId: navParams.fromOrderId })}
            style={{ padding: '7px 16px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            ← Back to {navParams.fromOrderName || 'order'}
          </button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Providers</h1>
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>Supplier database — hotels, transport, guides, attractions</div>
        </div>
        <button onClick={() => { setShowForm(true); setEditingId(null); setContacts([{ name: '', role: '', email: '', phone: '' }]); setParseText(''); setTimeout(() => formRef.current?.reset(), 50); }}
          style={{ padding: '9px 18px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          + New provider
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: '1.25rem' }}>
        <button onClick={() => setTab('list')}
          style={{ padding: '8px 18px', borderRadius: 8, border: `1px solid ${colors.border}`, background: tab === 'list' ? colors.primary : 'transparent', color: tab === 'list' ? colors.white : colors.muted, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          📋 Databáze
        </button>
        <button onClick={() => setTab('compose')}
          style={{ padding: '8px 18px', borderRadius: 8, border: `1px solid ${colors.border}`, background: tab === 'compose' ? colors.primary : 'transparent', color: tab === 'compose' ? colors.white : colors.muted, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          📨 Poptávka
        </button>
      </div>

      {tab === 'list' && (
      <>
      <div style={{ display: 'flex', gap: 10, marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" placeholder="Search by name or city..." defaultValue={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '7px 12px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'Georgia, serif', width: 220 }} />
        {[['all', 'All'], ...PROVIDER_TYPES.map(t => [t.value, t.icon + ' ' + t.label])].map(([val, label]) => (
          <button key={val} onClick={() => setFilter(val)}
            style={{ padding: '5px 12px', borderRadius: 20, border: `1px solid ${filter === val ? colors.primary : colors.border}`, background: filter === val ? colors.primary : 'transparent', color: filter === val ? colors.white : colors.muted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
            {label}
          </button>
        ))}
      </div>

      {showForm && (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: '1rem' }}>{editingId ? 'Edit provider' : 'New provider'}</div>

          <div style={{ background: '#f0ede8', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1rem', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: colors.primary, fontWeight: 500 }}>✨ AI search (free)</div>
            <input type="text" placeholder="Type provider name and click search..." value={aiName} onChange={e => setAiName(e.target.value)}
              style={{ flex: 1, minWidth: 200, padding: '7px 10px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif' }} />
            <button type="button" onClick={handleAiFill} disabled={aiLoading}
              style={{ padding: '7px 16px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: aiLoading ? 0.6 : 1 }}>
              {aiLoading ? 'Searching...' : '✨ Fill automatically'}
            </button>
          </div>

          <div style={{ background: '#f0ede8', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: 13, color: colors.primary, fontWeight: 500, marginBottom: 6 }}>📋 Paste company info to auto-fill</div>
            <textarea value={parseText} onChange={e => setParseText(e.target.value)} rows={3}
              placeholder="Paste any text here — website content, email signature, company registry entry — and AI will extract the fields below."
              style={{ width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 }} />
            <button type="button" onClick={handleParseText} disabled={parseLoading}
              style={{ padding: '7px 16px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: parseLoading ? 0.6 : 1 }}>
              {parseLoading ? 'Parsing...' : '📋 Parse into fields'}
            </button>
          </div>

          <form ref={formRef} onSubmit={handleSubmit}>
            <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Basic info</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
              <div>{lbl('Name *')}<input name="provName" type="text" required style={iStyle} /></div>
              <div>{lbl('Type')}
                <select name="provType" style={iStyle}>
                  {PROVIDER_TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
                </select>
              </div>
              <div>{lbl('Website')}<input name="website" type="text" placeholder="https://..." style={iStyle} /></div>
              <div>{lbl('Main email')}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input name="email" type="email" placeholder="info@hotel.com" style={iStyle} />
                  <button type="button" onClick={() => {
                    const name = formRef.current?.provName?.value || '';
                    const city = formRef.current?.city?.value || '';
                    window.open(`https://www.google.com/search?q=${encodeURIComponent(`"${name}" ${city} groups reservations email contact`)}`, '_blank');
                  }} style={{ padding: '7px 10px', background: '#f0ede8', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
                    🔍 Find
                  </button>
                </div>
              </div>
              <div>{lbl('Main phone')}<input name="phone" type="text" placeholder="+31 20 541 11 23" style={iStyle} /></div>
            </div>

            <SectionHead title="Address" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}>{lbl('Street address')}<input name="address" type="text" placeholder="Piet Heinkade 11" style={iStyle} /></div>
              <div>{lbl('City')}<input name="city" type="text" placeholder="Amsterdam" style={iStyle} /></div>
              <div>{lbl('ZIP / postal code')}<input name="zip" type="text" placeholder="1019 BR" style={iStyle} /></div>
              <div>{lbl('Country')}<input name="country" type="text" placeholder="Netherlands" style={iStyle} /></div>
            </div>

            <SectionHead title="Billing & VAT" />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 12 }}>
              <div>{lbl('VAT number')}<input name="vat" type="text" placeholder="NL123456789B01" style={iStyle} /></div>
              <div>{lbl('Company ID / registration')}<input name="ico" type="text" placeholder="12345678" style={iStyle} /></div>
              <div>{lbl('Billing email')}<input name="billingEmail" type="email" placeholder="billing@hotel.com" style={iStyle} /></div>
              <div>{lbl('IBAN (for payments)')}<input name="iban" type="text" placeholder="NL91 ABNA 0417 1643 00" style={iStyle} /></div>
            </div>

            <SectionHead title="Contact persons" />
            {contacts.map((ct, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 32px', gap: 8, marginBottom: 8 }}>
                <div>{i === 0 && lbl('Name')}<input type="text" value={ct.name} onChange={e => updateContact(i, 'name', e.target.value)} placeholder="Jane Smith" style={iStyle} /></div>
                <div>{i === 0 && lbl('Role / department')}<input type="text" value={ct.role} onChange={e => updateContact(i, 'role', e.target.value)} placeholder="Groups reservations" style={iStyle} /></div>
                <div>{i === 0 && lbl('Email')}<input type="email" value={ct.email} onChange={e => updateContact(i, 'email', e.target.value)} placeholder="groups@hotel.com" style={iStyle} /></div>
                <div>{i === 0 && lbl('Phone')}<input type="text" value={ct.phone} onChange={e => updateContact(i, 'phone', e.target.value)} placeholder="+31 20 000 0000" style={iStyle} /></div>
                <div style={{ display: 'flex', alignItems: i === 0 ? 'flex-end' : 'center' }}>
                  {contacts.length > 1 && <button type="button" onClick={() => removeContact(i)} style={{ padding: '7px 8px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', color: '#7f1d1d', fontSize: 12 }}>✕</button>}
                </div>
              </div>
            ))}
            <button type="button" onClick={addContact} style={{ padding: '6px 14px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit', marginBottom: 16 }}>
              + Add contact
            </button>

            <SectionHead title="Notes" />
            <div style={{ marginBottom: 16 }}>
              <textarea name="notes" rows={2} placeholder="Group rates, special conditions, deadlines..." style={{ ...iStyle, resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                {editingId ? 'Save changes' : 'Add provider'}
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
        filtered.length === 0 ? (
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '3rem', textAlign: 'center', color: colors.muted, fontSize: 14 }}>
            No providers found.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map((p) => {
              const bookings = getBookingsFor(p);
              return (
                <div key={p.id} style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 1.25rem', cursor: 'pointer' }} onClick={() => toggleExpand(p.id)}>
                    <div style={{ fontSize: 22, flexShrink: 0 }}>{PROVIDER_TYPES.find(t => t.value === p.type)?.icon || '📋'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{p.name}</div>
                      <div style={{ fontSize: 12, color: colors.muted }}>
                        {[p.city, p.country].filter(Boolean).join(', ')}
                        {p.contacts?.filter(c => c.name).length ? ` · ${p.contacts.filter(c => c.name).length} contact(s)` : ''}
                        {p.vat ? ` · VAT: ${p.vat}` : ''}
                        {bookings.length ? ` · ${bookings.length} booking(s)` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button onClick={e => { e.stopPropagation(); handleEdit(p); }} style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: colors.muted }}>✏</button>
                      <button onClick={e => { e.stopPropagation(); handleDelete(p.id); }} style={{ padding: '5px 10px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#7f1d1d' }}>✕</button>
                      <span style={{ fontSize: 12, color: colors.muted, marginLeft: 4 }}>{expanded[p.id] ? '▲' : '▼'}</span>
                    </div>
                  </div>

                  {expanded[p.id] && (
                    <div style={{ borderTop: `1px solid ${colors.border}`, padding: '1rem 1.25rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Address & contact</div>
                        {p.address && <div style={{ fontSize: 13, color: colors.text }}>{p.address}</div>}
                        {(p.city || p.zip || p.country) && <div style={{ fontSize: 13, color: colors.muted }}>{[p.zip, p.city, p.country].filter(Boolean).join(', ')}</div>}
                        {p.email && <div style={{ fontSize: 12, marginTop: 4 }}><a href={`mailto:${p.email}`} style={{ color: '#0C447C', textDecoration: 'none' }}>✉ {p.email}</a></div>}
                        {p.phone && <div style={{ fontSize: 12, color: colors.muted }}>✆ {p.phone}</div>}
                        {p.website && <div style={{ fontSize: 12 }}><a href={p.website.startsWith('http') ? p.website : `https://${p.website}`} target="_blank" rel="noopener noreferrer" style={{ color: '#0C447C', textDecoration: 'none' }}>🌐 {p.website}</a></div>}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Billing</div>
                        {p.vat && <div style={{ fontSize: 12, color: colors.muted }}>VAT: {p.vat}</div>}
                        {p.ico && <div style={{ fontSize: 12, color: colors.muted }}>ID: {p.ico}</div>}
                        {p.billingEmail && <div style={{ fontSize: 12 }}><a href={`mailto:${p.billingEmail}`} style={{ color: '#0C447C', textDecoration: 'none' }}>✉ {p.billingEmail}</a></div>}
                        {p.iban && <div style={{ fontSize: 12, color: colors.muted }}>IBAN: {p.iban}</div>}
                      </div>
                      {p.contacts?.filter(c => c.name).length > 0 && (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Contacts</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                            {p.contacts.filter(c => c.name).map((ct, ci) => (
                              <div key={ci} style={{ background: '#f7f6f3', borderRadius: 7, padding: '8px 10px', fontSize: 12 }}>
                                <div style={{ fontWeight: 600, color: colors.text }}>{ct.name}</div>
                                {ct.role && <div style={{ color: colors.muted }}>{ct.role}</div>}
                                {ct.email && <div><a href={`mailto:${ct.email}`} style={{ color: '#0C447C', textDecoration: 'none' }}>✉ {ct.email}</a></div>}
                                {ct.phone && <div style={{ color: colors.muted }}>✆ {ct.phone}</div>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {p.notes && <div style={{ gridColumn: '1 / -1', fontSize: 12, color: colors.muted, fontStyle: 'italic' }}>{p.notes}</div>}

                      {bookings.length > 0 && (
                        <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Bookings ({bookings.length})</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {bookings.map((b, bi) => (
                              <div key={bi} onClick={() => navigate('order-detail', { orderId: b.order.id })}
                                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f7f6f3', borderRadius: 7, cursor: 'pointer', fontSize: 12 }}>
                                <div style={{ fontWeight: 600, color: colors.primary, width: 80, flexShrink: 0 }}>{b.order.startDate || '—'}</div>
                                <div style={{ flex: 1 }}>
                                  <span style={{ fontWeight: 600, color: colors.text }}>{b.order.name}</span>
                                  <span style={{ color: colors.muted }}> · {b.order.clientName}</span>
                                </div>
                                <div style={{ color: colors.muted }}>{b.service.name}{b.service.dateFrom ? ` (${b.service.dateFrom})` : ''}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      }
      </>
      )}

      {tab === 'compose' && (
        <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '1.5rem', alignItems: 'start' }}>
          <div>
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem' }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 15, color: colors.primary, fontWeight: 600 }}>Dodavatelé ({composeSelected.length} vybráno)</h3>
              <select value={composeTypeFilter} onChange={e => setComposeTypeFilter(e.target.value)} style={{ ...iStyle, marginBottom: 8 }}>
                <option value="all">Všechny typy</option>
                {PROVIDER_TYPES.map(t => <option key={t.value} value={t.value}>{t.icon} {t.label}</option>)}
              </select>
              <div style={{ maxHeight: 340, overflowY: 'auto', border: `1px solid ${colors.border}`, borderRadius: 6 }}>
                {composeProviders.map(p => (
                  <label key={p.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '7px 10px', cursor: 'pointer', borderBottom: `1px solid ${colors.border}`, background: composeSelected.includes(p.id) ? '#f0f7ff' : '#fff' }}>
                    <input type="checkbox" checked={composeSelected.includes(p.id)} onChange={() => toggleComposeSelect(p.id)} style={{ marginTop: 2 }} />
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: colors.muted }}>
                        {PROVIDER_TYPES.find(t => t.value === p.type)?.icon} {p.city} · {(p.contacts || []).map(c => c.email).filter(Boolean).join(', ') || 'bez emailu'}
                      </div>
                    </div>
                  </label>
                ))}
                {composeProviders.length === 0 && <p style={{ padding: 12, color: colors.muted, fontSize: 12 }}>Žádní dodavatelé.</p>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button onClick={() => setComposeSelected(composeProviders.filter(p => (p.contacts||[]).some(c=>c.email)).map(p => p.id))} style={{ fontSize: 11, color: colors.primary, background: 'none', border: `1px solid ${colors.border}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>Vybrat vše</button>
                <button onClick={() => setComposeSelected([])} style={{ fontSize: 11, color: colors.muted, background: 'none', border: `1px solid ${colors.border}`, borderRadius: 4, padding: '3px 10px', cursor: 'pointer' }}>Odznačit</button>
              </div>
            </div>
          </div>

          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 15, color: colors.primary, fontWeight: 600 }}>Email</h3>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: colors.muted, display: 'block', marginBottom: 3 }}>Odesílat z</label>
              <select value={senderFrom} onChange={e => setSenderFrom(e.target.value)} style={iStyle}>
                <option value="grupos">grupos@tour-pragenses.com</option>
                <option value="reservas3">reservas3@tour-pragenses.com</option>
                <option value="info">info@tour-pragenses.com</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: colors.muted, display: 'block', marginBottom: 3 }}>Předmět</label>
              <input value={subject} onChange={e => setSubject(e.target.value)} style={iStyle} />
            </div>
            {originalProgramText && (
              <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10, background: '#f7f6f3', padding: '8px 10px', borderRadius: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={translateEnabled} onChange={e => setTranslateEnabled(e.target.checked)} />
                  Přeložit program do angličtiny
                </label>
                <button onClick={handleTranslate} disabled={!translateEnabled || translating}
                  style={{ fontSize: 11, padding: '4px 10px', background: translateEnabled ? colors.primary : colors.border, color: '#fff', border: 'none', borderRadius: 5, cursor: translateEnabled ? 'pointer' : 'default' }}>
                  {translating ? 'Překládám…' : '🌐 Přeložit teď'}
                </button>
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: colors.muted, display: 'block', marginBottom: 3 }}>Text emailu</label>
              <textarea value={emailBody} onChange={e => setEmailBody(e.target.value)} rows={16} style={{ ...iStyle, resize: 'vertical', lineHeight: 1.6 }} />
            </div>
            {composeSelected.length > 0 && (
              <div style={{ background: '#f7f6f3', borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
                <strong>Vybráno ({composeSelected.length}):</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {providers.filter(p => composeSelected.includes(p.id)).map(p => (
                    <li key={p.id} style={{ fontSize: 12 }}>{p.name} <span style={{ color: colors.muted }}>· {(p.contacts||[]).map(c=>c.email).filter(Boolean).join(', ')}</span></li>
                  ))}
                </ul>
              </div>
            )}
            <button onClick={handleSendInquiry} disabled={!composeSelected.length || sending}
              style={{ padding: '10px 24px', background: composeSelected.length && !sending ? colors.primary : colors.border, color: composeSelected.length && !sending ? '#fff' : colors.muted, border: 'none', borderRadius: 7, fontSize: 15, cursor: composeSelected.length && !sending ? 'pointer' : 'default', fontFamily: 'inherit' }}>
              {sending ? sendProgress || 'Připravuji…' : `✉ Odeslat na ${composeSelected.length} dodavatel${composeSelected.length === 1 ? 'e' : composeSelected.length < 5 && composeSelected.length > 0 ? 'e' : 'ů'}`}
            </button>
            {sendResult && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: sendResult.failed ? '#fff3e0' : '#e8f5e9', borderRadius: 6, fontSize: 13 }}>
                {sendResult.sent > 0 && <div style={{ color: colors.success || '#2d6a4f' }}>✓ Odesláno: <strong>{sendResult.sent}</strong> emailů</div>}
                {sendResult.failed > 0 && <div style={{ color: '#854f0b', marginTop: 4 }}>⚠ Nepodařilo se: <strong>{sendResult.failed}</strong> emailů</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
