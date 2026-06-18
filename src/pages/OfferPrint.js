import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { DEFAULT_RATES, computeOfferPricing, evalAmount } from '../lib/offerCalc';
import coverBase64 from '../lib/coverBase64';

const ASSETS = process.env.PUBLIC_URL + '/offer-assets';

const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
};

const PageChrome = () => (
  <>
    <div className="op-header">
      <div>
        TOUR PRAGENSES<br />
        www.tour-pragenses.com<br />
        +420 777 079 997<br />
        info@tour-pragenses.com
      </div>
      <img src={`${ASSETS}/logo.png`} alt="Tour Pragenses" />
    </div>
    <div className="op-footer">
      <b>Pragenses s.r.o.</b> &nbsp;|&nbsp; Lipnická 688, Praha 9 - Kyje, Czech Republic &nbsp;|&nbsp; IČO: 284 45 961 &nbsp;|&nbsp; DIČ: CZ284 45 961
    </div>
  </>
);

export default function OfferPrint({ offerId, navigate, colors }) {
  const [offer, setOffer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rates, setRates] = useState(DEFAULT_RATES);

  const fetchData = useCallback(async () => {
    const snap = await getDoc(doc(db, 'offers', offerId));
    if (snap.exists()) setOffer({ id: snap.id, ...snap.data() });
    setLoading(false);
  }, [offerId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    (async () => {
      try {
        const symbols = Object.keys(DEFAULT_RATES).join(',');
        const resp = await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${symbols}`);
        const data = await resp.json();
        if (data && data.rates) {
          const newRates = {};
          Object.entries(data.rates).forEach(([cur, value]) => { if (value > 0) newRates[cur] = 1 / value; });
          setRates(prev => ({ ...prev, ...newRates }));
        }
      } catch (err) { console.error('Failed to fetch live exchange rates', err); }
    })();
  }, []);

  if (loading) return <div style={{ color: colors.muted, fontSize: 14, padding: 20 }}>Loading...</div>;
  if (!offer) return <div style={{ color: colors.muted, fontSize: 14, padding: 20 }}>Offer not found.</div>;

  const items = offer.items || [];
  const margin = offer.margin || 15;
  const paxList = offer.paxList || '15,20,25,30,35';
  const activeItems = items.filter(it => it.enabled !== false);
  const { rows } = computeOfferPricing(items, margin, paxList, rates);

  const SPLIT_CURRENCIES = ['CHF', 'GBP'];
  const CUR_SYMBOL = { EUR: '€', CHF: 'CHF', GBP: '£' };
  const CUR_FLAG = { EUR: '🇪🇺', CHF: '🇨🇭', GBP: '🇬🇧' };
  const activeCurrencies = [...new Set(activeItems.map(it => it.currency))].filter(c => SPLIT_CURRENCIES.includes(c));
  const hasSplit = activeCurrencies.length > 0;
  const paxCounts = paxList.split(',').map(s => parseInt(s.trim())).filter(n => n > 0);

  const computeByCurrency = (cur) => {
    const paxItems = activeItems.filter(it => it.type === 'per_pax');
    const groupItems = activeItems.filter(it => it.type === 'group');
    const curPaxItems = paxItems.filter(it => it.currency === cur);
    const curGroupItems = groupItems.filter(it => it.currency === cur && it.subType !== 'guide_hotel');
    const perPaxDbl = curPaxItems.reduce((sum, it) => sum + evalAmount(it.subType === 'hotel'
      ? (((evalAmount(it.pricePerNightDbl) + evalAmount(it.cityTax)) * (parseFloat(it.nights) || 0)) / 2)
      : it.costDbl), 0);
    const perPaxSngl = curPaxItems.reduce((sum, it) => sum + evalAmount(it.subType === 'hotel'
      ? ((evalAmount(it.pricePerNightSngl) + evalAmount(it.cityTaxSngl || it.cityTax)) * (parseFloat(it.nights) || 0))
      : (it.costSngl || it.costDbl)), 0);
    const groupTotal = curGroupItems.reduce((sum, it) => sum + evalAmount(it.groupCost), 0);
    const snglSupp = perPaxSngl - perPaxDbl;
    const rows = paxCounts.map(pax => {
      const costDbl = groupTotal / pax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const focShare = perPaxDbl / pax;
      const finalDbl = costDbl + marginAmount + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, finalDbl, finalSngl };
    });
    return { cur, rows };
  };

  const computeEurOnly = () => {
    const paxItems = activeItems.filter(it => it.type === 'per_pax');
    const groupItems = activeItems.filter(it => it.type === 'group');
    const eurPaxItems = paxItems.filter(it => !SPLIT_CURRENCIES.includes(it.currency));
    const eurGroupItems = groupItems.filter(it => !SPLIT_CURRENCIES.includes(it.currency) && it.subType !== 'guide_hotel');
    const toEUR = (v, c) => c === 'EUR' ? v : v * (rates[c] || 1);
    const perPaxDbl = eurPaxItems.reduce((sum, it) => sum + toEUR(evalAmount(it.subType === 'hotel'
      ? (((evalAmount(it.pricePerNightDbl) + evalAmount(it.cityTax)) * (parseFloat(it.nights) || 0)) / 2)
      : it.costDbl), it.currency), 0);
    const perPaxSngl = eurPaxItems.reduce((sum, it) => sum + toEUR(evalAmount(it.subType === 'hotel'
      ? ((evalAmount(it.pricePerNightSngl) + evalAmount(it.cityTaxSngl || it.cityTax)) * (parseFloat(it.nights) || 0))
      : (it.costSngl || it.costDbl)), it.currency), 0);
    const groupTotal = eurGroupItems.reduce((sum, it) => sum + toEUR(evalAmount(it.groupCost), it.currency), 0);
    const snglSupp = perPaxSngl - perPaxDbl;
    const rows = paxCounts.map(pax => {
      const costDbl = groupTotal / pax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const focShare = perPaxDbl / pax;
      const finalDbl = costDbl + marginAmount + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, finalDbl, finalSngl };
    });
    return { cur: 'EUR', rows };
  };

  const splitData = hasSplit
    ? [...activeCurrencies.map(c => computeByCurrency(c)), computeEurOnly()]
    : null;

  const hotels = items.filter(it => it.type === 'per_pax' && it.subType === 'hotel');
  const tickets = items.filter(it => it.type === 'per_pax' && it.subType === 'ticket' && it.name);
  const groupServices = items.filter(it => it.type === 'group' && it.name);
  const guideHotels = items.filter(it => it.type === 'group' && it.subType === 'guide_hotel');
  const hasCityTax = hotels.some(h => evalAmount(h.cityTax) > 0 || evalAmount(h.cityTaxSngl) > 0);
  const programParagraphs = (offer.programText || '').split(/\n\s*\n/).filter(p => p.trim());

  const createdDate = offer.createdAt ? new Date(offer.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const emailSubject = encodeURIComponent(`Proposta: ${offer.name}`);
  const emailBody = encodeURIComponent(`Prezado(a),\n\nSegue em anexo a proposta "${offer.name}".\n\nAtenciosamente,\nTour Pragenses`);
  const clientEmail = offer.clientEmail || '';

  return (
    <div>
      <style>{`
        @media print {
          .op-no-print { display: none !important; }
          .app-sidebar { display: none !important; }
          .app-main { padding: 0 !important; background: white !important; }
          @page {
            size: A4;
            margin: 35mm 18mm 25mm 18mm;
          }
          @page :first {
            margin: 0 !important;
          }
          .op-cover-print {
            page-break-after: always;
            position: relative;
            width: 210mm;
            height: 297mm;
            margin: -35mm -18mm -25mm -18mm;
            overflow: hidden;
          }
          .op-cover-print img { width: 210mm; height: 297mm; object-fit: cover; display: block; }
          /* Hide fixed header/footer on first page */
          .op-print-header, .op-print-footer { display: none; }
          .op-content-print .op-print-header, .op-content-print ~ .op-print-header { display: flex !important; }
          .op-content-print { }
          .op-section { page-break-inside: avoid; margin-top: 6px; }
          .op-print-header {
            position: fixed; top: 0; left: 0; right: 0;
            height: 25mm;
            display: flex !important;
            justify-content: space-between;
            align-items: center;
            padding: 6mm 18mm 0 18mm;
            font-family: Arial, sans-serif; font-size: 9px; color: #999; line-height: 1.5;
            background: white;
            border-bottom: 1px solid #eee;
          }
          .op-print-header img { height: 28px; opacity: 0.55; }
          .op-print-footer {
            position: fixed; bottom: 0; left: 0; right: 0;
            height: 18mm;
            font-family: Arial, sans-serif; font-size: 9px; color: #999;
            text-align: center;
            padding: 4mm 18mm 0 18mm;
            background: white;
            border-top: 1px solid #eee;
          }
          .op-no-cover-header { display: none; }
        }
        @media screen {
          .op-print-only { display: none !important; }
          .op-page-frame { max-width: 800px; margin: 0 auto 24px; background: #fff; box-shadow: 0 0 12px rgba(0,0,0,0.12); padding: 32mm 18mm 22mm 18mm; box-sizing: border-box; position: relative; min-height: 1000px; overflow: hidden; }
        }
        /* Shared styles */
        .op-header { position: absolute; top: 8mm; left: 18mm; right: 18mm; display: flex; justify-content: space-between; align-items: flex-start; font-family: Arial, sans-serif; font-size: 9px; color: #999; line-height: 1.5; z-index: 1; }
        .op-header img { height: 32px; opacity: 0.55; }
        .op-footer { position: absolute; bottom: 8mm; left: 18mm; right: 18mm; text-align: center; font-family: Arial, sans-serif; font-size: 9px; color: #999; z-index: 1; }
        .op-watermark { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; object-position: bottom right; pointer-events: none; z-index: 0; opacity: 0.35; }
        .op-page-content { position: relative; z-index: 1; }
        .op-cover-img { width: 100%; }
        .op-content h2, .op-print-only h2 { color: #1a3a5c; font-size: 15px; border-bottom: 2px solid #c8a84b; padding-bottom: 4px; margin-top: 20px; margin-bottom: 8px; }
        .op-content h3, .op-print-only h3 { color: #1a3a5c; font-size: 12px; margin: 12px 0 4px; }
        .op-content p, .op-print-only p { font-size: 11px; line-height: 1.6; color: #222; margin: 4px 0 8px; font-family: Arial, sans-serif; }
        .op-content ul, .op-print-only ul { font-size: 11px; line-height: 1.6; padding-left: 16px; font-family: Arial, sans-serif; }
        .op-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-top: 6px; }
        .op-table th, .op-table td { border: 1px solid #ddd; padding: 4px 6px; text-align: right; font-family: Arial, sans-serif; }
        .op-table th:first-child, .op-table td:first-child { text-align: left; }
        .op-table th { background: #1a3a5c; color: #fff; font-weight: 600; }
        .op-table tr:nth-child(even) td { background: #f7f6f3; }
        .op-final { font-weight: 700; color: #1a3a5c; }
      `}</style>

      <div className="op-no-print" style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => navigate('offer-detail', { offerId })} style={{ padding: '8px 16px', background: '#f7f6f3', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' }}>← Voltar</button>
        <button onClick={() => window.print()} style={{ padding: '8px 16px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>🖨️ Imprimir / Salvar PDF</button>
        {createdDate && <span style={{ fontSize: 12, color: colors.muted }}>Criado em: {createdDate}</span>}
      </div>

      {/* SCREEN PREVIEW — shown on screen only */}
      {/* Cover page */}
      <div className="op-page-frame op-cover">
        <img className="op-cover-img op-page-content" src={`${ASSETS}/cover.png`} alt="Tour Pragenses — Seu parceiro na Europa" />
        <img className="op-watermark" src={`${ASSETS}/watermark.png`} alt="" />
        <PageChrome />
      </div>

      {/* Content page screen preview */}
      <div className="op-page-frame op-content">
        <img className="op-watermark" src={`${ASSETS}/watermark.png`} alt="" />
        <PageChrome />
        <div className="op-page-content">
        <h2 style={{ marginTop: 0, color: '#0c447c', fontSize: 20 }}>{offer.name}</h2>
        {createdDate && <p style={{ fontSize: 11, color: '#999', marginTop: 8 }}>Proposta elaborada em: {createdDate}</p>}
        {offer.destinations && <p><b>Destinos:</b> {offer.destinations}</p>}
        {(offer.startDate || offer.endDate) && <p><b>Período:</b> {fmtDate(offer.startDate)} {offer.endDate ? `a ${fmtDate(offer.endDate)}` : ''}</p>}

        {hotels.length > 0 && (
          <>
            <h2>Hotéis</h2>
            <ul>
              {hotels.map(h => (
                <li key={h.id}>
                  <b>{h.city ? `${h.city}: ` : ''}{h.name || 'Hotel'}</b>{(h.dateFrom || h.dateTo) ? ` — ${fmtDate(h.dateFrom)} a ${fmtDate(h.dateTo)}` : ''}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="op-section">
          <h2>Investimento</h2>
          <p style={{ fontSize: 11, color: '#666' }}>
            Valores por pessoa. Inclui hotéis, taxas municipais, refeições e ingressos indicados, transporte e guias durante o roteiro.
          </p>
          {hasSplit ? (
            splitData.map(({ cur, rows: sRows }) => (
              <div key={cur} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#1a3a5c', marginBottom: 4 }}>
                  {CUR_FLAG[cur]} Serviços faturados em {cur}
                </div>
                <table className="op-table">
                  <thead>
                    <tr>
                      <th>Participantes</th>
                      <th>Quarto duplo (por pessoa)</th>
                      <th>Quarto individual (por pessoa)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sRows.map(r => (
                      <tr key={r.pax}>
                        <td>{r.pax} + 1 cortesia</td>
                        <td className="op-final">{CUR_SYMBOL[cur]} {r.finalDbl.toFixed(2)}</td>
                        <td className="op-final">{CUR_SYMBOL[cur]} {r.finalSngl.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          ) : (
            <table className="op-table">
              <thead>
                <tr>
                  <th>Participantes</th>
                  <th>Quarto duplo (por pessoa)</th>
                  <th>Quarto individual (por pessoa)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.pax}>
                    <td>{r.pax} + 1 cortesia</td>
                    <td className="op-final">€ {r.finalDbl.toFixed(2)}</td>
                    <td className="op-final">€ {r.finalSngl.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rows.length === 0 && <p style={{ color: '#999' }}>Nenhum valor calculado.</p>}
        </div>

        <div className="op-section">
          <h2>Incluído no preço</h2>
          <ul>
            {(offer.includedText || '').split('\n').filter(l => l.trim()).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          <h3 style={{ marginTop: 14 }}>Não incluído</h3>
          <ul>
            {(offer.notIncludedText || 'Voos internacionais e taxas de embarque\nBebidas e refeições não mencionadas\nGorjetas e despesas de caráter pessoal\nMaleteiros\nSeguro viagem').split('\n').filter(l => l.trim()).map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>

        {programParagraphs.length > 0 && (
          <div className="op-section">
            <h2>Roteiro</h2>
            {programParagraphs.map((p, i) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</p>)}
          </div>
        )}

        <div className="op-section" style={{ marginTop: 24, textAlign: 'center' }}>
          <p style={{ fontWeight: 700 }}>Equipe Tour Pragenses</p>
          <p style={{ fontStyle: 'italic', color: '#666' }}>Seu parceiro na Europa.</p>
        </div>
        </div>
      </div>

      {/* PRINT-ONLY VERSION */}
      <div className="op-print-only" style={{ fontFamily: 'Arial, sans-serif' }}>

        {/* Fixed header — shows on every page except cover */}
        <div className="op-print-header">
          <div style={{ fontSize: 9, color: '#999', lineHeight: 1.5 }}>
            TOUR PRAGENSES&nbsp;&nbsp;www.tour-pragenses.com&nbsp;&nbsp;+420 777 079 997&nbsp;&nbsp;info@tour-pragenses.com
          </div>
          <img src={`${ASSETS}/logo.png`} alt="Tour Pragenses" />
        </div>

        {/* Fixed footer — shows on every page */}
        <div className="op-print-footer">
          <b>Pragenses s.r.o.</b> | Lipnická 688, Praha 9 - Kyje, Czech Republic | IČO: 284 45 961 | DIČ: CZ284 45 961
        </div>

        {/* Cover page — full bleed, first page has margin: 0 */}
        <div className="op-cover-print">
          <img src={coverBase64} alt="" />
        </div>

        {/* Content */}
        <div className="op-content-print">
          <h2 style={{ marginTop: 0 }}>{offer.name}</h2>
          {createdDate && <p style={{ color: '#999' }}>Proposta elaborada em: {createdDate}</p>}
          {offer.destinations && <p><b>Destinos:</b> {offer.destinations}</p>}
          {(offer.startDate || offer.endDate) && <p><b>Período:</b> {fmtDate(offer.startDate)} {offer.endDate ? `a ${fmtDate(offer.endDate)}` : ''}</p>}

          {hotels.length > 0 && (
            <div className="op-section">
              <h2>Hotéis</h2>
              <ul>{hotels.map(h => <li key={h.id}><b>{h.city ? `${h.city}: ` : ''}{h.name || 'Hotel'}</b>{(h.dateFrom || h.dateTo) ? ` — ${fmtDate(h.dateFrom)} a ${fmtDate(h.dateTo)}` : ''}</li>)}</ul>
            </div>
          )}

          <div className="op-section">
            <h2>Investimento</h2>
            <p>Valores por pessoa. Inclui hotéis, taxas municipais, refeições e ingressos indicados, transporte e guias durante o roteiro.</p>
            {hasSplit ? splitData.map(({ cur, rows: sRows }) => (
              <div key={cur} style={{ marginBottom: 12 }}>
                <p style={{ fontWeight: 700, marginBottom: 4 }}>{CUR_FLAG[cur]} Serviços faturados em {cur}</p>
                <table className="op-table">
                  <thead><tr><th>Participantes</th><th>Quarto duplo</th><th>Quarto individual</th></tr></thead>
                  <tbody>{sRows.map(r => <tr key={r.pax}><td>{r.pax} + 1 cortesia</td><td className="op-final">{CUR_SYMBOL[cur]} {r.finalDbl.toFixed(2)}</td><td className="op-final">{CUR_SYMBOL[cur]} {r.finalSngl.toFixed(2)}</td></tr>)}</tbody>
                </table>
              </div>
            )) : (
              <table className="op-table">
                <thead><tr><th>Participantes</th><th>Quarto duplo</th><th>Quarto individual</th></tr></thead>
                <tbody>{rows.map(r => <tr key={r.pax}><td>{r.pax} + 1 cortesia</td><td className="op-final">€ {r.finalDbl.toFixed(2)}</td><td className="op-final">€ {r.finalSngl.toFixed(2)}</td></tr>)}</tbody>
              </table>
            )}
          </div>

          <div className="op-section">
            <h2>Incluído no preço</h2>
            <ul>
              {(offer.includedText || '').split('\n').filter(l => l.trim()).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
            <h3>Não incluído</h3>
            <ul>
              {(offer.notIncludedText || 'Voos internacionais e taxas de embarque\nBebidas e refeições não mencionadas\nGorjetas e despesas de caráter pessoal\nMaleteiros\nSeguro viagem').split('\n').filter(l => l.trim()).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </div>

          {programParagraphs.length > 0 && (
            <div className="op-section">
              <h2>Roteiro</h2>
              {programParagraphs.map((p, i) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</p>)}
            </div>
          )}

          <div style={{ marginTop: 24, textAlign: 'center' }}>
            <p style={{ fontWeight: 700 }}>Equipe Tour Pragenses</p>
            <p style={{ fontStyle: 'italic', color: '#666' }}>Seu parceiro na Europa.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
