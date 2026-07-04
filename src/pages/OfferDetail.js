import React, { useState, useEffect, useCallback } from 'react';
import { db, auth, storage } from '../lib/firebase';
import { doc, getDoc, getDocs, collection, updateDoc, addDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { DEFAULT_RATES, CURRENCIES, evalAmount, getEffectiveCostDbl, getEffectiveCostSngl, toEUR } from '../lib/offerCalc';

const STATUS_OPTS = [
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent to client' },
  { value: 'won', label: 'Won → confirmed' },
  { value: 'lost', label: 'Lost / declined' },
];

const decimalInput = (e) => {
  const val = e.target.value;
  const normalized = val.replace(/,/g, '.');
  if (normalized !== val) e.target.value = normalized;
};

// Reusable input that accepts plain numbers or "=formula" expressions, and converts
// the formula to its computed result on blur, so the field shows the computed number directly.
// Defined at module level (not inside OfferDetail) so it keeps a stable identity across
// re-renders and inputs don't lose focus on every keystroke.
const FormulaField = ({ value, onChange, placeholder, colors }) => {
  const style = { width: '100%', padding: '6px 8px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  return (
    <input type="text" placeholder={placeholder} value={value} onChange={onChange} onInput={decimalInput}
      onBlur={e => {
        const v = e.target.value;
        if (String(v).trim().startsWith('=')) {
          const computed = evalAmount(v);
          onChange({ target: { value: String(Math.round(computed * 100) / 100) } });
        }
      }}
      style={style} />
  );
};

const fmtDateBR = (d) => { if (!d || d.length < 10) return d; const [y, m, day] = d.split('-'); return `${day}/${m}/${y}`; };

// Date input in DD.MM.YYYY order — always consistent regardless of browser/OS locale
const DateDMY = ({ value, onChange, colors, dateKey }) => {
  const toDisplay = (v) => {
    if (v && v.length === 10) {
      const [y, m, d] = v.split('-');
      return `${d}.${m}.${y}`;
    }
    return '';
  };
  const toISO = (v) => {
    const clean = v.replace(/[^\d]/g, '');
    if (clean.length === 8) {
      const d = clean.slice(0, 2), m = clean.slice(2, 4), y = clean.slice(4, 8);
      if (!isNaN(new Date(`${y}-${m}-${d}`))) return `${y}-${m}-${d}`;
    }
    return null;
  };
  const getWeekday = (v) => {
    if (v && v.length === 10) {
      const d = new Date(v + 'T00:00:00');
      if (!isNaN(d)) return d.toLocaleDateString('en-US', { weekday: 'short' });
    }
    return '';
  };
  const [weekday, setWeekday] = React.useState(() => getWeekday(value));
  const inputRef = React.useRef(null);
  const prevValue = React.useRef(value);
  React.useEffect(() => {
    if (prevValue.current !== value && inputRef.current && document.activeElement !== inputRef.current) {
      inputRef.current.value = toDisplay(value);
      prevValue.current = value;
      setWeekday(getWeekday(value));
    }
  }, [value]);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        ref={inputRef}
        type="text"
        placeholder="DD.MM.RRRR"
        defaultValue={toDisplay(value)}
        onBlur={e => {
          const iso = toISO(e.target.value);
          if (iso) { e.target.value = toDisplay(iso); onChange(iso); setWeekday(getWeekday(iso)); }
        }}
        style={{ padding: '6px 8px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', width: 100, boxSizing: 'border-box' }}
      />
      {weekday && <span style={{ fontSize: 11, color: colors.muted, fontWeight: 600, whiteSpace: 'nowrap' }}>{weekday}</span>}
    </span>
  );
};

// Small drag-and-drop / click-to-upload control for attaching a hotel confirmation
// (e.g. an email saved as PDF, a voucher, or a screenshot) directly to an itinerary item.
const HotelAttachment = ({ item, onUpload, onRemove, colors }) => {
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [dragOver, setDragOver] = React.useState(false);
  const [error, setError] = React.useState('');
  const inputRef = React.useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    setError('');
    setProgress(0);
    setUploading(true);
    try {
      await onUpload(file, (pct) => setProgress(pct));
    } catch (e) {
      setError(e.message || 'Nahrání selhalo');
      console.error('Attachment upload failed:', e);
    } finally {
      setUploading(false);
    }
  };

  if (item.confirmationFileUrl) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <a href={item.confirmationFileUrl} target="_blank" rel="noopener noreferrer"
          title={item.confirmationFileName}
          style={{ fontSize: 10, color: colors.primary, textDecoration: 'underline', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          📎 {item.confirmationFileName || 'potvrzení'}
        </a>
        <button onClick={onRemove} title="Odebrat přílohu"
          style={{ fontSize: 10, color: colors.danger, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>✕</button>
      </div>
    );
  }

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault(); setDragOver(false);
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
      onClick={() => !uploading && inputRef.current && inputRef.current.click()}
      title={error || 'Přetáhni sem email/PDF potvrzení, nebo klikni pro výběr souboru'}
      style={{
        fontSize: 10, padding: '2px 6px', borderRadius: 4, cursor: uploading ? 'default' : 'pointer',
        border: `1px dashed ${error ? colors.danger : dragOver ? colors.primary : colors.border}`,
        background: dragOver ? '#f0f7ff' : 'transparent',
        color: error ? colors.danger : colors.muted, whiteSpace: 'nowrap',
        maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
      {uploading ? `⏳ Nahrávám… ${progress}%` : error ? '⚠ ' + error : '📎 Potvrzení'}
      <input ref={inputRef} type="file" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files && e.target.files[0]; if (f) handleFile(f); e.target.value = ''; }} />
    </div>
  );
};

export default function OfferDetail({ offerId, navigate, colors }) {
  const [offer, setOffer] = useState(null);
  const [clients, setClients] = useState([]);
  const [items, setItems] = useState([]);
  const itemsRef = React.useRef(items);
  const [lastSavedItems, setLastSavedItems] = useState(null);
  const [isLocked, setIsLocked] = useState(false);
  const [showLockDialog, setShowLockDialog] = useState(false);
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');
  const [margin, setMargin] = useState(15);
  const [paxList, setPaxList] = useState('15,20,25,30,35');
  const [focCount, setFocCount] = useState(1);
  const [focType, setFocType] = useState('dbl');
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [ratesUpdatedAt, setRatesUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSplit, setShowSplit] = useState(false);

  const fetchData = useCallback(async () => {
    const snap = await getDoc(doc(db, 'offers', offerId));
    if (snap.exists()) {
      const data = snap.data();
      setOffer({ id: snap.id, ...data });
      setItems(data.items || []);
      itemsRef.current = data.items || [];
      setLastSavedItems(data.items || []);
      setIsLocked(data.locked || false);
      setMargin(data.margin ?? 15);
      setPaxList(data.paxList || '15,20,25,30,35');
      setFocCount(data.focCount ?? 1);
      setFocType(data.focType || 'dbl');
      setShowSplit(data.showSplit ?? false);
    }
    const cliSnap = await getDocs(collection(db, 'clients'));
    setClients(cliSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, [offerId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fetchLiveRates = useCallback(async () => {
    try {
      const symbols = Object.keys(DEFAULT_RATES).join(',');
      const resp = await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${symbols}`);
      const data = await resp.json();
      if (data && data.rates) {
        const newRates = {};
        Object.entries(data.rates).forEach(([cur, value]) => {
          if (value > 0) newRates[cur] = 1 / value;
        });
        setRates(prev => ({ ...prev, ...newRates }));
        setRatesUpdatedAt(data.date || '');
      }
    } catch (err) {
      console.error('Failed to fetch live exchange rates', err);
    }
  }, []);

  useEffect(() => { fetchLiveRates(); }, [fetchLiveRates]);

  // 30-second interval autosave DISABLED — debounced per-field auto-save (updateItem) now handles this more reliably
  const [lastAutoSave] = useState(null);

  const [itineraryText, setItineraryText] = useState('');
  const [parseError, setParseError] = useState('');

  const toEURWithRates = (amount, currency) => toEUR(amount, currency, rates);

  const hashPin = (pin) => {
    // Simple hash — not cryptographic but sufficient for this use case
    let h = 0;
    for (let i = 0; i < pin.length; i++) { h = (Math.imul(31, h) + pin.charCodeAt(i)) | 0; }
    return String(h);
  };

  const handleLock = async () => {
    if (!pinInput || pinInput.length < 4) { setPinError('Zadejte minimálně 4 znaky.'); return; }
    await updateDoc(doc(db, 'offers', offerId), { locked: true, pinHash: hashPin(pinInput), updatedAt: new Date().toISOString() });
    setIsLocked(true);
    setShowLockDialog(false);
    setPinInput('');
    setPinError('');
  };

  const handleUnlock = async () => {
    if (hashPin(pinInput) !== offer?.pinHash) { setPinError('Nesprávný PIN.'); return; }
    await updateDoc(doc(db, 'offers', offerId), { locked: false, updatedAt: new Date().toISOString() });
    setIsLocked(false);
    setShowUnlockDialog(false);
    setPinInput('');
    setPinError('');
  };

  const handleEmergencyUnlock = async () => {
    if (!window.confirm('Nouzové odemčení — PIN bude vymazán. Pokračovat?')) return;
    await updateDoc(doc(db, 'offers', offerId), { locked: false, pinHash: null, updatedAt: new Date().toISOString() });
    setIsLocked(false);
    setShowUnlockDialog(false);
    setPinInput('');
    setPinError('');
  };

  const isOwner = auth.currentUser?.email === 'helena.maria.brito@gmail.com';



  const CITY_PT = {
    'MUNICH': 'Munique', 'MÜNCHEN': 'Munique', 'SALZBURG': 'Salzburgo', 'SALSBURG': 'Salzburgo',
    'INNSBRUCK': 'Innsbruck', 'FUSSEN': 'Füssen', 'FÜSSEN': 'Füssen', 'BERN': 'Berna',
    'GRINDELWALD': 'Grindelwald', 'ST. MORITZ': 'St. Moritz', 'SAINT MORITZ': 'St. Moritz',
    'BOLZANO': 'Bolzano', 'BOLSANO': 'Bolzano', 'MILAN': 'Milão', 'MILANO': 'Milão',
    'VIENNA': 'Viena', 'WIEN': 'Viena', 'PRAGUE': 'Praga', 'PRAHA': 'Praga',
    'BUDAPEST': 'Budapeste', 'WARSAW': 'Varsóvia', 'WARSZAWA': 'Varsóvia',
    'KRAKOW': 'Cracóvia', 'KRAKÓW': 'Cracóvia', 'BERLIN': 'Berlim', 'FRANKFURT': 'Frankfurt',
    'HAMBURG': 'Hamburgo', 'COLOGNE': 'Colônia', 'KÖLN': 'Colônia', 'DRESDEN': 'Dresden',
    'AMSTERDAM': 'Amsterdã', 'BRUSSELS': 'Bruxelas', 'BRUXELLES': 'Bruxelas',
    'BRUGES': 'Bruges', 'PARIS': 'Paris', 'LYON': 'Lyon', 'NICE': 'Nice',
    'ROME': 'Roma', 'ROMA': 'Roma', 'FLORENCE': 'Florença', 'FIRENZE': 'Florença',
    'VENICE': 'Veneza', 'VENEZIA': 'Veneza', 'NAPLES': 'Nápoles', 'NAPOLI': 'Nápoles',
    'BARCELONA': 'Barcelona', 'MADRID': 'Madrid', 'SEVILLE': 'Sevilha', 'SEVILLA': 'Sevilha',
    'LISBON': 'Lisboa', 'LISBOA': 'Lisboa', 'PORTO': 'Porto',
    'LONDON': 'Londres', 'EDINBURGH': 'Edimburgo', 'DUBLIN': 'Dublin',
    'ZURICH': 'Zurique', 'ZÜRICH': 'Zurique', 'GENEVA': 'Genebra', 'GENÈVE': 'Genebra',
    'LUCERNE': 'Lucerna', 'LUZERN': 'Lucerna', 'INTERLAKEN': 'Interlaken',
    'STOCKHOLM': 'Estocolmo', 'OSLO': 'Oslo', 'COPENHAGEN': 'Copenhague',
    'HELSINKI': 'Helsinque', 'TALLINN': 'Tallinn', 'RIGA': 'Riga', 'VILNIUS': 'Vilnius',
    'ATHENS': 'Atenas', 'ATENAS': 'Atenas', 'SANTORINI': 'Santorini',
    'ISTANBUL': 'Istambul', 'DUBROVNIK': 'Dubrovnik', 'SPLIT': 'Split',
    'BUDVA': 'Budva', 'TIRANA': 'Tirana', 'GJIROKASTER': 'Gjirokastra',
    'GIROCASTRO': 'Gjirokastra', 'SARANDE': 'Sarandë', 'SARANDA': 'Sarandë',
    'CORFU': 'Corfu', 'KERKYRA': 'Corfu',
    'BELGRADE': 'Belgrado', 'BEOGRAD': 'Belgrado', 'SOFIA': 'Sofia',
    'BUCHAREST': 'Bucareste', 'BUCURESTI': 'Bucareste', 'CZESTOCHOWA': 'Czestochowa',
    'VADUZ': 'Vaduz', 'LUXEMBOURG': 'Luxemburgo',
    // Varianty názvů měst
    'BUXELAS': 'Bruxelas', 'BRUSEL': 'Bruxelas', 'BRÜSSEL': 'Bruxelas',
    'LISABON': 'Lisboa', 'LISBONA': 'Lisboa',
    'MUNIQUE': 'Munique', 'MUNICH': 'Munique', 'MUNCHEN': 'Munique',
    'PRAGA': 'Praga', 'PRAG': 'Praga',
    'VIENA': 'Viena', 'VIENNE': 'Viena',
    'VARSOVIA': 'Varsóvia', 'VARSOVIE': 'Varsóvia',
    'CRACOVIA': 'Cracóvia', 'CRACOVIE': 'Cracóvia',
    'FLORENCA': 'Florença', 'FLORENCIA': 'Florença',
    'VENEZA': 'Veneza', 'VENECIA': 'Veneza',
    'NAPOLES': 'Nápoles', 'NÁPOLES': 'Nápoles',
    'SEVILHA': 'Sevilha',
    'COLONIA': 'Colônia', 'COLÓNIA': 'Colônia',
    'HAMBURGO': 'Hamburgo',
    'BERLIM': 'Berlim',
    'ZURIQUE': 'Zurique',
    'GENEBRA': 'Genebra',
    'LUCERNA': 'Lucerna',
    'ESTOCOLMO': 'Estocolmo',
    'COPENHAGUE': 'Copenhague', 'KOBENHAVN': 'Copenhague',
    'HELSINQUE': 'Helsinque',
    'ATENAS': 'Atenas',
    'ISTAMBUL': 'Istambul',
    'BELGRADO': 'Belgrado',
    'BUCARESTE': 'Bucareste',
    'LONDRA': 'Londres', 'LONDRE': 'Londres', 'LONDRAS': 'Londres',
    'EDIMBURGO': 'Edimburgo',
    'MILAO': 'Milão', 'MILÁN': 'Milão',
    'RÜDESHEIM': 'Rüdesheim', 'RUDESHEIM': 'Rüdesheim',
    'NURENBERG': 'Nuremberga', 'NUREMBERG': 'Nuremberga', 'NURNBERG': 'Nuremberga', 'NÜRNBERG': 'Nuremberga',
    'MESTRE': 'Mestre', 'DESENZANO': 'Desenzano del Garda', 'DESENZANO DEL GARDA': 'Desenzano del Garda',
    'FUSSEN': 'Füssen', 'FUSSEN': 'Füssen',
  };

  const handleParseItinerary = () => {
    setParseError('');
    // Normalize dashes and whitespace
    const normalized = itineraryText
      .replace(/[\u2013\u2014\u2012\u2015]/g, '-')
      .replace(/[\u00a0\u202f\u2009\u2007\u2003\u2002\u2001\u2000\u00ad]/g, ' ')
      .replace(/\t/g, '    ')
      .replace(/\r/g, '');

    // --- Format C: flag-emoji block style ---
    // 🇬🇧 Londres 23.04. – 28.04.2027
    // • Hotel: DoubleTree by Hilton London - Hyde Park
    // • Morada: 150 Bayswater Road, London W2 4RT, Reino Unido
    // • Telefone: +44 20 7229 1212
    const blockPattern = /(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)?([A-ZÁÉÍÓÚÀÂÊÔÃÕÜÖÄČŠŽŘÝŮĚa-záéíóúàâêôãõüöäčšžřýůě]+)\s+(\d{1,2})\.(\d{1,2})\.\s*-+\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/gu;
    const blockMatches = [...normalized.matchAll(blockPattern)];
    if (blockMatches.length > 0) {
      const lines = normalized.split('\n');
      const newHotelsBlock = [];
      blockMatches.forEach((m, idx) => {
        const [full, cityRaw, d1, m1, d2, m2, y2] = m;
        const dateFrom = `${y2}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
        const dateTo = `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
        const nights = Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000);
        if (nights <= 0) return;

        // Find the line index where this match occurred, then look at subsequent lines for Hotel:
        const matchLineIdx = lines.findIndex(l => l.includes(full));
        let hotelName = '';
        if (matchLineIdx >= 0) {
          for (let i = matchLineIdx + 1; i < Math.min(matchLineIdx + 6, lines.length); i++) {
            const hotelMatch = lines[i].match(/Hotel:\s*(.+)/i);
            if (hotelMatch) { hotelName = hotelMatch[1].trim(); break; }
            // Stop if we hit the next block (another flag/date line)
            if (/\d{1,2}\.\d{1,2}\.\s*-/.test(lines[i])) break;
          }
        }

        const cityClean = cityRaw.trim().toUpperCase();
        const cityPT = CITY_PT[cityClean] || (cityRaw.charAt(0).toUpperCase() + cityRaw.slice(1).toLowerCase());

        newHotelsBlock.push({
          id: Date.now() + Math.random() + idx,
          name: hotelName, city: cityPT,
          type: 'per_pax', subType: 'hotel', enabled: true,
          costDbl: '', costSngl: '', pricePerNightDbl: '', pricePerNightSngl: '',
          nights: String(nights), cityTax: '', cityTaxSngl: '', guideOverride: '',
          dateFrom, dateTo, groupCost: '', currency: 'EUR'
        });
      });

      if (newHotelsBlock.length > 0) {
        setItems(prev => {
          const newItems = [...prev];
          const lastHotelIdx = newItems.map((it, i) => it.subType === 'hotel' ? i : -1).filter(i => i >= 0).pop();
          const insertAt = lastHotelIdx !== undefined ? lastHotelIdx + 1 : 0;
          newItems.splice(insertAt, 0, ...newHotelsBlock);
          itemsRef.current = newItems;
          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          updateDoc(doc(db, 'offers', offerId), { items: newItems, updatedAt: new Date().toISOString() }).catch(err => console.error(err));
          return newItems;
        });
        setItineraryText('');
        return;
      }
    }

    // --- Format D: flag-emoji block style with DD/MM (year) in parentheses ---
    // 🇳🇱 Amsterdã (15/04 – 18/04/2027)
    // • Hotel: Mövenpick Hotel Amsterdam City Centre 4*
    // • Endereço: Piet Heinkade 11, 1019 BR Amsterdam, Países Baixos
    const blockPatternD = /(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)?([A-ZÁÉÍÓÚÀÂÊÔÃÕÜÖÄČŠŽŘÝŮĚa-záéíóúàâêôãõüöäčšžřýůě]+)\s*\((\d{1,2})\/(\d{1,2})\s*-+\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\)/gu;
    const blockMatchesD = [...normalized.matchAll(blockPatternD)];
    if (blockMatchesD.length > 0) {
      const lines = normalized.split('\n');
      const newHotelsBlockD = [];
      blockMatchesD.forEach((m, idx) => {
        const [full, cityRaw, d1, m1, d2, m2, y2] = m;
        const dateFrom = `${y2}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
        const dateTo = `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
        const nights = Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000);
        if (nights <= 0) return;

        const matchLineIdx = lines.findIndex(l => l.includes(full));
        let hotelName = '';
        if (matchLineIdx >= 0) {
          for (let i = matchLineIdx + 1; i < Math.min(matchLineIdx + 8, lines.length); i++) {
            // Match "Hotel:" or "Opção A:" / "Opção B:" style labels
            const hotelMatch = lines[i].match(/(?:Hotel|Op[çc][ãa]o\s*[A-Z]):\s*(.+)/i);
            if (hotelMatch) { hotelName = hotelMatch[1].trim(); break; }
            // Stop if we hit the next block (another flag/date line)
            if (/\(\d{1,2}\/\d{1,2}\s*-/.test(lines[i])) break;
          }
        }

        const cityClean = cityRaw.trim().toUpperCase();
        const cityPT = CITY_PT[cityClean] || (cityRaw.charAt(0).toUpperCase() + cityRaw.slice(1).toLowerCase());

        newHotelsBlockD.push({
          id: Date.now() + Math.random() + idx,
          name: hotelName, city: cityPT,
          type: 'per_pax', subType: 'hotel', enabled: true,
          costDbl: '', costSngl: '', pricePerNightDbl: '', pricePerNightSngl: '',
          nights: String(nights), cityTax: '', cityTaxSngl: '', guideOverride: '',
          dateFrom, dateTo, groupCost: '', currency: 'EUR'
        });
      });

      if (newHotelsBlockD.length > 0) {
        setItems(prev => {
          const newItems = [...prev];
          const lastHotelIdx = newItems.map((it, i) => it.subType === 'hotel' ? i : -1).filter(i => i >= 0).pop();
          const insertAt = lastHotelIdx !== undefined ? lastHotelIdx + 1 : 0;
          newItems.splice(insertAt, 0, ...newHotelsBlockD);
          itemsRef.current = newItems;
          if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
          updateDoc(doc(db, 'offers', offerId), { items: newItems, updatedAt: new Date().toISOString() }).catch(err => console.error(err));
          return newItems;
        });
        setItineraryText('');
        return;
      }
    }

    // Split on newlines first, then also split lines that have multiple date patterns
    // Also split on DD/MM a DD/MM pattern (Format F) that may appear on same line
    const normalized2 = normalized.replace(/(\d{1,2}\/\d{1,2}\s+a\s+\d{1,2}\/\d{1,2}\s+)/g, '\n$1').trim();
    const rawLines = normalized2.split('\n').map(l => l.trim()).filter(l => l);

    // Split each line before any new date-range pattern (DD.MM. YYYY - or DD.MM.YYYY -)
    const lines = [];
    for (const line of rawLines) {
      // Primary: split before new date range (lookbehind for non-digit/dot)
      const parts = line.split(/(?<=[A-Za-záéíóúàâêôãõüöäčšžřýůě])\s+(?=\d{1,2}\.\d{1,2}\.\s*\d{0,4}\s*[-–])/g);
      if (parts.length > 1) {
        parts.forEach(p => { if (p.trim()) lines.push(p.trim()); });
      } else {
        lines.push(line);
      }
    }

    console.debug('parser v198b');
    const newHotels = [];
    let lastYear = new Date().getFullYear() + 1 + ''; // default next year

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Remove trailing notes
      const cleanLine = line.replace(/\s*-\s*(obeslano|FD|June|July|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr|objedn)[^\n]*/i, '').trim();

      let dateFrom = '', dateTo = '', cityRaw = '', hotelName = '';

      // Format G: CITY | DD/MM/YYYY a DD/MM/YYYY HOTEL NAME (pipe-delimited, unambiguous separator)
      // Tolerant of stray spaces before slashes and of a typo'd 5-digit year (takes last 4 digits).
      const fmtG = cleanLine.match(/^(.+?)\s*\|\s*(\d{1,2})\/(\d{1,2})\s*\/?\s*(\d{4,5})\s*a\s*(\d{1,2})\/(\d{1,2})\s*\/?\s*(\d{4,5})\s+(.+)$/);
      if (fmtG) {
        const [, cityG, d1, m1, y1raw, d2, m2, y2raw, hotelG] = fmtG;
        const y1 = y1raw.slice(-4);
        const y2 = y2raw.slice(-4);
        dateFrom = `${y1}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
        dateTo = `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
        lastYear = y2;
        cityRaw = cityG.trim();
        hotelName = hotelG.trim();
      }

      // Format H: D1[-D2]/MM/YYYY CITY - HOTEL (compact range, single shared year; month repeated
      // only when it rolls over, e.g. "20-22/05/2027 Ljubljana - Hotel" or "31/05-02/06/2027 City - Hotel")
      if (!dateFrom) {
        const fmtH = cleanLine.match(/^(\d{1,2})(?:\/(\d{1,2}))?-(\d{1,2})\/(\d{1,2})\s*\/?\s*(\d{4})\s*\u00b7?\s*(.+?)\s*-+\s*(.+)$/);
        if (fmtH) {
          const [, d1, m1raw, d2, m2, yearH, cityH, hotelH] = fmtH;
          const m1 = m1raw || m2;
          dateFrom = `${yearH}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
          dateTo = `${yearH}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
          lastYear = yearH;
          cityRaw = cityH.trim();
          hotelName = hotelH.trim();
        }
      }

      // Format I: DD/MM/YYYY-DD/MM/YYYY CITY - HOTEL (full date written out on both sides)
      if (!dateFrom) {
        const fmtI = cleanLine.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\s*\/?\s*(\d{4})\s*\u00b7?\s*(.+?)\s*-+\s*(.+)$/);
        if (fmtI) {
          const [, d1, m1, y1, d2, m2, y2, cityI, hotelI] = fmtI;
          dateFrom = `${y1}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
          dateTo = `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
          lastYear = y2;
          cityRaw = cityI.trim();
          hotelName = hotelI.trim();
        }
      }

      // Format J: ▸ D1 A D2/MM/YYYY • CITY - HOTEL (bullet-prefixed, shared month/year, uppercase "A",
      // bullet-dot separator before city; city may include a parenthetical note like "VENEZA (MESTRE)")
      if (!dateFrom) {
        const fmtJ = cleanLine.match(/^\u25b8?\s*(\d{1,2})\s+[Aa]\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*\u2022?\s*(.+?)\s*-+\s*(.+)$/);
        if (fmtJ) {
          const [, d1, d2, m2, yearJraw, cityJ, hotelJ] = fmtJ;
          const yearJ = yearJraw.length === 2 ? '20' + yearJraw : yearJraw;
          dateFrom = `${yearJ}-${m2.padStart(2,'0')}-${d1.padStart(2,'0')}`;
          dateTo = `${yearJ}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
          lastYear = yearJ;
          cityRaw = cityJ.trim();
          hotelName = hotelJ.trim();
        }
      }

      // Format A: DD.MM. - DD.MM.YYYY CITY (year only on second date)
      // or: DD.MM.YYYY - DD.MM.YYYY CITY
      const fmtA = cleanLine.match(/(\d{1,2})\.(\d{1,2})\.\s*(\d{4})?\s*-+\s*(\d{1,2})\.(\d{1,2})\.\s*(\d{4})\s+(.+)/);
      if (!dateFrom && fmtA) {
        const [, d1, m1, y1raw, d2, m2, y2, rest] = fmtA;
        const y1 = y1raw || y2;
        lastYear = y2;
        dateFrom = `${y1}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
        dateTo = `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
        // Clean trailing " -" with nothing after
        const restClean = rest.replace(/\s*-\s*$/, '').trim();
        const colonIdx = restClean.indexOf(':');
        if (colonIdx > 0) {
          cityRaw = restClean.slice(0, colonIdx).trim();
          hotelName = restClean.slice(colonIdx + 1).trim();
        } else {
          // Split city from hotel: city = first word(s), hotel = rest
          const CITY_CONN = new Set(['DEL','DE','DU','DO','DA','DES','THE','AM','AN','IM','SAINT','SAN','LE','LA','LES','LOS','AUX','VON','VAN','BAD','GRAN','NEW','LAKE']);
          const CITY_PRE = new Set(['ST','ST.']);
          const rcWords = restClean.split(/\s+/);
          let cityEnd = 1; // first word always city
          if (CITY_PRE.has((rcWords[0] || '').toUpperCase().replace('.',''))) {
            if (cityEnd < rcWords.length) cityEnd++; // take word after ST.
          }
          while (cityEnd < rcWords.length) {
            const w = (rcWords[cityEnd] || '').toUpperCase().replace('.','');
            if (CITY_CONN.has(w)) { cityEnd++; if (cityEnd < rcWords.length) cityEnd++; }
            else break;
          }
          cityRaw = rcWords.slice(0, cityEnd).join(' ');
          hotelName = rcWords.slice(cityEnd).join(' ');
          // If no hotel found on same line, look at next non-empty line
          if (!hotelName) {
            for (let j = i + 1; j < lines.length; j++) {
              const nextLine = lines[j].trim();
              if (!nextLine) continue;
              if (/^\d{1,2}[.\/]/.test(nextLine)) break;
              hotelName = nextLine;
              break;
            }
          }
        }
      } else {
        // Format F: DD/MM a DD/MM CITY – [HOTEL NAME](url) or HOTEL NAME
        const fmtF = cleanLine.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').match(/^(\d{1,2})\/(\d{1,2})\s+a\s+(\d{1,2})\/(\d{1,2})\s+(.+?)\s*[\u2013\u2014-]+\s*(.+)/);
        if (!dateFrom && fmtF) {
          const [, d1, m1, d2, m2, cityRawF, hotelRawF] = fmtF;
          const year = lastYear || new Date().getFullYear() + '';
          dateFrom = `${year}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
          // If dateTo < dateFrom, try next year
          let dateTo2 = `${year}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
          if (dateTo2 < dateFrom) dateTo2 = `${parseInt(year)+1}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
          dateTo = dateTo2;
          cityRaw = cityRawF.trim();
          hotelName = hotelRawF.trim();
        }

        // Format E: DD a DD/MM/YYYY: City (next line: HOTEL NAME)
        const fmtE = cleanLine.match(/^(\d{1,2})\s+a\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*:\s*(.+)/i);
        if (!dateFrom && fmtE) {
          const [, d1, d2, m2, y2raw, city] = fmtE;
          const y2 = y2raw.length === 2 ? '20' + y2raw : y2raw;
          lastYear = y2;
          dateFrom = `${y2}-${m2.padStart(2,'0')}-${d1.padStart(2,'0')}`;
          dateTo = `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
          cityRaw = city.trim();
          hotelName = '';
          // next non-empty line will be hotel name
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (!nextLine) continue;
            // if it looks like another date line, stop
            if (/^\d{1,2}\s+a\s+\d/.test(nextLine)) break;
            hotelName = nextLine;
            break;
          }
        }

        // Format B: DD/MM a DD/MM/YY – CITY: HOTEL (Portuguese style)
        const fmtB = cleanLine.match(/(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\s+a\s+(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\s*-+\s*([^:]+)(?::\s*(.+))?/i);
        if (!dateFrom && fmtB) {
          const [, d1, m1, y1raw, d2, m2, y2raw, city, hotel] = fmtB;
          const y2 = y2raw.length === 2 ? '20' + y2raw : y2raw;
          const y1 = y1raw ? (y1raw.length === 2 ? '20' + y1raw : y1raw) : y2;
          lastYear = y2;
          dateFrom = `${y1}-${m1.padStart(2,'0')}-${d1.padStart(2,'0')}`;
          dateTo = `${y2}-${m2.padStart(2,'0')}-${d2.padStart(2,'0')}`;
          cityRaw = city.trim();
          hotelName = hotel ? hotel.trim() : '';
        }
      }

      if (!dateFrom || !dateTo) continue;
      const nights = Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000);
      if (nights <= 0) continue;

      const cityClean = cityRaw.replace(/\/[A-ZÁÉÍÓÚÀÂÊÔÃÕ]+$/, '').trim().toUpperCase();
      const cityPT = CITY_PT[cityClean] || (cityClean.charAt(0) + cityClean.slice(1).toLowerCase());

      newHotels.push({
        id: Date.now() + Math.random(),
        name: hotelName, city: cityPT,
        type: 'per_pax', subType: 'hotel', enabled: true,
        costDbl: '', costSngl: '', pricePerNightDbl: '', pricePerNightSngl: '',
        nights: String(nights), cityTax: '', cityTaxSngl: '', guideOverride: '',
        dateFrom, dateTo, groupCost: '', currency: 'EUR'
      });
    }

    if (newHotels.length === 0) {
      const shown = lines.slice(0, 12).map((l, idx) => `${idx + 1}. ${l}`).join('\n');
      const more = lines.length > 12 ? `\n… a dalších ${lines.length - 12} řádků` : '';
      setParseError(`Nepodařilo se rozpoznat žádné řádky. Takto to parser rozdělil (${lines.length} řádků):\n${shown}${more}`);
      return;
    }

    const existingItems = [...items];
    const lastHotelIdx = existingItems.map((it, i) => it.subType === 'hotel' ? i : -1).filter(i => i >= 0).pop();
    const insertAt = lastHotelIdx !== undefined ? lastHotelIdx + 1 : 0;
    existingItems.splice(insertAt, 0, ...newHotels);
    setItems(existingItems);
    itemsRef.current = existingItems;
    updateDoc(doc(db, 'offers', offerId), { items: existingItems, updatedAt: new Date().toISOString() }).catch(err => console.error(err));
    setItineraryText('');
  };

  const iStyle = { width: '100%', padding: '6px 8px', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const lbl = (t) => <label style={{ fontSize: 11, color: colors.muted, display: 'block', marginBottom: 3 }}>{t}</label>;

  const newItemRef = React.useRef(null);
  const [newItemId, setNewItemId] = React.useState(null);

  React.useEffect(() => {
    if (newItemRef.current) {
      newItemRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      newItemRef.current = null;
    }
  }, [items]);

  const saveTimeoutRef = React.useRef(null);
  const addItem = (type, subType) => {
    const newItem = { id: Date.now() + Math.random(), name: '', city: '', type, subType: subType || '', enabled: true, costDbl: '', costSngl: '', pricePerNightDbl: '', pricePerNightSngl: '', nights: '', cityTax: '', cityTaxSngl: '', guideOverride: '', dateFrom: '', dateTo: '', groupCost: '', currency: 'EUR' };
    setNewItemId(newItem.id);
    setItems(prev => {
      const newItems = [...prev];
      if (type === 'per_pax' && subType === 'hotel') {
        const lastHotelIdx = newItems.map((it, i) => it.subType === 'hotel' ? i : -1).filter(i => i >= 0).pop();
        newItems.splice(lastHotelIdx !== undefined ? lastHotelIdx + 1 : 0, 0, newItem);
      } else if (type === 'per_pax' && subType === 'ticket') {
        const lastTicketIdx = newItems.map((it, i) => it.subType === 'ticket' ? i : -1).filter(i => i >= 0).pop();
        if (lastTicketIdx !== undefined) {
          newItems.splice(lastTicketIdx + 1, 0, newItem);
        } else {
          const lastHotelIdx = newItems.map((it, i) => it.subType === 'hotel' ? i : -1).filter(i => i >= 0).pop();
          newItems.splice(lastHotelIdx !== undefined ? lastHotelIdx + 1 : 0, 0, newItem);
        }
      } else {
        newItems.push(newItem);
      }
      itemsRef.current = newItems;
      // Cancel any pending debounced save (it has stale data) and save immediately
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      updateDoc(doc(db, 'offers', offerId), {
        items: newItems,
        updatedAt: new Date().toISOString(),
      }).catch(err => console.error('Auto-save new item failed:', err));
      return newItems;
    });
  };

  const moveItem = (index, direction) => {
    const newItems = [...items];
    const target = index + direction;
    if (target < 0 || target >= newItems.length) return;
    [newItems[index], newItems[target]] = [newItems[target], newItems[index]];
    setItems(newItems);
  };

  const dragItem = React.useRef(null);
  const dragOverItem = React.useRef(null);

  const handleDragStart = (idx) => { dragItem.current = idx; };
  const handleDragEnter = (idx) => { dragOverItem.current = idx; };
  const handleDragEnd = () => {
    const from = dragItem.current;
    const to = dragOverItem.current;
    if (from === null || to === null || from === to) { dragItem.current = null; dragOverItem.current = null; return; }
    const newItems = [...items];
    const dragged = newItems.splice(from, 1)[0];
    newItems.splice(to, 0, dragged);
    setItems(newItems);
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const updateItem = (id, field, value) => {
    setItems(prev => {
      const newItems = prev.map(it => it.id === id ? { ...it, [field]: value } : it);
      itemsRef.current = newItems;
      // Debounced auto-save for any field change (prevents data loss like the Munich nights bug)
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        updateDoc(doc(db, 'offers', offerId), {
          items: itemsRef.current,
          updatedAt: new Date().toISOString(),
        }).catch(err => console.error('Auto-save item field failed:', err));
      }, 800);
      return newItems;
    });
  };

  // Same as updateItem but sets several fields on the item at once (used for attachments,
  // where filename + URL + storage path must all land together in a single save).
  const updateItemFields = (id, fields) => {
    setItems(prev => {
      const newItems = prev.map(it => it.id === id ? { ...it, ...fields } : it);
      itemsRef.current = newItems;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        updateDoc(doc(db, 'offers', offerId), {
          items: itemsRef.current,
          updatedAt: new Date().toISOString(),
        }).catch(err => console.error('Auto-save item fields failed:', err));
      }, 800);
      return newItems;
    });
  };

  // Upload a hotel confirmation (email saved as PDF, screenshot, voucher, etc.) to Firebase
  // Storage and attach the resulting URL to the itinerary item.
  const handleUploadConfirmation = (item, file, onProgress) => {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `offers/${offerId}/confirmations/${item.id}_${Date.now()}_${safeName}`;
    const fileRef = storageRef(storage, path);
    const task = uploadBytesResumable(fileRef, file);
    return new Promise((resolve, reject) => {
      task.on('state_changed',
        (snapshot) => {
          if (onProgress) onProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
        },
        (err) => {
          // Surface the real Firebase error code (e.g. storage/unauthorized) so it can be
          // shown directly in the UI without needing browser dev tools.
          reject(new Error(err.code ? `${err.code}` : (err.message || 'Neznámá chyba')));
        },
        async () => {
          try {
            const url = await getDownloadURL(task.snapshot.ref);
            updateItemFields(item.id, {
              confirmationFileUrl: url,
              confirmationFileName: file.name,
              confirmationFilePath: path,
            });
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  };

  const handleRemoveConfirmation = async (item) => {
    if (!window.confirm('Odebrat přiloženou přílohu?')) return;
    if (item.confirmationFilePath) {
      try { await deleteObject(storageRef(storage, item.confirmationFilePath)); }
      catch (e) { console.error('Storage delete failed (continuing anyway):', e); }
    }
    updateItemFields(item.id, {
      confirmationFileUrl: '',
      confirmationFileName: '',
      confirmationFilePath: '',
    });
  };

  const removeItem = (id) => {
    setItems(prev => {
      const newItems = prev.filter(it => it.id !== id);
      itemsRef.current = newItems;
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      updateDoc(doc(db, 'offers', offerId), {
        items: newItems,
        updatedAt: new Date().toISOString(),
      }).catch(err => console.error('Auto-save remove failed:', err));
      return newItems;
    });
  };

  const [saveStatus, setSaveStatus] = useState(''); // '', 'saving', 'ok', 'error'

  const handleSave = async () => {
    if (isLocked) { alert('Nabídka je zamčena. Nejprve ji odemkněte.'); return; }
    if (loading) { alert('Data se ještě načítají — počkejte prosím.'); return; }
    // Cancel any pending debounced auto-save — we'll save the current state right now instead
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    await new Promise(r => setTimeout(r, 300));
    setSaving(true);
    setSaveStatus('saving');
    try {
      const currentItems = itemsRef.current;
      if (currentItems.length === 0 && lastSavedItems && lastSavedItems.length > 0) {
        if (!window.confirm('POZOR: Seznam položek je prázdný! Uložením smažete všechny hotely a položky. Opravdu chcete uložit?')) {
          setSaving(false);
          setSaveStatus('');
          return;
        }
      }
      await updateDoc(doc(db, 'offers', offerId), {
        items: currentItems, margin: parseFloat(margin) || 0, paxList, focCount: parseInt(focCount) || 1, focType,
        updatedAt: new Date().toISOString(),
      });
      setLastSavedItems(currentItems);
      setSaveStatus('ok');
      setTimeout(() => setSaveStatus(''), 5000);
    } catch (err) {
      setSaveStatus('error');
      alert('❌ Chyba při ukládání: ' + err.message);
    }
    setSaving(false);
  };

  const handleHeaderChange = async (field, value) => {
    setOffer(prev => ({ ...prev, [field]: value }));
    await updateDoc(doc(db, 'offers', offerId), { [field]: value, updatedAt: new Date().toISOString() });
  };

  const handleDecline = async () => {
    if (!window.confirm('Move this offer to Declined?')) return;
    await updateDoc(doc(db, 'offers', offerId), { declined: true });
    navigate('offers');
  };

  const handleConvertToOrder = async () => {
    if (!window.confirm('Create a new Order from this offer? Hotels and tickets will be copied as services.')) return;
    const data = {
      name: offer.name,
      clientId: offer.clientId || '',
      clientName: offer.clientName || '',
      startDate: offer.startDate || '',
      endDate: offer.endDate || '',
      paxCount: '',
      status: 'enquired',
      destinations: offer.destinations || '',
      focType: 'dbl',
      margin: margin || 15,
      notes: `Created from offer "${offer.name}".\n${offer.notes || ''}`,
      createdAt: new Date().toISOString(),
    };
    const ref = await addDoc(collection(db, 'orders'), data);

    // Copy hotels as hotel services
    const currentItems = itemsRef.current;
    const hotelItems = currentItems.filter(it => it.enabled !== false && it.subType === 'hotel');
    for (const h of hotelItems) {
      const nights = parseFloat(h.nights) || '';
      await addDoc(collection(db, 'orders', ref.id, 'services'), {
        type: 'hotel',
        name: h.name || '',
        providerName: h.name || '',
        providerEmail: '', providerEmail2: '', providerWebsite: '', providerPhone: '',
        city: h.city || '',
        dateFrom: h.dateFrom || '',
        dateTo: h.dateTo || '',
        ticketCount: '',
        nights,
        currency: h.currency || 'EUR',
        status: 'enquired',
        optionDate: '', depositDate: '', depositAmount: '', depositCurrency: 'EUR', confirmationLink: '',
        notes: '',
        dblRooms: '', snglRooms: '', twnRooms: '', trplRooms: '',
        pricePerDblRoom: h.pricePerNightDbl || '',
        pricePerSnglRoom: h.pricePerNightSngl || '',
        pricePerTwnRoom: '', pricePerTrplRoom: '',
        cityTax: h.cityTax || '',
        cityTaxIncluded: 'separate', cityTaxType: 'per_person',
        dinners: '', dinnerPrice: '', lunches: '', lunchPrice: '',
        guideRoom: '', guideRoomPrice: '',
        driverAccom: 'none', driverRoomPrice: '', driverNights: '',
        hotelFoc: 'none', hotelFocOccupancy: 'dbl',
        cancellationDays: '', cancellationDate: '',
        pricePerPax: '', totalPrice: '',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    }

    // Copy tickets/meals as ticket services
    const ticketItems = currentItems.filter(it => it.enabled !== false && it.subType === 'ticket');
    for (const t of ticketItems) {
      await addDoc(collection(db, 'orders', ref.id, 'services'), {
        type: 'ticket',
        name: t.name || '',
        providerName: '', providerEmail: '', providerEmail2: '', providerWebsite: '', providerPhone: '',
        dateFrom: t.dateFrom || '', dateTo: t.dateTo || '',
        currency: t.currency || 'EUR',
        status: 'enquired',
        optionDate: '', depositDate: '', depositAmount: '', depositCurrency: 'EUR', confirmationLink: '',
        notes: '',
        pricePerPax: t.costDbl || '',
        ticketCount: '',
        totalPrice: '',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    }

    // Copy group costs (bus, guide etc.) as "other" services if that type exists, else as notes
    const groupSvcItems = currentItems.filter(it => it.enabled !== false && it.type === 'group' && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
    for (const g of groupSvcItems) {
      await addDoc(collection(db, 'orders', ref.id, 'services'), {
        type: 'other',
        name: g.name || '',
        providerName: '', providerEmail: '', providerEmail2: '', providerWebsite: '', providerPhone: '',
        dateFrom: g.dateFrom || '', dateTo: g.dateTo || '',
        currency: g.currency || 'EUR',
        status: 'enquired',
        optionDate: '', depositDate: '', depositAmount: '', depositCurrency: 'EUR', confirmationLink: '',
        notes: '',
        totalPrice: g.groupCost || '',
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    }

    await handleHeaderChange('status', 'won');
    navigate('order-detail', { orderId: ref.id });
  };

  if (loading) return <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div>;
  if (!offer) return <div style={{ color: colors.muted, fontSize: 14 }}>Offer not found.</div>;

  const activeItems = items.filter(it => it.enabled !== false);
  const groupItems = activeItems.filter(it => it.type === 'group');
  const paxItems = activeItems.filter(it => it.type === 'per_pax');

  const perPaxDblEUR = paxItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostDbl(it), it.currency), 0);
  const perPaxSnglEUR = paxItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostSngl(it), it.currency), 0);
  const snglSupplementEUR = perPaxSnglEUR - perPaxDblEUR;

  // Hotel guide cost = sum of SNGL-room cost across ALL hotels AND tickets/meals in this offer
  // (the guide travels with the group, occupying a SNGL room at every hotel) — computed automatically.
  const regularGroupItems = groupItems.filter(it => it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
  const guideHotelItems = groupItems.filter(it => it.subType === 'guide_hotel');
  const driverHotelItems = groupItems.filter(it => it.subType === 'driver_hotel');
  const regularGroupTotalEUR = regularGroupItems.reduce((sum, it) => sum + toEURWithRates(evalAmount(it.groupCost), it.currency), 0);

  // Hotel-only SNGL total (no tickets/meals) — for the driver, who only needs lodging, not activities
  const hotelOnlyItems = paxItems.filter(it => it.subType === 'hotel');
  const hotelOnlySnglEUR = hotelOnlyItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostSngl(it), it.currency), 0);

  const getGuideHotelCost = (it) => {
    const override = it.guideOverride;
    if (override !== '' && override !== undefined && override !== null) {
      return toEURWithRates(evalAmount(override), it.currency || 'EUR');
    }
    return perPaxSnglEUR; // hotels + tickets/meals
  };
  const getDriverHotelCost = (it) => {
    const override = it.guideOverride;
    if (override !== '' && override !== undefined && override !== null) {
      return toEURWithRates(evalAmount(override), it.currency || 'EUR');
    }
    return hotelOnlySnglEUR; // hotels only, no tickets
  };
  const guideHotelTotalEUR = guideHotelItems.reduce((sum, it) => sum + getGuideHotelCost(it), 0);
  const driverHotelTotalEUR = driverHotelItems.reduce((sum, it) => sum + getDriverHotelCost(it), 0);
  const groupTotalEUR = regularGroupTotalEUR + guideHotelTotalEUR + driverHotelTotalEUR;

  // FOC pool: DBL = per-pax DBL cost, SNGL = per-pax SNGL cost
  const focPoolEUR = focType === 'sngl' ? perPaxSnglEUR : perPaxDblEUR;
  const focCountNum = parseInt(focCount) || 1;

  // Compute per-currency breakdown (only CHF, GBP — other currencies stay in EUR)
  const SPLIT_CURRENCIES = ['CHF', 'GBP'];
  const activeCurrencies = [...new Set(activeItems.map(it => it.currency))].filter(c => SPLIT_CURRENCIES.includes(c));
  const hasSplit = activeCurrencies.length > 0;

  const paxCounts = paxList.split(',').map(s => parseInt(s.trim())).filter(n => n > 0);

  // Per-currency per-pax and group costs (in original currency, no conversion)
  const computeByCurrency = (cur) => {
    const curPaxItems = paxItems.filter(it => it.currency === cur);
    const curGroupItems = groupItems.filter(it => it.currency === cur && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
    const perPaxDbl = curPaxItems.reduce((sum, it) => sum + evalAmount(it.subType === 'hotel'
      ? (((evalAmount(it.pricePerNightDbl) + evalAmount(it.cityTax)) * (parseFloat(it.nights) || 0)) / 2)
      : it.costDbl), 0);
    const perPaxSngl = curPaxItems.reduce((sum, it) => sum + evalAmount(it.subType === 'hotel'
      ? ((evalAmount(it.pricePerNightSngl) + evalAmount(it.cityTaxSngl || it.cityTax)) * (parseFloat(it.nights) || 0))
      : (it.costSngl || it.costDbl)), 0);
    const groupTotal = curGroupItems.reduce((sum, it) => sum + evalAmount(it.groupCost), 0);
    const snglSupp = perPaxSngl - perPaxDbl;
    const focPool = perPaxDbl;
    const rows = paxCounts.map(pax => {
      const groupPerPax = groupTotal / pax;
      const costDbl = groupPerPax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const sellingBeforeFoc = costDbl + marginAmount;
      const focShare = focPool / pax;
      const finalDbl = sellingBeforeFoc + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, groupPerPax, costDbl, marginAmount, focShare, finalDbl, finalSngl };
    });
    return { cur, perPaxDbl, perPaxSngl, groupTotal, snglSupp, rows };
  };

  // EUR-only items (currency === EUR or not in SPLIT_CURRENCIES)
  const computeEurOnly = () => {
    const eurPaxItems = paxItems.filter(it => !SPLIT_CURRENCIES.includes(it.currency));
    const eurGroupItems = groupItems.filter(it => !SPLIT_CURRENCIES.includes(it.currency) && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
    const perPaxDbl = eurPaxItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostDbl(it), it.currency), 0);
    const perPaxSngl = eurPaxItems.reduce((sum, it) => sum + toEURWithRates(getEffectiveCostSngl(it), it.currency), 0);
    const groupTotal = eurGroupItems.reduce((sum, it) => sum + toEURWithRates(evalAmount(it.groupCost), it.currency), 0)
      + guideHotelTotalEUR + driverHotelTotalEUR;
    const snglSupp = perPaxSngl - perPaxDbl;
    const focPool = perPaxDbl;
    const rows = paxCounts.map(pax => {
      const groupPerPax = groupTotal / pax;
      const costDbl = groupPerPax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const sellingBeforeFoc = costDbl + marginAmount;
      const focShare = focPool / pax;
      const finalDbl = sellingBeforeFoc + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, groupPerPax, costDbl, marginAmount, focShare, finalDbl, finalSngl };
    });
    return { cur: 'EUR', perPaxDbl, perPaxSngl, groupTotal, snglSupp, rows };
  };

  const splitData = showSplit && hasSplit
    ? [...activeCurrencies.map(c => computeByCurrency(c)), computeEurOnly()]
    : null;

  const rows = paxCounts.map(pax => {
    const groupPerPax = groupTotalEUR / pax;
    const costDbl = groupPerPax + perPaxDblEUR;
    const marginAmount = costDbl * (margin / 100);
    const sellingBeforeFoc = costDbl + marginAmount;
    const focShare = (focPoolEUR * focCountNum) / pax;
    const finalDbl = sellingBeforeFoc + focShare;
    const finalSngl = finalDbl + snglSupplementEUR;
    return { pax, groupPerPax, costDbl, marginAmount, sellingBeforeFoc, focShare, finalDbl, finalSngl };
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <button onClick={() => navigate('offers')} style={{ padding: '6px 14px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
          ← Back to Offers
        </button>
        <button onClick={() => { setPinInput(''); setPinError(''); isLocked ? setShowUnlockDialog(true) : setShowLockDialog(true); }}
          style={{ padding: '6px 14px', background: isLocked ? '#dc2626' : '#f7f6f3', color: isLocked ? '#fff' : colors.text, border: `1px solid ${isLocked ? '#dc2626' : colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: isLocked ? 700 : 400 }}>
          {isLocked ? '🔒 Zamčeno — klikněte pro odemčení' : '🔓 Zamknout nabídku (PIN)'}
        </button>
      </div>

      {/* Lock dialog */}
      {showLockDialog && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '2rem', width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>🔒 Zamknout nabídku</div>
            <div style={{ fontSize: 13, color: colors.muted, marginBottom: 16 }}>Zadejte PIN (min. 4 znaky). Bez tohoto PIN nebude možné nabídku odemknout a upravovat.</div>
            <input type="password" value={pinInput} onChange={e => { setPinInput(e.target.value); setPinError(''); }}
              placeholder="Zadejte PIN" autoFocus
              style={{ width: '100%', padding: '10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 16, textAlign: 'center', boxSizing: 'border-box', letterSpacing: 6, marginBottom: 8 }} />
            {pinError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{pinError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleLock} style={{ flex: 1, padding: '10px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontWeight: 600 }}>Zamknout</button>
              <button onClick={() => setShowLockDialog(false)} style={{ flex: 1, padding: '10px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, cursor: 'pointer' }}>Zrušit</button>
            </div>
          </div>
        </div>
      )}

      {/* Unlock dialog */}
      {showUnlockDialog && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '2rem', width: 320, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>🔓 Odemknout nabídku</div>
            <div style={{ fontSize: 13, color: colors.muted, marginBottom: 16 }}>Zadejte PIN pro odemčení a povolení úprav.</div>
            <input type="password" value={pinInput} onChange={e => { setPinInput(e.target.value); setPinError(''); }}
              placeholder="Zadejte PIN" autoFocus
              onKeyDown={e => e.key === 'Enter' && handleUnlock()}
              style={{ width: '100%', padding: '10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 16, textAlign: 'center', boxSizing: 'border-box', letterSpacing: 6, marginBottom: 8 }} />
            {pinError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{pinError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleUnlock} style={{ flex: 1, padding: '10px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontWeight: 600 }}>Odemknout</button>
              <button onClick={() => setShowUnlockDialog(false)} style={{ flex: 1, padding: '10px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, cursor: 'pointer' }}>Zrušit</button>
            </div>
            {isOwner && (
              <button onClick={handleEmergencyUnlock} style={{ width: '100%', marginTop: 12, padding: '8px', background: 'transparent', color: '#dc2626', border: '1px solid #dc2626', borderRadius: 7, fontSize: 12, cursor: 'pointer' }}>
                🔑 Nouzové odemčení (zapomenutý PIN)
              </button>
            )}
          </div>
        </div>
      )}

      {isLocked && (
        <div style={{ background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 10, padding: '12px 16px', marginBottom: '1rem', fontSize: 13, color: '#dc2626', fontWeight: 600 }}>
          🔒 Tato nabídka je zamčena. Pro úpravy ji odemkněte PINem.
        </div>
      )}

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 12, alignItems: 'end' }}>
          <div>{lbl('Offer name')}
            <input type="text" defaultValue={offer.name} onBlur={e => handleHeaderChange('name', e.target.value)} style={{ ...iStyle, fontSize: 16, fontWeight: 700, padding: '8px 10px' }} />
          </div>
          <div>{lbl('Client')}
            <select defaultValue={offer.clientId || ''} onChange={e => {
              const c = clients.find(x => x.id === e.target.value);
              handleHeaderChange('clientId', e.target.value);
              handleHeaderChange('clientName', c?.name || '');
            }} style={iStyle}>
              <option value="">— Select client —</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>{lbl('Start date')}<DateDMY dateKey="startDate" value={offer.startDate || ''} onChange={v => handleHeaderChange('startDate', v)} colors={colors} /></div>
          <div>{lbl('End date')}<DateDMY dateKey="endDate" value={offer.endDate || ''} onChange={v => handleHeaderChange('endDate', v)} colors={colors} /></div>
          <div>{lbl('Status')}
            <select defaultValue={offer.status || 'draft'} onChange={e => handleHeaderChange('status', e.target.value)} style={iStyle}>
              {STATUS_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          {lbl('Destinations')}<input type="text" defaultValue={offer.destinations} onBlur={e => handleHeaderChange('destinations', e.target.value)} style={iStyle} />
        </div>
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 8 }}>📋 Vytvořit hotely z textu</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Vložte text s itinerářem (datumy, města, případně hotely) — aplikace automaticky vytvoří hotelové řádky s datumy a přeloží města do PT-BR.
        </div>
        <textarea value={itineraryText} onChange={e => setItineraryText(e.target.value)} rows={5}
          placeholder={"18.5.2027 – 21.5.2027 MUNICH\n21.5.2027 – 23.5.2027 SALZBURG\n23.5.2027 – 24.5.2027 INNSBRUCK"}
          style={{ width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box', resize: 'vertical', marginBottom: 10 }} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={handleParseItinerary} disabled={!itineraryText.trim()}
            style={{ padding: '8px 18px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            ✨ Vytvořit hotely z textu
          </button>
          <button onClick={() => {
            const hotelItems = activeItems.filter(it => it.subType === 'hotel');
            // Build city list with per-city dates
            const cityMap = {};
            hotelItems.forEach(h => {
              if (!h.city) return;
              if (!cityMap[h.city]) cityMap[h.city] = { checkIn: h.dateFrom, checkOut: h.dateTo };
              else cityMap[h.city].checkOut = h.dateTo; // extend checkout if multiple nights
            });
            const cityList = Object.entries(cityMap).map(([city, dates]) => ({ city, ...dates }));
            navigate('hotels', {
              prefill: {
                groupName: offer.name || offer.clientName || '',
                cityList,
              }
            });
          }}
            style={{ padding: '8px 18px', background: colors.accent, color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            ✉ Poslat poptávky hotelům
          </button>
        </div>
        {parseError && <div style={{ fontSize: 12, color: colors.danger, marginTop: 8, whiteSpace: 'pre-line' }}>{parseError}</div>}
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Cost items</div>
        {(() => {
          const totalNights = offer.startDate && offer.endDate && offer.startDate.length === 10 && offer.endDate.length === 10
            ? Math.round((new Date(offer.endDate) - new Date(offer.startDate)) / 86400000)
            : null;
          const hotels = activeItems.filter(it => it.subType === 'hotel');
          const hotelNightsSum = hotels.reduce((sum, it) => sum + (parseFloat(it.nights) || 0), 0);
          const displayNights = totalNights ?? hotelNightsSum;
          const mismatch = totalNights !== null && hotelNightsSum > 0 && totalNights !== hotelNightsSum;

          // Check 1: empty DBL/SNGL prices
          const hotelsWithEmptyPrices = hotels.filter(h => !h.pricePerNightDbl || h.pricePerNightDbl === '' || !h.pricePerNightSngl || h.pricePerNightSngl === '');
          const ticketsWithEmptyPrice = activeItems.filter(it => it.type === 'per_pax' && it.subType === 'ticket' && (!it.costDbl || it.costDbl === ''));
          const groupCostsWithEmptyPrice = activeItems.filter(it => it.type === 'group' && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel' && (!it.groupCost || it.groupCost === ''));

          // Check 2: date gaps between consecutive hotels (sorted by dateFrom)
          const hotelsSorted = [...hotels].filter(h => h.dateFrom && h.dateTo && h.dateFrom.length === 10 && h.dateTo.length === 10)
            .sort((a, b) => a.dateFrom.localeCompare(b.dateFrom));
          const dateGaps = [];
          for (let i = 0; i < hotelsSorted.length - 1; i++) {
            const curr = hotelsSorted[i], next = hotelsSorted[i + 1];
            if (curr.dateTo !== next.dateFrom) {
              const gapDays = Math.round((new Date(next.dateFrom) - new Date(curr.dateTo)) / 86400000);
              if (gapDays !== 0) {
                dateGaps.push({ from: curr.city || curr.name || '?', to: next.city || next.name || '?', days: gapDays, dateTo: curr.dateTo, dateFrom: next.dateFrom });
              }
            }
          }

          // Check 3: duplicate hotels (same city + same name)
          const seenHotels = {};
          const duplicateHotels = [];
          hotels.forEach(h => {
            const key = `${(h.city || '').toLowerCase().trim()}|${(h.name || '').toLowerCase().trim()}`;
            if (key !== '|' && seenHotels[key]) {
              duplicateHotels.push(h.city ? `${h.city}: ${h.name}` : h.name);
            }
            seenHotels[key] = true;
          });

          // Check 4: margin issues
          const marginNum = parseFloat(margin);
          const marginIssue = isNaN(marginNum) || marginNum <= 0;

          const hasAnyWarning = mismatch || hotelsWithEmptyPrices.length > 0 || ticketsWithEmptyPrice.length > 0 || groupCostsWithEmptyPrice.length > 0 || dateGaps.length > 0 || duplicateHotels.length > 0 || marginIssue;

          return displayNights > 0 || hasAnyWarning ? (
            <div style={{ marginBottom: 10 }}>
              {displayNights > 0 && (
                <div style={{ fontSize: 13, color: colors.primary, fontWeight: 600, padding: '6px 10px', background: '#FFFDE7', borderRadius: 7, display: 'inline-block', marginBottom: 6 }}>
                  🏨 Celkem nocí: {displayNights}
                </div>
              )}
              {mismatch && (
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 6, padding: '8px 12px', background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 7 }}>
                  ⚠️ POZOR: Datum nabídky ukazuje {totalNights} nocí, ale součet nocí u hotelů je {hotelNightsSum}. Zkontrolujte prosím počet nocí u hotelů — chybí nebo přebývá {Math.abs(totalNights - hotelNightsSum)} {Math.abs(totalNights - hotelNightsSum) === 1 ? 'noc' : 'noci'}.
                </div>
              )}
              {hotelsWithEmptyPrices.length > 0 && (
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 6, padding: '8px 12px', background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 7 }}>
                  ⚠️ POZOR: Tyto hotely nemají vyplněnou cenu DBL nebo SNGL: {hotelsWithEmptyPrices.map(h => h.city ? `${h.city} (${h.name || 'bez názvu'})` : (h.name || 'bez názvu')).join(', ')}.
                </div>
              )}
              {ticketsWithEmptyPrice.length > 0 && (
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 6, padding: '8px 12px', background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 7 }}>
                  ⚠️ POZOR: Estas vstupenky/refeições não têm preço preenchido: {ticketsWithEmptyPrice.map(t => t.name || 'sem nome').join(', ')}.
                </div>
              )}
              {groupCostsWithEmptyPrice.length > 0 && (
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 6, padding: '8px 12px', background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 7 }}>
                  ⚠️ POZOR: Estes custos de grupo não têm preço preenchido: {groupCostsWithEmptyPrice.map(g => g.name || 'sem nome').join(', ')}.
                </div>
              )}
              {dateGaps.length > 0 && (
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 6, padding: '8px 12px', background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 7 }}>
                  ⚠️ POZOR: Mezera nebo přesah v datech mezi hotely: {dateGaps.map((g, i) => `${g.from} (até ${fmtDateBR(g.dateTo)}) → ${g.to} (desde ${fmtDateBR(g.dateFrom)}) — ${g.days > 0 ? `falta ${g.days} dia(s)` : `sobrepõe ${Math.abs(g.days)} dia(s)`}`).join('; ')}.
                </div>
              )}
              {duplicateHotels.length > 0 && (
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 6, padding: '8px 12px', background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 7 }}>
                  ⚠️ POZOR: Hotel duplicado detectado: {duplicateHotels.join(', ')}. Verifique se não foi adicionado por engano.
                </div>
              )}
              {marginIssue && (
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginTop: 6, padding: '8px 12px', background: '#FEF2F2', border: '2px solid #dc2626', borderRadius: 7 }}>
                  ⚠️ POZOR: Margem está zerada, vazia ou inválida ({margin === '' ? 'vazia' : margin}). A oferta pode estar sendo calculada sem lucro.
                </div>
              )}
            </div>
          ) : null;
        })()}
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 12 }}>
          <b>Per-pax (hotels, tickets, meals)</b>: enter the cost per person for the whole trip, in DBL and SNGL room basis. <b>Group cost (bus, flight)</b>: enter the total cost for the whole group — it gets divided by the number of paying pax. <b>Hotel guide</b>: SNGL room price × nights, also divided by pax.
        </div>

        {items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, overflowX: 'auto' }}>
            {items.map((it, idx) => {
              const isHotel = it.type === 'per_pax' && it.subType === 'hotel';
              const isGuideHotel = it.type === 'group' && it.subType === 'guide_hotel';
              const isDriverHotel = it.type === 'group' && it.subType === 'driver_hotel';
              const isTicket = it.type === 'per_pax' && it.subType === 'ticket';
              const isTransportGroup = it.type === 'group' && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel';
              const cols = isHotel ? '60px 2fr 1fr 1fr 60px 1fr 1fr 1fr 90px 32px' : (isGuideHotel || isDriverHotel) ? '60px 2fr 1fr 1fr 90px 32px' : it.type === 'per_pax' ? '60px 2fr 1fr 90px 32px' : '60px 2fr 1fr 90px 32px';
              const minWidth = isHotel ? 1100 : undefined;
              const isEnabled = it.enabled !== false;
              const rowBg = isGuideHotel ? '#FCE4EC' : isDriverHotel ? '#E1BEE7' : it.type === 'group' ? '#FCE4EC' : (it.type === 'per_pax' && it.subType === 'ticket') ? '#E3F2FD' : isHotel ? '#FFFDE7' : 'transparent';
              return (
                <div key={it.id} ref={it.id === newItemId ? newItemRef : null}
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragEnter={() => handleDragEnter(idx)}
                  onDragEnd={handleDragEnd}
                  onDragOver={e => e.preventDefault()}
                  style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '6px 8px', borderBottom: `1px solid ${colors.border}`, borderRadius: 6, background: rowBg, minWidth, opacity: isEnabled ? 1 : 0.45, cursor: 'grab' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                    <input type="checkbox" checked={isEnabled} onChange={e => updateItem(it.id, 'enabled', e.target.checked)} title={isEnabled ? 'Kliknutím vypnout' : 'Kliknutím zapnout'} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                    <span title="Přetáhněte pro přesunutí" style={{ fontSize: 14, color: colors.muted, cursor: 'grab', lineHeight: 1, userSelect: 'none' }}>⠿</span>
                  </div>
                  <div>
                    {isHotel ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input key={`city-${it.id}`} type="text" placeholder="Město" value={it.city || ''} onChange={e => updateItem(it.id, 'city', e.target.value)} style={{ ...iStyle, flex: '0 0 35%', fontWeight: 600 }} />
                        <input key={`name-${it.id}`} type="text" placeholder="Název hotelu" value={it.name || ''} onChange={e => updateItem(it.id, 'name', e.target.value)} style={{ ...iStyle, flex: 1 }} />
                      </div>
                    ) : (
                      <input key={`name-${it.id}`} type="text" placeholder={isGuideHotel ? 'e.g. Guide hotel (auto)' : isDriverHotel ? 'e.g. Driver hotel (auto)' : 'e.g. Big Ben ticket'} value={it.name || ''} onChange={e => updateItem(it.id, 'name', e.target.value)} style={iStyle} />
                    )}
                    {(isHotel || it.type === 'group' || (it.type === 'per_pax' && it.subType === 'ticket')) && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
                        <DateDMY dateKey={`df-${it.id}`} value={it.dateFrom || ''} colors={colors} onChange={v => {
                          updateItem(it.id, 'dateFrom', v);
                          const current = itemsRef.current.find(x => x.id === it.id);
                          const dTo = current ? current.dateTo : it.dateTo;
                          if (v && dTo && v.length === 10 && dTo.length === 10) {
                            const n = Math.round((new Date(dTo) - new Date(v)) / 86400000);
                            if (n > 0) updateItem(it.id, 'nights', String(n));
                          }
                          // Chain: if THIS hotel's dateFrom is set, auto-fill the PREVIOUS hotel's dateTo if empty
                          // (departure from previous hotel = arrival at this one)
                          if (isHotel && v && v.length === 10) {
                            const allItems = itemsRef.current;
                            const myIdx = allItems.findIndex(x => x.id === it.id);
                            for (let i = myIdx - 1; i >= 0; i--) {
                              if (allItems[i].subType === 'hotel') {
                                if (!allItems[i].dateTo || allItems[i].dateTo === '') {
                                  updateItem(allItems[i].id, 'dateTo', v);
                                  const prevFrom = allItems[i].dateFrom;
                                  if (prevFrom && prevFrom.length === 10) {
                                    const n2 = Math.round((new Date(v) - new Date(prevFrom)) / 86400000);
                                    if (n2 > 0) updateItem(allItems[i].id, 'nights', String(n2));
                                  }
                                }
                                break;
                              }
                            }
                          }
                        }} />
                        <DateDMY dateKey={`dt-${it.id}`} value={it.dateTo || ''} colors={colors} onChange={v => {
                          updateItem(it.id, 'dateTo', v);
                          const current = itemsRef.current.find(x => x.id === it.id);
                          const dFrom = current ? current.dateFrom : it.dateFrom;
                          if (v && dFrom && v.length === 10 && dFrom.length === 10) {
                            const n = Math.round((new Date(v) - new Date(dFrom)) / 86400000);
                            if (n > 0) updateItem(it.id, 'nights', String(n));
                          }
                          // Chain: if THIS hotel's dateTo is set, auto-fill the NEXT hotel's dateFrom if empty
                          if (isHotel && v && v.length === 10) {
                            const allItems = itemsRef.current;
                            const myIdx = allItems.findIndex(x => x.id === it.id);
                            for (let i = myIdx + 1; i < allItems.length; i++) {
                              if (allItems[i].subType === 'hotel') {
                                if (!allItems[i].dateFrom || allItems[i].dateFrom === '') {
                                  updateItem(allItems[i].id, 'dateFrom', v);
                                  const nextTo = allItems[i].dateTo;
                                  if (nextTo && nextTo.length === 10) {
                                    const n2 = Math.round((new Date(nextTo) - new Date(v)) / 86400000);
                                    if (n2 > 0) updateItem(allItems[i].id, 'nights', String(n2));
                                  }
                                }
                                break;
                              }
                            }
                          }
                        }} />
                        {it.dateFrom && it.dateTo && (() => {
                          const n = Math.round((new Date(it.dateTo) - new Date(it.dateFrom)) / 86400000);
                          return n > 0 ? <span style={{ fontSize: 11, color: colors.primary, fontWeight: 600, whiteSpace: 'nowrap', alignSelf: 'center' }}>{n} {n === 1 ? 'noc' : n < 5 ? 'noci' : 'nocí'}</span> : null;
                        })()}
                      </div>
                    )}
                    {isHotel && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select value={it.bookingStatus || ''} onChange={e => updateItem(it.id, 'bookingStatus', e.target.value)}
                          style={{ fontSize: 10, padding: '2px 4px', border: `1px solid ${it.bookingStatus === 'confirmed' ? '#2d6a4f' : it.bookingStatus === 'requested' ? '#854f0b' : colors.border}`, borderRadius: 4, background: it.bookingStatus === 'confirmed' ? '#e8f5e9' : it.bookingStatus === 'requested' ? '#fff8e1' : '#fff', color: it.bookingStatus === 'confirmed' ? '#2d6a4f' : it.bookingStatus === 'requested' ? '#854f0b' : colors.muted }}>
                          <option value="">Stav?</option>
                          <option value="requested">🟡 Poptáno</option>
                          <option value="confirmed">🟢 Potvrzeno</option>
                        </select>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <span style={{ fontSize: 9, color: colors.muted }}>Option:</span>
                          <DateDMY dateKey={`opt-${it.id}`} value={it.optionDate || ''} colors={colors}
                            onChange={v => updateItem(it.id, 'optionDate', v)} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <span style={{ fontSize: 9, color: colors.muted }}>Free cancel:</span>
                          <DateDMY dateKey={`cxl-${it.id}`} value={it.cancellationDeadline || ''} colors={colors}
                            onChange={v => updateItem(it.id, 'cancellationDeadline', v)} />
                        </div>
                        <HotelAttachment
                          item={it}
                          colors={colors}
                          onUpload={(file, onProgress) => handleUploadConfirmation(it, file, onProgress)}
                          onRemove={() => handleRemoveConfirmation(it)}
                        />
                      </div>
                    )}
                    {(isTicket || isTransportGroup) && (
                      <div style={{ display: 'flex', marginTop: 4 }}>
                        <HotelAttachment
                          item={it}
                          colors={colors}
                          onUpload={(file, onProgress) => handleUploadConfirmation(it, file, onProgress)}
                          onRemove={() => handleRemoveConfirmation(it)}
                        />
                      </div>
                    )}
                  </div>
                  {isHotel ? (
                    <>
                      <FormulaField placeholder="Price/night DBL, or =199" value={it.pricePerNightDbl} onChange={e => updateItem(it.id, 'pricePerNightDbl', e.target.value)} colors={colors} />
                      <FormulaField placeholder="Price/night SNGL, or =189" value={it.pricePerNightSngl} onChange={e => updateItem(it.id, 'pricePerNightSngl', e.target.value)} colors={colors} />
                      <input type="number" placeholder="Nights" value={it.nights} onChange={e => updateItem(it.id, 'nights', e.target.value)} style={iStyle} />
                      <FormulaField placeholder="City tax DBL/p/night, or =199*0.05" value={it.cityTax} onChange={e => updateItem(it.id, 'cityTax', e.target.value)} colors={colors} />
                      <FormulaField placeholder="City tax SNGL/p/night (if different)" value={it.cityTaxSngl} onChange={e => updateItem(it.id, 'cityTaxSngl', e.target.value)} colors={colors} />
                      <div style={{ fontSize: 11, color: colors.muted, textAlign: 'right' }}>
                        {it.city ? <span style={{ fontWeight: 600 }}>{it.city}</span> : null}{it.city && it.name ? ' · ' : ''}{it.name}<br/>
                        DBL: {getEffectiveCostDbl(it).toFixed(2)} / SNGL: {getEffectiveCostSngl(it).toFixed(2)} per pax
                      </div>
                    </>
                  ) : it.type === 'per_pax' ? (
                    <FormulaField placeholder="Cost/pax (per person), or =212/2" value={it.costDbl} onChange={e => updateItem(it.id, 'costDbl', e.target.value)} colors={colors} />
                  ) : isGuideHotel ? (
                    <>
                      <div style={{ fontSize: 11, color: colors.muted }}>
                        Auto: {perPaxSnglEUR.toFixed(2)} EUR<br />(hotéis + ingressos/refeições, SNGL)
                      </div>
                      <FormulaField placeholder={`Override, default ${perPaxSnglEUR.toFixed(2)}`} value={it.guideOverride} onChange={e => updateItem(it.id, 'guideOverride', e.target.value)} colors={colors} />
                      <select value={it.currency || 'EUR'} onChange={e => updateItem(it.id, 'currency', e.target.value)} style={iStyle}>
                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </>
                  ) : isDriverHotel ? (
                    <>
                      <div style={{ fontSize: 11, color: colors.muted }}>
                        Auto: {hotelOnlySnglEUR.toFixed(2)} EUR<br />(somente hotéis, SNGL)
                      </div>
                      <FormulaField placeholder={`Override, default ${hotelOnlySnglEUR.toFixed(2)}`} value={it.guideOverride} onChange={e => updateItem(it.id, 'guideOverride', e.target.value)} colors={colors} />
                      <select value={it.currency || 'EUR'} onChange={e => updateItem(it.id, 'currency', e.target.value)} style={iStyle}>
                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </>
                  ) : (
                    <>
                      <FormulaField placeholder="Total group cost, or =4524+2299.14" value={it.groupCost} onChange={e => updateItem(it.id, 'groupCost', e.target.value)} colors={colors} />
                      <select value={it.currency} onChange={e => updateItem(it.id, 'currency', e.target.value)} style={iStyle}>
                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </>
                  )}
                  {!isGuideHotel && !isDriverHotel && (isHotel || it.type === 'per_pax') && (
                    <select value={it.currency} onChange={e => updateItem(it.id, 'currency', e.target.value)} style={iStyle}>
                      {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                  <button onClick={() => removeItem(it.id)} style={{ padding: '5px 8px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12, cursor: 'pointer', color: colors.danger }}>✕</button>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={() => addItem('per_pax', 'hotel')} style={{ padding: '7px 14px', background: colors.white, border: `1px solid ${colors.primary}`, color: colors.primary, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            + Hotel (price/night × nights)
          </button>
          <button onClick={() => addItem('per_pax', 'ticket')} style={{ padding: '7px 14px', background: colors.white, border: `1px solid ${colors.primary}`, color: colors.primary, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            + Ticket / meal (flat per-pax price)
          </button>
          <button onClick={() => addItem('group')} style={{ padding: '7px 14px', background: colors.white, border: `1px solid ${colors.primary}`, color: colors.primary, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            + Group cost (bus, flight)
          </button>
          <button onClick={() => addItem('group', 'guide_hotel')} style={{ padding: '7px 14px', background: colors.white, border: `1px solid ${colors.primary}`, color: colors.primary, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            + Hotel guide (hotéis + ingressos)
          </button>
          <button onClick={() => addItem('group', 'driver_hotel')} style={{ padding: '7px 14px', background: colors.white, border: `1px solid ${colors.primary}`, color: colors.primary, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
            + Hotel driver (somente hotéis)
          </button>
        </div>
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Pricing settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 2fr', gap: 12, marginBottom: 10 }}>
          <div>{lbl('Margin (%)')}<input type="text" inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value)} onInput={decimalInput} style={iStyle} /></div>
          <div>{lbl('FOC — počet volných osob')}
            <input type="number" min="0" max="20" value={focCount} onChange={e => setFocCount(e.target.value)} style={iStyle} />
          </div>
          <div>{lbl('FOC typ')}
            <select value={focType} onChange={e => setFocType(e.target.value)} style={iStyle}>
              <option value="dbl">DBL (sdílí pokoj)</option>
              <option value="sngl">SNGL (vlastní pokoj)</option>
            </select>
          </div>
          <div>{lbl('Pax sizes to calculate (comma-separated)')}<input type="text" value={paxList} onChange={e => setPaxList(e.target.value)} style={iStyle} /></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={handleSave} disabled={saving || loading} style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, opacity: (saving || loading) ? 0.6 : 1 }}>
            {saving ? 'Ukládám...' : '💾 Save offer'}
          </button>
          {saveStatus === 'ok' && <div style={{ fontSize: 13, color: 'green', fontWeight: 600 }}>✓ Uloženo v {new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>}
          {saveStatus === 'error' && <div style={{ fontSize: 13, color: 'red', fontWeight: 600 }}>❌ Chyba uložení!</div>}
          {lastAutoSave && <div style={{ fontSize: 11, color: colors.muted }}>✓ Automaticky uloženo v {lastAutoSave}</div>}
          <div style={{ fontSize: 12, color: colors.muted }}>
            Exchange rates (→ EUR){ratesUpdatedAt ? ` · ECB ${ratesUpdatedAt}` : ''}: {Object.entries(rates).map(([c, r]) => `${c} ${r.toFixed(4)}`).join(' · ')}
          </div>
        </div>
      </div>

      <div style={{ background: colors.white, border: `2px solid ${colors.primary}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem', overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary }}>💰 Selling price per pax</div>
          {hasSplit && (
            <button onClick={() => { const newVal = !showSplit; setShowSplit(newVal); updateDoc(doc(db, 'offers', offerId), { showSplit: newVal }).catch(()=>{}); }} style={{ padding: '5px 12px', background: showSplit ? colors.primary : colors.white, color: showSplit ? colors.white : colors.primary, border: `1px solid ${colors.primary}`, borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
              {showSplit ? '📊 Zobrazit celkem (EUR)' : `📊 Rozdělit podle měn (${activeCurrencies.join(' + ')} + EUR)`}
            </button>
          )}
        </div>

        {!showSplit ? (
          <>
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
              Hotels/tickets per pax (DBL): {perPaxDblEUR.toFixed(2)} EUR · (SNGL): {perPaxSnglEUR.toFixed(2)} EUR · SNGL supplement: {snglSupplementEUR.toFixed(2)} EUR · Group costs total: {groupTotalEUR.toFixed(2)} EUR
              <br/>
              <b>↳ Apenas hotéis (DBL): {paxItems.filter(it => it.subType === 'hotel').reduce((sum, it) => sum + toEURWithRates(getEffectiveCostDbl(it), it.currency), 0).toFixed(2)} EUR</b>
              {' · '}
              <b>Apenas ingressos/outros (DBL): {paxItems.filter(it => it.subType !== 'hotel').reduce((sum, it) => sum + toEURWithRates(getEffectiveCostDbl(it), it.currency), 0).toFixed(2)} EUR</b>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `2px solid ${colors.border}` }}>
                  <th style={{ textAlign: 'left', padding: '6px 8px' }}>Pax</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>Group cost/pax</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>+ Hotel/tickets (DBL)</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>= Cost/pax (DBL)</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>+ Margin ({margin}%)</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px' }}>+ FOC share</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 700 }}>= Price/pax DBL</th>
                  <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 700 }}>Price/pax SNGL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.pax} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.pax} + {focCountNum} FOC ({focType.toUpperCase()})</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.groupPerPax.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{perPaxDblEUR.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.costDbl.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.marginAmount.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{r.focShare.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{r.finalDbl.toFixed(2)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{r.finalSngl.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div style={{ color: colors.muted, fontSize: 13 }}>Add cost items and pax sizes to see the calculation.</div>}
          </>
        ) : (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {splitData.map(({ cur, perPaxDbl, groupTotal, snglSupp, rows: sRows }) => (
              <div key={cur} style={{ flex: '1 1 300px', minWidth: 280 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, marginBottom: 6, padding: '4px 10px', background: cur === 'EUR' ? '#EAF3DE' : '#E3F2FD', borderRadius: 6, display: 'inline-block' }}>
                  {cur === 'EUR' ? '🇪🇺' : cur === 'CHF' ? '🇨🇭' : '🇬🇧'} Cena v {cur}
                </div>
                <div style={{ fontSize: 11, color: colors.muted, marginBottom: 8 }}>
                  Hotel/vstupenky/pax (DBL): {perPaxDbl.toFixed(2)} · Group costs: {groupTotal.toFixed(2)} · SNGL příplatek: {snglSupp.toFixed(2)}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: `2px solid ${colors.border}` }}>
                      <th style={{ textAlign: 'left', padding: '5px 6px' }}>Pax</th>
                      <th style={{ textAlign: 'right', padding: '5px 6px' }}>+Marže</th>
                      <th style={{ textAlign: 'right', padding: '5px 6px' }}>+FOC</th>
                      <th style={{ textAlign: 'right', padding: '5px 6px', fontWeight: 700 }}>DBL {cur}</th>
                      <th style={{ textAlign: 'right', padding: '5px 6px', fontWeight: 700 }}>SNGL {cur}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sRows.map(r => (
                      <tr key={r.pax} style={{ borderBottom: `1px solid ${colors.border}` }}>
                        <td style={{ padding: '5px 6px', fontWeight: 600 }}>{r.pax}+1</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right' }}>{r.marginAmount.toFixed(2)}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right' }}>{r.focShare.toFixed(2)}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{r.finalDbl.toFixed(2)}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{r.finalSngl.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Programa da viagem (PT-BR)</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Cole aqui o texto do roteiro dia-a-dia (em português). Selecione o texto e use os botões para formatar. Este texto será usado na proposta gerada para o cliente.
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => document.execCommand('bold')}
            style={{ width: 32, height: 32, fontWeight: 700, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'Georgia, serif' }}>
            B
          </button>
          {[
            { c: '#FFF59D', label: 'Amarelo' },
            { c: '#F8BBD0', label: 'Rosa claro' },
            { c: '#B2EBF2', label: 'Turquesa claro' },
            { c: '#E0E0E0', label: 'Cinza' },
          ].map(({ c, label }) => (
            <button key={c} type="button" onMouseDown={e => e.preventDefault()} onClick={() => document.execCommand('hiliteColor', false, c)}
              style={{ width: 32, height: 32, background: c, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer' }}
              title={label} />
          ))}
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => document.execCommand('removeFormat')}
            style={{ padding: '0 10px', height: 32, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>
            ✕ Limpar
          </button>
        </div>
        <div
          contentEditable
          suppressContentEditableWarning
          onBlur={e => handleHeaderChange('programText', e.currentTarget.innerHTML)}
          dangerouslySetInnerHTML={{ __html: offer.programText || '' }}
          data-placeholder="📅 07/04/2027 • QUARTA-FEIRA • DIA 1: BRASIL / LISBOA / BERLIM (AÉREO)&#10;Apresentação no aeroporto para embarque..."
          style={{ ...iStyle, minHeight: 220, resize: 'vertical', fontFamily: 'Georgia, serif', lineHeight: 1.5, overflowY: 'auto', whiteSpace: 'pre-wrap' }}
        />
        <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
          <button onClick={() => navigate('offer-print', { offerId })} style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            📄 Gerar oferta (PDF)
          </button>
          <button onClick={() => {
            // Build Excel data
            const fmtDate = (d) => { if (!d || d.length < 10) return ''; const [y,m,day] = d.split('-'); return `${day}.${m}.${y}`; };
            const data = [];
            data.push([`${offer.name || ''} | ${fmtDate(offer.startDate)} - ${fmtDate(offer.endDate)}`]);
            data.push([offer.clientName || '']);
            data.push([]);

            // Collect all currencies used in hotels
            const allHotels = activeItems.filter(it => it.subType === 'hotel');
            const allTickets = activeItems.filter(it => it.subType === 'ticket');
            const allCurrencies = [...new Set([
              ...allHotels.map(h => h.currency || 'EUR'),
              ...allTickets.map(t => t.currency || 'EUR')
            ])];

            // Output hotels and tickets grouped by currency
            allCurrencies.forEach(curr => {
              const currHotels = allHotels.filter(h => (h.currency || 'EUR') === curr);
              const currTickets = allTickets.filter(t => (t.currency || 'EUR') === curr);
              if (currHotels.length === 0 && currTickets.length === 0) return;

              data.push([`HOTELY / INGRESSOS — ${curr}`, '', '', '', 'DBL/noite', 'SNGL/noite', 'DBL total', 'SNGL total']);
              let totalDblCurr = 0, totalSnglCurr = 0;

              let currentCity = '';
              currHotels.forEach(h => {
                if (h.city && h.city !== currentCity) {
                  currentCity = h.city;
                  data.push([`${h.city} ${fmtDate(h.dateFrom)} - ${fmtDate(h.dateTo)}`]);
                }
                const dbl = evalAmount(h.pricePerNightDbl);
                const sngl = evalAmount(h.pricePerNightSngl);
                const nights = parseFloat(h.nights) || 0;
                const tax = evalAmount(h.cityTax);
                const taxSngl = (h.cityTaxSngl !== '' && h.cityTaxSngl !== undefined && h.cityTaxSngl !== null) ? evalAmount(h.cityTaxSngl) : evalAmount(h.cityTax);
                const tDbl = ((dbl + tax) * nights) / 2;
                const tSngl = (sngl + taxSngl) * nights;
                totalDblCurr += tDbl;
                totalSnglCurr += tSngl;
                data.push([h.name || '', '', '', '', dbl, sngl, tDbl.toFixed(2), tSngl.toFixed(2)]);
                if (tax > 0) data.push([`  TAX`, '', '', '', tax, taxSngl, (tax * nights / 2).toFixed(2), (taxSngl * nights).toFixed(2)]);
              });

              currTickets.forEach(t => {
                const v = evalAmount(t.costDbl);
                totalDblCurr += v;
                data.push([t.name || '', '', '', '', '', '', v.toFixed(2), v.toFixed(2)]);
              });

              data.push([`TOTAL ${curr}`, '', '', '', '', '', totalDblCurr.toFixed(2), totalSnglCurr.toFixed(2)]);
              data.push([]);
            });

            // Totals per pax
            data.push([]);
            const perPaxDbl = perPaxDblEUR;
            const perPaxSngl = perPaxSnglEUR;
            const rateNote = [...new Set(activeItems.filter(it => it.currency && it.currency !== 'EUR').map(it => it.currency))].map(c => `1 ${c} = ${(rates[c]||1).toFixed(4)} EUR`).join(', ');
            data.push([`TOTAL per pax (EUR)${rateNote ? ' · kurz: ' + rateNote : ''}`, '', '', '', '', '', perPaxDbl.toFixed(2), perPaxSngl.toFixed(2)]);

            // Group costs
            data.push([]);
            groupItems.filter(it => it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel').forEach(g => {
              const gc = evalAmount(g.groupCost);
              const gcurr = g.currency || 'EUR';
              data.push([g.name || '', '', `${gc} ${gcurr}`]);
            });
            data.push([`TOTAL group (EUR)`, '', groupTotalEUR.toFixed(2)]);

            // Pricing table
            data.push([]);
            data.push(['Pax', 'Group/pax', '+ Hotels (DBL)', '= Cost DBL', `+ Margin ${margin}%`, '+ FOC', '= Price DBL', 'Price SNGL']);
            rows.forEach(r => {
              data.push([
                `${r.pax} + ${focCountNum} FOC`,
                r.groupPerPax.toFixed(2),
                perPaxDblEUR.toFixed(2),
                r.costDbl.toFixed(2),
                r.marginAmount.toFixed(2),
                r.focShare.toFixed(2),
                r.finalDbl.toFixed(2),
                r.finalSngl.toFixed(2)
              ]);
            });

            // Load SheetJS and create Excel
            const loadXLSX = () => new Promise((resolve, reject) => {
              if (window.XLSX) { resolve(window.XLSX); return; }
              const s = document.createElement('script');
              s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
              s.onload = () => resolve(window.XLSX);
              s.onerror = reject;
              document.head.appendChild(s);
            });
            loadXLSX().then(XLSX => {
              const ws = XLSX.utils.aoa_to_sheet(data);
              ws['!cols'] = [{ wch: 45 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 14 }];
              const wb = XLSX.utils.book_new();
              XLSX.utils.book_append_sheet(wb, ws, 'Kalkulace');
              XLSX.writeFile(wb, `${offer.name || 'kalkulace'}.xlsx`);
            }).catch(() => alert('Chyba při generování Excelu.'));
          }} style={{ padding: '9px 20px', background: '#27500A', color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            📥 Export Excel
          </button>
        </div>
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary }}>Incluído no preço</div>
          <button onClick={() => {
            const hotelItems = activeItems.filter(it => it.subType === 'hotel');
            const ticketItems = activeItems.filter(it => it.subType === 'ticket' && it.name);
            const groupSvcs = activeItems.filter(it => it.type === 'group' && it.name && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
            const hasTax = hotelItems.some(h => evalAmount(h.cityTax) > 0);
            const lines = [];
            if (hotelItems.length > 0) lines.push(`Hospedagem em hotéis selecionados, com café da manhã incluído (${hotelItems.length} ${hotelItems.length === 1 ? 'hotel' : 'hotéis'}, conforme itinerário)`);
            if (hasTax) lines.push('Taxas municipais (city tax) dos hotéis');
            groupSvcs.forEach(it => lines.push(it.name));
            ticketItems.forEach(it => lines.push(`1x ${it.name}`));
            lines.push('Assistência da nossa equipe durante toda a viagem');
            handleHeaderChange('includedText', lines.join('\n'));
          }} style={{ padding: '5px 12px', background: colors.white, border: `1px solid ${colors.primary}`, color: colors.primary, borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
            ↻ Gerar automaticamente
          </button>
        </div>
        <textarea key={offer.includedText} defaultValue={offer.includedText} onBlur={e => handleHeaderChange('includedText', e.target.value)} rows={6}
          placeholder={'Hospedagem em hotéis selecionados...\nTransporte por ônibus panorâmico...\n1x Visita ao Coliseu...'}
          style={{ ...iStyle, resize: 'vertical', lineHeight: 1.6 }} />
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Não incluído</div>
        <textarea defaultValue={offer.notIncludedText || 'Voos internacionais e taxas de embarque\nBebidas e refeições não mencionadas\nGorjetas e despesas de caráter pessoal\nMaleteiros\nSeguro viagem'} onBlur={e => handleHeaderChange('notIncludedText', e.target.value)} rows={5}
          style={{ ...iStyle, resize: 'vertical', lineHeight: 1.6 }} />
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Notes</div>
        <textarea defaultValue={offer.notes} onBlur={e => handleHeaderChange('notes', e.target.value)} rows={3} style={{ ...iStyle, resize: 'vertical', marginBottom: 14 }} />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={handleConvertToOrder} style={{ padding: '9px 20px', background: colors.success, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            ✓ Client confirmed — Convert to Order
          </button>
          <button onClick={handleDecline} style={{ padding: '9px 20px', background: colors.danger, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            ✕ Move to Declined
          </button>
        </div>
      </div>
    </div>
  );
}
