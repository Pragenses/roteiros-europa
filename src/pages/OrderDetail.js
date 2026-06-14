import React, { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc, collection, getDocs, addDoc, deleteDoc, updateDoc } from 'firebase/firestore';
import { parseServiceText, parseServiceDocument, aiFillProviderFree } from '../lib/ai';

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
  const [ratesUpdatedAt, setRatesUpdatedAt] = useState(null);
  const [ratesLoading, setRatesLoading] = useState(false);
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
    setServices(svcSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !(s.draft && !s.name)));
    const provSnap = await getDocs(collection(db, 'providers'));
    setProviders(provSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, [orderId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fetchLiveRates = useCallback(async () => {
    setRatesLoading(true);
    try {
      const symbols = Object.keys(DEFAULT_RATES).join(',');
      const resp = await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${symbols}`);
      const data = await resp.json();
      if (data && data.rates) {
        const newRates = {};
        Object.entries(data.rates).forEach(([cur, value]) => {
          if (value > 0) newRates[cur] = 1 / value; // value = "1 EUR = X cur" -> we want "1 cur = ? EUR"
        });
        setRates(prev => ({ ...prev, ...newRates }));
        setRatesUpdatedAt(data.date || new Date().toISOString().slice(0, 10));
      }
    } catch (err) {
      console.error('Failed to fetch live exchange rates', err);
    }
    setRatesLoading(false);
  }, []);

  useEffect(() => { fetchLiveRates(); }, [fetchLiveRates]);

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
      ticketCount: f.ticketCount?.value || '',
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
      driverNights: f.driverNights?.value || '',
      hotelFoc: f.hotelFoc?.value || 'none',
      hotelFocOccupancy: f.hotelFocOccupancy?.value || 'dbl',
      cancellationDays: f.cancellationDays?.value || '',
      cancellationDate: f.cancellationDate?.value || '',
      pricePerPax: f.pricePerPax?.value || '',
      totalPrice: f.totalPrice?.value || '',
      draft: false,
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

  const closeServiceForm = async () => {
    // If this was a freshly-created draft that was never filled in, remove it
    if (editingServiceId) {
      const f = serviceFormRef.current;
      const nameVal = f?.svcName?.value?.trim();
      if (!nameVal) {
        try {
          const snap = await getDoc(doc(db, 'orders', orderId, 'services', editingServiceId));
          if (snap.exists() && snap.data().draft) {
            await deleteDoc(doc(db, 'orders', orderId, 'services', editingServiceId));
          }
        } catch (err) {
          console.error('Failed to clean up draft:', err);
        }
      }
    }
    setShowServiceForm(false);
    setEditingServiceId(null);
    fetchData();
  };

  const createHotelServiceFromParsed = async (parsed) => {
    const data = {
      type: 'hotel',
      name: parsed.name || '',
      providerName: parsed.name || '',
      providerEmail: parsed.email || '',
      providerEmail2: '',
      providerWebsite: parsed.website || '',
      providerPhone: parsed.phone || '',
      city: parsed.city || '',
      dateFrom: parsed.dateFrom || '',
      dateTo: parsed.dateTo || '',
      ticketCount: '',
      nights: parsed.nights || '',
      currency: parsed.currency || 'EUR',
      status: 'enquired',
      optionDate: '',
      depositDate: '',
      depositAmount: '',
      depositCurrency: 'EUR',
      confirmationLink: '',
      notes: parsed.notes || '',
      dblRooms: parsed.dblRooms || '',
      snglRooms: parsed.snglRooms || '',
      twnRooms: parsed.twnRooms || '',
      trplRooms: parsed.trplRooms || '',
      pricePerDblRoom: parsed.pricePerDblRoom || '',
      pricePerSnglRoom: parsed.pricePerSnglRoom || '',
      pricePerTwnRoom: parsed.pricePerTwnRoom || '',
      pricePerTrplRoom: parsed.pricePerTrplRoom || '',
      cityTax: parsed.cityTax || '',
      cityTaxIncluded: parsed.cityTaxIncluded || 'separate',
      cityTaxType: parsed.cityTaxType || 'per_person',
      dinners: parsed.dinners || '',
      dinnerPrice: parsed.dinnerPrice || '',
      lunches: parsed.lunches || '',
      lunchPrice: parsed.lunchPrice || '',
      guideRoom: '',
      guideRoomPrice: '',
      driverAccom: 'none',
      driverRoomPrice: '',
      driverNights: '',
      hotelFoc: parsed.hotelFoc || 'none',
      hotelFocOccupancy: parsed.hotelFocOccupancy || 'dbl',
      cancellationDays: parsed.cancellationDays || '',
      cancellationDate: parsed.cancellationDate || '',
      pricePerPax: '',
      totalPrice: '',
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    await addDoc(collection(db, 'orders', orderId, 'services'), data);

    // Auto-create provider if it doesn't exist yet
    const providerNameToSave = (data.providerName || '').trim();
    if (providerNameToSave) {
      const exists = providers.find(p => p.name.toLowerCase().trim() === providerNameToSave.toLowerCase());
      if (!exists) {
        await addDoc(collection(db, 'providers'), {
          name: providerNameToSave,
          type: 'hotel',
          city: data.city || '', country: '', address: '', zip: '', vat: '', ico: '', website: '', iban: '', billingEmail: '',
          email: '', phone: '', notes: '',
          contacts: [{ name: '', role: '', email: '', phone: '' }],
          createdAt: new Date().toISOString(),
        });
      }
    }
  };

  const applyParsedFields = async (parsed) => {
    const f = serviceFormRef.current;
    if (!f) return;
    if (parsed.name && f.svcName) f.svcName.value = parsed.name;
    if (parsed.city && f.city) f.city.value = parsed.city;
    if (parsed.dateFrom && f.dateFrom) f.dateFrom.value = parsed.dateFrom;
    if (parsed.dateTo && f.dateTo) f.dateTo.value = parsed.dateTo;
    if (parsed.nights && f.nights) f.nights.value = parsed.nights;
    if ((!parsed.nights || parsed.nights === '') && parsed.dateFrom && parsed.dateTo && f.nights) {
      const d1 = new Date(parsed.dateFrom);
      const d2 = new Date(parsed.dateTo);
      const diff = Math.round((d2 - d1) / 86400000);
      if (diff > 0) f.nights.value = diff;
    }

    if (activeType === 'hotel') {
      const numFields = ['dblRooms', 'pricePerDblRoom', 'snglRooms', 'pricePerSnglRoom', 'twnRooms', 'pricePerTwnRoom', 'trplRooms', 'pricePerTrplRoom', 'cityTax', 'dinners', 'dinnerPrice', 'lunches', 'lunchPrice', 'cancellationDays'];
      numFields.forEach(key => {
        if (parsed[key] !== undefined && parsed[key] !== '' && f[key]) f[key].value = parsed[key];
      });
      if (parsed.currency && f.currency) f.currency.value = parsed.currency;
      if (parsed.cityTaxIncluded && f.cityTaxIncluded) f.cityTaxIncluded.value = parsed.cityTaxIncluded;
      if (parsed.cityTaxType && f.cityTaxType) f.cityTaxType.value = parsed.cityTaxType;
      if (parsed.notes && f.notes && !f.notes.value) f.notes.value = parsed.notes;

      if (parsed.hotelFoc && f.hotelFoc) {
        f.hotelFoc.value = parsed.hotelFoc;
        setHotelFocSelected(parsed.hotelFoc);
      }
      if (parsed.hotelFocOccupancy && f.hotelFocOccupancy) f.hotelFocOccupancy.value = parsed.hotelFocOccupancy;

      if (parsed.cancellationDate && f.cancellationDate) {
        f.cancellationDate.value = parsed.cancellationDate;
        if (f.cancellationDays) f.cancellationDays.value = '';
        setCancellationDateDisplay('');
      } else if (parsed.cancellationDays && f.cancellationDays) {
        f.cancellationDays.value = parsed.cancellationDays;
        if (f.cancellationDate) f.cancellationDate.value = '';
        const dateFrom = parsed.dateFrom || f.dateFrom?.value;
        if (dateFrom) {
          const d = new Date(dateFrom);
          d.setDate(d.getDate() - parseInt(parsed.cancellationDays));
          setCancellationDateDisplay(d.toLocaleDateString('en-GB'));
        }
      }
    }
    // Try to match against known providers to auto-fill provider/email/phone
    if (parsed.name && f.providerName) {
      const match = providers.find(p => p.name.toLowerCase().trim() === parsed.name.toLowerCase().trim()
        || p.name.toLowerCase().includes(parsed.name.toLowerCase())
        || parsed.name.toLowerCase().includes(p.name.toLowerCase()));
      if (match) {
        f.providerName.value = match.name;
        if (!f.providerEmail.value) f.providerEmail.value = match.email || '';
        if (!f.providerPhone.value) f.providerPhone.value = match.phone || '';
        if (!f.providerWebsite.value) f.providerWebsite.value = match.website || '';
        if (!f.city.value && match.city) f.city.value = match.city;
      } else {
        f.providerName.value = parsed.name;
      }
      // Contact info found directly in the pasted text/document takes priority (most accurate, specific to this hotel/email)
      if (parsed.email && f.providerEmail && !f.providerEmail.value) f.providerEmail.value = parsed.email;
      if (parsed.phone && f.providerPhone && !f.providerPhone.value) f.providerPhone.value = parsed.phone;
      if (parsed.website && f.providerWebsite && !f.providerWebsite.value) f.providerWebsite.value = parsed.website;
      // If email/phone/website are still missing, fall back to a web search
      if (!f.providerEmail.value || !f.providerPhone.value || !f.providerWebsite.value) {
        try {
          const webInfo = await aiFillProviderFree(parsed.name);
          if (webInfo.email && f.providerEmail && !f.providerEmail.value) f.providerEmail.value = webInfo.email;
          if (webInfo.phone && f.providerPhone && !f.providerPhone.value) f.providerPhone.value = webInfo.phone;
          if (webInfo.website && f.providerWebsite && !f.providerWebsite.value) f.providerWebsite.value = webInfo.website;
          if (webInfo.city && f.city && !f.city.value) f.city.value = webInfo.city;
        } catch (webErr) {
          console.error('Web lookup failed:', webErr);
          // Non-fatal - just leave email/phone/website empty, user can fill manually
        }
      }
    }
  };

  const handleParsedResult = async (parsed) => {
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) { alert('Could not find any hotels in this text.'); return; }
      // Apply the first hotel to the current form
      await applyParsedFields(parsed[0]);
      const rest = parsed.slice(1);
      if (rest.length > 0) {
        const names = rest.map(p => p.name || '(unnamed)').join(', ');
        const ok = window.confirm(`Found ${parsed.length} hotels in this text. The first (${parsed[0].name || ''}) was filled into this form.\n\nAdd the other ${rest.length} as separate hotel services too?\n${names}`);
        if (ok) {
          for (const item of rest) {
            await createHotelServiceFromParsed(item);
          }
          await fetchData();
          alert(`Added ${rest.length} additional hotel service(s). You'll find them in the Hotels section.`);
        }
      }
    } else {
      await applyParsedFields(parsed);
    }
  };

  const handlePasteText = async () => {
    if (!pasteText.trim()) { alert('Paste some text first.'); return; }
    setPasteLoading(true);
    try {
      const parsed = await parseServiceText(pasteText, activeType);
      await handleParsedResult(parsed);
    } catch (err) {
      console.error(err);
      alert('Could not parse this text: ' + err.message);
    }
    setPasteLoading(false);
  };

  const handleContractUpload = async (file) => {
    if (!file) return;
    if (file.size > 10000000) { alert('File too large for AI parsing (max ~10 MB).'); return; }
    setPasteLoading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const mediaType = file.type || 'application/pdf';
      const parsed = await parseServiceDocument(base64, mediaType, activeType);
      await handleParsedResult(parsed);
    } catch (err) {
      console.error(err);
      alert('Could not parse this document: ' + err.message);
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
      if (chunks.length === 0) { alert('No data found for this document.'); return; }
      const dataUrl = chunks.map(c => c.data).join('');
      const commaIdx = dataUrl.indexOf(',');
      const meta = dataUrl.slice(0, commaIdx); // e.g. "data:application/pdf;base64"
      const base64 = dataUrl.slice(commaIdx + 1);
      const mimeMatch = meta.match(/data:(.*);base64/);
      const mime = mimeMatch ? mimeMatch[1] : (d.type || 'application/octet-stream');
      const byteChars = atob(base64);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error(err);
      alert('Download failed: ' + err.message);
    }
  };

  const handleFileUpload = (e) => {
    uploadFile(e.target.files[0]);
    e.target.value = '';
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    let file = e.dataTransfer.files?.[0];
    if (!file && e.dataTransfer.items) {
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        const item = e.dataTransfer.items[i];
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) { file = f; break; }
        }
      }
    }
    if (!file) {
      // Webmail clients (Gmail, Outlook web) often use a "DownloadURL" / uri-list payload instead of a real File
      const downloadUrl = e.dataTransfer.getData('DownloadURL') || e.dataTransfer.getData('text/uri-list');
      if (downloadUrl) {
        try {
          const parts = downloadUrl.split(':');
          let url = downloadUrl;
          let suggestedName = 'attachment';
          if (parts.length >= 3 && (downloadUrl.startsWith('application') || downloadUrl.includes(':'))) {
            // Format is often "mime/type:filename:url"
            const firstColon = downloadUrl.indexOf(':');
            const secondColon = downloadUrl.indexOf(':', firstColon + 1);
            if (secondColon > -1) {
              suggestedName = downloadUrl.slice(firstColon + 1, secondColon);
              url = downloadUrl.slice(secondColon + 1);
            }
          }
          const resp = await fetch(url);
          const blob = await resp.blob();
          file = new File([blob], suggestedName, { type: blob.type });
        } catch (err) {
          console.error('Attachment fetch failed', err);
        }
      }
    }
    if (file) {
      uploadFile(file);
    } else {
      const types = Array.from(e.dataTransfer.types || []);
      const items = Array.from(e.dataTransfer.items || []).map(it => `${it.kind}/${it.type}`);
      console.log('Drop debug - types:', types, 'items:', items);
      window.prompt('Could not read this as a file directly. Debug info below (select & copy and send to support):', 'types: ' + types.join(', ') + ' | items: ' + items.join(', '));
    }
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

  const sortByDate = (arr) => [...arr].sort((a, b) => {
    const da = a.dateFrom || '9999-99-99';
    const db = b.dateFrom || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
  });
  const hotels = sortByDate(services.filter(s => s.type === 'hotel'));
  const restaurants = sortByDate(services.filter(s => s.type === 'restaurant'));
  const tickets = sortByDate(services.filter(s => s.type === 'ticket'));
  const trainsBoats = sortByDate(services.filter(s => s.type === 'train_boat'));
  const buses = sortByDate(services.filter(s => s.type === 'bus'));
  const guides = sortByDate(services.filter(s => s.type === 'guide'));
  const extras = sortByDate(services.filter(s => s.type === 'extra_cost'));
  const others = sortByDate(services.filter(s => s.type === 'other'));

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
    const cur = s.currency || 'EUR';
    const lines = [];

    let roomCost = 0;
    if (dbl > 0) { const amt = dbl * pDbl * nights; roomCost += amt; lines.push({ label: `${dbl}× DBL @ ${pDbl} ${cur} × ${nights} night(s)`, amount: amt }); }
    if (sngl > 0) { const amt = sngl * pSngl * nights; roomCost += amt; lines.push({ label: `${sngl}× SNGL @ ${pSngl} ${cur} × ${nights} night(s)`, amount: amt }); }
    if (twn > 0) { const amt = twn * pTwn * nights; roomCost += amt; lines.push({ label: `${twn}× TWN @ ${pTwn} ${cur} × ${nights} night(s)`, amount: amt }); }
    if (trpl > 0) { const amt = trpl * pTrpl * nights; roomCost += amt; lines.push({ label: `${trpl}× TRPL @ ${pTrpl} ${cur} × ${nights} night(s)`, amount: amt }); }

    const totalPax = dbl * 2 + sngl * 1 + twn * 2 + trpl * 3;

    let cityTaxCost = 0;
    const cityTax = parseFloat(s.cityTax) || 0;
    if (s.cityTaxIncluded !== 'included' && cityTax > 0) {
      if (s.cityTaxType === 'percent') {
        cityTaxCost = roomCost * (cityTax / 100);
        lines.push({ label: `City tax: ${cityTax}% of room cost (${roomCost.toFixed(2)} ${cur})`, amount: cityTaxCost });
      } else if (s.cityTaxType === 'per_room') {
        cityTaxCost = cityTax * totalRooms * nights;
        lines.push({ label: `City tax: ${totalRooms} room(s) × ${cityTax} ${cur} × ${nights} night(s)`, amount: cityTaxCost });
      } else {
        cityTaxCost = cityTax * totalPax * nights;
        lines.push({ label: `City tax: ${totalPax} pax × ${cityTax} ${cur} × ${nights} night(s)`, amount: cityTaxCost });
      }
    }

    // Meals (dinners/lunches) - per person for everyone staying at this hotel
    const dinnersCount = parseFloat(s.dinners) || 0;
    const dinnerPrice = parseFloat(s.dinnerPrice) || 0;
    const dinnerCost = dinnersCount * dinnerPrice * totalPax;
    if (dinnerCost > 0) lines.push({ label: `Dinners: ${dinnersCount}× × ${totalPax} pax × ${dinnerPrice} ${cur}`, amount: dinnerCost });

    const lunchesCount = parseFloat(s.lunches) || 0;
    const lunchPrice = parseFloat(s.lunchPrice) || 0;
    const lunchCost = lunchesCount * lunchPrice * totalPax;
    if (lunchCost > 0) lines.push({ label: `Lunches: ${lunchesCount}× × ${totalPax} pax × ${lunchPrice} ${cur}`, amount: lunchCost });

    // Guide accommodation - stays the full hotel period
    let guideCost = 0;
    if (s.guideRoom && s.guideRoomPrice) {
      guideCost = (parseFloat(s.guideRoomPrice) || 0) * nights;
      lines.push({ label: `Guide room (${s.guideRoom.toUpperCase()}) @ ${s.guideRoomPrice} ${cur} × ${nights} night(s)`, amount: guideCost });
    }

    // Driver accommodation - may stay only some nights
    let driverCost = 0;
    if (s.driverAccom && s.driverAccom !== 'none' && s.driverRoomPrice) {
      const driverNights = s.driverNights ? parseFloat(s.driverNights) : nights;
      driverCost = (parseFloat(s.driverRoomPrice) || 0) * driverNights;
      lines.push({ label: `Driver room @ ${s.driverRoomPrice} ${cur} × ${driverNights} night(s)`, amount: driverCost });
    }

    // Hotel FOC: 1 free person per X paying, occupying a room of given type
    let focDiscount = 0;
    if (s.hotelFoc && s.hotelFoc.startsWith('1 per ')) {
      const per = parseInt(s.hotelFoc.replace('1 per ', ''));
      if (per > 0 && totalPax > 0) {
        const freePersons = Math.floor(totalPax / per);
        if (freePersons > 0) {
          const occupancyMap = { sngl: { price: pSngl, share: 1, label: 'SNGL', pct: '100%' }, dbl: { price: pDbl, share: 2, label: 'DBL', pct: '50%' }, twn: { price: pTwn, share: 2, label: 'TWN', pct: '50%' }, trpl: { price: pTrpl, share: 3, label: 'TRPL', pct: '33%' } };
          const occ = occupancyMap[s.hotelFocOccupancy || 'dbl'];
          const perPersonPrice = occ.share > 0 ? occ.price / occ.share : 0;
          focDiscount = freePersons * perPersonPrice * nights;
          lines.push({ label: `Hotel FOC: ${freePersons}× free person (${occ.pct} of ${occ.label} @ ${occ.price} ${cur}) × ${nights} night(s)`, amount: -focDiscount });
        }
      }
    }

    const total = lines.reduce((sum, l) => sum + l.amount, 0);

    return { lines, total, nights, totalRooms, currency: cur };
  };

  // Generic cost for any service (used in Cost Summary across all types)
  const getServiceCost = (s) => {
    const cur = s.currency || 'EUR';
    if (s.type === 'hotel') {
      const calc = calculateHotelCost(s);
      return calc ? { total: calc.total, currency: cur } : null;
    }
    if (s.type === 'ticket') {
      const count = parseFloat(s.ticketCount) || 0;
      const price = parseFloat(s.pricePerPax) || 0;
      if (count > 0 && price > 0) return { total: count * price, currency: cur };
      return null;
    }
    // Other types: use totalPrice (flat fee) or pricePerPax × order pax count
    if (s.totalPrice) {
      return { total: parseFloat(s.totalPrice) || 0, currency: cur };
    }
    if (s.pricePerPax) {
      const pax = parseInt(order?.paxCount) || 0;
      if (pax > 0) return { total: (parseFloat(s.pricePerPax) || 0) * pax, currency: cur };
    }
    return null;
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
              <span style={{ color: '#dc2626', fontWeight: 700 }}> · Free cancellation until {new Date(s.cancellationDate).toLocaleDateString('en-GB')}</span>
            ) : (s.cancellationDays && s.dateFrom ? (() => {
              const d = new Date(s.dateFrom);
              d.setDate(d.getDate() - parseInt(s.cancellationDays));
              return <span style={{ color: '#dc2626', fontWeight: 700 }}> · Free cancellation until {d.toLocaleDateString('en-GB')}</span>;
            })() : '')}
          </div>
        )}
        {s.type === 'hotel' && (() => {
          const calc = calculateHotelCost(s);
          if (!calc) return null;
          return (
            <div style={{ fontSize: 12, marginTop: 6, padding: '8px 10px', background: '#f0ede8', borderRadius: 6, color: colors.text }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>How this is calculated:</div>
              {calc.lines.map((line, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ color: colors.muted }}>{line.label}</span>
                  <span style={{ whiteSpace: 'nowrap' }}>{line.amount < 0 ? '-' : ''}{Math.abs(line.amount).toFixed(2)} {calc.currency}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, borderTop: `1px solid ${colors.border}`, marginTop: 4, paddingTop: 4 }}>
                <span>Total to pay hotel</span>
                <span style={{ color: '#dc2626' }}>{calc.total.toFixed(2)} {calc.currency}</span>
              </div>
            </div>
          );
        })()}
        {s.type === 'ticket' && s.pricePerPax && (
          <div style={{ fontSize: 12, marginTop: 4, padding: '6px 10px', background: '#f0ede8', borderRadius: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: colors.muted }}>{s.ticketCount || '?'} ticket(s) × {s.pricePerPax} {s.currency}</span>
              <span style={{ fontWeight: 700, color: '#dc2626' }}>{s.ticketCount ? ((parseFloat(s.pricePerPax) || 0) * (parseInt(s.ticketCount) || 0)).toFixed(2) : '?'} {s.currency}</span>
            </div>
          </div>
        )}
        {s.totalPrice && s.type !== 'ticket' && (
          <div style={{ fontSize: 12, marginTop: 4, padding: '6px 10px', background: '#f0ede8', borderRadius: 6, display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: colors.muted }}>Total price</span>
            <span style={{ fontWeight: 700, color: '#dc2626' }}>{parseFloat(s.totalPrice).toFixed(2)} {s.currency}</span>
          </div>
        )}
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
  // Allow comma as decimal separator (common in European number entry), normalize to a period
  const decimalInput = (e) => {
    const val = e.target.value;
    const normalized = val.replace(',', '.');
    if (normalized !== val) e.target.value = normalized;
  };

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

      {services.length > 0 && (() => {
        const rows = services.map(s => ({ s, cost: getServiceCost(s) })).filter(r => r.cost);
        if (rows.length === 0) return null;
        const byCurrency = {};
        rows.forEach(({ cost }) => {
          byCurrency[cost.currency] = (byCurrency[cost.currency] || 0) + cost.total;
        });
        const sortedRows = [...rows].sort((a, b) => {
          const da = a.s.dateFrom || '9999-99-99';
          const db = b.s.dateFrom || '9999-99-99';
          return da < db ? -1 : da > db ? 1 : 0;
        });
        return (
          <div style={{ background: colors.white, border: `2px solid ${colors.primary}`, borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>💰 Cost Summary — All services</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {sortedRows.map(({ s, cost }, i) => (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0', borderBottom: i < sortedRows.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                  <span style={{ color: colors.text }}>
                    {SERVICE_TYPES.find(t => t.value === s.type)?.icon || '📋'} {s.name}{s.city ? ` (${s.city})` : ''}{s.dateFrom ? ` · ${s.dateFrom}` : ''}
                  </span>
                  <span style={{ fontWeight: 600 }}>{cost.total.toFixed(2)} {cost.currency}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: `2px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {Object.entries(byCurrency).map(([cur, total]) => (
                <div key={cur} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700, color: colors.primary }}>
                  <span>Total ({cur})</span>
                  <span>{total.toFixed(2)} {cur}</span>
                </div>
              ))}
            </div>
            {(() => {
              const eurTotal = Object.entries(byCurrency).reduce((sum, [cur, total]) => {
                const rate = cur === 'EUR' ? 1 : (rates[cur] || 0);
                return sum + total * rate;
              }, 0);
              return (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', fontSize: 13, color: colors.muted }}>
                  <span>Estimated total in EUR (orientational)</span>
                  <span>≈ {eurTotal.toFixed(2)} EUR</span>
                </div>
              );
            })()}
          </div>
        );
      })()}

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0.75rem 1rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 12, color: colors.muted, fontWeight: 600 }}>
            Exchange rates (→ EUR){ratesUpdatedAt ? ` · ECB ${ratesUpdatedAt}` : ''}:
          </div>
          {Object.entries(rates).map(([cur, rate]) => (
            <div key={cur} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{cur}:</span>
              {showRates ? (
                <input type="number" step="0.001" value={rate} onChange={e => setRates({ ...rates, [cur]: parseFloat(e.target.value) })}
                  style={{ width: 58, padding: '2px 5px', border: `1px solid ${colors.border}`, borderRadius: 4, fontSize: 12 }} />
              ) : (
                <span style={{ fontSize: 12, color: colors.muted }}>{typeof rate === 'number' ? rate.toFixed(4) : rate}</span>
              )}
            </div>
          ))}
          <button onClick={fetchLiveRates} disabled={ratesLoading} style={{ padding: '3px 10px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit' }}>
            {ratesLoading ? '⏳ Updating...' : '🔄 Refresh'}
          </button>
          <button onClick={() => setShowRates(!showRates)} style={{ padding: '3px 10px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit' }}>
            {showRates ? '✓ Done' : '✏ Edit rates'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        {SERVICE_TYPES.map(t => (
          <button key={t.value} onClick={async () => {
              setActiveType(t.value);
              setShowServiceForm(true);
              setPasteText('');
              setCancellationDateDisplay('');
              setHotelFocSelected('none');
              setTimeout(() => serviceFormRef.current?.reset(), 50);
              // Create a draft doc immediately so the Documents drag&drop section is available right away
              const draftRef = await addDoc(collection(db, 'orders', orderId, 'services'), {
                type: t.value, name: '', draft: true, createdAt: new Date().toISOString(),
              });
              setEditingServiceId(draftRef.id);
              setDocuments([]);
            }}
            style={{ padding: '7px 14px', background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', color: colors.text }}>
            {t.icon} + {t.label}
          </button>
        ))}
      </div>

      {showServiceForm && (
        <div style={{ background: colors.white, border: `2px solid ${colors.primary}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1rem' }}>
            <button type="button" onClick={closeServiceForm}
              style={{ padding: '6px 14px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
              ← Back to order
            </button>
            <div style={{ fontSize: 14, fontWeight: 600, color: colors.primary }}>
              {editingServiceId ? 'Edit' : 'Add'}: {SERVICE_TYPES.find(t => t.value === activeType)?.icon} {SERVICE_TYPES.find(t => t.value === activeType)?.label}
            </div>
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
            <span style={{ fontSize: 12, color: colors.muted, margin: '0 8px' }}>or</span>
            <label style={{ padding: '7px 16px', background: colors.white, color: colors.primary, border: `1px solid ${colors.primary}`, borderRadius: 6, fontSize: 13, cursor: pasteLoading ? 'default' : 'pointer', fontFamily: 'inherit', opacity: pasteLoading ? 0.6 : 1, display: 'inline-block' }}>
              {pasteLoading ? 'Parsing...' : '📄 Upload contract (PDF/image) to auto-fill'}
              <input type="file" accept="application/pdf,image/*" disabled={pasteLoading} style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files[0]) handleContractUpload(e.target.files[0]); e.target.value = ''; }} />
            </label>
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
              {activeType === 'ticket' ? (
                <div>{lbl('Date')}<input name="dateFrom" type="date" style={iStyle} /></div>
              ) : (
                <>
                  <div>{lbl('Date from')}<input name="dateFrom" type="date" style={iStyle}
                    onChange={() => {
                      const f = serviceFormRef.current;
                      if (!f?.dateFrom?.value || !f?.dateTo?.value || !f.nights) return;
                      const d1 = new Date(f.dateFrom.value);
                      const d2 = new Date(f.dateTo.value);
                      const diff = Math.round((d2 - d1) / 86400000);
                      if (diff > 0) f.nights.value = diff;
                    }} /></div>
                  <div>{lbl('Date to')}<input name="dateTo" type="date" style={iStyle}
                    onChange={() => {
                      const f = serviceFormRef.current;
                      if (!f?.dateFrom?.value || !f?.dateTo?.value || !f.nights) return;
                      const d1 = new Date(f.dateFrom.value);
                      const d2 = new Date(f.dateTo.value);
                      const diff = Math.round((d2 - d1) / 86400000);
                      if (diff > 0) f.nights.value = diff;
                    }} /></div>
                </>
              )}
              {['hotel', 'restaurant'].includes(activeType) && <div>{lbl('Nights')}<input name="nights" type="number" style={iStyle} /></div>}
              {activeType === 'ticket' && <div>{lbl('Number of tickets')}<input name="ticketCount" type="number" placeholder="e.g. 20" style={iStyle} /></div>}
            </div>

            {activeType === 'hotel' && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.08em', margin: '12px 0 8px', borderTop: `1px solid ${colors.border}`, paddingTop: 12 }}>Client rooms</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
                  <div>{lbl('DBL rooms')}<input name="dblRooms" type="number" placeholder="10" style={iStyle} /></div>
                  <div>{lbl('SNGL rooms')}<input name="snglRooms" type="number" placeholder="2" style={iStyle} /></div>
                  <div>{lbl('TWN rooms')}<input name="twnRooms" type="number" placeholder="0" style={iStyle} /></div>
                  <div>{lbl('TRPL rooms')}<input name="trplRooms" type="number" placeholder="0" style={iStyle} /></div>
                  <div>{lbl('Price DBL / room / night')}<input name="pricePerDblRoom" type="text" inputMode="decimal" onChange={decimalInput} placeholder="150" style={iStyle} /></div>
                  <div>{lbl('Price SNGL / room / night')}<input name="pricePerSnglRoom" type="text" inputMode="decimal" onChange={decimalInput} placeholder="120" style={iStyle} /></div>
                  <div>{lbl('Price TWN / room / night')}<input name="pricePerTwnRoom" type="text" inputMode="decimal" onChange={decimalInput} placeholder="150" style={iStyle} /></div>
                  <div>{lbl('Price TRPL / room / night')}<input name="pricePerTrplRoom" type="text" inputMode="decimal" onChange={decimalInput} placeholder="190" style={iStyle} /></div>
                  <div>{lbl('City tax amount')}<input name="cityTax" type="text" inputMode="decimal" onChange={decimalInput} placeholder="4.20" style={iStyle} /></div>
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
                  <div>{lbl('Dinner price / person')}<input name="dinnerPrice" type="text" inputMode="decimal" onChange={decimalInput} placeholder="28" style={iStyle} /></div>
                  <div>{lbl('Lunches (days)')}<input name="lunches" type="number" placeholder="0" style={iStyle} /></div>
                  <div>{lbl('Lunch price / person')}<input name="lunchPrice" type="text" inputMode="decimal" onChange={decimalInput} placeholder="22" style={iStyle} /></div>
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
                  <div>{lbl('Guide room price / night')}<input name="guideRoomPrice" type="text" inputMode="decimal" onChange={decimalInput} placeholder="same as client" style={iStyle} /></div>
                  <div>{lbl('Driver accommodation')}
                    <select name="driverAccom" style={iStyle}>
                      <option value="none">Goes home</option>
                      <option value="same">Same hotel</option>
                      <option value="other">Different hotel</option>
                    </select>
                  </div>
                  <div>{lbl('Driver room price / night')}<input name="driverRoomPrice" type="text" inputMode="decimal" onChange={decimalInput} placeholder="0" style={iStyle} /></div>
                  <div>{lbl('Driver nights (if not full stay)')}<input name="driverNights" type="number" placeholder="e.g. 1" style={iStyle} /></div>
                </div>
                <div style={{ fontSize: 11, color: colors.muted, marginTop: -4, marginBottom: 8 }}>If driver stays the whole period, leave "Driver nights" empty — it will use the hotel's total nights.</div>
              </>
            )}

            {activeType === 'ticket' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 }}>
                <div>{lbl('Price / person')}<input name="pricePerPax" type="text" inputMode="decimal" onChange={decimalInput} placeholder="26" style={iStyle} /></div>
              </div>
            )}

            {!['hotel', 'ticket'].includes(activeType) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 }}>
                <div>{lbl('Price / person (if applicable)')}<input name="pricePerPax" type="text" inputMode="decimal" onChange={decimalInput} style={iStyle} /></div>
                <div>{lbl('Total price (if flat fee)')}<input name="totalPrice" type="text" inputMode="decimal" onChange={decimalInput} style={iStyle} /></div>
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
              <div>{lbl('Deposit amount')}<input name="depositAmount" type="text" inputMode="decimal" onChange={decimalInput} style={iStyle} /></div>
              <div style={{ gridColumn: '1 / -1' }}>{lbl('Confirmation link (hotel/supplier portal)')}<input name="confirmationLink" type="text" placeholder="https://..." style={iStyle} /></div>
            </div>

            <div style={{ marginBottom: 12 }}>
              {lbl('Notes')}<textarea name="notes" rows={2} style={{ ...iStyle, resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button type="submit" style={{ padding: '8px 18px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                {editingServiceId ? 'Save changes' : 'Add service'}
              </button>
              <button type="button" onClick={closeServiceForm}
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
