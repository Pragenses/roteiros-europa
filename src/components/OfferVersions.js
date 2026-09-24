// 📁 Verze nabídky — seznam uložených verzí na kartě nabídky.
//
// Jen pro čtení. Všechno se kreslí z „zmrazeného" výpočtu uloženého s verzí
// (viz src/lib/offerVersions.js) — nic se tu nepřepočítává, takže verze ukazuje
// přesně ta čísla, která dostal klient, i když se nabídka mezitím změnila.
//
// Starší verze uložené dřívějším zeleným tlačítkem („Salvar versão (NR)")
// leží v nabídce v poli `pdfVersions` a mají jen PDF, bez výpočtu — ukazují
// se proto jen ke stažení.

import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';

const CUR_FLAG = { EUR: '🇪🇺', CHF: '🇨🇭', GBP: '🇬🇧' };
const SUBTYPE_LABEL = { hotel: 'Hotel', ticket: 'Vstupenka', guide_hotel: 'Hotel průvodce', driver_hotel: 'Hotel řidiče' };

const n2 = (v) => (Number(v) || 0).toFixed(2);
const fmtDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${parseInt(m[3], 10)}. ${parseInt(m[2], 10)}. ${m[1]}` : '';
};
const fmtWhen = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const who = (email) => String(email || '').split('@')[0];

// Krátké shrnutí ceny do řádku seznamu: cena DBL pro nejmenší skupinu.
function priceSummary(snap) {
  if (!snap) return '';
  if (snap.showSplit && snap.split && snap.split.length) {
    const pax = snap.split[0].rows[0]?.pax;
    if (!pax) return '';
    return `${pax} pax: ` + snap.split.map(p => `${n2(p.rows[0]?.finalDbl)} ${p.cur}`).join(' + ');
  }
  const r = snap.combinedRows && snap.combinedRows[0];
  return r ? `${r.pax} pax: ${n2(r.finalDbl)} EUR` : '';
}

const th = { textAlign: 'right', padding: '6px 8px' };
const td = { padding: '6px 8px', textAlign: 'right' };
const red = { ...td, fontWeight: 700, color: '#dc2626' };

function CombinedTable({ snap, colors }) {
  const rows = snap.combinedRows || [];
  return (
    <>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Hotels/tickets per pax (DBL): {n2(snap.perPaxDblEUR)} EUR · (SNGL): {n2(snap.perPaxSnglEUR)} EUR · SNGL supplement: {n2(snap.snglSupplementEUR)} EUR · Group costs total: {n2(snap.groupTotalEUR)} EUR
        <br />
        <b>↳ Apenas hotéis (DBL): {n2(snap.hotelsOnlyDblEUR)} EUR</b>{' · '}<b>Apenas ingressos/outros (DBL): {n2(snap.othersDblEUR)} EUR</b>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `2px solid ${colors.border}` }}>
            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Pax</th>
            <th style={th}>Group cost/pax</th>
            <th style={th}>+ Hotel/tickets (DBL)</th>
            <th style={th}>= Cost/pax (DBL)</th>
            <th style={th}>+ Margin ({snap.margin}%)</th>
            <th style={th}>+ FOC share</th>
            <th style={{ ...th, fontWeight: 700 }}>= Price/pax DBL</th>
            <th style={{ ...th, fontWeight: 700 }}>Price/pax SNGL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.pax} style={{ borderBottom: `1px solid ${colors.border}` }}>
              <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.pax} + {snap.focCount} FOC ({String(snap.focType || 'dbl').toUpperCase()})</td>
              <td style={td}>{n2(r.groupPerPax)}</td>
              <td style={td}>{n2(r.perPaxDbl)}</td>
              <td style={td}>{n2(r.costDbl)}</td>
              <td style={td}>{n2(r.marginAmount)}</td>
              <td style={td}>{n2(r.focShare)}</td>
              <td style={red}>{n2(r.finalDbl)}</td>
              <td style={red}>{n2(r.finalSngl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function SplitTables({ snap, colors }) {
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      {snap.split.map(({ cur, perPaxDbl, groupTotal, snglSupp, rows }) => (
        <div key={cur} style={{ flex: '1 1 300px', minWidth: 280 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, marginBottom: 6, padding: '4px 10px', background: cur === 'EUR' ? '#EAF3DE' : '#E3F2FD', borderRadius: 6, display: 'inline-block' }}>
            {CUR_FLAG[cur] || ''} Cena v {cur}
          </div>
          <div style={{ fontSize: 11, color: colors.muted, marginBottom: 8 }}>
            Hotel/vstupenky/pax (DBL): {n2(perPaxDbl)} · Group costs: {n2(groupTotal)} · SNGL příplatek: {n2(snglSupp)}
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
              {rows.map(r => (
                <tr key={r.pax} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <td style={{ padding: '5px 6px', fontWeight: 600 }}>{r.pax}+{snap.focCount}</td>
                  <td style={{ padding: '5px 6px', textAlign: 'right' }}>{n2(r.marginAmount)}</td>
                  <td style={{ padding: '5px 6px', textAlign: 'right' }}>{n2(r.focShare)}</td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{n2(r.finalDbl)}</td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{n2(r.finalSngl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// Cena jedné služby tak, jak byla zadaná (v původní měně).
function itemPrice(it) {
  const c = it.currency || 'EUR';
  if (it.subType === 'hotel') {
    const parts = [];
    if (it.pricePerNightDbl !== undefined) parts.push(`DBL ${it.pricePerNightDbl}`);
    if (it.pricePerNightSngl !== undefined) parts.push(`SNGL ${it.pricePerNightSngl}`);
    if (it.cityTax !== undefined) parts.push(`city tax ${it.cityTax}`);
    return parts.length ? `${parts.join(' · ')} ${c} / pokoj / noc` : '';
  }
  if (it.type === 'group') {
    if (it.groupCost !== undefined) return `${it.groupCost} ${c} za skupinu`;
    if (it.guideOverride !== undefined) return `${it.guideOverride} ${c}`;
    return 'dopočteno automaticky';
  }
  const parts = [];
  if (it.costDbl !== undefined) parts.push(`DBL ${it.costDbl}`);
  if (it.costSngl !== undefined) parts.push(`SNGL ${it.costSngl}`);
  return parts.length ? `${parts.join(' · ')} ${c} / os.` : '';
}

function ItemsList({ items, colors }) {
  if (!items || !items.length) return null;
  const cell = { padding: '5px 8px', borderBottom: `1px solid ${colors.border}`, verticalAlign: 'top' };
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, marginBottom: 6 }}>Služby v této verzi</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${colors.border}`, textAlign: 'left' }}>
              <th style={{ padding: '5px 8px' }}>Druh</th>
              <th style={{ padding: '5px 8px' }}>Město</th>
              <th style={{ padding: '5px 8px' }}>Název</th>
              <th style={{ padding: '5px 8px' }}>Termín</th>
              <th style={{ padding: '5px 8px' }}>Cena</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.id || i}>
                <td style={cell}>{SUBTYPE_LABEL[it.subType] || (it.type === 'group' ? 'Skupinová služba' : 'Služba na osobu')}</td>
                <td style={cell}>{it.city || ''}</td>
                <td style={{ ...cell, fontWeight: 600 }}>{it.name || ''}</td>
                <td style={cell}>
                  {it.dateFrom ? fmtDate(it.dateFrom) : ''}{it.dateTo ? ` – ${fmtDate(it.dateTo)}` : ''}
                  {it.nights ? ` (${it.nights} n.)` : ''}
                </td>
                <td style={cell}>{itemPrice(it)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VersionPreview({ v, colors }) {
  const snap = v.snapshot || {};
  const hasSplit = snap.split && snap.split.length > 0;
  // Ukáže se to, co dostal klient. Druhý pohled jde přepnout.
  const [split, setSplit] = useState(!!snap.showSplit && hasSplit);
  return (
    <div style={{ padding: '12px 4px 4px', overflowX: 'auto' }}>
      {snap.checkMismatch && (
        <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 8 }}>
          ⚠ U této verze nesedí mezisoučty s konečnou cenou. Konečné ceny odpovídají PDF, mezisoučty berte s rezervou.
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap', fontSize: 12, color: colors.muted }}>
        <span>Klient dostal: <b>{snap.showSplit ? 'ceny rozdělené podle měn' : 'ceny v EUR'}</b></span>
        {hasSplit && (
          <button onClick={() => setSplit(!split)} style={{ padding: '4px 10px', background: colors.white, color: colors.primary, border: `1px solid ${colors.primary}`, borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
            {split ? '📊 Zobrazit celkem (EUR)' : '📊 Rozdělit podle měn'}
          </button>
        )}
        {snap.rates && (
          <span>Kurzy v době uložení: {Object.entries(snap.rates).filter(([c]) => c !== 'EUR').map(([c, r]) => `${c} ${Number(r).toFixed(4)}`).join(' · ')}</span>
        )}
      </div>
      {split && hasSplit ? <SplitTables snap={snap} colors={colors} /> : <CombinedTable snap={snap} colors={colors} />}
      <ItemsList items={snap.items} colors={colors} />
    </div>
  );
}

export default function OfferVersions({ offerId, legacyVersions, colors }) {
  const [versions, setVersions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    if (!offerId) return undefined;
    const q = query(collection(db, 'offerVersions'), where('offerId', '==', offerId));
    const unsub = onSnapshot(q, snap => {
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => (b.versionNo || 0) - (a.versionNo || 0));
      setVersions(list);
      setLoaded(true);
      setError('');
    }, err => {
      console.error('Načtení verzí selhalo:', err);
      setError('Verze se nepodařilo načíst: ' + err.message);
      setLoaded(true);
    });
    return unsub;
  }, [offerId]);

  const legacy = (legacyVersions || []).slice().reverse();
  const total = versions.length + legacy.length;
  const link = { fontSize: 12, color: colors.primary, textDecoration: 'underline', whiteSpace: 'nowrap' };

  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 10 }}>
        📁 Verze nabídky {total > 0 && <span style={{ fontWeight: 400, color: colors.muted }}>({total})</span>}
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {loaded && !error && total === 0 && (
        <div style={{ fontSize: 13, color: colors.muted }}>
          Zatím žádná uložená verze. Verze se uloží při „⬇ Gerar PDF" nebo „🖨️ Imprimir" v náhledu nabídky.
        </div>
      )}

      {versions.map((v, i) => {
        const open = openId === v.id;
        return (
          <div key={v.id} style={{ borderBottom: `1px solid ${colors.border}`, background: i === 0 ? '#F4F8EE' : 'transparent', borderRadius: i === 0 ? 6 : 0 }}>
            <div
              onClick={() => setOpenId(open ? null : v.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 8px', cursor: 'pointer', flexWrap: 'wrap' }}
            >
              <span style={{ width: 14, color: colors.muted }}>{open ? '▾' : '▸'}</span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{v.fileName || `v${v.versionNo}`}</span>
              {i === 0 && <span style={{ fontSize: 11, background: '#27500A', color: '#fff', borderRadius: 5, padding: '1px 6px' }}>poslední</span>}
              <span style={{ fontSize: 12, color: colors.muted }}>{fmtWhen(v.createdAt)}</span>
              <span style={{ fontSize: 12, color: colors.muted }}>{who(v.createdBy)}</span>
              {v.source === 'print' && <span style={{ fontSize: 11, color: colors.muted }}>(tisk)</span>}
              <span style={{ fontSize: 12, fontWeight: 600 }}>{priceSummary(v.snapshot)}</span>
              <a href={v.pdfUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ ...link, marginLeft: 'auto' }}>📥 Stáhnout</a>
            </div>
            {open && <VersionPreview v={v} colors={colors} />}
          </div>
        );
      })}

      {legacy.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>Starší verze (jen PDF, bez náhledu výpočtu)</div>
          {legacy.map((v, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px', borderBottom: `1px solid ${colors.border}` }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{v.label}</span>
              <span style={{ fontSize: 12, color: colors.muted }}>{fmtWhen(v.savedAt)}</span>
              <a href={v.url} target="_blank" rel="noopener noreferrer" style={{ ...link, marginLeft: 'auto' }}>📥 Stáhnout</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
