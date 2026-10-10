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

// Přehled jedné akce v Realizaci. Všechno se čte ŽIVĚ z nabídky
// (offers/<id>) — žádná kopie. Upravuje se v nabídce („Otevřít nabídku“);
// tady je přehled. Pokoje, platby, rooming list a vouchery přijdou
// v dalších krocích.

const STATUS = {
  '':          { label: 'Stav?',          bg: '#F1EFE8', color: '#444441' },
  requested:   { label: '🟡 Poptáno',      bg: '#fff8e1', color: '#854f0b' },
  negotiating: { label: '🟠 V jednání',    bg: '#ffedd5', color: '#c2410c' },
  preapproved: { label: '🔵 Předschváleno', bg: '#dbeafe', color: '#1d4ed8' },
  confirmed:   { label: '🟢 Potvrzeno',    bg: '#e8f5e9', color: '#2d6a4f' },
  cancelled:   { label: '🔴 Zrušeno',      bg: '#fee2e2', color: '#dc2626' },
};

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
          {rz.history && rz.history.length > 1 ? ` · prodaná verze změněna ${rz.history.length - 1}×, naposledy ${fmtDate(rz.changedAt)}${rz.changedBy ? ' – ' + rz.changedBy : ''}` : ''}
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

      <div style={{ ...card, background: '#F7F6F3', color: colors.muted, fontSize: 13 }}>
        Další kroky Realizace (připravujeme): finální počet osob a pokoje · platby dodavatelům · rooming list · vouchery · kontrolní seznam před odjezdem.
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
                  <span style={{ background: (STATUS[itemStatus(it)] || STATUS['']).bg, color: (STATUS[itemStatus(it)] || STATUS['']).color, fontSize: 11, padding: '2px 8px', borderRadius: 6, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {(STATUS[itemStatus(it)] || STATUS['']).label}
                  </span>
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
