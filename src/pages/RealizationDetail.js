import React, { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { doc, onSnapshot, updateDoc, FieldPath } from 'firebase/firestore';
import { auth } from '../lib/firebase';
import { codeForEmail } from '../lib/people';
import { KINDS, TRANSPORT, kindById, suggestKind, kindOf as serviceKindOf, deadlineState, LEVEL_STYLE } from '../lib/serviceKinds';
import { isInRealization, realizationItems, itemStatus, serviceCounts, fmtMoney, fmtDate } from '../lib/realization';
import { DEFAULT_RATES } from '../lib/offerCalc';
import { computeOfferRows } from '../lib/offerRows';
import { loadRatesDoc, effectiveRates } from '../lib/rates';
import { allDeposits, DEPOSIT_STYLE, effectiveDeposits } from '../lib/deposits';
import { FINAL_FIELDS, finalFor, hotelTotal, mealCandidates } from '../lib/depositCalc';
import { saveFinalGroup, saveFinalHotel, addDepositRow } from '../lib/depositStore';
import DepositRows from '../components/DepositRows';
import { BOOKING_STATUS, statusStyle, displayStatus, setItemStatus, fmtStatusAt } from '../lib/bookingStatus';

// Přehled jedné akce v Realizaci. Všechno se čte ŽIVĚ z nabídky
// (offers/<id>) — žádná kopie. Upravuje se v nabídce („Otevřít nabídku“);
// tady je přehled. Pokoje, platby, rooming list a vouchery přijdou
// v dalších krocích.

// Stavy služeb: lib/bookingStatus.js (stejné jako v nabídce).

export default function RealizationDetail({ offerId, navigate, colors }) {
  const [offer, setOffer] = useState(undefined);
  // Kurzy z Nastavení → „💱 Kurzy měn“ — stejné jako v nabídce.
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [ratesDate, setRatesDate] = useState('');
  useEffect(() => {
    (async () => {
      try { setRates(effectiveRates(await loadRatesDoc())); setRatesDate('ok'); }
      catch (e) { console.error('Kurzy z Nastavení se nepodařilo načíst', e); }
    })();
  }, []);

  useEffect(() => {
    if (!offerId) return undefined;
    const unsub = onSnapshot(doc(db, 'offers', offerId),
      snap => setOffer(snap.exists() ? { id: snap.id, ...snap.data() } : null),
      err => { console.error(err); setOffer(null); });
    return unsub;
  }, [offerId]);

  const back = (
    <button onClick={() => navigate('realization')} style={{ padding: '6px 14px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
      ← Zpět na Realizaci
    </button>
  );

  if (offer === undefined) return <div style={{ color: colors.muted, fontSize: 14 }}>Načítám…</div>;
  if (offer === null) return <div>{back}<div style={{ marginTop: 16, color: colors.muted }}>Akce nenalezena.</div></div>;

  const rz = offer.realization || {};
  const sold = rz.sold || {};
  const items = realizationItems(offer);
  const cnt = serviceCounts(offer);
  // ── Druh služby a harmonogram (krok A) ──
  const rzServices = offer.rzServices || {};
  const hotelItems = items.filter(it => it.subType === 'hotel' && !it.cancelled);
  const hotelsAllConfirmed = hotelItems.length > 0 && hotelItems.every(it => itemStatus(it) === 'confirmed');
  const rowsK = items.map(it => {
    const kind = serviceKindOf(it, rzServices);
    const saved = rzServices[String(it.id)] || null;
    return { it, kind, saved, suggestion: kind ? '' : suggestKind(it),
      dl: deadlineState({ it, kind, saved, offer, statusOf: itemStatus, hotelsAllConfirmed }) };
  });
  const byKind = {};
  rowsK.forEach(r => { const k = r.kind || '_none'; (byKind[k] = byKind[k] || []).push(r); });
  const kindOrder = ['_none', ...KINDS.map(k => k.id)];
  const nLate = rowsK.filter(r => r.dl.level === 'late').length;
  const nWarn = rowsK.filter(r => r.dl.level === 'warn').length;
  const nNoKind = rowsK.filter(r => !r.kind).length;
  const nSuggest = rowsK.filter(r => !r.kind && r.suggestion).length;
  const card = { background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1rem 1.25rem', marginBottom: '1rem' };
  const th = { padding: '6px 10px', textAlign: 'right', fontSize: 11, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em' };
  const td = { padding: '6px 10px', textAlign: 'right', borderTop: `1px solid ${colors.border}` };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {back}
        <button onClick={() => navigate('offer-detail', { offerId })} style={{ padding: '6px 14px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          Otevřít nabídku
        </button>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {offer.offerNumber && <span style={{ fontWeight: 700, letterSpacing: '0.05em', background: '#EEF2F7', borderRadius: 5, padding: '3px 8px', fontSize: 13 }}>{offer.offerNumber}</span>}
          <h1 style={{ fontSize: 20, fontWeight: 700, color: colors.primary, margin: 0 }}>{offer.name || '(bez názvu)'}</h1>
        </div>
        <div style={{ fontSize: 13, color: colors.muted, marginTop: 6 }}>
          {offer.clientName || '—'} · {fmtDate(offer.startDate)} – {fmtDate(offer.endDate)}{offer.destinations ? ` · ${offer.destinations}` : ''}
        </div>
        {!isInRealization(offer) && (
          <div style={{ marginTop: 10, fontSize: 13, color: '#9a3412', fontWeight: 600 }}>⚠ Tato nabídka není v Realizaci.</div>
        )}
      </div>

      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary, marginBottom: 4 }}>🔒 Prodejní cena pro klienta (zamčená)</div>
        <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
          Z verze <b>{rz.soldVersionName || '—'}</b>{rz.soldVersionCreatedAt ? ` (uložena ${fmtDate(rz.soldVersionCreatedAt)})` : ''} ·
          potvrzeno {fmtDate(rz.confirmedAt)}{rz.confirmedBy ? ` – ${rz.confirmedBy}` : ''}
          {(() => { const n = (rz.history || []).filter(h => h.action === 'change').length; return n > 0 ? ` · prodaná verze změněna ${n}×, naposledy ${fmtDate(rz.changedAt)}${rz.changedBy ? ' – ' + rz.changedBy : ''}` : ''; })()}
        </div>
        <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr><th style={{ ...th, textAlign: 'left' }}>Skupina</th><th style={th}>DBL / os.</th><th style={th}>SNGL / os.</th></tr></thead>
          <tbody>
            {(sold.combinedRows || []).map(r => (
              <tr key={r.pax}>
                <td style={{ ...td, textAlign: 'left' }}>{r.pax} pax</td>
                <td style={{ ...td, fontWeight: 700 }}>{fmtMoney(r.finalDbl)} €</td>
                <td style={td}>{fmtMoney(r.finalSngl)} €</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sold.showSplit && sold.split && (
          <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
            Klient dostal ceny rozdělené podle měn:{' '}
            {(sold.split[0].rows || []).map(r => (
              <span key={r.pax} style={{ marginRight: 12 }}>
                {r.pax} pax {sold.split.map(p => { const x = (p.rows || []).find(y => y.pax === r.pax); return `${fmtMoney(x ? x.finalDbl : null)} ${p.cur}`; }).join(' + ')}
              </span>
            ))}
          </div>
        )}
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>
          Marže {sold.margin}% · FOC {sold.focCount} ({String(sold.focType || 'dbl').toUpperCase()}). Změnit prodanou verzi jde v nabídce (zelená lišta nahoře).
        </div>
      </div>

      {(() => {
        // ── Ceny a zisk pro všechny velikosti skupiny, živě ──
        // Prodáno = zamčená verze. Náklady = dnešní výpočet nabídky (stejný jako
        // v nabídce, dnešní kurzy). Finální velikost skupiny se určí až před odjezdem.
        const live = computeOfferRows(offer, rates);
        const rowsCmp = (sold.combinedRows || []).map(sr => {
          const cur = live.rows.find(r => r.pax === sr.pax);
          const costNow = cur ? cur.totalCostDbl : null;
          const profitNow = cur ? sr.finalDbl - costNow : null;
          const profitSold = (sr.costDbl !== undefined && sr.focShare !== undefined) ? sr.finalDbl - (sr.costDbl + sr.focShare) : null;
          const firmPct = cur && costNow > 0 ? Math.round(cur.confirmedCostDbl / costNow * 100) : null;
          return { pax: sr.pax, sold: sr.finalDbl, costNow, firm: cur ? cur.confirmedCostDbl : null, firmPct, profitNow, profitSold };
        });
        const col = (v) => v === null ? colors.muted : v < 0 ? '#b91c1c' : '#27500A';
        return (
          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary, marginBottom: 4 }}>💶 Ceny a zisk — živě</div>
            <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10, lineHeight: 1.5 }}>
              Prodaná cena je zamčená. Náklady se počítají z nabídky tak, jak je dnes — když upravíte hotel, bus nebo průvodce, zisk se přepočítá.
              Finální velikost skupiny se určí před odjezdem.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 13, minWidth: 640 }}>
                <thead><tr>
                  <th style={{ ...th, textAlign: 'left' }}>Skupina</th>
                  <th style={th}>Prodáno / os.</th>
                  <th style={th}>Náklady dnes / os.</th>
                  <th style={th}>z toho pevné</th>
                  <th style={th}>Zisk / os.</th>
                  <th style={th}>Zisk při prodeji / os.</th>
                  <th style={th}>Zisk celkem</th>
                </tr></thead>
                <tbody>
                  {rowsCmp.map(r => (
                    <tr key={r.pax}>
                      <td style={{ ...td, textAlign: 'left' }}>{r.pax} pax</td>
                      <td style={{ ...td, fontWeight: 700 }}>{fmtMoney(r.sold)} €</td>
                      <td style={td}>{r.costNow === null ? '—' : `${fmtMoney(r.costNow)} €`}</td>
                      <td style={{ ...td, color: colors.muted }}>{r.firm === null ? '—' : `${fmtMoney(r.firm)} € (${r.firmPct} %)`}</td>
                      <td style={{ ...td, fontWeight: 700, color: col(r.profitNow) }}>{r.profitNow === null ? '—' : `${fmtMoney(r.profitNow)} €`}</td>
                      <td style={{ ...td, color: colors.muted }}>{r.profitSold === null ? '—' : `${fmtMoney(r.profitSold)} €`}</td>
                      <td style={{ ...td, fontWeight: 700, color: col(r.profitNow) }}>{r.profitNow === null ? '—' : `${fmtMoney(r.profitNow * r.pax)} €`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rowsCmp.some(r => r.costNow === null) && (
              <div style={{ fontSize: 12, color: '#9a3412', marginTop: 6 }}>⚠ Některé velikosti skupiny z prodané verze nejsou v nabídce v „Pax sizes“ — pro ně se dnešní náklady nepočítají.</div>
            )}
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 8, lineHeight: 1.5 }}>
              Náklady = na platící osobu ve dvoulůžkovém pokoji, včetně podílu na FOC. „Pevné“ = služby ve stavu Potvrzeno, zbytek je zatím odhad.
              Kurzy {ratesDate ? 'z Nastavení (💱 Kurzy měn)' : 'výchozí z programu (Nastavení se nenačetlo)'}.
              Zisk celkem = zisk na osobu × počet platících osob.
            </div>
          </div>
        );
      })()}

      <ServicesByKind offerId={offerId} colors={colors} card={card} cnt={cnt} itemsCount={items.length}
        byKind={byKind} kindOrder={kindOrder} nLate={nLate} nWarn={nWarn} nNoKind={nNoKind} nSuggest={nSuggest} rowsK={rowsK} />

      <FinalCountsBlock offer={offer} offerId={offerId} colors={colors} card={card} />

      <DepositsBlock offer={offer} offerId={offerId} navigate={navigate} colors={colors} card={card} />

      <div style={{ ...card, background: '#F7F6F3', color: colors.muted, fontSize: 13 }}>
        Další kroky Realizace (připravujeme): platby od klienta · kontrola faktur hotelů · rooming list · vouchery · kontrolní seznam před odjezdem.
      </div>
    </div>
  );
}

// ── Služby seskupené podle druhu, s termíny rezervací ──────────────────────
// Druh se ukládá do offers/<id>.rzServices[<itemId>] (FieldPath — id položek
// mohou obsahovat tečku). Nabídka toto pole nikdy nepřepisuje.
function ServicesByKind({ offerId, colors, card, cnt, itemsCount, byKind, kindOrder, nLate, nWarn, nNoKind, nSuggest, rowsK }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const save = async (itemId, patch) => {
    setBusy(String(itemId)); setErr('');
    try {
      const prev = (rowsK.find(r => String(r.it.id) === String(itemId)) || {}).saved || {};
      const by = codeForEmail(auth.currentUser?.email) || auth.currentUser?.email || '';
      const next = { ...prev, ...patch, setBy: by, setAt: new Date().toISOString() };
      Object.keys(next).forEach(k => { if (next[k] === undefined) delete next[k]; });
      await updateDoc(doc(db, 'offers', offerId), new FieldPath('rzServices', String(itemId)), next);
    } catch (e) { setErr('Uložení se nepovedlo: ' + (e.message || e)); }
    setBusy('');
  };
  const acceptAll = async () => {
    const list = rowsK.filter(r => !r.kind && r.suggestion);
    if (!list.length) return;
    const txt = list.map(r => `• ${[r.it.city, r.it.name].filter(Boolean).join(' – ') || 'bez názvu'} → ${kindById(r.suggestion).label}`).join('\n');
    if (!window.confirm(`Uložit tyto návrhy druhu služby?\n\n${txt}`)) return;
    for (const r of list) { await save(r.it.id, { kind: r.suggestion }); }
  };
  const sel = { padding: '3px 6px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12, fontFamily: 'inherit', background: '#fff' };

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>Služby a termíny rezervací</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: cnt.total > 0 && cnt.confirmed === cnt.total ? '#27500A' : '#c2410c' }}>potvrzeno {cnt.confirmed} / {cnt.total}</div>
        {nLate > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: LEVEL_STYLE.late.color, background: LEVEL_STYLE.late.bg, borderRadius: 6, padding: '2px 8px' }}>⛔ {nLate} po termínu</span>}
        {nWarn > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: LEVEL_STYLE.warn.color, background: LEVEL_STYLE.warn.bg, borderRadius: 6, padding: '2px 8px' }}>⏳ {nWarn} rezervovat teď</span>}
        {nNoKind > 0 && <span style={{ fontSize: 12, fontWeight: 700, color: LEVEL_STYLE.nokind.color, background: LEVEL_STYLE.nokind.bg, borderRadius: 6, padding: '2px 8px' }}>❓ {nNoKind} bez druhu</span>}
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8, lineHeight: 1.5 }}>
        Služby se berou živě z nabídky (stavy, opce, storno se upravují v nabídce). Druh služby je jen štítek pro termíny — na cenu nemá vliv.
        Termíny se počítají od data příjezdu skupiny.
      </div>
      {err && <div style={{ color: '#b91c1c', fontSize: 12, marginBottom: 6 }}>⚠ {err}</div>}

      {kindOrder.filter(k => byKind[k]).map(k => {
        const kd = kindById(k);
        const head = kd ? { icon: kd.icon, label: kd.label, color: kd.color, bg: kd.bg, rule: kd.rule }
          : { icon: '❓', label: 'Bez druhu — vyberte', color: '#c2410c', bg: '#fff7ed', rule: 'druh určí termín rezervace' };
        return (
          <div key={k} style={{ border: `1px solid ${head.color}33`, borderLeft: `5px solid ${head.color}`, borderRadius: 8, marginBottom: 10, overflow: 'hidden' }}>
            <div style={{ background: head.bg, color: head.color, padding: '6px 10px', display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{head.icon} {head.label} ({byKind[k].length})</span>
              <span style={{ fontSize: 11 }}>termín: {head.rule}</span>
              {k === '_none' && nSuggest > 0 && (
                <button onClick={acceptAll} disabled={!!busy}
                  style={{ marginLeft: 'auto', padding: '2px 10px', background: '#c2410c', color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600 }}>
                  Projít a uložit návrhy ({nSuggest})
                </button>
              )}
            </div>
            {byKind[k].map(({ it, kind, saved, suggestion, dl }) => {
              const ls = LEVEL_STYLE[dl.level];
              const sugg = suggestion ? kindById(suggestion) : null;
              return (
                <div key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 10px', borderTop: `1px solid ${colors.border}`, fontSize: 13, flexWrap: 'wrap', opacity: it.cancelled ? 0.55 : 1 }}>
                  <span style={{ fontWeight: 600, minWidth: 200, flex: '1 1 220px', textDecoration: it.cancelled ? 'line-through' : 'none' }}>
                    {[it.city, it.name].filter(Boolean).join(' – ') || '(bez názvu)'}
                    <span style={{ fontWeight: 400, color: colors.muted, fontSize: 11, marginLeft: 6 }}>
                      {it.type === 'group' ? 'za skupinu' : 'za osobu'}
                    </span>
                  </span>
                  <span style={{ color: colors.muted, minWidth: 140, fontSize: 12 }}>
                    {it.dateFrom ? fmtDate(it.dateFrom) : ''}{it.dateTo && it.dateTo !== it.dateFrom ? ` – ${fmtDate(it.dateTo)}` : ''}{it.nights ? ` · ${it.nights} n.` : ''}
                    {it.subType === 'hotel' && it.trplOffer === 'yes' && <span style={{ marginLeft: 6, color: '#1a3a5c' }}>· TRPL ✓{String(it.trplPrice || '').trim() ? ` ${it.trplPrice} ${it.currency || 'EUR'}` : ''}</span>}
                    {it.subType === 'hotel' && it.trplOffer === 'no' && <span style={{ marginLeft: 6, color: '#c2410c', fontWeight: 700 }}>· TRPL ✕</span>}
                  </span>
                  <span style={{ fontSize: 11, minWidth: 150 }}>
                    {it.optionDate ? <span style={{ color: '#c2410c' }}>Opce {fmtDate(it.optionDate)} </span> : null}
                    {it.cancellationDeadline ? <span style={{ color: '#075985' }}>Storno {fmtDate(it.cancellationDeadline)}</span> : null}
                  </span>

                  {/* druh služby */}
                  <select value={kind} disabled={busy === String(it.id) || it.subType === 'hotel'}
                    title={it.subType === 'hotel' ? 'Hotelová karta je vždy hotel' : 'Druh služby (jen pro termíny, cenu nemění)'}
                    onChange={e => save(it.id, { kind: e.target.value })}
                    style={{ ...sel, borderColor: kind ? colors.border : '#fdba74', background: kind ? '#fff' : '#fff7ed' }}>
                    <option value="">❓ vyberte druh…</option>
                    {KINDS.filter(x => it.subType === 'hotel' || x.id !== 'hotel').map(x => <option key={x.id} value={x.id}>{x.icon} {x.label}</option>)}
                  </select>
                  {!kind && sugg && (
                    <button onClick={() => save(it.id, { kind: sugg.id })} disabled={!!busy}
                      style={{ padding: '2px 8px', background: sugg.bg, color: sugg.color, border: `1px solid ${sugg.color}`, borderRadius: 5, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                      {sugg.icon} {sugg.label}?
                    </button>
                  )}
                  {kind === 'transport' && (
                    <>
                      <select value={(saved && saved.transport) || ''} onChange={e => save(it.id, { transport: e.target.value })} style={sel}>
                        <option value="">vlak / loď / transfer / let?</option>
                        {TRANSPORT.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                      <label style={{ fontSize: 12, color: colors.muted }}>pro osob:{' '}
                        <input type="number" min="0" defaultValue={(saved && saved.pax) || ''} title="Jen informace pro objednávku — na cenu nemá vliv"
                          onBlur={e => { const v = e.target.value; if (String(v) !== String((saved && saved.pax) || '')) save(it.id, { pax: v }); }}
                          style={{ ...sel, width: 56 }} />
                      </label>
                    </>
                  )}
                  {kind === 'custom' && (
                    <label style={{ fontSize: 12, color: colors.muted }}>termín:{' '}
                      <input type="date" defaultValue={(saved && saved.due) || ''} onBlur={e => { if (e.target.value !== ((saved && saved.due) || '')) save(it.id, { due: e.target.value }); }} style={sel} />
                    </label>
                  )}

                  <span style={{ background: ls.bg, color: ls.color, fontSize: 11, padding: '2px 8px', borderRadius: 6, fontWeight: 600, whiteSpace: 'nowrap', marginLeft: 'auto' }}>
                    {ls.icon} {dl.text}
                  </span>
                  <StatusPicker it={it} offerId={offerId} colors={colors} onError={setErr} />
                </div>
              );
            })}
          </div>
        );
      })}
      {itemsCount === 0 && <div style={{ fontSize: 13, color: colors.muted }}>V nabídce nejsou žádné zaškrtnuté služby.</div>}
    </div>
  );
}

// ── Stav služby: mění se tady i v nabídce, zapisuje se kdo a kdy ──
function StatusPicker({ it, offerId, colors, onError }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const cur = displayStatus(it);
  const s = statusStyle(cur);
  const NAMES = Object.fromEntries(BOOKING_STATUS.map(o => [o.value, o.label]));
  const pick = async (v) => {
    if (v === cur) return;
    if (v === 'cancelled' && !window.confirm(`Označit „${[it.city, it.name].filter(Boolean).join(' – ') || 'službu'}“ jako ZRUŠENOU?\n\nDodavateli se nic neodešle.`)) return;
    setBusy(true); onError('');
    try { await setItemStatus(offerId, it.id, v, 'Realizace'); }
    catch (e) { console.error(e); onError('Stav se nepodařilo uložit: ' + (e.message || e)); }
    setBusy(false);
  };
  const log = Array.isArray(it.statusLog) ? it.statusLog : [];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' }}>
      <select value={cur} disabled={busy} onChange={e => pick(e.target.value)} title="Stav služby — mění se i na kartě v nabídce"
        style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                 border: `1px solid ${s.border || colors.border}`, background: s.bg, color: s.color || colors.muted, opacity: busy ? 0.6 : 1 }}>
        {BOOKING_STATUS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {it.statusAt ? (
        <span onClick={() => setOpen(v => !v)} title="Historie stavu"
          style={{ fontSize: 11, color: colors.muted, cursor: 'pointer', textDecoration: 'underline dotted', whiteSpace: 'nowrap' }}>
          {fmtStatusAt(it.statusAt)}{it.statusBy ? ` – ${it.statusBy}` : ''}{it.statusFrom ? ` (${it.statusFrom})` : ''}
        </span>
      ) : <span style={{ fontSize: 11, color: colors.muted, minWidth: 0 }} />}
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '120%', zIndex: 20, background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 8,
                      boxShadow: '0 8px 20px rgba(0,0,0,0.15)', padding: '8px 10px', minWidth: 320, fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Historie stavu</div>
          {log.length === 0 && <div style={{ color: colors.muted }}>Zatím bez záznamu.</div>}
          {log.map((h, i) => (
            <div key={i} style={{ padding: '2px 0', borderTop: i ? `1px solid ${colors.border}` : 'none' }}>
              {fmtStatusAt(h.at)} · <b>{h.by}</b>{h.from ? ` (${h.from})` : ''}: {NAMES[h.fromStatus] || 'Stav?'} → <b>{NAMES[h.toStatus] || h.toStatus}</b>
            </div>
          ))}
          <button onClick={() => setOpen(false)} style={{ marginTop: 6, fontSize: 11, padding: '2px 8px', border: `1px solid ${colors.border}`, borderRadius: 5, background: '#fff', cursor: 'pointer' }}>Zavřít</button>
        </div>
      )}
    </span>
  );
}

// ── Konečné počty: společné pro akci + výjimky u hotelů + nastavení výpočtu ──
// Ukládá se do offers/<id>.rzFinal po částech (lib/depositStore.js). Z těchto
// počtů se počítají zálohy (a později kontrola faktur hotelů).
function CountInput({ value, onCommit, disabled, colors, width = 48 }) {
  const [v, setV] = useState(value ?? '');
  const [focus, setFocus] = useState(false);
  useEffect(() => { if (!focus) setV(value ?? ''); }, [value, focus]);
  return (
    <input type="text" inputMode="numeric" value={v} disabled={disabled}
      onFocus={() => setFocus(true)}
      onChange={e => setV(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={() => { setFocus(false); if (String(v) !== String(value ?? '')) onCommit(v); }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }}
      style={{ width, padding: '4px 6px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 13, textAlign: 'right',
               fontFamily: 'inherit', background: disabled ? '#f4f4f2' : '#fff', color: disabled ? colors.muted : colors.text }} />
  );
}

function FinalCountsBlock({ offer, offerId, colors, card }) {
  const [err, setErr] = useState('');
  const [showLog, setShowLog] = useState(false);
  const [openCalc, setOpenCalc] = useState({});
  const f = offer.rzFinal || {};
  const g = f.group || {};
  const hotels = (offer.items || [])
    .filter(it => it.subType === 'hotel' && it.enabled !== false && !it.cancelled)
    .sort((a, b) => String(a.dateFrom || '').localeCompare(String(b.dateFrom || '')));
  const meals = mealCandidates(offer);
  const run = async (fn) => { setErr(''); try { await fn(); } catch (e) { console.error(e); setErr('Uložení se nepovedlo: ' + (e.message || e)); } };
  const fmtAt = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const log = Array.isArray(f.log) ? [...f.log].reverse() : [];
  const lbl = { fontSize: 11, color: colors.muted };
  const countsLine = (c) => FINAL_FIELDS.filter(x => String(c[x.key] ?? '').trim() !== '' && String(c[x.key]) !== '0')
    .map(x => `${c[x.key]} ${x.short}`).join(' · ') || '—';

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>🛏 Konečné počty</div>
        {g.setAt && <span style={lbl}>změněno {fmtAt(g.setAt)}{g.setBy ? ` – ${g.setBy}` : ''}</span>}
        <button onClick={() => setShowLog(v => !v)} style={{ marginLeft: 'auto', padding: '2px 9px', background: '#fff', color: colors.primary, border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
          {showLog ? '▾' : '▸'} Historie změn ({log.length})
        </button>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 10 }}>
        Skutečně prodaná místa a pokoje. Vyplňte, až je znáte, a měňte podle skutečnosti — z těchto čísel se počítají zálohy.
      </div>
      {showLog && (
        <div style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8, marginBottom: 10 }}>
          {log.length === 0 && <div style={{ padding: 8, fontSize: 12, color: colors.muted }}>Zatím žádné změny.</div>}
          {log.map((h, i) => (
            <div key={i} style={{ padding: '4px 10px', fontSize: 12, borderTop: i ? `1px solid ${colors.border}` : 'none' }}>
              {fmtAt(h.at)} · {h.by} · <b>{h.where}</b> · {h.text}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', background: '#F7F6F3', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, alignSelf: 'center', minWidth: 120 }}>Celá akce</div>
        {FINAL_FIELDS.map(x => (
          <label key={x.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={lbl}>{x.label}</span>
            <CountInput colors={colors} value={g[x.key]} width={x.key === 'pax' ? 56 : 48}
              onCommit={v => run(() => saveFinalGroup(offerId, offer, { [x.key]: v }))} />
          </label>
        ))}
      </div>

      {hotels.length === 0 && <div style={{ fontSize: 13, color: colors.muted }}>V nabídce nejsou zaškrtnuté hotely.</div>}
      {hotels.map(it => {
        const ff = finalFor(offer, it.id);
        const h = ff.hotel;
        const calc = h.calc || {};
        const tot = hotelTotal(it, offer);
        const cur = it.currency || 'EUR';
        const isOpen = !!openCalc[it.id];
        const setCalc = (patch, text) => run(() => saveFinalHotel(offerId, offer, it, { calc: { ...calc, ...patch } }, text));
        const mealIds = (calc.meals || []).map(String);
        const foc = calc.foc || {};
        return (
          <div key={it.id} style={{ border: `1px solid ${ff.exception ? '#f59e0b' : colors.border}`, background: ff.exception ? '#fffbeb' : '#fff', borderRadius: 8, padding: '8px 12px', marginBottom: 6 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: 13, minWidth: 200 }}>🏨 {[it.city, it.name].filter(Boolean).join(' – ') || '(bez názvu)'}</span>
              <span style={lbl}>{fmtDate(it.dateFrom)}{it.nights ? ` · ${it.nights} nocí` : ''}</span>
              {!ff.exception && <span style={{ fontSize: 12 }}>{countsLine(ff.counts)}</span>}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: ff.exception ? '#b45309' : colors.muted, fontWeight: ff.exception ? 700 : 400 }}>
                <input type="checkbox" checked={ff.exception}
                  onChange={e => run(() => saveFinalHotel(offerId, offer, it,
                    e.target.checked
                      ? { exception: true, ...Object.fromEntries(FINAL_FIELDS.map(x => [x.key, h[x.key] !== undefined && h.exception ? h[x.key] : (g[x.key] ?? '')])) }
                      : { exception: false },
                    e.target.checked ? 'výjimka zapnuta (vlastní počty)' : 'výjimka zrušena (počty celé akce)'))} />
                ✎ výjimka (jiné počty než celá akce)
              </label>
              <span style={{ marginLeft: 'auto', fontSize: 12 }}>
                celá cena: <b>{tot.any && tot.total > 0 ? `${fmtMoney(tot.total)} ${cur}` : '—'}</b>
              </span>
              <button onClick={() => setOpenCalc(o => ({ ...o, [it.id]: !o[it.id] }))} title="Výpočet celé ceny a nastavení (strava, FOC)"
                style={{ padding: '2px 8px', background: isOpen ? '#e0f2fe' : '#fff', color: '#0369a1', border: '1px solid #7dd3fc', borderRadius: 5, fontSize: 12, cursor: 'pointer', fontWeight: 700 }}>ℹ</button>
            </div>
            {ff.exception && (
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 6 }}>
                {FINAL_FIELDS.map(x => (
                  <label key={x.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={lbl}>{x.label}</span>
                    <CountInput colors={colors} value={h[x.key]} width={x.key === 'pax' ? 56 : 48}
                      onCommit={v => run(() => saveFinalHotel(offerId, offer, it, { [x.key]: v }))} />
                  </label>
                ))}
              </div>
            )}
            {isOpen && (
              <div style={{ marginTop: 8, fontSize: 12, background: '#f8fafc', border: '1px solid #bae6fd', borderRadius: 6, padding: '8px 10px', lineHeight: 1.6 }}>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 6 }}>
                  {meals.length > 0 ? meals.map(m => (
                    <label key={m.id} style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                      <input type="checkbox" checked={mealIds.includes(String(m.id))}
                        onChange={e => setCalc({ meals: e.target.checked ? [...mealIds, String(m.id)] : mealIds.filter(x => x !== String(m.id)) },
                          `${e.target.checked ? 'započítat' : 'nezapočítat'} stravu: ${m.name || ''}`)} />
                      započítat stravu: {[m.city, m.name].filter(Boolean).join(' – ')}
                    </label>
                  )) : <span style={{ color: colors.muted }}>Strava: v nabídce není karta polopenze / jídla v hotelu.</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!foc.on}
                      onChange={e => setCalc({ foc: { n: foc.n || '1', type: foc.type || 'sgl', on: e.target.checked } }, e.target.checked ? 'odečíst FOC: ano' : 'odečíst FOC: ne')} />
                    odečíst FOC
                  </label>
                  {foc.on && (
                    <>
                      <CountInput colors={colors} value={foc.n || '1'} width={36} onCommit={v => setCalc({ foc: { ...foc, n: v } }, `FOC počet: ${v}`)} />
                      <select value={foc.type || 'sgl'} onChange={e => setCalc({ foc: { ...foc, type: e.target.value } }, `FOC pokoj: ${e.target.value.toUpperCase()}`)}
                        style={{ padding: '3px 6px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12 }}>
                        <option value="sgl">SGL</option><option value="dbl">DBL</option>
                      </select>
                      <span style={{ color: colors.muted }}>pokoj zdarma (city tax se platí dál)</span>
                    </>
                  )}
                  {it.focRatio && <span style={{ color: colors.muted }}>· na kartě: FOC {it.focRatio}{it.focRoomType ? ` (${String(it.focRoomType).toUpperCase()})` : ''}</span>}
                </div>
                {tot.lines.map((l, k) => (
                  <div key={k} style={{ display: 'flex', gap: 12, color: l.amount < 0 ? '#9a3412' : colors.text }}>
                    <span style={{ flex: 1 }}>{l.label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(l.amount)}</span>
                  </div>
                ))}
                <div style={{ borderTop: `1px solid ${colors.border}`, marginTop: 3, paddingTop: 3, fontWeight: 700, display: 'flex' }}>
                  <span style={{ flex: 1 }}>celá cena hotelu</span><span>{fmtMoney(tot.total)} {cur}</span>
                </div>
                {tot.warnings.map((w, k) => <div key={k} style={{ color: '#b45309' }}>⚠ {w}</div>)}
                <div style={{ marginTop: 4 }}><b>Podmínky z karty:</b> {String(it.depositTerms || '').trim() || <span style={{ color: colors.muted }}>nevyplněno</span>}</div>
                <div style={{ color: colors.muted, marginTop: 2 }}>Ceny jsou z karty hotelu v nabídce. FOC se odečítá jen když je zaškrtnuto.</div>
              </div>
            )}
          </div>
        );
      })}
      {err && <div style={{ color: '#b91c1c', fontSize: 13, marginTop: 6 }}>❌ {err}</div>}
    </div>
  );
}

// ── Zálohy dodavatelům: upravují se tady i na kartě v nabídce (jedno společné
// místo, změna se hned ukáže na obou stranách). ──
function DepositsBlock({ offer, offerId, navigate, colors, card }) {
  const today = new Date().toISOString().slice(0, 10);
  const [addFor, setAddFor] = useState('');
  const [err, setErr] = useState('');
  const active = (offer.items || []).filter(it => it.enabled !== false && !it.cancelled
    && it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');
  const list = allDeposits(active, today, offer.startDate, offer);
  const byCur = {};
  list.forEach(d => {
    const c = byCur[d.currency] = byCur[d.currency] || { total: 0, paid: 0, open: 0 };
    if (!d.known) return;
    c.total += d.amount; if (d.status === 'paid') c.paid += d.amount; else c.open += d.amount;
  });
  const unknownN = list.filter(d => !d.known && d.status !== 'paid').length;
  const n = (s) => list.filter(d => d.status === s).length;
  const label = (it) => [it.city, it.name].filter(Boolean).join(' – ') || '(bez názvu)';
  // Hotely vždy, ostatní služby jen když už mají zálohu.
  const shown = active.filter(it => it.subType === 'hotel' || effectiveDeposits(offer, it).length > 0)
    .sort((a, b) => (a.subType === 'hotel' ? 0 : 1) - (b.subType === 'hotel' ? 0 : 1) || String(a.dateFrom || '').localeCompare(String(b.dateFrom || '')));
  const others = active.filter(it => !shown.includes(it));
  const addOther = async () => {
    const it = active.find(x => String(x.id) === String(addFor));
    if (!it) return;
    setErr('');
    try { await addDepositRow(offerId, offer, it, 'Realizace'); setAddFor(''); }
    catch (e) { setErr('Zálohu se nepodařilo přidat: ' + (e.message || e)); }
  };
  const chip = (st, text) => <span style={{ fontSize: 12, fontWeight: 700, color: DEPOSIT_STYLE[st].color, background: DEPOSIT_STYLE[st].bg, borderRadius: 6, padding: '2px 8px' }}>{text}</span>;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>💸 Zálohy dodavatelům</div>
        {n('overdue') > 0 && chip('overdue', `⛔ ${n('overdue')} po splatnosti`)}
        {n('soon') > 0 && chip('soon', `⏳ ${n('soon')} splatné do 14 dní`)}
        {n('nodue') > 0 && chip('nodue', `❓ ${n('nodue')} bez splatnosti`)}
        <button onClick={() => navigate('offer-detail', { offerId })} style={{ marginLeft: 'auto', padding: '3px 10px', background: '#fff', color: colors.primary, border: `1px solid ${colors.primary}`, borderRadius: 5, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
          Otevřít nabídku
        </button>
      </div>
      <div style={{ fontSize: 12, color: colors.muted, marginBottom: 8, lineHeight: 1.5 }}>
        Zálohy jde upravovat tady i na kartě v nabídce — je to stejné místo, změna se hned ukáže na obou stranách.
        Prázdná částka se vypočte z konečných počtů (zeleně); napsaná částka má přednost (✎). „✓ zaplaceno“ vypočtenou částku zafixuje.
      </div>
      {shown.map(it => (
        <div key={it.id} style={{ borderTop: `1px solid ${colors.border}`, padding: '8px 0' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>
            {it.subType === 'hotel' ? '🏨' : '•'} {label(it)}
            <span style={{ fontWeight: 400, color: colors.muted, fontSize: 12 }}> · {it.currency || 'EUR'}{it.dateFrom ? ` · příjezd ${fmtDate(it.dateFrom)}` : ''}</span>
          </div>
          <DepositRows offerId={offerId} offer={offer} item={it} from="Realizace" colors={colors} arrival={offer.startDate} big />
        </div>
      ))}
      {others.length > 0 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${colors.border}`, paddingTop: 8 }}>
          <span style={{ fontSize: 12, color: colors.muted }}>Záloha k jiné službě:</span>
          <select value={addFor} onChange={e => setAddFor(e.target.value)} style={{ padding: '3px 6px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 12 }}>
            <option value="">— vyberte službu —</option>
            {others.map(it => <option key={it.id} value={it.id}>{label(it)}</option>)}
          </select>
          <button disabled={!addFor} onClick={addOther} style={{ padding: '3px 10px', background: addFor ? colors.primary : '#ccc', color: '#fff', border: 'none', borderRadius: 5, fontSize: 12, cursor: addFor ? 'pointer' : 'default' }}>+ záloha</button>
        </div>
      )}
      {err && <div style={{ color: '#b91c1c', fontSize: 13, marginTop: 6 }}>❌ {err}</div>}
      {list.length > 0 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, fontSize: 12, borderTop: `1px solid ${colors.border}`, paddingTop: 8 }}>
          {Object.entries(byCur).map(([c, v]) => (
            <span key={c}><b>{c}</b>: celkem {fmtMoney(v.total)} · zaplaceno {fmtMoney(v.paid)} · <b style={{ color: v.open > 0 ? '#9a3412' : '#27500A' }}>zbývá {fmtMoney(v.open)}</b></span>
          ))}
          {unknownN > 0 && <span style={{ color: '#9a3412' }}>+ {unknownN}× částka se určí (chybí počty nebo procento)</span>}
        </div>
      )}
    </div>
  );
}
