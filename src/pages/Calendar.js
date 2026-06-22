import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CLIENT_PALETTE = ['#E6F1FB','#FAEEDA','#EAF3DE','#EEEDFE','#FCEBEB','#F1EFE8','#FCF0E8','#E8F5F1','#F5E8F5','#E8EEF5'];
const CLIENT_TEXT_PALETTE = ['#0C447C','#633806','#27500A','#534AB7','#791F1F','#444441','#7A3B0A','#085041','#6B2F6B','#1A3A5C'];

export default function Calendar({ navigate, colors }) {
  const [orders, setOrders] = useState([]);
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(2027);
  const [clientColors, setClientColors] = useState({});

  useEffect(() => {
    const fetchData = async () => {
      const [ordersSnap, offersSnap] = await Promise.all([
        getDocs(collection(db, 'orders')),
        getDocs(collection(db, 'offers')),
      ]);
      const allOrders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const allOffers = offersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      setOrders(allOrders);
      setOffers(allOffers);
      const cc = {};
      let idx = 0;
      allOrders.forEach(o => { if (o.clientName && !cc[o.clientName]) cc[o.clientName] = idx++ % CLIENT_PALETTE.length; });
      setClientColors(cc);
      setLoading(false);
    };
    fetchData();
  }, []);

  const getOrdersForMonth = (month) =>
    orders.filter(o => {
      if (!o.startDate) return false;
      const d = new Date(o.startDate);
      return d.getFullYear() === year && d.getMonth() === month;
    }).sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  const getOffersForMonth = (month) =>
    offers.filter(o => {
      if (!o.startDate) return false;
      const d = new Date(o.startDate);
      return d.getFullYear() === year && d.getMonth() === month;
    }).sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  const uniqueClients = [...new Set(orders.map(o => o.clientName).filter(Boolean))];

  if (loading) return <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Calendar</h1>
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>Group departures by month</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setYear(y => y - 1)} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>←</button>
          <span style={{ fontSize: 18, fontWeight: 700, color: colors.primary, minWidth: 50, textAlign: 'center' }}>{year}</span>
          <button onClick={() => setYear(y => y + 1)} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>→</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ background: '#FCEBF3', color: '#9D2466', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20 }}>📋 Offers</span>
        {uniqueClients.length > 0 && <span style={{ fontSize: 12, color: colors.muted }}>Clients:</span>}
        {uniqueClients.map(c => {
          const idx = clientColors[c] || 0;
          return <span key={c} style={{ background: CLIENT_PALETTE[idx], color: CLIENT_TEXT_PALETTE[idx], fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20 }}>{c}</span>;
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MONTHS.map((month, mi) => {
          const monthOrders = getOrdersForMonth(mi);
          const monthOffers = getOffersForMonth(mi);
          const totalCount = monthOrders.length + monthOffers.length;
          return (
            <div key={mi} style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0.875rem 1.25rem', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ width: 90, flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary }}>{month}</div>
                <div style={{ fontSize: 11, color: colors.muted }}>{totalCount} {totalCount === 1 ? 'item' : 'items'}</div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {totalCount === 0 ? (
                  <div style={{ fontSize: 12, color: colors.border, paddingTop: 2 }}>—</div>
                ) : (
                  <>
                    {monthOffers.map(o => (
                      <div key={`offer-${o.id}`} onClick={() => navigate('offer-detail', { offerId: o.id })}
                        style={{ background: '#FCEBF3', color: '#9D2466', fontSize: 11, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', lineHeight: 1.3, border: '1px solid #9D246622' }}>
                        <div style={{ fontWeight: 700 }}>
                          📋 {o.startDate ? new Date(o.startDate).getDate() + '/' + (new Date(o.startDate).getMonth() + 1) : ''} {o.name}
                        </div>
                        <div style={{ opacity: 0.75 }}>{o.clientName}{o.status ? ` · ${o.status}` : ''}</div>
                      </div>
                    ))}
                    {monthOrders.map(o => {
                      const idx = clientColors[o.clientName] || 0;
                      return (
                        <div key={`order-${o.id}`} onClick={() => navigate('order-detail', { orderId: o.id })}
                          style={{ background: CLIENT_PALETTE[idx], color: CLIENT_TEXT_PALETTE[idx], fontSize: 11, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', lineHeight: 1.3, border: `1px solid ${CLIENT_TEXT_PALETTE[idx]}22` }}>
                          <div style={{ fontWeight: 700 }}>
                            {o.startDate ? new Date(o.startDate).getDate() + '/' + (new Date(o.startDate).getMonth() + 1) : ''} {o.name}
                          </div>
                          <div style={{ opacity: 0.75 }}>{o.clientName}{o.paxCount ? ` · ${o.paxCount} pax` : ''}</div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {offers.filter(o => !o.startDate).length > 0 && (
        <div style={{ marginTop: 16, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0.875rem 1.25rem' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.muted, marginBottom: 8 }}>📋 Offers without date</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {offers.filter(o => !o.startDate).map(o => (
              <div key={`offer-nodate-${o.id}`} onClick={() => navigate('offer-detail', { offerId: o.id })}
                style={{ background: '#FCEBF3', color: '#9D2466', fontSize: 11, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', lineHeight: 1.3, border: '1px solid #9D246622' }}>
                <div style={{ fontWeight: 700 }}>📋 {o.name}</div>
                <div style={{ opacity: 0.75 }}>{o.clientName || ''}{o.status ? ` · ${o.status}` : ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
