import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, addDoc, deleteDoc, doc } from 'firebase/firestore';

const STATUS_OPTS = [
  { value: 'enquired', label: 'Enquired' },
  { value: 'option', label: 'Option' },
  { value: 'awaiting_deposit', label: 'Awaiting deposit' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'action_required', label: 'Action required' },
  { value: 'completed', label: 'Completed' },
];

const STATUS_STYLE = {
  'confirmed': { bg: '#EAF3DE', color: '#27500A' },
  'awaiting_deposit': { bg: '#FAEEDA', color: '#633806' },
  'option': { bg: '#E6F1FB', color: '#0C447C' },
  'action_required': { bg: '#FCEBEB', color: '#791F1F' },
  'enquired': { bg: '#F1EFE8', color: '#444441' },
  'completed': { bg: '#F1EFE8', color: '#888780' },
  'potvrzeno': { bg: '#EAF3DE', color: '#27500A' },
  'ceka_zalohu': { bg: '#FAEEDA', color: '#633806' },
  'opce': { bg: '#E6F1FB', color: '#0C447C' },
  'nutna_akce': { bg: '#FCEBEB', color: '#791F1F' },
  'poptano': { bg: '#F1EFE8', color: '#444441' },
  'dokonceno': { bg: '#F1EFE8', color: '#888780' },
};

const STATUS_LABEL = {
  'confirmed': 'Confirmed', 'awaiting_deposit': 'Awaiting deposit',
  'option': 'Option', 'action_required': 'Action required',
  'enquired': 'Enquired', 'completed': 'Completed',
  'potvrzeno': 'Confirmed', 'ceka_zalohu': 'Awaiting deposit',
  'opce': 'Option', 'nutna_akce': 'Action required',
  'poptano': 'Enquired', 'dokonceno': 'Completed',
};

export default function Orders({ navigate, colors }) {
  const [orders, setOrders] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState('all');
  const formRef = useRef(null);

  const fetchAll = useCallback(async () => {
    const [ordSnap, cliSnap] = await Promise.all([
      getDocs(collection(db, 'orders')),
      getDocs(collection(db, 'clients'))
    ]);
    setOrders(ordSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => new Date(a.startDate) - new Date(b.startDate)));
    setClients(cliSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const f = formRef.current;
    const clientId = f.clientId.value;
    const client = clients.find(c => c.id === clientId);
    const data = {
      name: f.orderName.value,
      clientId, clientName: client?.name || '',
      startDate: f.startDate.value,
      endDate: f.endDate.value,
      paxCount: f.paxCount.value || '',
      status: f.status.value,
      destinations: f.destinations.value,
      focCount: parseInt(f.focCount.value) || 1,
      focType: f.focType.value,
      margin: parseFloat(f.margin.value) || 15,
      notes: f.notes.value,
      createdAt: new Date().toISOString()
    };
    const ref = await addDoc(collection(db, 'orders'), data);
    setShowForm(false);
    navigate('order-detail', { orderId: ref.id });
  };

  const handleDelete = async (id) => {
    if (window.confirm('Delete this order?')) {
      await deleteDoc(doc(db, 'orders', id));
      fetchAll();
    }
  };

  const allFilters = [['all', 'All'], ...STATUS_OPTS.map(o => [o.value, o.label])];
  const filtered = filter === 'all' ? orders : orders.filter(o => o.status === filter || (filter === 'confirmed' && o.status === 'potvrzeno') || (filter === 'enquired' && o.status === 'poptano'));

  const Badge = ({ status }) => {
    const s = STATUS_STYLE[status] || STATUS_STYLE['enquired'];
    return <span style={{ background: s.bg, color: s.color, fontSize: 11, padding: '3px 8px', borderRadius: 6, fontWeight: 500 }}>{STATUS_LABEL[status] || status}</span>;
  };

  const iStyle = { width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const lbl = (t) => <label style={{ fontSize: 12, color: colors.muted, display: 'block', marginBottom: 4 }}>{t}</label>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Orders</h1>
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>{orders.length} orders total</div>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ padding: '9px 18px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          + New order
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        {allFilters.map(([val, label]) => (
          <button key={val} onClick={() => setFilter(val)}
            style={{ padding: '5px 12px', borderRadius: 20, border: `1px solid ${filter === val ? colors.primary : colors.border}`, background: filter === val ? colors.primary : 'transparent', color: filter === val ? colors.white : colors.muted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
            {label}
          </button>
        ))}
      </div>

      {showForm && (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: '1rem' }}>New order</div>
          <form ref={formRef} onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>{lbl('Order name *')}<input name="orderName" type="text" placeholder="e.g. Primavera na Europa 2027" required style={iStyle} /></div>
              <div>{lbl('Client *')}
                <select name="clientId" required style={iStyle}>
                  <option value="">— Select client —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>{lbl('Departure date *')}<input name="startDate" type="date" required style={iStyle} /></div>
              <div>{lbl('Return date')}<input name="endDate" type="date" style={iStyle} /></div>
              <div>{lbl('Pax count (paying) — can be added later')}<input name="paxCount" type="number" placeholder="e.g. 20" style={iStyle} /></div>
              <div>{lbl('Status')}
                <select name="status" style={iStyle}>
                  {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>{lbl('Destinations')}<input name="destinations" type="text" placeholder="Amsterdam, Brussels, Luxembourg" style={iStyle} /></div>
              <div>{lbl('Margin (%)')}<input name="margin" type="number" defaultValue="15" min="0" max="50" style={iStyle} /></div>
              <div>{lbl('FOC — persons free of charge')}
                <div style={{ display: 'flex', gap: 8 }}>
                  <input name="focCount" type="number" defaultValue="1" min="0" max="5" style={{ ...iStyle, width: 70 }} />
                  <select name="focType" style={{ ...iStyle }}>
                    <option value="dbl">DBL room</option>
                    <option value="sngl">SNGL room</option>
                    <option value="1dbl+1sngl">1 DBL + 1 SNGL</option>
                    <option value="2dbl">2 DBL rooms</option>
                  </select>
                </div>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              {lbl('Notes')}<textarea name="notes" rows={2} style={{ ...iStyle, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                Create order
              </button>
              <button type="button" onClick={() => setShowForm(false)}
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
            No orders found.
          </div>
        ) : (
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {filtered.map((o, i) => (
              <div key={o.id}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 1.25rem', borderBottom: i < filtered.length - 1 ? `1px solid ${colors.border}` : 'none', cursor: 'pointer' }}
                onClick={() => navigate('order-detail', { orderId: o.id })}>
                <div style={{ width: 44, textAlign: 'center', flexShrink: 0 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: colors.primary }}>{o.startDate ? new Date(o.startDate).getDate() : '—'}</div>
                  <div style={{ fontSize: 10, color: colors.muted, textTransform: 'uppercase' }}>
                    {o.startDate ? new Date(o.startDate).toLocaleString('en', { month: 'short' }) : ''}
                  </div>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{o.name}</div>
                  <div style={{ fontSize: 12, color: colors.muted }}>{o.clientName} · {o.destinations || ''}{o.paxCount ? ` · ${o.paxCount} pax` : ''} · FOC {o.focCount || 1} ({o.focType || 'dbl'})</div>
                </div>
                <Badge status={o.status} />
                <button onClick={e => { e.stopPropagation(); handleDelete(o.id); }}
                  style={{ padding: '4px 8px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer', color: colors.muted }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}
