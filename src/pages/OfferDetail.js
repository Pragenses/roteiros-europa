import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc, getDocs, collection, updateDoc, addDoc } from 'firebase/firestore';
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

export default function OfferDetail({ offerId, navigate, colors }) {
  const [offer, setOffer] = useState(null);
  const [clients, setClients] = useState([]);
  const [items, setItems] = useState([]);
  const [margin, setMargin] = useState(15);
  const [paxList, setPaxList] = useState('15,20,25,30,35');
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [ratesUpdatedAt, setRatesUpdatedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    const snap = await getDoc(doc(db, 'offers', offerId));
    if (snap.exists()) {
      const data = snap.data();
      setOffer({ id: snap.id, ...data });
      setItems(data.items || []);
      setMargin(data.margin ?? 15);
      setPaxList(data.paxList || '15,20,25,30,35');
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

  const toEURWithRates = (amount, currency) => toEUR(amount, currency, rates);

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

  const addItem = (type, subType) => {
    const newItem = { id: Date.now() + Math.random(), name: '', type, subType: subType || '', enabled: true, costDbl: '', costSngl: '', pricePerNightDbl: '', pricePerNightSngl: '', nights: '', cityTax: '', cityTaxSngl: '', guideOverride: '', dateFrom: '', dateTo: '', groupCost: '', currency: 'EUR' };
    setNewItemId(newItem.id);
    const newItems = [...items];
    if (type === 'per_pax' && subType === 'hotel') {
      // Insert after last hotel
      const lastHotelIdx = newItems.map((it, i) => it.subType === 'hotel' ? i : -1).filter(i => i >= 0).pop();
      newItems.splice(lastHotelIdx !== undefined ? lastHotelIdx + 1 : 0, 0, newItem);
    } else if (type === 'per_pax' && subType === 'ticket') {
      // Insert after last ticket/meal (or after last hotel if no tickets yet)
      const lastTicketIdx = newItems.map((it, i) => it.subType === 'ticket' ? i : -1).filter(i => i >= 0).pop();
      if (lastTicketIdx !== undefined) {
        newItems.splice(lastTicketIdx + 1, 0, newItem);
      } else {
        const lastHotelIdx = newItems.map((it, i) => it.subType === 'hotel' ? i : -1).filter(i => i >= 0).pop();
        newItems.splice(lastHotelIdx !== undefined ? lastHotelIdx + 1 : 0, 0, newItem);
      }
    } else {
      // Group costs go to the end
      newItems.push(newItem);
    }
    setItems(newItems);
  };

  const moveItem = (index, direction) => {
    const newItems = [...items];
    const target = index + direction;
    if (target < 0 || target >= newItems.length) return;
    [newItems[index], newItems[target]] = [newItems[target], newItems[index]];
    setItems(newItems);
  };

  const updateItem = (id, field, value) => {
    setItems(items.map(it => it.id === id ? { ...it, [field]: value } : it));
  };

  const removeItem = (id) => {
    setItems(items.filter(it => it.id !== id));
  };

  const handleSave = async () => {
    setSaving(true);
    await updateDoc(doc(db, 'offers', offerId), {
      items, margin: parseFloat(margin) || 0, paxList,
      updatedAt: new Date().toISOString(),
    });
    setSaving(false);
  };

  const handleHeaderChange = async (field, value) => {
    setOffer(prev => ({ ...prev, [field]: value }));
    await updateDoc(doc(db, 'offers', offerId), { [field]: value, updatedAt: new Date().toISOString() });
  };

  const handleConvertToOrder = async () => {
    if (!window.confirm('Create a new Order from this offer? You can fill in services and details afterwards.')) return;
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

  // Hotel guide cost = sum of SNGL-room cost across ALL hotels in this offer (the guide travels with
  // the group, occupying a SNGL room at every hotel) — computed automatically, no manual input.
  const regularGroupItems = groupItems.filter(it => it.subType !== 'guide_hotel');
  const guideHotelItems = groupItems.filter(it => it.subType === 'guide_hotel');
  const regularGroupTotalEUR = regularGroupItems.reduce((sum, it) => sum + toEURWithRates(evalAmount(it.groupCost), it.currency), 0);
  const getGuideHotelCost = (it) => {
    const override = it.guideOverride;
    if (override !== '' && override !== undefined && override !== null) return evalAmount(override);
    return perPaxSnglEUR;
  };
  const guideHotelTotalEUR = guideHotelItems.reduce((sum, it) => sum + getGuideHotelCost(it), 0);
  const groupTotalEUR = regularGroupTotalEUR + guideHotelTotalEUR;

  // FOC: the free person's cost is the sum of ALL per-pax items (hotels, meals, tickets, city tax, boats, trains...)
  // on a DBL basis, divided across the paying pax. Group costs (bus, guide, flights) are NOT included.
  const focPoolEUR = perPaxDblEUR;

  const paxCounts = paxList.split(',').map(s => parseInt(s.trim())).filter(n => n > 0);

  const rows = paxCounts.map(pax => {
    const groupPerPax = groupTotalEUR / pax;
    const costDbl = groupPerPax + perPaxDblEUR;
    const marginAmount = costDbl * (margin / 100);
    const sellingBeforeFoc = costDbl + marginAmount;
    const focShare = focPoolEUR / pax;
    const finalDbl = sellingBeforeFoc + focShare;
    const finalSngl = finalDbl + snglSupplementEUR;
    return { pax, groupPerPax, costDbl, marginAmount, sellingBeforeFoc, focShare, finalDbl, finalSngl };
  });

  return (
    <div>
      <button onClick={() => navigate('offers')} style={{ padding: '6px 14px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', marginBottom: '1rem' }}>
        ← Back to Offers
      </button>

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
          <div>{lbl('Start date')}<input type="date" defaultValue={offer.startDate} onBlur={e => handleHeaderChange('startDate', e.target.value)} style={iStyle} /></div>
          <div>{lbl('End date')}<input type="date" defaultValue={offer.endDate} onBlur={e => handleHeaderChange('endDate', e.target.value)} style={iStyle} /></div>
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
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Cost items</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 12 }}>
          <b>Per-pax (hotels, tickets, meals)</b>: enter the cost per person for the whole trip, in DBL and SNGL room basis. <b>Group cost (bus, flight)</b>: enter the total cost for the whole group — it gets divided by the number of paying pax. <b>Hotel guide</b>: SNGL room price × nights, also divided by pax.
        </div>

        {items.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12, overflowX: 'auto' }}>
            {items.map((it, idx) => {
              const isHotel = it.type === 'per_pax' && it.subType === 'hotel';
              const isGuideHotel = it.type === 'group' && it.subType === 'guide_hotel';
              const cols = isHotel ? '60px 2fr 1fr 1fr 60px 1fr 1fr 1fr 90px 32px' : isGuideHotel ? '60px 2fr 1fr 1fr 32px' : it.type === 'per_pax' ? '60px 2fr 1fr 90px 32px' : '60px 2fr 1fr 90px 32px';
              const minWidth = isHotel ? 1100 : undefined;
              const isEnabled = it.enabled !== false;
              const rowBg = isGuideHotel ? '#FCE4EC' : it.type === 'group' ? '#FCE4EC' : (it.type === 'per_pax' && it.subType === 'ticket') ? '#E3F2FD' : isHotel ? '#FFFDE7' : 'transparent';
              return (
                <div key={it.id} ref={it.id === newItemId ? newItemRef : null} style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', padding: '6px 8px', borderBottom: `1px solid ${colors.border}`, borderRadius: 6, background: rowBg, minWidth, opacity: isEnabled ? 1 : 0.45 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                    <input type="checkbox" checked={isEnabled} onChange={e => updateItem(it.id, 'enabled', e.target.checked)} title={isEnabled ? 'Incluído no cálculo (clique para excluir)' : 'Excluído do cálculo (clique para incluir)'} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                    <div style={{ display: 'flex', gap: 2 }}>
                      <button onClick={() => moveItem(idx, -1)} disabled={idx === 0} title="Move up" style={{ padding: '4px 6px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: idx === 0 ? 'default' : 'pointer', color: idx === 0 ? colors.border : colors.muted }}>▲</button>
                      <button onClick={() => moveItem(idx, 1)} disabled={idx === items.length - 1} title="Move down" style={{ padding: '4px 6px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 11, cursor: idx === items.length - 1 ? 'default' : 'pointer', color: idx === items.length - 1 ? colors.border : colors.muted }}>▼</button>
                    </div>
                  </div>
                  <div>
                    <input type="text" placeholder={isHotel ? 'e.g. Hotel Kopthorne Tara' : isGuideHotel ? 'e.g. Guide hotel (auto)' : 'e.g. Big Ben ticket'} value={it.name} onChange={e => updateItem(it.id, 'name', e.target.value)} style={iStyle} />
                    {(isHotel || it.type === 'group' || (it.type === 'per_pax' && it.subType === 'ticket')) && (
                      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                        <input type="date" value={it.dateFrom || ''} onChange={e => updateItem(it.id, 'dateFrom', e.target.value)} style={iStyle} title="Date from" />
                        <input type="date" value={it.dateTo || ''} onChange={e => updateItem(it.id, 'dateTo', e.target.value)} style={iStyle} title="Date to" />
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
                        DBL: {getEffectiveCostDbl(it).toFixed(2)} / SNGL: {getEffectiveCostSngl(it).toFixed(2)} per pax
                      </div>
                    </>
                  ) : it.type === 'per_pax' ? (
                    <FormulaField placeholder="Cost/pax (per person), or =212/2" value={it.costDbl} onChange={e => updateItem(it.id, 'costDbl', e.target.value)} colors={colors} />
                  ) : isGuideHotel ? (
                    <>
                      <div style={{ fontSize: 11, color: colors.muted }}>
                        Auto: {perPaxSnglEUR.toFixed(2)} EUR<br />(sum of all hotels' SNGL cost)
                      </div>
                      <FormulaField placeholder={`Override, default ${perPaxSnglEUR.toFixed(2)}`} value={it.guideOverride} onChange={e => updateItem(it.id, 'guideOverride', e.target.value)} colors={colors} />
                    </>
                  ) : (
                    <>
                      <FormulaField placeholder="Total group cost, or =4524+2299.14" value={it.groupCost} onChange={e => updateItem(it.id, 'groupCost', e.target.value)} colors={colors} />
                      <select value={it.currency} onChange={e => updateItem(it.id, 'currency', e.target.value)} style={iStyle}>
                        {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </>
                  )}
                  {!isGuideHotel && (isHotel || it.type === 'per_pax') && (
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
            + Hotel guide (SNGL room × nights ÷ pax)
          </button>
        </div>
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Pricing settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 10 }}>
          <div>{lbl('Margin (%)')}<input type="text" inputMode="decimal" value={margin} onChange={e => setMargin(e.target.value)} onInput={decimalInput} style={iStyle} /></div>
          <div>{lbl('Pax sizes to calculate (comma-separated)')}<input type="text" value={paxList} onChange={e => setPaxList(e.target.value)} style={iStyle} /></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={handleSave} disabled={saving} style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving...' : '💾 Save offer'}
          </button>
          <div style={{ fontSize: 12, color: colors.muted }}>
            Exchange rates (→ EUR){ratesUpdatedAt ? ` · ECB ${ratesUpdatedAt}` : ''}: {Object.entries(rates).map(([c, r]) => `${c} ${r.toFixed(4)}`).join(' · ')}
          </div>
        </div>
      </div>

      <div style={{ background: colors.white, border: `2px solid ${colors.primary}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem', overflowX: 'auto' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>💰 Selling price per pax (EUR)</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Hotels/tickets per pax (DBL): {perPaxDblEUR.toFixed(2)} EUR · (SNGL): {perPaxSnglEUR.toFixed(2)} EUR · SNGL supplement: {snglSupplementEUR.toFixed(2)} EUR · Group costs total: {groupTotalEUR.toFixed(2)} EUR · FOC cost pool/person: {focPoolEUR.toFixed(2)} EUR
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
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.pax} + 1 FOC</td>
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
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Programa da viagem (PT-BR)</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Cole aqui o texto do roteiro dia-a-dia (em português). Este texto será usado na proposta gerada para o cliente.
        </div>
        <textarea defaultValue={offer.programText} onBlur={e => handleHeaderChange('programText', e.target.value)} rows={10} placeholder={"📅 07/04/2027 • QUARTA-FEIRA • DIA 1: BRASIL / LISBOA / BERLIM (AÉREO)\nApresentação no aeroporto para embarque...\n\n📅 08/04/2027 • QUINTA-FEIRA • DIA 2: BERLIM • CITY TOUR\n..."} style={{ ...iStyle, resize: 'vertical', fontFamily: 'Georgia, serif', lineHeight: 1.5 }} />
        <div style={{ marginTop: 14 }}>
          <button onClick={() => navigate('offer-print', { offerId })} style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            📄 Gerar oferta (PDF)
          </button>
        </div>
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>Notes</div>
        <textarea defaultValue={offer.notes} onBlur={e => handleHeaderChange('notes', e.target.value)} rows={3} style={{ ...iStyle, resize: 'vertical', marginBottom: 14 }} />
        <button onClick={handleConvertToOrder} style={{ padding: '9px 20px', background: colors.success, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          ✓ Client confirmed — Convert to Order
        </button>
      </div>
    </div>
  );
}
