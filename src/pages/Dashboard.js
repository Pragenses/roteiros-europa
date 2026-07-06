import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';

const STATUS_COLORS = {
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

const STATUS_LABELS = {
  'confirmed': 'Confirmed', 'awaiting_deposit': 'Awaiting deposit',
  'option': 'Option', 'action_required': 'Action required',
  'enquired': 'Enquired', 'completed': 'Completed',
  'potvrzeno': 'Confirmed', 'ceka_zalohu': 'Awaiting deposit',
  'opce': 'Option', 'nutna_akce': 'Action required',
  'poptano': 'Enquired', 'dokonceno': 'Completed',
};

export default function Dashboard({ navigate, colors }) {
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState({ active: 0, clients: 0, urgentOptions: 0 });
  const [hotelTasks, setHotelTasks] = useState([]);
  const [balanceTasks, setBalanceTasks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [ordSnap, cliSnap, offSnap] = await Promise.all([
          getDocs(collection(db, 'orders')),
          getDocs(collection(db, 'clients')),
          getDocs(collection(db, 'offers'))
        ]);
        const allOrders = ordSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const sorted = allOrders.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
        const upcoming = sorted.filter(o => new Date(o.startDate) >= new Date());
        setOrders(upcoming.slice(0, 6));
        const urgent = allOrders.filter(o => {
          if (!o.optionDate) return false;
          const diff = (new Date(o.optionDate) - new Date()) / (1000 * 60 * 60 * 24);
          return diff <= 14 && diff >= 0;
        });
        setStats({ active: allOrders.filter(o => o.status !== 'completed' && o.status !== 'dokonceno').length, clients: cliSnap.size, urgentOptions: urgent.length });

        // Hotel option / cancellation deadlines living inside each offer's items
        const allOffers = offSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => !o.declined);
        const today = new Date();
        const hTasks = [];
        allOffers.forEach(offer => {
          (offer.items || []).forEach(item => {
            if (!(item.type === 'per_pax' && item.subType === 'hotel')) return;
            if (item.optionDate && item.bookingStatus !== 'confirmed') {
              const diff = Math.round((new Date(item.optionDate) - today) / 86400000);
              if (diff <= 14) hTasks.push({ kind: 'option', offerId: offer.id, offerName: offer.name, hotelName: item.name, date: item.optionDate, diff });
            }
            if (item.cancellationDeadline) {
              const diff = Math.round((new Date(item.cancellationDeadline) - today) / 86400000);
              if (diff <= 14) hTasks.push({ kind: 'cancellation', offerId: offer.id, offerName: offer.name, hotelName: item.name, date: item.cancellationDeadline, diff });
            }
          });
        });
        hTasks.sort((a, b) => a.diff - b.diff);
        setHotelTasks(hTasks);

        // Client balances still outstanding (received but not yet allocated to an order/offer)
        const allClients = cliSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const bTasks = [];
        allClients.forEach(c => {
          const received = {};
          (c.payments || []).forEach(p => { received[p.currency] = (received[p.currency] || 0) + p.amount; });
          const allocated = {};
          (c.allocations || []).forEach(a => { allocated[a.currency] = (allocated[a.currency] || 0) + a.amount; });
          Object.keys(received).forEach(cur => {
            const remaining = received[cur] - (allocated[cur] || 0);
            if (Math.abs(remaining) > 0.5) bTasks.push({ clientId: c.id, clientName: c.name, currency: cur, remaining });
          });
        });
        setBalanceTasks(bTasks);
      } catch (e) { console.log('No data yet'); }
      setLoading(false);
    };
    fetchData();
  }, []);

  const Badge = ({ status }) => {
    const s = STATUS_COLORS[status] || STATUS_COLORS['enquired'];
    return <span style={{ background: s.bg, color: s.color, fontSize: 11, padding: '3px 8px', borderRadius: 6, fontWeight: 500, whiteSpace: 'nowrap' }}>{STATUS_LABELS[status] || status}</span>;
  };

  const Metric = ({ val, label }) => (
    <div style={{ background: '#f0ede8', borderRadius: 8, padding: '1rem', textAlign: 'center', flex: 1 }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: colors.primary }}>{val}</div>
      <div style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>{label}</div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Dashboard</h1>
        <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>Orbis Europa DMC — Booking Overview</div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: '1.5rem' }}>
        <Metric val={stats.active} label="Active orders" />
        <Metric val={stats.clients} label="Clients 2027" />
        <Metric val={stats.urgentOptions} label="Options expiring soon" />
        <Metric val="15%" label="Margin" />
      </div>

      {(hotelTasks.length > 0 || balanceTasks.length > 0) && (
        <div style={{ background: '#FFFBF0', border: `1px solid #E8D9A8`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: '#854f0b', textTransform: 'uppercase', marginBottom: '1rem' }}>
            ⚠️ Vyžaduje pozornost ({hotelTasks.length + balanceTasks.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {hotelTasks.map((t, i) => (
              <div key={'h' + i} onClick={() => navigate('offer-detail', { offerId: t.offerId })}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: colors.white, borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: t.diff < 0 ? '#7f1d1d' : '#854f0b', width: 80, flexShrink: 0 }}>
                  {t.diff < 0 ? `${-t.diff}d po termínu` : t.diff === 0 ? 'DNES' : `za ${t.diff}d`}
                </span>
                <span style={{ color: colors.muted, width: 90, flexShrink: 0 }}>{t.kind === 'option' ? 'Opce' : 'Storno lhůta'}</span>
                <span style={{ flex: 1, fontWeight: 600, color: colors.text }}>{t.hotelName}</span>
                <span style={{ color: colors.muted, fontSize: 12 }}>{t.offerName}</span>
              </div>
            ))}
            {balanceTasks.map((t, i) => (
              <div key={'b' + i} onClick={() => navigate('clients')}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: colors.white, borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: colors.primary, width: 80, flexShrink: 0 }}>💰 Zůstatek</span>
                <span style={{ flex: 1, fontWeight: 600, color: colors.text }}>{t.clientName}</span>
                <span style={{ color: t.remaining > 0 ? colors.primary : '#7f1d1d', fontWeight: 700 }}>{t.remaining.toFixed(2)} {t.currency}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: colors.muted, textTransform: 'uppercase', marginBottom: '1rem' }}>Upcoming departures</div>
        {loading ? <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div> :
          orders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: colors.muted, fontSize: 14 }}>
              No orders yet.<br />
              <button onClick={() => navigate('orders')} style={{ marginTop: 12, padding: '8px 16px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
                Add first order
              </button>
            </div>
          ) : orders.map((o, i) => (
            <div key={o.id} onClick={() => navigate('order-detail', { orderId: o.id })}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < orders.length - 1 ? `1px solid ${colors.border}` : 'none', cursor: 'pointer' }}>
              <div style={{ width: 48, textAlign: 'center', flexShrink: 0 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: colors.primary }}>{o.startDate ? new Date(o.startDate).getDate() : '—'}</div>
                <div style={{ fontSize: 10, color: colors.muted, textTransform: 'uppercase' }}>
                  {o.startDate ? new Date(o.startDate).toLocaleString('en', { month: 'short' }) : ''}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name}</div>
                <div style={{ fontSize: 12, color: colors.muted }}>{o.clientName}{o.paxCount ? ` · ${o.paxCount} pax` : ''}</div>
              </div>
              <Badge status={o.status} />
            </div>
          ))
        }
      </div>
      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: colors.muted, textTransform: 'uppercase', marginBottom: '1rem' }}>Quick actions</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[['New order', 'orders'], ['New client', 'clients'], ['New provider', 'providers'], ['Calendar', 'calendar']].map(([label, p]) => (
            <button key={p} onClick={() => navigate(p)}
              style={{ padding: '8px 16px', background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, color: colors.text, cursor: 'pointer', fontFamily: 'inherit' }}>
              + {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
