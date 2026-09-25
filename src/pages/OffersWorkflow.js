import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, doc, updateDoc } from 'firebase/firestore';
import { PEOPLE, personByCode, codeForEmail } from '../lib/people';

// Offers workflow — pracovní pohled na nabídky s filtry.
// Stávající stránka Offers zůstává beze změny; tady se jen čte a jediné,
// co se odsud zapisuje, je připnutí (pole pinnedFor).
//
// Pole na nabídce:
//   responsible = '' (společné) | 'HD' | 'FD' | 'HŠ'
//   pinnedFor   = '' (nepřipnuto) | 'ALL' (všichni) | 'HD' | 'FD' | 'HŠ'

const STATUS_LABEL = { draft: 'Draft', sent: 'Odesláno', won: 'Potvrzeno', lost: 'Zamítnuto' };
const STATUS_STYLE = {
  draft: { bg: '#F1EFE8', color: '#444441' },
  sent: { bg: '#E6F1FB', color: '#0C447C' },
  won: { bg: '#EAF3DE', color: '#27500A' },
  lost: { bg: '#FCEBEB', color: '#791F1F' },
};

const STATUS_FILTERS = [
  { id: 'active', label: 'Rozpracované', match: s => s === 'draft' || s === 'sent' },
  { id: 'draft', label: 'Draft', match: s => s === 'draft' },
  { id: 'sent', label: 'Odeslané', match: s => s === 'sent' },
  { id: 'won', label: 'Potvrzené', match: s => s === 'won' },
  { id: 'all', label: 'Vše', match: () => true },
];

const STORE_KEY = 'offersWorkflowFilters';

const loadFilters = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
};

// „upraveno před 2 h“
const ago = (iso) => {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'právě teď';
  if (min < 60) return `před ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'včera';
  if (d < 31) return `před ${d} dny`;
  const m = Math.round(d / 30);
  return m < 12 ? `před ${m} měs.` : `před ${Math.round(m / 12)} r.`;
};

const dmy = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export default function OffersWorkflow({ navigate, colors, userRole, userEmail }) {
  const myCode = codeForEmail(userEmail);
  const saved = loadFilters();

  const [offers, setOffers] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [person, setPerson] = useState(saved.person !== undefined ? saved.person : (myCode || 'ALL'));
  const [statusF, setStatusF] = useState(saved.status || 'active');
  const [clientF, setClientF] = useState(saved.client || '');
  const [search, setSearch] = useState('');
  const [pinError, setPinError] = useState('');

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ person, status: statusF, client: clientF })); } catch (e) {}
  }, [person, statusF, clientF]);

  const fetchAll = useCallback(async () => {
    const [offSnap, cliSnap] = await Promise.all([
      getDocs(collection(db, 'offers')),
      getDocs(collection(db, 'clients')),
    ]);
    let all = offSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => !o.declined);
    // Omezený uživatel vidí jen nabídky, které mu byly výslovně povoleny —
    // stejné pravidlo jako na stránce Offers.
    if (userRole === 'limited') all = all.filter(o => (o.allowedUsers || []).includes(userEmail));
    setOffers(all);
    setClients(cliSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    setLoading(false);
  }, [userRole, userEmail]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Připnutí / odepnutí přímo ze seznamu. Zapisuje se jen pole pinnedFor,
  // nic jiného v nabídce se nemění (ani čas poslední úpravy).
  const setPin = async (o, value) => {
    setPinError('');
    const before = o.pinnedFor || '';
    setOffers(list => list.map(x => (x.id === o.id ? { ...x, pinnedFor: value } : x)));
    try {
      await updateDoc(doc(db, 'offers', o.id), { pinnedFor: value });
    } catch (err) {
      console.error('Připnutí se nepodařilo uložit:', err);
      setOffers(list => list.map(x => (x.id === o.id ? { ...x, pinnedFor: before } : x)));
      setPinError('Připnutí se nepodařilo uložit. Zkuste to prosím znovu.');
    }
  };

  const clientColor = (o) => {
    const c = clients.find(x => x.id === o.clientId) || clients.find(x => x.name === o.clientName);
    return c?.color || '#e2ddd5';
  };

  // ── Filtrování ─────────────────────────────────────────────────────────
  const forPerson = (o) => person === 'ALL' || !o.responsible || o.responsible === person;
  const pinnedForView = (o) => {
    if (!o.pinnedFor) return false;
    if (person === 'ALL') return true;
    return o.pinnedFor === 'ALL' || o.pinnedFor === person;
  };
  const statusMatch = (STATUS_FILTERS.find(f => f.id === statusF) || STATUS_FILTERS[0]).match;
  const term = norm(search.trim());
  const words = term ? term.split(/\s+/) : [];
  const searchMatch = (o) => {
    if (!words.length) return true;
    const hay = norm([o.offerNumber, o.name, o.clientName, o.destinations].join(' '));
    return words.every(w => hay.includes(w));
  };
  const clientMatch = (o) => !clientF || (o.clientName || '') === clientF;

  const base = offers.filter(o => forPerson(o) && clientMatch(o) && searchMatch(o));
  const byEdit = (a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
  // Připnuté jsou nahoře vždy, bez ohledu na filtr stavu.
  const pinned = base.filter(pinnedForView).sort(byEdit);
  const rest = base.filter(o => !pinnedForView(o) && statusMatch(o.status || 'draft')).sort(byEdit);

  const clientNames = Array.from(new Set(offers.map(o => o.clientName).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  // ── Vzhled ─────────────────────────────────────────────────────────────
  const chip = (active, color) => ({
    padding: '6px 12px', borderRadius: 16, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${active ? (color || colors.primary) : colors.border}`,
    background: active ? (color || colors.primary) : colors.white,
    color: active ? '#fff' : colors.text, fontWeight: active ? 700 : 400,
  });

  const PinButton = ({ o }) => {
    const [open, setOpen] = useState(false);
    const ref = React.useRef(null);
    // Kliknutí kamkoli mimo nabídku ji zavře.
    useEffect(() => {
      if (!open) return undefined;
      const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
      document.addEventListener('mousedown', close);
      return () => document.removeEventListener('mousedown', close);
    }, [open]);
    const p = o.pinnedFor || '';
    const who = p === 'ALL' ? 'všichni' : (personByCode(p)?.code || '');
    return (
      <div ref={ref} style={{ position: 'relative', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
        <button type="button" onClick={() => setOpen(v => !v)}
          title={p ? `Připnuto pro: ${who}` : 'Připnout'}
          style={{ border: `1px solid ${p ? '#E3B341' : colors.border}`, background: p ? '#FFF4D6' : colors.white,
                   borderRadius: 7, padding: '4px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                   color: p ? '#7a5c0a' : colors.muted, opacity: p ? 1 : 0.7, whiteSpace: 'nowrap' }}>
          📌{p ? ` ${who}` : ''}
        </button>
        {open && (
          <div style={{ position: 'absolute', right: 0, top: '110%', zIndex: 20, background: colors.white,
                        border: `1px solid ${colors.border}`, borderRadius: 8, boxShadow: '0 8px 20px rgba(0,0,0,0.15)',
                        padding: 4, minWidth: 170 }}>
            {[{ v: '', t: 'nepřipnuto' }, { v: 'ALL', t: '📌 všichni' },
              ...PEOPLE.map(x => ({ v: x.code, t: `📌 ${x.code} – ${x.short}` }))].map(opt => (
              <div key={opt.v || 'none'} onClick={() => { setOpen(false); if (opt.v !== p) setPin(o, opt.v); }}
                style={{ padding: '6px 10px', fontSize: 13, cursor: 'pointer', borderRadius: 5,
                         background: opt.v === p ? '#F4F6F8' : 'transparent', fontWeight: opt.v === p ? 700 : 400 }}>
                {opt.t}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const Row = ({ o }) => {
    const st = STATUS_STYLE[o.status || 'draft'] || STATUS_STYLE.draft;
    const resp = personByCode(o.responsible);
    const openTodos = (o.todos || []).filter(t => !t.done).length;
    return (
      <div onClick={() => navigate('offer-detail', { offerId: o.id })}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px 10px 0',
                 borderBottom: `1px solid ${colors.border}`, cursor: 'pointer', background: colors.white }}
        onMouseEnter={e => { e.currentTarget.style.background = '#FAF9F6'; }}
        onMouseLeave={e => { e.currentTarget.style.background = colors.white; }}>
        <div style={{ width: 6, alignSelf: 'stretch', background: clientColor(o), flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            {o.offerNumber && (
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', background: '#EEF2F7', color: '#334',
                             borderRadius: 5, padding: '2px 6px', flexShrink: 0 }}>{o.offerNumber}</span>
            )}
            <span style={{ fontSize: 14, fontWeight: 600, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {o.name || '(bez názvu)'}
            </span>
          </div>
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: '2px 10px', alignItems: 'center' }}>
            <span>{o.clientName || '— bez klienta —'}</span>
            {o.startDate && <span>{dmy(o.startDate)}{o.endDate ? ` – ${dmy(o.endDate)}` : ''}</span>}
            {openTodos > 0 && (
              <span style={{ fontSize: 11, fontWeight: 700, color: '#854f0b', background: '#fff8e1', borderRadius: 10, padding: '1px 7px' }}>
                ✓ {openTodos} úkol{openTodos === 1 ? '' : (openTodos < 5 ? 'y' : 'ů')}
              </span>
            )}
            {(o.updatedAt || o.createdAt) && <span>upraveno {ago(o.updatedAt || o.createdAt)}</span>}
          </div>
        </div>
        <span title={resp ? `Má na starost: ${resp.name}` : 'Společné'}
          style={{ fontSize: 11, fontWeight: 700, borderRadius: 10, padding: '2px 8px', flexShrink: 0,
                   background: resp ? resp.bg : '#F4F4F2', color: resp ? resp.color : colors.muted }}>
          {resp ? resp.code : 'společné'}
        </span>
        <span style={{ background: st.bg, color: st.color, fontSize: 11, padding: '3px 8px', borderRadius: 6, fontWeight: 500, flexShrink: 0 }}>
          {STATUS_LABEL[o.status || 'draft'] || o.status}
        </span>
        <PinButton o={o} />
      </div>
    );
  };

  const box = { background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'visible', marginBottom: '1.25rem' };
  const boxTitle = (t) => (
    <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, padding: '10px 14px', borderBottom: `1px solid ${colors.border}`, background: '#FAF9F6', borderRadius: '12px 12px 0 0' }}>{t}</div>
  );

  return (
    <div>
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Offers workflow</h1>
        <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>Na čem se pracuje — připnuté nahoře, pak podle poslední úpravy.</div>
      </div>

      {/* Čí pohled */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: colors.muted, width: 70 }}>Kdo:</span>
        <button type="button" onClick={() => setPerson('ALL')} style={chip(person === 'ALL')}>Všichni</button>
        {PEOPLE.map(p => (
          <button key={p.code} type="button" onClick={() => setPerson(p.code)} style={chip(person === p.code, p.color)}>
            {p.short}{p.code === myCode ? ' (já)' : ''}
          </button>
        ))}
      </div>

      {/* Stav */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: colors.muted, width: 70 }}>Stav:</span>
        {STATUS_FILTERS.map(f => (
          <button key={f.id} type="button" onClick={() => setStatusF(f.id)} style={chip(statusF === f.id)}>{f.label}</button>
        ))}
      </div>

      {/* Klient + hledání */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: '1.25rem', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: colors.muted, width: 70 }}>Klient:</span>
        <select value={clientF} onChange={e => setClientF(e.target.value)}
          style={{ padding: '7px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'inherit', background: colors.white, minWidth: 200 }}>
          <option value="">Všichni klienti</option>
          {clientNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Hledat číslo, název, destinaci…"
          style={{ flex: 1, minWidth: 200, maxWidth: 420, padding: '7px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
        {search && (
          <button type="button" onClick={() => setSearch('')}
            style={{ padding: '6px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, background: 'transparent', color: colors.muted, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>✕</button>
        )}
      </div>

      {pinError && (
        <div style={{ background: '#FCEBEB', color: '#791F1F', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 12 }}>{pinError}</div>
      )}

      {loading ? <div style={{ color: colors.muted, fontSize: 14 }}>Načítám…</div> : (
        <>
          {pinned.length > 0 && (
            <div style={box}>
              {boxTitle(`📌 Připnuté (${pinned.length})`)}
              {pinned.map(o => <Row key={o.id} o={o} />)}
            </div>
          )}
          <div style={box}>
            {boxTitle(`${(STATUS_FILTERS.find(f => f.id === statusF) || {}).label} (${rest.length})`)}
            {rest.length === 0
              ? <div style={{ padding: '1.5rem', textAlign: 'center', color: colors.muted, fontSize: 13 }}>Pro tyto filtry tu nic není.</div>
              : rest.map(o => <Row key={o.id} o={o} />)}
          </div>
        </>
      )}
    </div>
  );
}
