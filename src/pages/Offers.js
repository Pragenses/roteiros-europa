import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, addDoc, deleteDoc, doc } from 'firebase/firestore';

const STATUS_OPTS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent to client' },
  { value: 'won', label: 'Won → confirmed' },
  { value: 'lost', label: 'Lost / declined' },
];

const STATUS_STYLE = {
  draft: { bg: '#F1EFE8', color: '#444441' },
  sent: { bg: '#E6F1FB', color: '#0C447C' },
  won: { bg: '#EAF3DE', color: '#27500A' },
  lost: { bg: '#FCEBEB', color: '#791F1F' },
};

const CLIENT_PALETTE = [
  '#FFF8E7', '#E8F5E9', '#E3F2FD', '#FCE4EC', '#F3E5F5',
  '#E0F7FA', '#FFF3E0', '#F9FBE7', '#EDE7F6', '#E8EAF6',
];

export default function Offers({ navigate, colors }) {
  const [offers, setOffers] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState('all');
  const formRef = useRef(null);

  const fetchAll = useCallback(async () => {
    const [offSnap, cliSnap] = await Promise.all([
      getDocs(collection(db, 'offers')),
      getDocs(collection(db, 'clients'))
    ]);
    setOffers(offSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
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
      name: f.offerName.value,
      clientId, clientName: client?.name || '',
      destinations: f.destinations.value,
      startDate: f.startDate.value,
      endDate: f.endDate.value,
      status: 'draft',
      margin: parseFloat(f.margin.value) || 15,
      focCount: parseInt(f.focCount.value) || 0,
      paxList: '15,20,25,30,35',
      items: [],
      notes: f.notes.value,
      createdAt: new Date().toISOString(),
    };
    const ref = await addDoc(collection(db, 'offers'), data);
    setShowForm(false);
    navigate('offer-detail', { offerId: ref.id });
  };

  const handleDelete = async (id) => {
    if (window.confirm('Delete this offer?')) {
      await deleteDoc(doc(db, 'offers', id));
      fetchAll();
    }
  };

  const allFilters = [['all', 'All'], ...STATUS_OPTS.map(o => [o.value, o.label])];
  const filtered = filter === 'all' ? offers : offers.filter(o => (o.status || 'draft') === filter);

  const Badge = ({ status }) => {
    const s = STATUS_STYLE[status || 'draft'] || STATUS_STYLE.draft;
    return <span style={{ background: s.bg, color: s.color, fontSize: 11, padding: '3px 8px', borderRadius: 6, fontWeight: 500 }}>{(STATUS_OPTS.find(o => o.value === (status || 'draft')) || {}).label}</span>;
  };

  const iStyle = { width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const lbl = (t) => <label style={{ fontSize: 12, color: colors.muted, display: 'block', marginBottom: 4 }}>{t}</label>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Offers</h1>
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>{offers.length} offers total — pricing for groups not yet confirmed</div>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ padding: '9px 18px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          + New offer
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
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: '1rem' }}>New offer</div>
          <form ref={formRef} onSubmit={handleSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>{lbl('Offer name *')}<input name="offerName" type="text" placeholder="e.g. Inglaterra, Bélgica e Holanda 2027" required style={iStyle} /></div>
              <div>{lbl('Client (optional for now)')}
                <select name="clientId" style={iStyle}>
                  <option value="">— Select client —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>{lbl('Start date')}<input name="startDate" type="date" style={iStyle} /></div>
              <div>{lbl('End date')}<input name="endDate" type="date" style={iStyle} /></div>
              <div>{lbl('Destinations')}<input name="destinations" type="text" placeholder="London, Brussels, Amsterdam" style={iStyle} /></div>
              <div>{lbl('Margin (%)')}<input name="margin" type="number" defaultValue="15" min="0" max="50" style={iStyle} /></div>
              <div>{lbl('FOC — persons free of charge')}<input name="focCount" type="number" defaultValue="0" min="0" max="5" style={iStyle} /></div>
            </div>
            <div style={{ marginBottom: 12 }}>
              {lbl('Notes')}<textarea name="notes" rows={2} style={{ ...iStyle, resize: 'vertical' }} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                Create offer
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
            No offers found.
          </div>
        ) : (() => {
          // Build client → color map using saved color from Firestore, fallback to palette
          const clientColorMap = {};
          let idx = 0;
          const autoIdx = {};
          offers.forEach(o => {
            if (o.clientName && !clientColorMap[o.clientName]) {
              const client = clients.find(c => c.name === o.clientName);
              if (client?.color) {
                clientColorMap[o.clientName] = client.color;
              } else {
                clientColorMap[o.clientName] = CLIENT_PALETTE[idx++ % CLIENT_PALETTE.length];
              }
            }
          });
          return (
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' }}>
              {filtered.map((o, i) => {
                const clientBg = o.clientName ? (clientColorMap[o.clientName] || colors.white) : colors.white;
                return (
                  <div key={o.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 1.25rem', borderBottom: i < filtered.length - 1 ? `1px solid ${colors.border}` : 'none', cursor: 'pointer', background: clientBg }}
                    onClick={() => navigate('offer-detail', { offerId: o.id })}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{o.name}</div>
                      <div style={{ fontSize: 12, color: colors.muted }}>{o.clientName || 'No client yet'}{o.destinations ? ` · ${o.destinations}` : ''}{o.startDate ? ` · ${o.startDate}` : ''} · {o.items?.length || 0} item(s) · margin {o.margin || 15}%</div>
                    </div>
                    <Badge status={o.status} />
                    <button onClick={e => { e.stopPropagation(); handleDelete(o.id); }}
                      style={{ padding: '4px 8px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer', color: colors.muted }}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()
      }
    </div>
  );
}
