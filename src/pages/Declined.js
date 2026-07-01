import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, doc, updateDoc, deleteDoc } from 'firebase/firestore';

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

export default function Declined({ navigate, colors }) {
  const [offers, setOffers] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedClient, setSelectedClient] = useState(null);

  const fetchAll = useCallback(async () => {
    const [offSnap, cliSnap] = await Promise.all([
      getDocs(collection(db, 'offers')),
      getDocs(collection(db, 'clients'))
    ]);
    const declined = offSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(o => o.declined === true)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    setOffers(declined);
    setClients(cliSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleRestore = async (id) => {
    await updateDoc(doc(db, 'offers', id), { declined: false });
    fetchAll();
  };

  const handleDelete = async (id, name) => {
    if (!window.confirm(`Permanently delete "${name}"?`)) return;
    if (!window.confirm('This cannot be undone. Are you sure?')) return;
    await deleteDoc(doc(db, 'offers', id));
    fetchAll();
  };

  // Build client color map
  const clientColorMap = {};
  let paletteIdx = 0;
  offers.forEach(o => {
    if (o.clientName && !clientColorMap[o.clientName]) {
      const client = clients.find(c => c.name === o.clientName);
      clientColorMap[o.clientName] = client?.color || CLIENT_PALETTE[paletteIdx++ % CLIENT_PALETTE.length];
    }
  });

  // Group by client
  const clientGroups = {};
  offers.forEach(o => {
    const key = o.clientName || '— No client —';
    if (!clientGroups[key]) clientGroups[key] = [];
    clientGroups[key].push(o);
  });
  const clientList = Object.entries(clientGroups).sort(([a], [b]) => a.localeCompare(b));
  const clientOffers = selectedClient ? (clientGroups[selectedClient] || []) : [];

  const Badge = ({ status }) => {
    const s = STATUS_STYLE[status || 'draft'] || STATUS_STYLE.draft;
    return <span style={{ background: s.bg, color: s.color, fontSize: 11, padding: '3px 8px', borderRadius: 6, fontWeight: 500 }}>
      {(STATUS_OPTS.find(o => o.value === (status || 'draft')) || {}).label}
    </span>;
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Declined</h1>
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>
            {selectedClient
              ? <><button onClick={() => setSelectedClient(null)} style={{ background: 'none', border: 'none', color: colors.primary, cursor: 'pointer', fontSize: 13, padding: 0, textDecoration: 'underline' }}>← All clients</button> &nbsp;·&nbsp; <strong>{selectedClient}</strong> — {clientOffers.length} offer{clientOffers.length !== 1 ? 's' : ''}</>
              : <>{offers.length} declined offers · {clientList.length} clients</>
            }
          </div>
        </div>
      </div>

      {loading ? <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div> : (

        !selectedClient ? (
          clientList.length === 0 ? (
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '3rem', textAlign: 'center', color: colors.muted, fontSize: 14 }}>
              No declined offers.
            </div>
          ) : (
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' }}>
              {clientList.map(([clientName, cOffers], i) => {
                const bg = clientColorMap[clientName] || colors.white;
                return (
                  <div key={clientName}
                    onClick={() => setSelectedClient(clientName)}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 1.25rem', borderBottom: i < clientList.length - 1 ? `1px solid ${colors.border}` : 'none', cursor: 'pointer', background: bg }}
                    onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
                    onMouseLeave={e => e.currentTarget.style.opacity = '1'}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>{clientName}</div>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: colors.muted }}>{cOffers.length}</div>
                    <div style={{ fontSize: 12, color: colors.muted }}>offer{cOffers.length !== 1 ? 's' : ''} →</div>
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' }}>
            {clientOffers.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: colors.muted }}>No offers.</div>
            ) : clientOffers.map((o, i) => {
              const bg = clientColorMap[o.clientName] || colors.white;
              return (
                <div key={o.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 1.25rem', borderBottom: i < clientOffers.length - 1 ? `1px solid ${colors.border}` : 'none', background: bg }}>
                  <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => navigate('offer-detail', { offerId: o.id })}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{o.name}</div>
                    <div style={{ fontSize: 12, color: colors.muted }}>
                      {o.clientName || ''}{o.destinations ? ` · ${o.destinations}` : ''}{o.startDate ? ` · ${o.startDate}` : ''}
                    </div>
                  </div>
                  <Badge status={o.status} />
                  <button onClick={() => handleRestore(o.id)}
                    style={{ padding: '4px 10px', background: colors.success, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    ↩ Restore
                  </button>
                  <button onClick={() => handleDelete(o.id, o.name)}
                    style={{ padding: '4px 10px', background: colors.danger, color: '#fff', border: 'none', borderRadius: 5, fontSize: 11, cursor: 'pointer' }}>
                    🗑 Delete
                  </button>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
