import React, { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { serviceCounts, nextDeadline, soldSummary, fmtDate, realizationItems, itemStatus } from '../lib/realization';
import { kindOf, deadlineState } from '../lib/serviceKinds';

// Počty termínů rezervací u akce (⛔ po termínu, ⏳ rezervovat teď, ❓ bez druhu).
const deadlineCounts = (o, today) => {
  const items = realizationItems(o);
  const hotels = items.filter(it => it.subType === 'hotel' && !it.cancelled);
  const hotelsAllConfirmed = hotels.length > 0 && hotels.every(it => itemStatus(it) === 'confirmed');
  const c = { late: 0, warn: 0, nokind: 0 };
  items.forEach(it => {
    const rz = o.rzServices || {};
    const kind = kindOf(it, rz);
    const lv = deadlineState({ it, kind, saved: rz[String(it.id)] || null, offer: o, statusOf: itemStatus, hotelsAllConfirmed, today }).level;
    if (c[lv] !== undefined) c[lv]++;
  });
  return c;
};

// Menu „Realization – Operations“: seznam potvrzených akcí.
// Data se čtou přímo z nabídek (offers s realization.status = 'active');
// nic se nekopíruje. Zatím jen pro vlastníky (testování).
export default function Realization({ navigate, colors }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [showPast, setShowPast] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'offers'), where('realization.status', '==', 'active')));
        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => String(a.startDate || '9999').localeCompare(String(b.startDate || '9999')));
        setList(rows);
      } catch (e) {
        setError('Načtení se nepovedlo: ' + (e.message || e));
        setList([]);
      }
    })();
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = (list || []).filter(o => !o.endDate || o.endDate >= today);
  const past = (list || []).filter(o => o.endDate && o.endDate < today);
  const shown = showPast ? past : upcoming;

  const cols = '110px minmax(180px, 1.4fr) minmax(120px, 1fr) 170px minmax(160px, 1.2fr) 90px 120px minmax(150px, 1fr)';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: '1rem' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>🧭 Realization – Operations</h1>
        <span style={{ fontSize: 12, background: '#FDF3D8', color: '#7A5A00', borderRadius: 6, padding: '2px 8px', fontWeight: 600 }}>testovací verze</span>
      </div>
      <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1rem', lineHeight: 1.5 }}>
        Potvrzené akce (v nabídce tlačítko „✓ Klient potvrdil → Realizace“). Prodejní cena je zamčená z verze, kterou klient přijal;
        hotely a služby se berou živě z nabídky.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {[[false, `Nadcházející (${upcoming.length})`], [true, `Proběhlé (${past.length})`]].map(([v, label]) => (
          <button key={String(v)} onClick={() => setShowPast(v)}
            style={{ padding: '5px 12px', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', border: `1px solid ${showPast === v ? colors.primary : colors.border}`, background: showPast === v ? colors.primary : colors.white, color: showPast === v ? colors.white : colors.text }}>
            {label}
          </button>
        ))}
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 10 }}>⚠ {error}</div>}
      {list === null && <div style={{ color: colors.muted, fontSize: 14 }}>Načítám…</div>}
      {list && shown.length === 0 && !error && (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', color: colors.muted, fontSize: 14 }}>
          {showPast ? 'Žádné proběhlé akce.' : 'Zatím tu nic není. Otevřete potvrzenou nabídku a dole klikněte na „✓ Klient potvrdil → Realizace“.'}
        </div>
      )}

      {list && shown.length > 0 && (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflowX: 'auto' }}>
          <div style={{ minWidth: 1100 }}>
            <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '9px 14px', background: '#F4F6F8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: colors.muted }}>
              <div>Číslo</div><div>Skupina</div><div>Klient</div><div>Termín</div><div>Prodáno</div><div>Potvrzeno</div><div>Rezervace</div><div>Nejbližší termín</div>
            </div>
            {shown.map(o => {
              const rz = o.realization || {};
              const cnt = serviceCounts(o);
              const nd = nextDeadline(o, today);
              const allOk = cnt.total > 0 && cnt.confirmed === cnt.total;
              const dc = deadlineCounts(o, today);
              return (
                <div key={o.id} onClick={() => navigate('realization-detail', { offerId: o.id })}
                  style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '10px 14px', borderTop: `1px solid ${colors.border}`, fontSize: 13, cursor: 'pointer', alignItems: 'center' }}>
                  <div style={{ fontWeight: 700, letterSpacing: '0.04em' }}>{o.offerNumber || '—'}</div>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.name || '(bez názvu)'}</div>
                  <div style={{ color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.clientName || '—'}</div>
                  <div>{fmtDate(o.startDate)} – {fmtDate(o.endDate)}</div>
                  <div>
                    <div style={{ fontWeight: 600 }}>{rz.soldVersionName ? String(rz.soldVersionName).split('_')[0] : '—'}</div>
                    <div style={{ fontSize: 12, color: colors.muted }}>{soldSummary(rz.sold)}</div>
                  </div>
                  <div style={{ fontWeight: 700, color: allOk ? '#27500A' : '#c2410c' }}>{cnt.confirmed} / {cnt.total}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {dc.late > 0 && <span style={{ color: '#b91c1c' }} title="po termínu">⛔ {dc.late}</span>}
                    {dc.warn > 0 && <span style={{ color: '#9a3412' }} title="rezervovat teď">⏳ {dc.warn}</span>}
                    {dc.nokind > 0 && <span style={{ color: '#c2410c' }} title="bez druhu služby">❓ {dc.nokind}</span>}
                    {!dc.late && !dc.warn && !dc.nokind && <span style={{ color: '#27500A' }}>✓</span>}
                  </div>
                  <div style={{ fontSize: 12 }}>
                    {nd ? <><b>{nd.kind} {fmtDate(nd.date)}</b><br /><span style={{ color: colors.muted }}>{nd.label}</span></> : <span style={{ color: colors.muted }}>—</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
