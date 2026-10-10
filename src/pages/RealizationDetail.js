import React, { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { isInRealization, realizationItems, itemStatus, serviceCounts, fmtMoney, fmtDate } from '../lib/realization';
import { DEFAULT_RATES } from '../lib/offerCalc';
import { computeOfferRows } from '../lib/offerRows';

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

const kindOf = (it) => {
  if (it.subType === 'hotel') return { icon: '🏨', group: 'Hotely' };
  if (it.type === 'per_pax') return { icon: '🎟', group: 'Vstupenky a jídla' };
  return { icon: '🚌', group: 'Skupinové služby (bus, průvodce…)' };
};

export default function RealizationDetail({ offerId, navigate, colors }) {
  const [offer, setOffer] = useState(undefined);
  // Dnešní kurzy — stejný zdroj jako v nabídce (frankfurter.app), jinak výchozí.
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [ratesDate, setRatesDate] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${Object.keys(DEFAULT_RATES).join(',')}`);
        const data = await resp.json();
        if (data && data.rates) {
          const r = {};
          Object.entries(data.rates).forEach(([cur, v]) => { if (v > 0) r[cur] = 1 / v; });
          setRates(prev => ({ ...prev, ...r }));
          setRatesDate(data.date || '');
        }
      } catch (e) { console.error('Kurzy se nepodařilo načíst', e); }
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
  const groups = {};
  items.forEach(it => { const k = kindOf(it).group; (groups[k] = groups[k] || []).push(it); });
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
              Kurzy {ratesDate ? `z ${fmtDate(ratesDate)}` : 'výchozí (dnešní se nenačetly)'}.
              Zisk celkem = zisk na osobu × počet platících osob.
            </div>
          </div>
        );
      })()}

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: colors.primary }}>Služby</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: cnt.total > 0 && cnt.confirmed === cnt.total ? '#27500A' : '#c2410c' }}>
            potvrzeno {cnt.confirmed} / {cnt.total}
          </div>
          <div style={{ fontSize: 12, color: colors.muted }}>— živě z nabídky, upravuje se v nabídce</div>
        </div>
        {Object.entries(groups).map(([g, list]) => (
          <div key={g} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '8px 0 4px' }}>{g}</div>
            {list.map(it => {
              const st = STATUS[itemStatus(it)] || STATUS[''];
              const k = kindOf(it);
              return (
                <div key={it.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', borderTop: `1px solid ${colors.border}`, fontSize: 13, flexWrap: 'wrap', opacity: it.cancelled ? 0.55 : 1 }}>
                  <span>{k.icon}</span>
                  <span style={{ fontWeight: 600, minWidth: 200, flex: '1 1 220px', textDecoration: it.cancelled ? 'line-through' : 'none' }}>
                    {[it.city, it.name].filter(Boolean).join(' – ') || '(bez názvu)'}
                  </span>
                  <span style={{ color: colors.muted, minWidth: 150 }}>
                    {it.dateFrom ? fmtDate(it.dateFrom) : ''}{it.dateTo && it.dateTo !== it.dateFrom ? ` – ${fmtDate(it.dateTo)}` : ''}{it.nights ? ` · ${it.nights} n.` : ''}
                  </span>
                  <span style={{ fontSize: 12, minWidth: 190 }}>
                    {it.optionDate ? <span style={{ color: '#c2410c' }}>Opce {fmtDate(it.optionDate)} </span> : null}
                    {it.cancellationDeadline ? <span style={{ color: '#075985' }}>Storno {fmtDate(it.cancellationDeadline)}</span> : null}
                  </span>
                  <span style={{ background: st.bg, color: st.color, fontSize: 11, padding: '2px 8px', borderRadius: 6, fontWeight: 600, whiteSpace: 'nowrap' }}>{st.label}</span>
                </div>
              );
            })}
          </div>
        ))}
        {items.length === 0 && <div style={{ fontSize: 13, color: colors.muted }}>V nabídce nejsou žádné zaškrtnuté služby.</div>}
      </div>

      <div style={{ ...card, background: '#F7F6F3', color: colors.muted, fontSize: 13 }}>
        Další kroky Realizace (připravujeme): finální počet osob a pokoje · platby dodavatelům · rooming list · vouchery · kontrolní seznam před odjezdem.
      </div>
    </div>
  );
}
