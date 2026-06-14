import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc, collection, getDocs, addDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { parseServiceText, aiFillProviderFree } from '../lib/ai';

const SERVICE_TYPES = [
  { value: 'hotel', label: 'Hotel', icon: '🏨' },
  { value: 'restaurant', label: 'Restaurant', icon: '🍽' },
  { value: 'ticket', label: 'Ticket / per person', icon: '🎟' },
  { value: 'train_boat', label: 'Train / boat', icon: '🚂' },
  { value: 'bus', label: 'Bus', icon: '🚌' },
  { value: 'guide', label: 'Guide', icon: '👤' },
  { value: 'extra_cost', label: 'Extra cost', icon: '💶' },
  { value: 'other', label: 'Other', icon: '📋' },
];

const CURRENCIES = ['EUR', 'GBP', 'CHF', 'CZK', 'PLN', 'NOK', 'DKK', 'USD'];

const SERVICE_STATUS = [
  { value: 'enquired', label: 'Enquired', bg: '#F1EFE8', color: '#444441' },
  { value: 'confirmed', label: 'Confirmed', bg: '#EAF3DE', color: '#27500A' },
  { value: 'option', label: 'Option', bg: '#E6F1FB', color: '#0C447C' },
  { value: 'deposit_paid', label: 'Deposit paid', bg: '#FAEEDA', color: '#633806' },
  { value: 'contract', label: 'Contract', bg: '#EEEDFE', color: '#534AB7' },
  { value: 'paid', label: 'Paid', bg: '#EAF3DE', color: '#085041' },
];

const ORDER_STATUS = [
  { value: 'enquired', label: 'Enquired' },
  { value: 'option', label: 'Option' },
  { value: 'awaiting_deposit', label: 'Awaiting deposit' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'action_required', label: 'Action required' },
  { value: 'completed', label: 'Completed' },
];

const DEFAULT_RATES = { GBP: 1.17, CHF: 1.07, PLN: 0.23, NOK: 0.087, DKK: 0.134, CZK: 0.040, USD: 0.92 };

const SERVICE_TO_PROVIDER_TYPE = {
  hotel: 'hotel',
  restaurant: 'restaurant',
  ticket: 'attraction',
  train_boat: 'transport',
  bus: 'transport',
  guide: 'guide',
  extra_cost: 'other',
  other: 'other',
};

export default function OrderDetail({ orderId, navigate, colors }) {
  const [order, setOrder] = useState(null);
  const [services, setServices] = useState([]);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showServiceForm, setShowServiceForm] = useState(false);
  const [activeType, setActiveType] = useState('hotel');
  const [editingServiceId, setEditingServiceId] = useState(null);
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [showRates, setShowRates] = useState(false);
  const [editingOrder, setEditingOrder] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [documents, setDocuments] = useState([]);
  const [docUploading, setDocUploading] = useState(false);
  const [cancellationDateDisplay, setCancellationDateDisplay] = useState('');
  const [hotelFocSelected, setHotelFocSelected] = useState('none');
  const [pasteLoading, setPasteLoading] = useState(false);
  const serviceFormRef = useRef(null);
  const orderFormRef = useRef(null);

  const fetchData = useCallback(async () => {
    if (!orderId) return;
    const snap = await getDoc(doc(db, 'orders', orderId));
    if (snap.exists()) setOrder({ id: snap.id, ...snap.data() });
    const svcSnap = await getDocs(collection(db, 'orders', orderId, 'services'));
    setServices(svcSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    const provSnap = await getDocs(collection(db, 'providers'));
    setProviders(provSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, [orderId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleServiceSubmit = async (e) => {
    e.preventDefault();
    const f = serviceFormRef.current;
    if (!f) return;
    const data = {
      type: activeType,
      name: f.svcName?.value || '',
      providerName: f.providerName?.value || '',
      providerEmail: f.providerEmail?.value || '',
      providerEmail2: f.providerEmail2?.value || '',
      providerWebsite: f.providerWebsite?.value || '',
      providerPhone: f.providerPhone?.value || '',
      city: f.city?.value || '',
      dateFrom: f.dateFrom?.value || '',
      dateTo: f.dateTo?.value || '',
      nights: f.nights?.value || '',
      currency: f.currency?.value || 'EUR',
      status: f.status?.value || 'enquired',
      optionDate: f.optionDate?.value || '',
      depositDate: f.depositDate?.value || '',
      depositAmount: f.depositAmount?.value || '',
      depositCurrency: f.depositCurrency?.value || 'EUR',
      confirmationLink: f.confirmationLink?.value || '',
      notes: f.notes?.value || '',
      dblRooms: f.dblRooms?.value || '',
      snglRooms: f.snglRooms?.value || '',
      twnRooms: f.twnRooms?.value || '',
      trplRooms: f.trplRooms?.value || '',
      pricePerDblRoom: f.pricePerDblRoom?.value || '',
      pricePerSnglRoom: f.pricePerSnglRoom?.value || '',
      pricePerTwnRoom: f.pricePerTwnRoom?.value || '',
      pricePerTrplRoom: f.pricePerTrplRoom?.value || '',
      cityTax: f.cityTax?.value || '',
      cityTaxIncluded: f.cityTaxIncluded?.value || 'separate',
      cityTaxType: f.cityTaxType?.value || 'per_person',
      dinners: f.dinners?.value || '',
      dinnerPrice: f.dinnerPrice?.value || '',
      lunches: f.lunches?.value || '',
      lunchPrice: f.lunchPrice?.value || '',
      guideRoom: f.guideRoom?.value || '',
      guideRoomPrice: f.guideRoomPrice?.value || '',
      driverAccom: f.driverAccom?.value || 'none',
      driverRoomPrice: f.driverRoomPrice?.value || '',
      hotelFoc: f.hotelFoc?.value || 'none',
      hotelFocOccupancy: f.hotelFocOccupancy?.value || 'dbl',
      cancellationDays: f.cancellationDays?.value || '',
      cancellationDate: f.cancellationDate?.value || '',
      pricePerPax: f.pricePerPax?.value || '',
      totalPrice: f.totalPrice?.value || '',
      updatedAt: new Date().toISOString(),
    };
    if (editingServiceId) {
      await updateDoc(doc(db, 'orders', orderId, 'services', editingServiceId), data);
    } else {
      await addDoc(collection(db, 'orders', orderId, 'services'), { ...data, createdAt: new Date().toISOString() });
    }

    // Auto-create provider in the database if it doesn't exist yet
    const providerNameToSave = (data.providerName || data.name || '').trim();
    if (providerNameToSave) {
      const exists = providers.find(p => p.name.toLowerCase().trim() === providerNameToSave.toLowerCase());
      if (!exists) {
        await addDoc(collection(db, 'providers'), {
          name: providerNameToSave,
          type: SERVICE_TO_PROVIDER_TYPE[activeType] || 'other',
          city: data.city || '',
          country: '',
          address: '', zip: '', vat: '', ico: '', website: '', iban: '', billingEmail: '',
          email: data.providerEmail || '',
          phone: data.providerPhone || '',
          notes: '',
          contacts: [{ name: '', role: '', email: data.providerEmail || '', phone: data.providerPhone || '' }],
          createdAt: new Date().toISOString(),
        });
      }
    }
    setShowServiceForm(false);
    setEditingServiceId(null);
    fetchData();
  };

  const handlePasteText = async () => {
    if (!pasteText.trim()) { alert('Paste some text first.'); return; }
    setPasteLoading(true);
    try {
      const parsed = await parseServiceText(pasteText, activeType);
      const f = serviceFormRef.current;
      if (!f) return;
      if (parsed.name && f.svcName) f.svcName.value = parsed.name;
      if (parsed.city && f.city) f.city.value = parsed.city;
      if (parsed.dateFrom && f.dateFrom) f.dateFrom.value = parsed.dateFrom;
      if (parsed.dateTo && f.dateTo) f.dateTo.value = parsed.dateTo;
      if (parsed.nights && f.nights) f.nights.value = parsed.nights;
      // Try to match against known providers to auto-fill provider/email/phone
      if (parsed.name && f.providerName) {
        const match = providers.find(p => p.name.toLowerCase().trim() === parsed.name.toLowerCase().trim()
          || p.name.toLowerCase().includes(parsed.name.toLowerCase())
          || parsed.name.toLowerCase().includes(p.name.toLowerCase()));
        if (match) {
          f.providerName.value = match.name;
          if (!f.providerEmail.value) f.providerEmail.value = match.email || '';
          if (!f.providerPhone.value) f.providerPhone.value = match.phone || '';
          if (!f.city.value && match.city) f.city.value = match.city;
        } else {
          // Not in our database - try a web search to find contact info
          f.providerName.value = parsed.name;
          try {
            const webInfo = await aiFillProviderFree(parsed.name);
            if (webInfo.email && f.providerEmail) f.providerEmail.value = webInfo.email;
            if (webInfo.phone && f.providerPhone) f.providerPhone.value = webInfo.phone;
            if (webInfo.city && f.city && !f.city.value) f.city.value = webInfo.city;
          } catch (webErr) {
            console.error('Web lookup failed:', webErr);
            // Non-fatal - just leave email/phone empty, user can fill manually
          }
        }
      }
    } catch (err) {
      console.error(err);
      alert('Could not parse this text: ' + err.message);
    }
    setPasteLoading(false);
  };

  const CHUNK_SIZE = 700000; // chars of base64 per chunk, safely under Firestore 1MB doc limit

  const fetchDocuments = async (sid) => {
    if (!sid) { setDocuments([]); return; }
    const snap = await getDocs(collection(db, 'orders', orderId, 'services', sid, 'documents'));
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
    setDocuments(docs);
  };

  const uploadFile = async (file) => {
    if (!file) return;
    if (!editingServiceId) { alert('Save the service first, then add documents.'); return; }
    if (file.size > 5000000) {
      alert('File is too large (' + Math.round(file.size / 1024) + ' KB). Maximum is about 5 MB per file.');
      return;
    }
    setDocUploading(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = reader.result;
        const chunks = [];
        for (let i = 0; i < dataUrl.length; i += CHUNK_SIZE) {
          chunks.push(dataUrl.slice(i, i + CHUNK_SIZE));
        }
        const docRef = await addDoc(collection(db, 'orders', orderId, 'services', editingServiceId, 'documents'), {
          name: file.name,
          type: file.type,
          size: file.size,
          chunkCount: chunks.length,
          uploadedAt: new Date().toISOString(),
        });
        for (let i = 0; i < chunks.length; i++) {
          await addDoc(collection(db, 'orders', orderId, 'services', editingServiceId, 'documents', docRef.id, 'chunks'), {
            index: i,
            data: chunks[i],
          });
        }
        await fetchDocuments(editingServiceId);
      } catch (err) {
        console.error(err);
        alert('Upload failed: ' + err.message);
      }
      setDocUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const handleDownloadDocument = async (d) => {
    try {
      const chunksSnap = await getDocs(collection(db, 'orders', orderId, 'services', editingServiceId, 'documents', d.id, 'chunks'));
      const chunks = chunksSnap.docs.map(c => c.data()).sort((a, b) => a.index - b.index);
      const dataUrl = chunks.map(c => c.data).join('');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = d.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + err.message);
    }
  };

  const handleFileUpload = (e) => {
    uploadFile(e.target.files[0]);
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDeleteDocument = async (docId) => {
    if (!window.confirm('Delete this document?')) return;
    const chunksSnap = await getDocs(collection(db, 'orders', orderId, 'services', editingServiceId, 'documents', docId, 'chunks'));
    await Promise.all(chunksSnap.docs.map(c => deleteDoc(c.ref)));
    await deleteDoc(doc(db, 'orders', orderId, 'services', editingServiceId, 'documents', docId));
    await fetchDocuments(editingServiceId);
  };

  const openEditService = (s) => {
    setActiveType(s.type);
    setEditingServiceId(s.id);
    setShowServiceForm(true);
    setPasteText('');
    setHotelFocSelected(s.hotelFoc || 'none');
    fetchDocuments(s.id);
    setTimeout(() => {
      const f = serviceFormRef.current;
      if (!f) return;
      Object.keys(s).forEach(k => { if (f[k]) f[k].value = s[k] || ''; });
      if (f.svcName) f.svcName.value = s.name || '';
      if (s.cancellationDays && s.dateFrom) {
        const d = new Date(s.dateFrom);
        d.setDate(d.getDate() - parseInt(s.cancellationDays));
        setCancellationDateDisplay(d.toLocaleDateString('en-GB'));
      } else {
        setCancellationDateDisplay('');
      }
    }, 80);
  };

  const deleteService = async (sid) => {
    if (window.confirm('Delete this service?')) {
      await deleteDoc(doc(db, 'orders', orderId, 'services', sid));
      fetchData();
    }
  };

  const handleOrderUpdate = async (e) => {
    e.preventDefault();
    const f = orderFormRef.current;
    await updateDoc(doc(db, 'orders', orderId), {
      paxCount: f.paxCount.value,
      status: f.status.value,
      notes: f.notes.value,
    });
    setEditingOrder(false);
    fetchData();
  };

  const hotels = services.filter(s => s.type === 'hotel');
  const restaurants = services.filter(s => s.type === 'restaurant');
  const tickets = services.filter(s => s.type === 'ticket');
  const trainsBoats = services.filter(s => s.type === 'train_boat');
  const buses = services.filter(s => s.type === 'bus');
  const guides = services.filter(s => s.type === 'guide');
  const extras = services.filter(s => s.type === 'extra_cost');
  const others = services.filter(s => s.type === 'other');

  const StatusBadge = ({ status }) => {
    const s = SERVICE_STATUS.find(x => x.value === status) || SERVICE_STATUS[0];
    return <span style={{ background: s.bg, color: s.color, fontSize: 11, padding: '2px 7px', borderRadius: 5, fontWeight: 500, whiteSpace: 'nowrap' }}>{s.label}</span>;
  };

  const calculateHotelCost = (s) => {
    const nights = parseFloat(s.nights) || 0;
    const dbl = parseInt(s.dblRooms) || 0, sngl = parseInt(s.snglRooms) || 0, twn = parseInt(s.twnRooms) || 0, trpl = parseInt(s.trplRooms) || 0;
    const pDbl = parseFloat(s.pricePerDblRoom) || 0, pSngl = parseFloat(s.pricePerSnglRoom) || 0, pTwn = parseFloat(s.pricePerTwnRoom) || 0, pTrpl = parseFloat(s.pricePerTrplRoom) || 0;
    const totalRooms = dbl + sngl + twn + trpl;
    if (totalRooms === 0 || nights === 0) return null;

    const roomCostPerNight = dbl * pDbl + sngl * pSngl + twn * pTwn + trpl * pTrpl;
    const roomCost = roomCostPerNight * nights;

    let cityTaxCost = 0;
    const cityTax = parseFloat(s.cityTax) || 0;
    if (s.cityTaxIncluded !== 'included' && cityTax > 0) {
      if (s.cityTaxType === 'percent') {
        cityTaxCost = roomCost * (cityTax / 100);
      } else if (s.cityTaxType === 'per_room') {
        cityTaxCost = cityTax * totalRooms * nights;
      } else {
        const totalPax = dbl * 2 + sngl * 1 + twn * 2 + trpl * 3;
        cityTaxCost = cityTax * totalPax * nights;
      }
    }

    let total = roomCost + cityTaxCost;

    // Hotel FOC: 1 free person per X paying, occupying a room of given type
    let focInfo = null;
    let focDiscount = 0;
    if (s.hotelFoc && s.hotelFoc.startsWith('1 per ')) {
      const per = parseInt(s.hotelFoc.replace('1 per ', ''));
      const totalPax = dbl * 2 + sngl * 1 + twn * 2 + trpl * 3;
      if (per > 0 && totalPax > 0) {
        const freePersons = Math.floor(totalPax / per);
        if (freePersons > 0) {
          const occupancyMap = { sngl: { price: pSngl, share: 1 }, dbl: { price: pDbl, share: 2 }, twn: { price: pTwn, share: 2 }, trpl: { price: pTrpl, share: 3 } };
          const occ = occupancyMap[s.hotelFocOccupancy || 'dbl'];
          const perPersonPrice = occ.share > 0 ? occ.price / occ.share : 0;
          focDiscount = freePersons * perPersonPrice * nights;
          total -= focDiscount;
          const pct = occ.share === 1 ? '100%' : occ.share === 2 ? '50%' : '33%';
          focInfo = { freePersons, pct, occupancy: (s.hotelFocOccupancy || 'dbl').toUpperCase() };
        }
      }
    }

    return { roomCost, cityTaxCost, focDiscount, total, nights, totalRooms, focInfo, currency: s.currency || 'EUR' };
  };

  const SectionDivider = ({ title, count }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '1.5rem 0 0.75rem' }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: colors.primary, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{title}</div>
      {count > 0 && <span style={{ fontSize: 11, background: '#E6F1FB', color: '#0C447C', padding: '1px 6px', borderRadius: 10 }}>{count}</span>}
      <div style={{ flex: 1, height: 2, background: colors.border }} />
    </div>
  );

  const ServiceRow = ({ s }) => (
    <div onClick={() => openEditService(s)} style={{ display: 'grid', gridTemplateColumns: '22px 1fr 100px 120px 80px 28px', gap: 8, alignItems: 'start', padding: '10px 0', borderBottom: `1px solid ${colors.border}`, cursor: 'pointer' }}>
      <div style={{ fontSize: 15, paddingTop: 2 }}>{SERVICE_TYPES.find(t => t.value === s.type)?.icon || '📋'}</div>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: colors.text }}>{s.name}</div>
        {s.providerName && <div style={{ fontSize: 12, color: colors.muted }}>{s.providerName}</div>}
        {s.providerEmail && <div style={{ fontSize: 11 }}><a href={`mailto:${s.providerEmail}`} onClick={e => e.stopPropagation()} style={{ color: '#0C447C', textDecoration: 'none' }}>✉ {s.providerEmail}</a></div>}
        {s.providerEmail2 && <div style={{ fontSize: 11 }}><a href={`mailto:${s.providerEmail2}`} onClick={e => e.stopPropagation()} style={{ color: '#0C447C', textDecoration: 'none' }}>✉ {s.providerEmail2}</a></div>}
        {s.providerWebsite && <div style={{ fontSize: 11 }}><a href={s.providerWebsite.startsWith('http') ? s.providerWebsite : `https://${s.providerWebsite}`} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#0C447C', textDecoration: 'none' }}>🌐 {s.providerWebsite}</a></div>}
        {(s.providerName || s.name) && (
          <div style={{ fontSize: 11 }}>
            <a href="#" onClick={e => { e.stopPropagation(); navigate('providers', { expandProviderName: s.providerName || s.name, fromOrderId: order.id, fromOrderName: order.name }); }} style={{ color: colors.muted, textDecoration: 'underline' }}>
              → View in Providers
            </a>
          </div>
        )}
        {s.providerPhone && <div style={{ fontSize: 11, color: colors.muted }}>✆ {s.providerPhone}</div>}
        {s.city && <div style={{ fontSize: 11, color: colors.muted }}>{s.city}{s.dateFrom ? ` · ${s.dateFrom}` : ''}{s.nights ? ` · ${s.nights} nights` : ''}</div>}
        {s.type === 'hotel' && (
          <div style={{ fontSize: 11, color: colors.muted }}>
            {s.dblRooms ? `${s.dblRooms}×DBL` : ''}{s.snglRooms ? ` ${s.snglRooms}×SNGL` : ''}{s.twnRooms ? ` ${s.twnRooms}×TWN` : ''}{s.trplRooms ? ` ${s.trplRooms}×TRPL` : ''}
            {s.pricePerDblRoom ? ` · DBL ${s.pricePerDblRoom} ${s.currency}` : ''}
            {s.cityTax ? ` · city tax ${s.cityTax}` : ''}
            {s.dinners ? ` · ${s.dinners}× dinner ${s.dinnerPrice ? s.dinnerPrice + ' ' + s.currency : ''}` : ''}
            {s.hotelFoc && s.hotelFoc !== 'none' ? ` · FOC ${s.hotelFoc}` : ''}
            {s.cancellationDate ? (
              <span style={{ color: colors.danger, fontWeight: 700 }}> · Free cancellation until {new Date(s.cancellationDate).toLocaleDateString('en-GB')}</span>
            ) : (s.cancellationDays && s.dateFrom ? (() => {
              const d = new Date(s.dateFrom);
              d.setDate(d.getDate() - parseInt(s.cancellationDays));
              return <span style={{ color: colors.danger, fontWeight: 700 }}> · Free cancellation until {d.toLocaleDateString('en-GB')}</span>;
            })() : '')}
          </div>
        )}
        {s.type === 'hotel' && (() => {
          const calc = calculateHotelCost(s);
          if (!calc) return null;
          return (
            <div style={{ fontSize: 12, marginTop: 6, padding: '8px 10px', background: '#f0ede8', borderRadius: 6, color: colors.text }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: colors.muted }}>Rooms × {calc.nights} night(s)</span>
                <span>{calc.roomCost.toFixed(2)} {calc.currency}</span>
              </div>
              {calc.cityTaxCost > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: colors.muted }}>City tax</span>
                  <span>{calc.cityTaxCost.toFixed(2)} {calc.currency}</span>
                </div>
              )}
              {calc.focDiscount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: colors.muted }}>Hotel FOC discount ({calc.focInfo.freePersons}× {calc.focInfo.pct} of {calc.focInfo.occupancy})</span>
                  <span>-{calc.focDiscount.toFixed(2)} {calc.currency}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: `1px solid ${colors.border}`, marginTop: 4, paddingTop: 4 }}>
                <span>Total to pay hotel</span>
                <span>{calc.total.toFixed(2)} {calc.currency}</span>
              </div>
            </div>
          );
        })()}
        {s.type === 'ticket' && s.pricePerPax && (
          <div style={{ fontSize: 11, color: colors.muted }}>{s.pricePerPax} {s.currency}/person × {order?.paxCount || '?'} = {((parseFloat(s.pricePerPax) || 0) * (parseInt(order?.paxCount) || 0)).toFixed(0)} {s.currency}</div>
        )}
        {s.totalPrice && s.type !== 'ticket' && <div style={{ fontSize: 11, color: colors.muted }}>Total: {s.totalPrice} {s.currency}</div>}
        {s.confirmationLink && <div style={{ fontSize: 11 }}><a href={s.confirmationLink} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#0C447C', textDecoration: 'none' }}>🔗 Confirmation</a></div>}
        {s.notes && <div style={{ fontSize: 11, color: colors.muted, fontStyle: 'italic', marginTop: 2 }}>{s.notes}</div>}
      </div>
      <div style={{ fontSize: 12 }}>
        {s.optionDate && <div style={{ color: new Date(s.optionDate) < new Date() ? colors.danger : '#854f0b', fontWeight: 500 }}>Option: {s.optionDate}</div>}
      </div>
      <div style={{ fontSize: 12 }}>
        {s.depositDate && <div style={{ color: colors.muted }}>Deposit: {s.depositDate}</div>}
        {s.depositAmount && <div style={{ fontWeight: 500 }}>{s.depositAmount} {s.depositCurrency}</div>}
      </div>
      <StatusBadge status={s.status} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <button onClick={e => { e.stopPropagation(); deleteService(s.id); }} style={{ padding: '3px 7px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer', color: colors.danger }}>✕</button>
      </div>
    </div>
  );

  const ServicesBlock = ({ list }) => list.length > 0 ? (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '0.5rem 1.25rem' }}>
      {list.map(s => <ServiceRow key={s.id} s={s} />)}
    </div>
  ) : null;

  const iStyle = { width: '100%', padding: '7px 9px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const lbl = (t) => <label style={{ fontSize: 11, color: colors.muted, display: 'block', marginBottom: 3 }}>{t}</label>;

  if (loading) return <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div>;
  if (!order) return <div style={{ color: colors.muted }}>Order not found.</div>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <button onClick={() => navigate('orders')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.muted, fontSize: 14, padding: 0, fontFamily: 'inherit' }}>
          ← Orders
        </button>
        <div style={{ color: colors.border }}>|</div>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: colors.primary, margin: 0 }}>{order.name}</h1>
          <div style={{ fontSize: 13, color: colors.muted }}>
            {order.clientName} · {order.startDate} – {order.endDate} · {order.paxCount ? order.paxCount + ' pax' : 'pax TBC'} · FOC {order.focCount || 1} ({order.focType || 'dbl'}) · Margin {order.margin || 15}%
          </div>
        </div>
        <button onClick={() => setEditingOrder(!editingOrder)} style={{ padding: '6px 14px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 12, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit' }}>
          ✏ Edit order
        </button>
      </div>

      {editingOrder && (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '1.25rem', marginBottom: '1rem' }}>
          <form ref={orderFormRef} onSubmit={handleOrderUpdate}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 10 }}>
              <div>{lbl('Pax count (paying)')}<input name="paxCount" type="number" defaultValue={order.paxCount} placeholder="e.g. 20" style={iStyle} /></div>
              <div>{lbl('Status')}
                <select name="status" defaultValue={order.status} style={iStyle}>
                  {ORDER_STATUS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>{lbl('Notes')}<input name="notes" type="text" defaultValue={order.notes} style={iStyle} /></div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" style={{ padding: '7px 16px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Save</button>
              <button type="button" onClick={() => setEditingOrder(false)} style={{ padding: '7px 16px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit' }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: colors.muted, fontWeight: 600 }}>Exchange rates (→ EUR):</div>
          {Object.entries(rates).map(([cur, rate]) => (
            <div key={cur} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{cur}:</span>
              {showRates ? (
                <input type="number" step="0.001" value={rate} onChange={e => setRates({ ...rates, [cur]: parseFloat(e.target.value) })}
                  style={{ width: 58, padding: '2px 5px', border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12 }} />
              ) : (
                <span style={{ fontSize: 12, color: colors.muted }}>{rate}</span>
              )}
            </div>
          ))}
          <button onClick={() => setShowRates(!showRates)} style={{ padding: '3px 10px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit' }}>
            {showRates ? '✓ Done' : '✏ Edit rates'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        {SERVICE_TYPES.map(t => (
          <button key={t.value} onClick={() => { setActiveType(t.value); setEditingServiceId(null); setShowServiceForm(true); setPasteText(''); setDocuments([]); setCancellationDateDisplay(''); setHotelFocSelected('none'); setTimeout(() => serviceFormRef.current?.reset(), 50); }}
            style={{ padding: '7px 14px', background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: colors.text }}>
            {t.icon} + {t.label}
          </button>
        ))}
      </div>

      {showServiceForm && (
        <div style={{ background: colors.white, border: `2px solid ${colors.primary}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: colors.primary }}>
              {editingServiceId ? 'Edit' : 'Add'}: {SERVICE_TYPES.find(t => t.value === activeType)?.icon} {SERVICE_TYPES.find(t => t.value === activeType)?.label}
            </div>
            <button type="button" onClick={() => { setShowServiceForm(false); setEditingServiceId(null); }}
              style={{ padding: '6px 14px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
              ← Back to order
            </button>
          </div>
          <div style={{ background: '#f0ede8', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: 13, color: colors.primary, fontWeight: 500, marginBottom: 6 }}>📋 Paste from email to auto-fill</div>
            <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={2}
              placeholder="e.g. Bergen | 25/07 e 28/07 — 3 noites. Hospedagem no elegante Radisson Blu Royal Hotel..."
              style={{ width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 }} />
            <button type="button" onClick={handlePasteText} disabled={pasteLoading}
              style={{ padding: '7px 16px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', opacity: pasteLoading ? 0.6 : 1 }}>
              {pasteLoading ? 'Parsing...' : '📋 Parse into fields'}
            </button>
          </div>

          <form ref={serviceFormRef} onSubmit={handleServiceSubmit}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 10 }}>
              <div>{lbl('Name *')}<input name="svcName" type="text" required style={iStyle} placeholder={activeType === 'hotel' ? 'e.g. Novotel Amsterdam City' : activeType === 'ticket' ? 'e.g. Keukenhof Gardens' : ''} /></div>
              <div>{lbl('Provider / supplier')}
                <input name="providerName" type="text" list="provider-suggestions" style={iStyle}
                  onChange={(e) => {
                    const match = providers.find(p => p.name.toLowerCase() === e.target.value.toLowerCase());
                    const f = serviceFormRef.current;
                    if (match && f) {
                      if (!f.providerEmail.value) f.providerEmail.value = match.email || '';
                      if (!f.providerPhone.value) f.providerPhone.value = match.phone || '';
                      if (!f.city.value && match.city) f.city.value = match.city;
                      if (!f.svcName.value) f.svcName.value = match.name;
                    }
                  }} />
                <datalist id="provider-suggestions">
                  {providers.map(p => <option key={p.id} value={p.name} />)}
                </datalist>
              </div>
              <div>{lbl('City')}<input name="city" type="text" style={iStyle} /></div>
              <div>{lbl('Provider email')}<input name="providerEmail" type="email" style={iStyle} /></div>
              <div>{lbl('Provider email 2')}<input name="providerEmail2" type="email" style={iStyle} /></div>
              <div>{lbl('Provider phone')}<input name="providerPhone" type="text" style={iStyle} /></div>
              <div>{lbl('Provider website')}<input name="providerWebsite" type="text" placeholder="https://..." style={iStyle} /></div>
              <div>{lbl('Status')}
                <select name="status" style={iStyle}>
                  {SERVICE_STATUS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>{lbl('Date from')}<input name="dateFrom" type="date" style={iStyle} /></div>
              <div>{lbl('Date to')}<input name="dateTo" type="date" style={iStyle} /></div>
              {['hotel', 'restaurant'].includes(activeType) && <div>{lbl('Nights')}<input name="nights" type="number" style={iStyle} /></div>}
            </div>

            {activeType === 'hotel' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 8px', borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>Client rooms</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
                  <div>{lbl('DBL rooms')}<input name="dblRooms" type="number" placeholder="10" style={iStyle} /></div>
                  <div>{lbl('SNGL rooms')}<input name="snglRooms" type="number" placeholder="2" style={iStyle} /></div>
                  <div>{lbl('TWN rooms')}<input name="twnRooms" type="number" placeholder="0" style={iStyle} /></div>
                  <div>{lbl('TRPL rooms')}<input name="trplRooms" type="number" placeholder="0" style={iStyle} /></div>
                  <div>{lbl('Price DBL / room / night')}<input name="pricePerDblRoom" type="number" placeholder="150" style={iStyle} /></div>
                  <div>{lbl('Price SNGL / room / night')}<input name="pricePerSnglRoom" type="number" placeholder="120" style={iStyle} /></div>
                  <div>{lbl('Price TWN / room / night')}<input name="pricePerTwnRoom" type="number" placeholder="150" style={iStyle} /></div>
                  <div>{lbl('Price TRPL / room / night')}<input name="pricePerTrplRoom" type="number" placeholder="190" style={iStyle} /></div>
                  <div>{lbl('City tax amount')}<input name="cityTax" type="number" placeholder="4.20" style={iStyle} /></div>
                  <div>{lbl('City tax basis')}
                    <select name="cityTaxIncluded" style={iStyle}>
                      <option value="separate">Charged separately</option>
                      <option value="included">Included in room price</option>
                    </select>
                  </div>
                  <div>{lbl('City tax calculated')}
                    <select name="cityTaxType" style={iStyle}>
                      <option value="per_person">Per person / night</option>
                      <option value="per_room">Per room / night</option>
                      <option value="percent">% of room price</option>
                    </select>
                  </div>
                  <div>{lbl('Hotel FOC policy')}
                    <select name="hotelFoc" style={iStyle} onChange={(e) => setHotelFocSelected(e.target.value)}>
                      <option value="none">No FOC</option>
                      <option value="1 per 10">1 free person per 10 paying</option>
                      <option value="1 per 15">1 free person per 15 paying</option>
                      <option value="1 per 18">1 free person per 18 paying</option>
                      <option value="1 per 20">1 free person per 20 paying</option>
                      <option value="custom">Custom (see notes)</option>
                    </select>
                  </div>
                  {hotelFocSelected !== 'none' ? (
                    <div>{lbl('FOC person occupies')}
                      <select name="hotelFocOccupancy" style={iStyle}>
                        <option value="sngl">SNGL room (100% free)</option>
                        <option value="dbl">DBL room (50% of room free)</option>
                        <option value="twn">TWN room (50% of room free)</option>
                        <option value="trpl">TRPL room (33% of room free)</option>
                      </select>
                    </div>
                  ) : (
                    <div>{lbl('FOC person occupies')}
                      <input value="—" disabled style={{ ...iStyle, color: colors.muted, background: '#f7f6f3' }} />
                      <input type="hidden" name="hotelFocOccupancy" value="dbl" />
                    </div>
                  )}
                  <div>{lbl('Free cancellation (days before arrival)')}
                    <input name="cancellationDays" type="number" placeholder="e.g. 60" style={iStyle}
                      onChange={(e) => {
                        const f = serviceFormRef.current;
                        const days = parseInt(e.target.value);
                        const dateFrom = f?.dateFrom?.value;
                        if (days && dateFrom) {
                          const d = new Date(dateFrom);
                          d.setDate(d.getDate() - days);
                          setCancellationDateDisplay(d.toLocaleDateString('en-GB'));
                          if (f.cancellationDate) f.cancellationDate.value = '';
                        } else {
                          setCancellationDateDisplay('');
                        }
                      }} />
                    {cancellationDateDisplay && <div style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>Deadline: {cancellationDateDisplay}</div>}
                  </div>
                  <div>{lbl('...or enter exact deadline date')}
                    <input name="cancellationDate" type="date" style={iStyle}
                      onChange={(e) => {
                        const f = serviceFormRef.current;
                        if (e.target.value) {
                          if (f.cancellationDays) f.cancellationDays.value = '';
                          setCancellationDateDisplay('');
                        }
                      }} />
                  </div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 8px', borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>Meals in hotel</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
                  <div>{lbl('Dinners (nights)')}<input name="dinners" type="number" placeholder="1" style={iStyle} /></div>
                  <div>{lbl('Dinner price / person')}<input name="dinnerPrice" type="number" placeholder="28" style={iStyle} /></div>
                  <div>{lbl('Lunches (days)')}<input name="lunches" type="number" placeholder="0" style={iStyle} /></div>
                  <div>{lbl('Lunch price / person')}<input name="lunchPrice" type="number" placeholder="22" style={iStyle} /></div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 8px', borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>Guide & driver accommodation</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
                  <div>{lbl('Guide room type')}
                    <select name="guideRoom" style={iStyle}>
                      <option value="">No guide</option>
                      <option value="sngl">SNGL (same hotel)</option>
                      <option value="dbl">DBL (same hotel)</option>
                    </select>
                  </div>
                  <div>{lbl('Guide room price / night')}<input name="guideRoomPrice" type="number" placeholder="same as client" style={iStyle} /></div>
                  <div>{lbl('Driver accommodation')}
                    <select name="driverAccom" style={iStyle}>
                      <option value="none">Goes home</option>
                      <option value="same">Same hotel</option>
                      <option value="other">Different hotel</option>
                    </select>
                  </div>
                  <div>{lbl('Driver room price / night')}<input name="driverRoomPrice" type="number" placeholder="0" style={iStyle} /></div>
                </div>
              </>
            )}

            {activeType === 'ticket' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 }}>
                <div>{lbl('Price / person')}<input name="pricePerPax" type="number" placeholder="26" style={iStyle} /></div>
              </div>
            )}

            {!['hotel', 'ticket'].includes(activeType) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 }}>
                <div>{lbl('Price / person (if applicable)')}<input name="pricePerPax" type="number" style={iStyle} /></div>
                <div>{lbl('Total price (if flat fee)')}<input name="totalPrice" type="number" style={iStyle} /></div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10, borderTop: `1px solid ${colors.border}`, paddingTop: 12, marginTop: 4 }}>
              <div>{lbl('Currency')}
                <select name="currency" style={iStyle}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>{lbl('Option date')}<input name="optionDate" type="date" style={iStyle} /></div>
              <div>{lbl('Deposit date')}<input name="depositDate" type="date" style={iStyle} /></div>
              <div>{lbl('Deposit amount')}<input name="depositAmount" type="number" style={iStyle} /></div>
              <div style={{ gridColumn: '1 / -1' }}>{lbl('Confirmation link (hotel/supplier portal)')}<input name="confirmationLink" type="text" placeholder="https://..." style={iStyle} /></div>
            </div>

            <div style={{ marginBottom: 12 }}>
              {lbl('Notes')}<textarea name="notes" rows={2} style={{ ...iStyle, resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" style={{ padding: '8px 18px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                {editingServiceId ? 'Save changes' : 'Add service'}
              </button>
              <button type="button" onClick={() => { setShowServiceForm(false); setEditingServiceId(null); }}
                style={{ padding: '8px 18px', background: 'transparent', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                Cancel
              </button>
            </div>
          </form>

          {editingServiceId && (
            <div style={{ marginTop: '1.25rem', borderTop: `1px solid ${colors.border}`, paddingTop: '1rem' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                📎 Documents ({documents.length})
              </div>
              <div onDrop={handleDrop} onDragOver={handleDragOver}
                style={{ marginBottom: 10, padding: '1.25rem', border: `2px dashed ${colors.border}`, borderRadius: 8, textAlign: 'center', background: '#fafaf8' }}>
                <div style={{ fontSize: 13, color: colors.muted, marginBottom: 8 }}>
                  {docUploading ? 'Uploading...' : 'Drag & drop a file here (PDF, image — max ~5 MB)'}
                </div>
                <label style={{ display: 'inline-block', padding: '6px 14px', background: '#f0ede8', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: colors.text }}>
                  or browse files
                  <input type="file" onChange={handleFileUpload} disabled={docUploading} style={{ display: 'none' }} />
                </label>
              </div>
              {documents.length === 0 ? (
                <div style={{ fontSize: 13, color: colors.muted }}>No documents uploaded yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {documents.map(d => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f7f6f3', borderRadius: 7, fontSize: 13 }}>
                      <span style={{ fontSize: 16 }}>{d.type?.includes('pdf') ? '📄' : '🖼'}</span>
                      <a href="#" onClick={e => { e.preventDefault(); handleDownloadDocument(d); }} style={{ flex: 1, color: colors.text, textDecoration: 'none', fontWeight: 500 }}>{d.name}</a>
                      <span style={{ fontSize: 11, color: colors.muted }}>{new Date(d.uploadedAt).toLocaleDateString('en-GB')}</span>
                      <span style={{ fontSize: 11, color: colors.muted }}>{Math.round((d.size || 0) / 1024)} KB</span>
                      <button onClick={() => handleDeleteDocument(d.id)} style={{ padding: '3px 8px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer', color: colors.danger }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {services.length === 0 && !showServiceForm && (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '2.5rem', textAlign: 'center', color: colors.muted, fontSize: 14 }}>
          No services yet. Use the buttons above to add hotels, restaurants, tickets, and other services.
        </div>
      )}

      {hotels.length > 0 && <><SectionDivider title="Hotels" count={hotels.length} /><ServicesBlock list={hotels} /></>}
      {restaurants.length > 0 && <><SectionDivider title="Restaurants" count={restaurants.length} /><ServicesBlock list={restaurants} /></>}
      {tickets.length > 0 && <><SectionDivider title="Tickets / per person" count={tickets.length} /><ServicesBlock list={tickets} /></>}
      {trainsBoats.length > 0 && <><SectionDivider title="Train / boat" count={trainsBoats.length} /><ServicesBlock list={trainsBoats} /></>}
      {buses.length > 0 && <><SectionDivider title="Bus" count={buses.length} /><ServicesBlock list={buses} /></>}
      {guides.length > 0 && <><SectionDivider title="Guides" count={guides.length} /><ServicesBlock list={guides} /></>}
      {extras.length > 0 && <><SectionDivider title="Extra costs" count={extras.length} /><ServicesBlock list={extras} /></>}
      {others.length > 0 && <><SectionDivider title="Other" count={others.length} /><ServicesBlock list={others} /></>}
    </div>
  );
}
