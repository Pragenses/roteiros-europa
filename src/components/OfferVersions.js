// 📁 Verze nabídky — seznam uložených verzí na kartě nabídky.
//
// Jen pro čtení. Všechno se kreslí z „zmrazeného" výpočtu uloženého s verzí
// (viz src/lib/offerVersions.js) — nic se tu nepřepočítává, takže verze ukazuje
// přesně ta čísla, která dostal klient, i když se nabídka mezitím změnila.
//
// Starší verze uložené dřívějším zeleným tlačítkem („Salvar versão (NR)")
// leží v nabídce v poli `pdfVersions` a mají jen PDF, bez výpočtu — ukazují
// se proto jen ke stažení.
//
// Název verze jde tužkou ✏️ přejmenovat (třeba když klient dostal NR1–NR4 mimo
// systém). Mění se jen název a číslo verze, nikdy ceny ani obsah.
//
// ⚖️ Porovnat: zaškrtnou se dvě verze (nebo verze a „Aktuální stav") a ukáže
// se, jak se změnily ceny, nastavení, kurzy a služby. Logika je v
// src/lib/offerCompare.js.
//
// 🗑 Mazání (jen Helena a Filip = role 'owner'): verze se přesune do koše po
// dvojím potvrzení (ve druhém kroku se opisuje číslo verze). Z koše jde
// obnovit — nic se nemaže natrvalo.

import React, { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { renameOfferVersion, versionNoFromName, cleanTypedFileName, setDownloadName, trashOfferVersion, restoreOfferVersion } from '../lib/offerVersions';
import { compareSnapshots } from '../lib/offerCompare';

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

// --- Porovnání -------------------------------------------------------------
const diffColor = (d) => (d > 0 ? '#dc2626' : d < 0 ? '#15803d' : '#777');
const fmtDiff = (d) => (d === null ? '—' : d === 0 ? '0.00' : (d > 0 ? '+' : '') + n2(d));

function CompareRowsTable({ rows, cur, colors }) {
  const c = { padding: '5px 8px', textAlign: 'right', borderBottom: `1px solid ${colors.border}` };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: `2px solid ${colors.border}` }}>
          <th style={{ textAlign: 'left', padding: '5px 8px' }}>Pax</th>
          <th style={{ ...c, borderBottom: 'none' }}>DBL starší</th>
          <th style={{ ...c, borderBottom: 'none' }}>DBL novější</th>
          <th style={{ ...c, borderBottom: 'none' }}>Rozdíl</th>
          <th style={{ ...c, borderBottom: 'none' }}>SNGL starší</th>
          <th style={{ ...c, borderBottom: 'none' }}>SNGL novější</th>
          <th style={{ ...c, borderBottom: 'none' }}>Rozdíl</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.pax}>
            <td style={{ ...c, textAlign: 'left', fontWeight: 600 }}>{r.pax}</td>
            <td style={c}>{r.dblA === null ? '—' : n2(r.dblA)}</td>
            <td style={{ ...c, fontWeight: 700 }}>{r.dblB === null ? '—' : n2(r.dblB)}</td>
            <td style={{ ...c, fontWeight: 700, color: diffColor(r.dblDiff) }}>{fmtDiff(r.dblDiff)}</td>
            <td style={c}>{r.snglA === null ? '—' : n2(r.snglA)}</td>
            <td style={{ ...c, fontWeight: 700 }}>{r.snglB === null ? '—' : n2(r.snglB)}</td>
            <td style={{ ...c, fontWeight: 700, color: diffColor(r.snglDiff) }}>{fmtDiff(r.snglDiff)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const itemTitle = (it) => [SUBTYPE_LABEL[it.subType] || (it.type === 'group' ? 'Skupinová služba' : 'Služba na osobu'), it.city, it.name].filter(Boolean).join(' · ');

function ComparePanel({ left, right, onClose, colors }) {
  const res = compareSnapshots(left.snapshot, right.snapshot);
  const box = { marginTop: 14 };
  const h = { fontSize: 13, fontWeight: 700, color: colors.primary, marginBottom: 6 };
  const nothing = !res.anyPriceChange && !res.settings.length && !res.rates.length && !res.added.length && !res.removed.length && !res.changed.length;
  return (
    <div style={{ border: `2px solid ${colors.primary}`, borderRadius: 10, padding: '12px 14px', margin: '4px 0 14px', background: '#FBFBF9', overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>⚖️ {left.label}</span>
        <span style={{ color: colors.muted }}>→</span>
        <span style={{ fontSize: 14, fontWeight: 700 }}>{right.label}</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', padding: '3px 10px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>✕ Zavřít</button>
      </div>
      <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>Vlevo starší, vpravo novější. Červeně zdražení, zeleně zlevnění.</div>

      {nothing && <div style={{ ...box, fontSize: 13 }}>Mezi těmito dvěma verzemi není žádný rozdíl.</div>}

      {res.onlyRateEffect && (
        <div style={{ ...box, fontSize: 13, padding: '8px 10px', background: '#FFF7E6', borderRadius: 7, color: '#854f0b' }}>
          Ceny v EUR se liší <b>jen kvůli změně kurzu</b> — služby, jejich ceny ani nastavení se nezměnily.
        </div>
      )}

      {(res.settings.length > 0 || res.rates.length > 0) && (
        <div style={box}>
          <div style={h}>Nastavení a kurzy</div>
          {res.settings.map(sd => (
            <div key={sd.label} style={{ fontSize: 12, marginBottom: 2 }}>{sd.label}: <s style={{ color: colors.muted }}>{sd.a || '—'}</s> → <b>{sd.b || '—'}</b></div>
          ))}
          {res.rates.map(r => (
            <div key={r.cur} style={{ fontSize: 12, marginBottom: 2 }}>Kurz {r.cur} → EUR: <s style={{ color: colors.muted }}>{r.a.toFixed(4)}</s> → <b>{r.b.toFixed(4)}</b> <span style={{ color: colors.muted }}>(vliv kurzu, ne změna ceny u dodavatele)</span></div>
          ))}
        </div>
      )}

      {!nothing && (
        <div style={box}>
          <div style={h}>Cena na osobu — celkem v EUR</div>
          <CompareRowsTable rows={res.combined} colors={colors} />
        </div>
      )}

      {res.split && !nothing && (
        <div style={box}>
          <div style={h}>Cena podle měn <span style={{ fontWeight: 400, color: colors.muted, fontSize: 12 }}>(v původní měně — změna kurzu se tu neprojeví)</span></div>
          {res.split.map(p => (
            <div key={p.cur} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{CUR_FLAG[p.cur] || ''} {p.cur}</div>
              <CompareRowsTable rows={p.rows} colors={colors} />
            </div>
          ))}
        </div>
      )}

      {(res.added.length > 0 || res.removed.length > 0 || res.changed.length > 0) && (
        <div style={box}>
          <div style={h}>Služby</div>
          {res.added.map((it, i) => (
            <div key={'a' + i} style={{ fontSize: 12, padding: '4px 8px', marginBottom: 3, background: '#EAF6E4', borderRadius: 5 }}>
              🟢 <b>přibylo:</b> {itemTitle(it)} {it.dateFrom ? `(${fmtDate(it.dateFrom)}${it.dateTo ? ' – ' + fmtDate(it.dateTo) : ''})` : ''} — {itemPrice(it)}
            </div>
          ))}
          {res.removed.map((it, i) => (
            <div key={'r' + i} style={{ fontSize: 12, padding: '4px 8px', marginBottom: 3, background: '#FDECEC', borderRadius: 5 }}>
              🔴 <b>ubylo:</b> {itemTitle(it)} {it.dateFrom ? `(${fmtDate(it.dateFrom)}${it.dateTo ? ' – ' + fmtDate(it.dateTo) : ''})` : ''} — {itemPrice(it)}
            </div>
          ))}
          {res.changed.map((ch, i) => (
            <div key={'c' + i} style={{ fontSize: 12, padding: '4px 8px', marginBottom: 3, background: '#FFF4E0', borderRadius: 5 }}>
              🟠 <b>změna:</b> {itemTitle(ch.item)}
              <div style={{ paddingLeft: 22 }}>
                {ch.diffs.map(d => (
                  <div key={d.field}>{d.label}: <s style={{ color: colors.muted }}>{(d.field === 'dateFrom' || d.field === 'dateTo') ? fmtDate(d.a) || d.a || '—' : (d.a || '—')}</s> → <b>{(d.field === 'dateFrom' || d.field === 'dateTo') ? fmtDate(d.b) || d.b || '—' : (d.b || '—')}</b></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Dvoukrokové potvrzení přesunu do koše.
function DeleteDialog({ name, when, price, onConfirm, onCancel, colors }) {
  const [step, setStep] = useState(1);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const no = versionNoFromName(name);
  const token = no ? `NR${no}` : 'SMAZAT';
  const ok = typed.replace(/\s+/g, '').toUpperCase() === token;
  const go = async () => {
    if (!ok) return;
    setBusy(true); setErr('');
    try { await onConfirm(); }
    catch (e) { console.error(e); setErr('Přesun do koše se nepovedl: ' + e.message); setBusy(false); }
  };
  const btn = { padding: '10px', border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' };
  return (
    <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '1.5rem', width: 420, maxWidth: '92vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>🗑 Přesunout verzi do koše?</div>
        <div style={{ fontSize: 14, fontWeight: 700, padding: '8px 10px', background: '#f7f6f3', borderRadius: 7, marginBottom: 6, wordBreak: 'break-word' }}>{name}</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 12 }}>{[when, price].filter(Boolean).join(' · ')}</div>
        {step === 1 ? (
          <>
            <div style={{ fontSize: 13, marginBottom: 14 }}>Verze zmizí ze seznamu. PDF i uložené ceny zůstanou v koši a verzi půjde obnovit.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => setStep(2)} style={{ ...btn, background: '#dc2626', color: '#fff', fontWeight: 600 }}>Ano, pokračovat</button>
              <button onClick={onCancel} style={{ ...btn, background: '#fff', border: `1px solid ${colors.border}` }}>Ne, nechat být</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, marginBottom: 6 }}>Pro potvrzení napište <b>{token}</b>:</div>
            <input type="text" value={typed} autoFocus disabled={busy}
              onChange={e => { setTyped(e.target.value); setErr(''); }}
              onKeyDown={e => { if (e.key === 'Enter') go(); if (e.key === 'Escape') onCancel(); }}
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 14, border: `1px solid ${colors.border}`, borderRadius: 7, marginBottom: 10, fontFamily: 'inherit' }} />
            {err && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{err}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={go} disabled={!ok || busy} style={{ ...btn, background: '#dc2626', color: '#fff', fontWeight: 600, opacity: (!ok || busy) ? 0.5 : 1, cursor: ok ? 'pointer' : 'default' }}>
                {busy ? 'Přesouvám…' : 'Přesunout do koše'}
              </button>
              <button onClick={onCancel} disabled={busy} style={{ ...btn, background: '#fff', border: `1px solid ${colors.border}` }}>Zrušit</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Políčko pro přejmenování jedné verze.
function RenameBox({ initial, usedOthers, onSave, onCancel, colors }) {
  const [val, setVal] = useState(initial || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dupOk, setDupOk] = useState(false);
  const no = versionNoFromName(val);
  const dup = no && usedOthers.includes(no);

  const save = async () => {
    const name = cleanTypedFileName(val);
    if (!name) { setErr('Název nesmí být prázdný.'); return; }
    if (dup && !dupOk) { setDupOk(true); setErr(`NR${no} už u této nabídky existuje. Změňte číslo, nebo klikněte znovu a uloží se i tak.`); return; }
    setBusy(true); setErr('');
    try { await onSave(name); }
    catch (e) { console.error(e); setErr('Přejmenování se nepovedlo: ' + e.message); setBusy(false); }
  };

  return (
    <div onClick={e => e.stopPropagation()} style={{ padding: '6px 8px 10px 34px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="text" value={val} autoFocus disabled={busy}
          onChange={e => { setVal(e.target.value); setErr(''); setDupOk(false); }}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
          style={{ flex: '1 1 320px', padding: '6px 8px', fontSize: 13, fontWeight: 600, border: `1px solid ${colors.border}`, borderRadius: 6, fontFamily: 'inherit' }}
        />
        <button onClick={save} disabled={busy} style={{ padding: '6px 12px', background: '#27500A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Ukládám…' : 'Uložit název'}
        </button>
        <button onClick={onCancel} disabled={busy} style={{ padding: '6px 10px', background: 'transparent', color: colors.muted, border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
          Zrušit
        </button>
      </div>
      {err
        ? <div style={{ fontSize: 12, color: dupOk ? '#854f0b' : '#dc2626', marginTop: 4 }}>{err}</div>
        : dup ? <div style={{ fontSize: 12, color: '#854f0b', marginTop: 4 }}>⚠ NR{no} už u této nabídky existuje.</div>
        : <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>Mění se jen název a číslo verze. Ceny a obsah verze zůstávají beze změny.</div>}
    </div>
  );
}

export default function OfferVersions({ offerId, legacyVersions, onRenameLegacy, onTrashLegacy, canDelete, getCurrentSnapshot, colors }) {
  const [versions, setVersions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [editKey, setEditKey] = useState(null); // 'v:<id>' nebo 'l:<index>'
  // Porovnání: vybrané položky (id verze nebo 'current') a otevřený výsledek.
  const [picked, setPicked] = useState([]);
  const [compare, setCompare] = useState(null); // { left, right }
  const [toDelete, setToDelete] = useState(null); // { kind: 'v'|'l', v }
  const [showTrash, setShowTrash] = useState(false);

  useEffect(() => {
    if (!offerId) return undefined;
    const q = query(collection(db, 'offerVersions'), where('offerId', '==', offerId));
    const unsub = onSnapshot(q, snap => {
      const list = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      list.sort((a, b) => ((b.versionNo || 0) - (a.versionNo || 0)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
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

  // Verze v koši se v seznamu neukazují (jen v sekci Koš).
  const allVersions = versions;
  const trashed = allVersions.filter(v => v.deletedAt);
  const active = allVersions.filter(v => !v.deletedAt);
  // Starší verze s původním pořadím (index) — kvůli přejmenování a koši.
  const legacyAll = (legacyVersions || []).map((v, idx) => ({ ...v, idx })).reverse();
  const legacy = legacyAll.filter(v => !v.deletedAt);
  const legacyTrashed = legacyAll.filter(v => v.deletedAt);
  // Čísla verzí použitá u nabídky, bez právě upravované verze.
  const usedExcept = (key) => [
    ...versions.filter(v => 'v:' + v.id !== key).map(v => parseInt(v.versionNo, 10)).filter(n => n > 0),
    ...legacyAll.filter(v => 'l:' + v.idx !== key).map(v => versionNoFromName(v.label)).filter(Boolean),
  ];
  const pencil = { padding: '2px 6px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12, cursor: 'pointer', lineHeight: 1.2 };

  const togglePick = (key) => setPicked(p => (p.includes(key) ? p.filter(k => k !== key) : (p.length >= 2 ? p : [...p, key])));
  const runCompare = () => {
    // Starší vlevo, novější vpravo. Aktuální stav je vždy nejnovější.
    const entries = picked.map(key => {
      if (key === 'current') return { label: 'Aktuální stav nabídky', snapshot: getCurrentSnapshot(), at: '9999' };
      const v = versions.find(x => x.id === key);
      return v ? { label: `${v.fileName || 'v' + v.versionNo} (${fmtWhen(v.createdAt)})`, snapshot: v.snapshot, at: String(v.createdAt || '') } : null;
    }).filter(Boolean);
    if (entries.length !== 2) return;
    entries.sort((x, y) => x.at.localeCompare(y.at));
    setCompare({ left: entries[0], right: entries[1] });
  };
  const checkbox = (key) => (
    <input
      type="checkbox"
      title="Vybrat k porovnání"
      checked={picked.includes(key)}
      disabled={!picked.includes(key) && picked.length >= 2}
      onClick={e => e.stopPropagation()}
      onChange={() => togglePick(key)}
      style={{ cursor: 'pointer', width: 15, height: 15, margin: 0 }}
    />
  );
  const total = active.length + legacy.length;
  const link = { fontSize: 12, color: colors.primary, textDecoration: 'underline', whiteSpace: 'nowrap' };

  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.25rem', marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary }}>
          📁 Verze nabídky {total > 0 && <span style={{ fontWeight: 400, color: colors.muted }}>({total})</span>}
        </div>
        {active.length > 0 && getCurrentSnapshot && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: colors.muted }}>
              {picked.length === 2 ? 'Vybráno 2' : `Zaškrtněte 2 k porovnání (${picked.length}/2)`}
            </span>
            <button
              onClick={runCompare}
              disabled={picked.length !== 2}
              style={{ padding: '5px 12px', background: picked.length === 2 ? colors.primary : colors.white, color: picked.length === 2 ? colors.white : colors.muted, border: `1px solid ${picked.length === 2 ? colors.primary : colors.border}`, borderRadius: 7, fontSize: 12, cursor: picked.length === 2 ? 'pointer' : 'default', fontFamily: 'inherit', fontWeight: 600 }}>
              ⚖️ Porovnat
            </button>
          </div>
        )}
      </div>

      {active.length > 0 && getCurrentSnapshot && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px', borderBottom: `1px dashed ${colors.border}` }}>
          {checkbox('current')}
          <span style={{ fontSize: 13, fontWeight: 600 }}>Aktuální stav nabídky</span>
          <span style={{ fontSize: 12, color: colors.muted }}>(to, co je teď v tabulce výše, s dnešními kurzy)</span>
        </div>
      )}

      {compare && <ComparePanel left={compare.left} right={compare.right} onClose={() => setCompare(null)} colors={colors} />}

      {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>}
      {loaded && !error && total === 0 && (
        <div style={{ fontSize: 13, color: colors.muted }}>
          Zatím žádná uložená verze. Verze se uloží při „⬇ Gerar PDF" nebo „🖨️ Imprimir" v náhledu nabídky.
        </div>
      )}

      {active.map((v, i) => {
        const open = openId === v.id;
        return (
          <div key={v.id} style={{ borderBottom: `1px solid ${colors.border}`, background: i === 0 ? '#F4F8EE' : 'transparent', borderRadius: i === 0 ? 6 : 0 }}>
            <div
              onClick={() => setOpenId(open ? null : v.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 8px', cursor: 'pointer', flexWrap: 'wrap' }}
            >
              {getCurrentSnapshot && checkbox(v.id)}
              <span style={{ width: 14, color: colors.muted }}>{open ? '▾' : '▸'}</span>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{v.fileName || `v${v.versionNo}`}</span>
              {i === 0 && <span style={{ fontSize: 11, background: '#27500A', color: '#fff', borderRadius: 5, padding: '1px 6px' }}>poslední</span>}
              <span style={{ fontSize: 12, color: colors.muted }}>{fmtWhen(v.createdAt)}</span>
              <span style={{ fontSize: 12, color: colors.muted }}>{who(v.createdBy)}</span>
              {v.source === 'print' && <span style={{ fontSize: 11, color: colors.muted }}>(tisk)</span>}
              <span style={{ fontSize: 12, fontWeight: 600 }}>{priceSummary(v.snapshot)}</span>
              <button title="Přejmenovat" onClick={e => { e.stopPropagation(); setEditKey('v:' + v.id); }} style={{ ...pencil, marginLeft: 'auto' }}>✏️</button>
              <a href={v.pdfUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={link}>📥 Stáhnout</a>
              {canDelete && <button title="Přesunout do koše" onClick={e => { e.stopPropagation(); setToDelete({ kind: 'v', v }); }} style={pencil}>🗑</button>}
            </div>
            {editKey === 'v:' + v.id && (
              <RenameBox
                initial={v.fileName}
                usedOthers={usedExcept('v:' + v.id)}
                colors={colors}
                onCancel={() => setEditKey(null)}
                onSave={async (name) => { await renameOfferVersion(v, name); setEditKey(null); }}
              />
            )}
            {open && <VersionPreview v={v} colors={colors} />}
          </div>
        );
      })}

      {legacy.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>Starší verze (jen PDF, bez náhledu výpočtu)</div>
          {legacy.map(v => (
            <div key={v.idx} style={{ borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px' }}>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{v.label}</span>
                <span style={{ fontSize: 12, color: colors.muted }}>{fmtWhen(v.savedAt)}</span>
                {onRenameLegacy && <button title="Přejmenovat" onClick={() => setEditKey('l:' + v.idx)} style={{ ...pencil, marginLeft: 'auto' }}>✏️</button>}
                <a href={v.url} target="_blank" rel="noopener noreferrer" style={{ ...link, marginLeft: onRenameLegacy ? 0 : 'auto' }}>📥 Stáhnout</a>
                {canDelete && onTrashLegacy && <button title="Přesunout do koše" onClick={() => setToDelete({ kind: 'l', v })} style={pencil}>🗑</button>}
              </div>
              {editKey === 'l:' + v.idx && (
                <RenameBox
                  initial={v.label}
                  usedOthers={usedExcept('l:' + v.idx)}
                  colors={colors}
                  onCancel={() => setEditKey(null)}
                  onSave={async (name) => {
                    const ok = await onRenameLegacy(v.idx, name);
                    if (ok === false) throw new Error('nabídku právě upravuje někdo jiný, nebo se nepodařilo uložit.');
                    await setDownloadName(v.path, name);
                    setEditKey(null);
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {canDelete && (trashed.length + legacyTrashed.length) > 0 && (
        <div style={{ marginTop: 14 }}>
          <button onClick={() => setShowTrash(!showTrash)} style={{ padding: '4px 10px', background: 'transparent', border: `1px solid ${colors.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', color: colors.muted, fontFamily: 'inherit' }}>
            {showTrash ? '▾' : '▸'} 🗑 Koš ({trashed.length + legacyTrashed.length})
          </button>
          {showTrash && (
            <div style={{ marginTop: 6, padding: '4px 8px', background: '#F7F6F3', borderRadius: 8 }}>
              {[...trashed.map(v => ({ kind: 'v', v, name: v.fileName || `v${v.versionNo}`, url: v.pdfUrl, at: v.deletedAt, by: v.deletedBy })),
                ...legacyTrashed.map(v => ({ kind: 'l', v, name: v.label, url: v.url, at: v.deletedAt, by: v.deletedBy }))]
                .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')))
                .map(t => (
                  <div key={t.kind + (t.kind === 'v' ? t.v.id : t.v.idx)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: `1px solid ${colors.border}`, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: colors.muted, textDecoration: 'line-through' }}>{t.name}</span>
                    <span style={{ fontSize: 12, color: colors.muted }}>smazáno {fmtWhen(t.at)}{t.by ? ' · ' + who(t.by) : ''}</span>
                    <a href={t.url} target="_blank" rel="noopener noreferrer" style={{ ...link, marginLeft: 'auto' }}>📥 Stáhnout</a>
                    <button onClick={async () => {
                      try {
                        if (t.kind === 'v') await restoreOfferVersion(t.v);
                        else { const ok = await onTrashLegacy(t.v.idx, false); if (ok === false) throw new Error('nabídku právě upravuje někdo jiný.'); }
                      } catch (e) { console.error(e); alert('Obnovení se nepovedlo: ' + e.message); }
                    }} style={{ padding: '3px 10px', background: '#27500A', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                      ↩ Obnovit
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {toDelete && (
        <DeleteDialog
          name={toDelete.kind === 'v' ? (toDelete.v.fileName || `v${toDelete.v.versionNo}`) : toDelete.v.label}
          when={fmtWhen(toDelete.kind === 'v' ? toDelete.v.createdAt : toDelete.v.savedAt)}
          price={toDelete.kind === 'v' ? priceSummary(toDelete.v.snapshot) : ''}
          colors={colors}
          onCancel={() => setToDelete(null)}
          onConfirm={async () => {
            if (toDelete.kind === 'v') {
              await trashOfferVersion(toDelete.v);
              setPicked(p => p.filter(k => k !== toDelete.v.id));
              if (openId === toDelete.v.id) setOpenId(null);
            } else {
              const ok = await onTrashLegacy(toDelete.v.idx, true);
              if (ok === false) throw new Error('nabídku právě upravuje někdo jiný.');
            }
            setToDelete(null);
          }}
        />
      )}
    </div>
  );
}
