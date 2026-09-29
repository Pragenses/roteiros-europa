import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs } from 'firebase/firestore';
import { PEOPLE } from '../lib/people';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const CLIENT_PALETTE = ['#E6F1FB','#FAEEDA','#EAF3DE','#EEEDFE','#FCEBEB','#F1EFE8','#FCF0E8','#E8F5F1','#F5E8F5','#E8EEF5'];
const CLIENT_TEXT_PALETTE = ['#0C447C','#633806','#27500A','#534AB7','#791F1F','#444441','#7A3B0A','#085041','#6B2F6B','#1A3A5C'];

// Filtry kalendáře — co se má ukazovat. Pamatuje si to tento prohlížeč.
const FILTERS = [
  { key: 'orders',  icon: '🚌', label: '🚌 Odjezdy zakázek', bg: '#E6F1FB', color: '#0C447C' },
  { key: 'offers',  icon: '📋', label: '📋 Nabídky',         bg: '#FCEBF3', color: '#9D2466' },
  { key: 'option',  icon: '⏳', label: '⏳ Opce hotelů',      bg: '#FEF9C3', color: '#854d0e' },
  { key: 'storno',  icon: '✂',  label: '✂ Storno lhůty',     bg: '#E0F2FE', color: '#075985' },
  { key: 'alt',     icon: '⚠',  label: '⚠ Alternativy',      bg: '#FFF7ED', color: '#9a3412' },
  { key: 'task',    icon: '✅', label: '✅ Úkoly',            bg: '#EAF3DE', color: '#27500A' },
];
const DEFAULT_FILTERS = { orders: true, offers: true, option: true, storno: true, alt: true, task: true, client: '', person: 'ALL' };
const FILTER_KEY = 'calFilters';

const ymd = (d) => String(d || '').slice(0, 10);
const dm = (d) => { const [, m, day] = ymd(d).split('-'); return `${parseInt(day, 10)}/${parseInt(m, 10)}`; };
const todayYmd = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

// Termíny ze servisních karet a úkolů všech nabídek.
// Opce: hotel, který není potvrzený ani zrušený (a nabídka není odmítnutá).
// Storno lhůta: zaškrtnutý hotel, který není zrušený.
// Alternativa: potvrzený, nezaškrtnutý a nezrušený hotel — hlídá se i
// v odmítnutých a převedených nabídkách (stejně jako na Dashboardu).
export const buildDeadlines = (offers) => {
  const list = [];
  const noDate = [];
  offers.forEach(offer => {
    const offerLabel = [offer.offerNumber, offer.name].filter(Boolean).join(' · ') || '(bez názvu)';
    const base = { offerId: offer.id, offerLabel, clientName: offer.clientName || '' };
    (offer.items || []).forEach(item => {
      if (!(item.type === 'per_pax' && item.subType === 'hotel')) return;
      if (item.cancelled) return;
      const hotel = [item.city, item.name].filter(Boolean).join(' – ') || 'hotel bez názvu';
      const isStray = item.enabled === false && item.bookingStatus === 'confirmed';
      if (isStray) {
        if (item.cancellationDeadline) list.push({ ...base, kind: 'alt', date: ymd(item.cancellationDeadline), text: `ALTERNATIVA · storno ${hotel}`, itemId: item.id });
        else noDate.push({ ...base, kind: 'alt', date: '', text: `ALTERNATIVA · ${hotel} — chybí storno lhůta`, itemId: item.id });
        return;
      }
      if (offer.declined) return;
      if (item.optionDate && item.bookingStatus !== 'confirmed') {
        list.push({ ...base, kind: 'option', date: ymd(item.optionDate), text: `Opce · ${hotel}`, itemId: item.id });
      }
      if (item.cancellationDeadline && item.enabled !== false) {
        list.push({ ...base, kind: 'storno', date: ymd(item.cancellationDeadline), text: `Storno · ${hotel}`, itemId: item.id });
      }
    });
    if (offer.declined) return;
    (offer.todos || []).forEach(t => {
      if (t.done || !t.due) return;
      list.push({ ...base, kind: 'task', date: ymd(t.due), text: t.text || 'úkol', who: t.who || '', itemId: t.itemId || '' });
    });
  });
  return { list, noDate };
};

export default function Calendar({ navigate, colors, userRole, userEmail }) {
  const [orders, setOrders] = useState([]);
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(new Date().getFullYear());
  const [clientColors, setClientColors] = useState({});
  const [filters, setFilters] = useState(() => {
    try { return { ...DEFAULT_FILTERS, ...(JSON.parse(localStorage.getItem(FILTER_KEY) || 'null') || {}) }; }
    catch (e) { return { ...DEFAULT_FILTERS }; }
  });
  const setFilter = (key, val) => setFilters(f => {
    const next = { ...f, [key]: val };
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(next)); } catch (e) {}
    return next;
  });

  useEffect(() => {
    const fetchData = async () => {
      const [ordersSnap, offersSnap] = await Promise.all([
        getDocs(collection(db, 'orders')),
        getDocs(collection(db, 'offers')),
      ]);
      const allOrders = ordersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      let allOffers = offersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Omezený uživatel vidí jen nabídky, ke kterým má přístup (jako jinde v aplikaci).
      if (userRole === 'limited') allOffers = allOffers.filter(o => (o.allowedUsers || []).includes(userEmail));
      setOrders(allOrders);
      setOffers(allOffers);
      const cc = {};
      let idx = 0;
      allOrders.forEach(o => { if (o.clientName && !cc[o.clientName]) cc[o.clientName] = idx++ % CLIENT_PALETTE.length; });
      setClientColors(cc);
      setLoading(false);
    };
    fetchData();
  }, [userRole, userEmail]);

  // Otevře nabídku a v ní rovnou sjede na danou servisní kartu.
  const openOffer = (offerId, itemId) => {
    if (itemId !== undefined && itemId !== null && itemId !== '') {
      try { sessionStorage.setItem('focusCard', JSON.stringify({ offerId, itemId })); } catch (e) {}
    }
    navigate('offer-detail', { offerId });
  };

  const clientOk = (name) => !filters.client || name === filters.client;
  const personOk = (who) => filters.person === 'ALL' || !who || who === filters.person;
  const inMonth = (date, month) => {
    if (!date) return false;
    const d = new Date(date);
    return d.getFullYear() === year && d.getMonth() === month;
  };

  const { list: deadlines, noDate } = buildDeadlines(offers);
  const visibleDeadline = (e) => filters[e.kind] && clientOk(e.clientName) && (e.kind !== 'task' || personOk(e.who));

  const getOrdersForMonth = (month) => !filters.orders ? [] :
    orders.filter(o => inMonth(o.startDate, month) && clientOk(o.clientName))
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const getOffersForMonth = (month) => !filters.offers ? [] :
    offers.filter(o => inMonth(o.startDate, month) && clientOk(o.clientName))
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const getDeadlinesForMonth = (month) =>
    deadlines.filter(e => inMonth(e.date, month) && visibleDeadline(e))
      .sort((a, b) => a.date.localeCompare(b.date));

  const uniqueClients = [...new Set([...orders, ...offers].map(o => o.clientName).filter(Boolean))].sort();
  const today = todayYmd();

  if (loading) return <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div>;

  const toggleStyle = (on, f) => ({
    background: on ? f.bg : 'transparent', color: on ? f.color : colors.muted,
    border: `1px solid ${on ? f.color + '55' : colors.border}`, textDecoration: on ? 'none' : 'line-through',
    fontSize: 12, fontWeight: 600, padding: '4px 11px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
  });
  const smallChip = (on) => ({
    background: on ? colors.primary : 'transparent', color: on ? '#fff' : colors.muted,
    border: `1px solid ${on ? colors.primary : colors.border}`,
    fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 16, cursor: 'pointer', fontFamily: 'inherit',
  });

  const deadlineChip = (e, key) => {
    const f = FILTERS.find(x => x.key === e.kind);
    const overdue = !!e.date && e.date < today;
    const isAlt = e.kind === 'alt';
    const person = e.who ? PEOPLE.find(p => p.code === e.who) : null;
    return (
      <div key={key} onClick={() => openOffer(e.offerId, e.itemId)} title={e.clientName}
        style={{ background: f.bg, color: f.color, fontSize: 11, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', lineHeight: 1.3,
                 border: overdue ? '2px solid #dc2626' : isAlt ? '2px solid #ea580c' : `1px solid ${f.color}33`, maxWidth: 320 }}>
        <div style={{ fontWeight: 700 }}>
          {f.icon} {e.date ? dm(e.date) : ''} {e.text}
          {person && <span style={{ marginLeft: 6, background: person.bg, color: person.color, borderRadius: 8, padding: '0 5px' }}>{person.code}</span>}
        </div>
        <div style={{ opacity: 0.8 }}>
          {e.offerLabel}
          {overdue && <span style={{ color: '#dc2626', fontWeight: 700 }}> · prošlo</span>}
        </div>
      </div>
    );
  };

  const visibleNoDate = noDate.filter(visibleDeadline);
  const offersNoDate = filters.offers ? offers.filter(o => !o.startDate && clientOk(o.clientName)) : [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Calendar</h1>
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>Odjezdy, termíny hotelů a úkoly po měsících</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => setYear(y => y - 1)} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>←</button>
          <span style={{ fontSize: 18, fontWeight: 700, color: colors.primary, minWidth: 50, textAlign: 'center' }}>{year}</span>
          <button onClick={() => setYear(y => y + 1)} style={{ padding: '6px 12px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14 }}>→</button>
        </div>
      </div>

      {/* Filtry: kliknutím se druh zapne / vypne. */}
      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0.75rem 1rem', marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: colors.muted, marginRight: 4 }}>Zobrazit:</span>
          {FILTERS.map(f => (
            <button key={f.key} type="button" onClick={() => setFilter(f.key, !filters[f.key])} style={toggleStyle(filters[f.key], f)}>{f.label}</button>
          ))}
        </div>
        {filters.task && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: colors.muted, marginRight: 4 }}>Úkoly pro:</span>
            <button type="button" onClick={() => setFilter('person', 'ALL')} style={smallChip(filters.person === 'ALL')}>Všichni</button>
            {PEOPLE.map(p => (
              <button key={p.code} type="button" onClick={() => setFilter('person', p.code)} style={smallChip(filters.person === p.code)}>{p.short}</button>
            ))}
          </div>
        )}
        {uniqueClients.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: colors.muted, marginRight: 4 }}>Klient:</span>
            <button type="button" onClick={() => setFilter('client', '')} style={smallChip(!filters.client)}>Všichni</button>
            {uniqueClients.map(c => {
              const idx = clientColors[c] || 0;
              const on = filters.client === c;
              return (
                <button key={c} type="button" onClick={() => setFilter('client', on ? '' : c)}
                  style={{ background: CLIENT_PALETTE[idx], color: CLIENT_TEXT_PALETTE[idx], fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20, cursor: 'pointer', fontFamily: 'inherit',
                           border: on ? `2px solid ${CLIENT_TEXT_PALETTE[idx]}` : '2px solid transparent' }}>{c}</button>
              );
            })}
          </div>
        )}
      </div>

      {visibleNoDate.length > 0 && (
        <div style={{ background: '#FFF7ED', border: '2px solid #ea580c', borderRadius: 10, padding: '0.75rem 1.25rem', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#9a3412', marginBottom: 8 }}>⚠ Alternativy bez storno lhůty</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {visibleNoDate.map((e, i) => deadlineChip(e, `nd-${i}`))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MONTHS.map((month, mi) => {
          const monthOrders = getOrdersForMonth(mi);
          const monthOffers = getOffersForMonth(mi);
          const monthDeadlines = getDeadlinesForMonth(mi);
          const hasTop = monthOffers.length > 0 || monthOrders.length > 0;
          const totalCount = monthOrders.length + monthOffers.length + monthDeadlines.length;
          return (
            <div key={mi} style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0.875rem 1.25rem', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{ width: 90, flexShrink: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary }}>{month}</div>
                <div style={{ fontSize: 11, color: colors.muted }}>{totalCount} {totalCount === 1 ? 'item' : 'items'}</div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {totalCount === 0 && <div style={{ fontSize: 12, color: colors.border, paddingTop: 2 }}>—</div>}
                {hasTop && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {monthOffers.map(o => (
                      <div key={`offer-${o.id}`} onClick={() => navigate('offer-detail', { offerId: o.id })}
                        style={{ background: '#FCEBF3', color: '#9D2466', fontSize: 11, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', lineHeight: 1.3, border: '1px solid #9D246622' }}>
                        <div style={{ fontWeight: 700 }}>
                          📋 {o.startDate ? new Date(o.startDate).getDate() + '/' + (new Date(o.startDate).getMonth() + 1) : ''} {o.offerNumber ? o.offerNumber + ' · ' : ''}{o.name}
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
                            🚌 {o.startDate ? new Date(o.startDate).getDate() + '/' + (new Date(o.startDate).getMonth() + 1) : ''} {o.offerNumber ? o.offerNumber + ' · ' : ''}{o.name}
                          </div>
                          <div style={{ opacity: 0.75 }}>{o.clientName}{o.paxCount ? ` · ${o.paxCount} pax` : ''}</div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {monthDeadlines.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, borderTop: hasTop ? `1px dashed ${colors.border}` : 'none', paddingTop: hasTop ? 6 : 0 }}>
                    {monthDeadlines.map((e, i) => deadlineChip(e, `d-${mi}-${i}`))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {offersNoDate.length > 0 && (
        <div style={{ marginTop: 16, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0.875rem 1.25rem' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.muted, marginBottom: 8 }}>📋 Offers without date</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {offersNoDate.map(o => (
              <div key={`offer-nodate-${o.id}`} onClick={() => navigate('offer-detail', { offerId: o.id })}
                style={{ background: '#FCEBF3', color: '#9D2466', fontSize: 11, borderRadius: 6, padding: '5px 10px', cursor: 'pointer', lineHeight: 1.3, border: '1px solid #9D246622' }}>
                <div style={{ fontWeight: 700 }}>📋 {o.offerNumber ? o.offerNumber + ' · ' : ''}{o.name}</div>
                <div style={{ opacity: 0.75 }}>{o.clientName || ''}{o.status ? ` · ${o.status}` : ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
