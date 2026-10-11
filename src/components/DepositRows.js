import React, { useState } from 'react';
import {
  isPaid, depositStatus, depositSummary, DEPOSIT_STYLE, DEPOSIT_KINDS, depositKind, rowDue,
  effectiveDeposits, amountOf, readAmount, PAYMENT_METHODS,
} from '../lib/deposits';
import { saveDepositRow, addDepositRow, deleteDepositRow } from '../lib/depositStore';

// Řádky záloh jedné karty — STEJNÉ v nabídce i v Realizaci (schváleno 11. 10. 2026).
// Data: offers/<id>.depositsBy (lib/deposits.js), zápisy po jednom řádku
// (lib/depositStore.js). Změna z jednoho místa se hned ukáže na druhém.

const fmt = (x) => (Number(x) || 0).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtD = (d) => { const s = String(d || '').slice(0, 10); return s.length === 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : ''; };
const fmtAt = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const localToday = () => { const t = new Date(); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

// Políčko, které ukládá až po opuštění (ne při každém písmenku).
function BlurInput({ value, onCommit, style, placeholder, title, numeric, integer }) {
  const [v, setV] = useState(value ?? '');
  const [focus, setFocus] = useState(false);
  React.useEffect(() => { if (!focus) setV(value ?? ''); }, [value, focus]);
  const commit = () => { setFocus(false); if (String(v) !== String(value ?? '')) onCommit(v); };
  return (
    <input type="text" inputMode={integer ? 'numeric' : numeric ? 'decimal' : 'text'} value={v} placeholder={placeholder} title={title}
      onFocus={() => setFocus(true)}
      onChange={e => {
        let x = e.target.value;
        if (numeric) x = x.replace(/,/g, '.');
        if (integer) x = x.replace(/[^0-9]/g, '');
        setV(x);
      }}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
      style={style} />
  );
}

const NativeDate = ({ value, onChange, colors }) => (
  <input type="date" value={String(value || '').slice(0, 10)} onChange={e => onChange(e.target.value)}
    style={{ fontSize: 11, padding: '2px 4px', border: `1px solid ${colors.border}`, borderRadius: 4 }} />
);

export default function DepositRows({
  offerId, offer, item, from, colors, DateInput, arrival, rowsOnly, canEdit = true, big,
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState({}); // rowKey -> ℹ rozbaleno
  const rows = effectiveDeposits(offer, item);
  const sum = depositSummary(item, undefined, arrival, offer);
  const cur = item.currency || 'EUR';
  const today = localToday();
  const Dt = DateInput || NativeDate;

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { console.error(e); setErr('Uložení zálohy se nepovedlo: ' + (e.message || e)); }
    setBusy(false);
  };
  const upd = (r, patch) => run(() => saveDepositRow(offerId, offer, item, r._key, patch, from));
  const add = () => run(() => addDepositRow(offerId, offer, item, from));
  const del = (r) => {
    if (!window.confirm('Smazat tuto zálohu?')) return;
    run(() => deleteDepositRow(offerId, offer, item, r._key));
  };

  if (rowsOnly && rows.length === 0) return null;

  const fs = big ? 12 : 10;
  const small = { fontSize: fs, padding: big ? '3px 6px' : '2px 4px', border: `1px solid ${colors.border}`, borderRadius: 4, fontFamily: 'inherit' };
  const lbl = { fontSize: big ? 11 : 9, color: colors.muted };

  return (
    <div style={{ flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2, opacity: busy ? 0.7 : 1 }}>
      {rows.map((r, i) => {
        const paid = isPaid(r);
        const st = depositStatus(r, today, item, arrival);
        const ds = DEPOSIT_STYLE[st];
        const kind = depositKind(r);
        const before = r.dueMode === 'before';
        const due = rowDue(r, item, arrival);
        const am = amountOf(r, item, offer);
        const calc = am.calc;
        const typed = readAmount(r.amount) > 0;
        const diff = paid && typed && am.computed !== null && Math.abs(am.computed - readAmount(r.amount)) >= 0.01
          ? am.computed - readAmount(r.amount) : null;
        const isOpen = !!open[r._key];
        const dis = !canEdit;
        return (
          <div key={r._key} style={{ borderRadius: 4, background: ds.bg, borderLeft: st === 'empty' ? 'none' : `3px solid ${ds.color}`, padding: '1px 5px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span style={{ ...lbl, width: big ? 0 : 46, display: big ? 'none' : 'inline' }}>{i === 0 ? 'Zálohy:' : ''}</span>
              <select disabled={dis} value={kind} onChange={e => upd(r, { kind: e.target.value })} title="Jak se záloha počítá" style={small}>
                {DEPOSIT_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              {kind === 'percent' && (
                <>
                  <BlurInput numeric value={r.pct || ''} placeholder="30" onCommit={v => upd(r, { pct: v })}
                    style={{ ...small, width: 38, textAlign: 'right' }} />
                  <span style={lbl}>%</span>
                  <select disabled={dis} value={r.basis || 'all'} onChange={e => upd(r, { basis: e.target.value })} title="Z čeho se procento počítá" style={small}>
                    <option value="all">z celé ceny</option>
                    <option value="no_tax">z ubytování bez city tax</option>
                  </select>
                </>
              )}
              {(kind === 'per_room' || kind === 'per_pax') && (
                <>
                  <BlurInput numeric value={r.unit || ''} placeholder="0" onCommit={v => upd(r, { unit: v })}
                    style={{ ...small, width: 52, textAlign: 'right' }} />
                  <span style={lbl}>{cur}/{kind === 'per_room' ? 'pokoj' : 'osobu'}</span>
                </>
              )}
              {kind !== 'fixed' && <span style={{ ...lbl, marginLeft: 2 }}>částka:</span>}
              <BlurInput numeric value={r.amount || ''}
                placeholder={kind === 'fixed' ? '0' : (am.computed !== null ? fmt(am.computed) : 'určí se')}
                title={kind === 'fixed' ? 'Částka zálohy' : 'Prázdné = vypočte se z konečných počtů. Napsaná částka má přednost.'}
                onCommit={v => upd(r, { amount: v, amountFrom: String(v).trim() ? 'manual' : '' })}
                style={{ ...small, width: big ? 84 : 70, textAlign: 'right', fontWeight: typed ? 700 : 400,
                         background: !typed && am.computed !== null ? '#f0fdf4' : '#fff' }} />
              <span style={lbl}>{cur}</span>
              {typed && r.amountFrom !== 'calc' && kind !== 'fixed' && <span title="Částka přepsaná ručně (má přednost před výpočtem)" style={{ ...lbl, color: '#9a3412', fontWeight: 700 }}>✎</span>}
              {!typed && am.computed !== null && <span title="Vypočteno z konečných počtů" style={{ ...lbl, color: '#166534', fontWeight: 700 }}>= výpočet</span>}
              <span style={{ ...lbl, marginLeft: 2 }}>splatnost:</span>
              <select disabled={dis} value={before ? 'before' : 'date'} title="Splatnost datem, nebo počtem dní před příjezdem do hotelu"
                onChange={e => upd(r, e.target.value === 'before' ? { dueMode: 'before' } : { dueMode: 'date', due: r.due || due })} style={small}>
                <option value="date">datum</option>
                <option value="before">dní před příjezdem</option>
              </select>
              {before ? (
                <>
                  <BlurInput integer value={r.dueDays || ''} placeholder="30" onCommit={v => upd(r, { dueDays: v })}
                    style={{ ...small, width: 36, textAlign: 'right' }} />
                  <span style={{ ...lbl, color: due ? colors.text : '#c2410c' }}>
                    {due ? `= ${fmtD(due)}` : (item.dateFrom || arrival ? 'zadejte počet dní' : 'chybí datum příjezdu')}
                  </span>
                </>
              ) : (
                <Dt dateKey={`due-${item.id}-${r._key}`} value={r.due || ''} colors={colors} onChange={v => upd(r, { due: v })} />
              )}
              {paid ? (
                <>
                  <button type="button" disabled={dis} title="Kliknutím vrátit na „k zaplacení“"
                    onClick={() => upd(r, r.amountFrom === 'calc' ? { paid: false, amount: '', amountFrom: '' } : { paid: false })}
                    style={{ ...small, cursor: 'pointer', background: '#e8f5e9', color: '#27500A', fontWeight: 700, borderColor: '#27500A' }}>✅ zaplaceno</button>
                  <Dt dateKey={`dep-${item.id}-${r._key}`} value={r.date || ''} colors={colors} onChange={v => upd(r, { date: v })} />
                  <select disabled={dis} value={r.method || ''} onChange={e => upd(r, { method: e.target.value })} title="Čím bylo zaplaceno" style={small}>
                    {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </>
              ) : (
                <>
                  <span style={{ fontSize: fs, fontWeight: 700, color: ds.color }}>{ds.icon} {st === 'empty' ? 'k zaplacení' : ds.label}</span>
                  <button type="button" disabled={dis} title="Označit jako zaplacené (dnešní datum, jde změnit). Vypočtená částka se tím zafixuje."
                    onClick={() => upd(r, {
                      paid: true, date: r.date || today,
                      ...(!typed && am.computed !== null ? { amount: String(am.computed), amountFrom: 'calc' } : {}),
                    })}
                    style={{ ...small, cursor: 'pointer', background: '#fff', color: '#27500A', borderColor: '#27500A' }}>✓ zaplaceno</button>
                </>
              )}
              <button type="button" onClick={() => setOpen(o => ({ ...o, [r._key]: !o[r._key] }))}
                title="Výpočet, podmínky hotelu a historie změn"
                style={{ ...small, cursor: 'pointer', background: isOpen ? '#e0f2fe' : '#fff', color: '#0369a1', borderColor: '#7dd3fc', fontWeight: 700 }}>ℹ</button>
              <button type="button" disabled={dis} onClick={() => del(r)} title="Smazat tuto zálohu"
                style={{ ...small, cursor: 'pointer', color: '#b91c1c', background: '#fff', lineHeight: 1 }}>✕</button>
              {diff !== null && (
                <span style={{ fontSize: fs, fontWeight: 700, color: '#9a3412' }}
                  title="Zaplacená částka se liší od výpočtu podle dnešních konečných počtů">
                  podle dnešních počtů {fmt(am.computed)} · rozdíl {diff > 0 ? '+' : ''}{fmt(diff)} {cur}
                </span>
              )}
            </div>
            {isOpen && (
              <div style={{ fontSize: big ? 12 : 11, background: '#fff', border: '1px solid #bae6fd', borderRadius: 6, padding: '6px 10px', margin: '4px 0 4px', lineHeight: 1.5 }}>
                {kind === 'fixed' ? (
                  <div style={{ color: colors.muted }}>Pevná částka — nic se nepočítá.</div>
                ) : calc ? (
                  <>
                    {(calc.lines || []).map((l, k) => (
                      <div key={k} style={{ display: 'flex', gap: 12, color: l.amount < 0 ? '#9a3412' : colors.text }}>
                        <span style={{ flex: 1 }}>{l.label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(l.amount)}</span>
                      </div>
                    ))}
                    {calc.formula && (
                      <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: 3, paddingTop: 3, fontWeight: 700 }}>
                        {calc.formula} = {calc.amount !== null && calc.amount !== undefined ? `${fmt(calc.amount)} ${cur}` : '?'}
                      </div>
                    )}
                    {(calc.warnings || []).map((w, k) => <div key={k} style={{ color: '#b45309' }}>⚠ {w}</div>)}
                  </>
                ) : null}
                {kind !== 'fixed' && <div style={{ color: colors.muted, marginTop: 3 }}>Počty a nastavení výpočtu (strava, FOC) jsou v Realizaci v bloku „🛏 Konečné počty“.</div>}
                <div style={{ marginTop: 4 }}>
                  <b>Podmínky z karty:</b> {String(item.depositTerms || '').trim() || <span style={{ color: colors.muted }}>nevyplněno</span>}
                </div>
                {r.lastAt && <div style={{ color: colors.muted, marginTop: 3 }}>Naposledy {fmtAt(r.lastAt)}{r.lastBy ? ` – ${r.lastBy}` : ''}{r.lastFrom ? ` (${r.lastFrom})` : ''}</div>}
                {Array.isArray(r.log) && r.log.length > 0 && (
                  <div style={{ marginTop: 3 }}>
                    {r.log.map((h, k) => (
                      <div key={k} style={{ color: colors.muted }}>{fmtAt(h.at)} · {h.by}{h.from ? ` (${h.from})` : ''} · {h.text}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...lbl, width: big ? 0 : 46, display: big ? 'none' : 'inline' }}>{rows.length === 0 ? 'Zálohy:' : ''}</span>
        {canEdit && (
          <button type="button" onClick={add} disabled={busy}
            style={{ ...small, cursor: 'pointer', background: '#fff', color: colors.primary }}>+ záloha</button>
        )}
        {sum.total > 0 && (
          <span style={{ fontSize: fs, color: colors.text, fontWeight: 600 }}>
            celkem {fmt(sum.total)} · zaplaceno {fmt(sum.paid)} · <span style={{ color: sum.open > 0 ? '#9a3412' : '#27500A' }}>zbývá {fmt(sum.open)}</span> {cur}
          </span>
        )}
        {sum.unknown > 0 && <span style={{ fontSize: fs, color: '#9a3412' }}>+ {sum.unknown}× podle podmínky, částka se určí</span>}
        {err && <span style={{ fontSize: fs, color: '#b91c1c', fontWeight: 700 }}>❌ {err}</span>}
      </div>
    </div>
  );
}
