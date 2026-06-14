import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { DEFAULT_RATES, computeOfferPricing } from '../lib/offerCalc';

const ASSETS = process.env.PUBLIC_URL + '/offer-assets';

const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
};

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
  const { rows, perPaxDblEUR, perPaxSnglEUR, snglSupplementEUR } = computeOfferPricing(items, margin, paxList, rates);

  const hotels = items.filter(it => it.type === 'per_pax' && it.subType === 'hotel');
  const programParagraphs = (offer.programText || '').split(/\n\s*\n/).filter(p => p.trim());

  return (
    <div>
      <style>{`
        @media print {
          .op-no-print { display: none !important; }
          @page { size: A4; margin: 32mm 18mm 22mm 18mm; }
          .op-cover { page-break-after: always; }
          .op-section { page-break-inside: avoid; }
        }
        @media screen {
          .op-page-frame { max-width: 800px; margin: 0 auto 24px; background: #fff; box-shadow: 0 0 12px rgba(0,0,0,0.12); padding: 32mm 18mm 22mm 18mm; box-sizing: border-box; position: relative; min-height: 1000px; }
        }
        .op-header { position: fixed; top: 8mm; left: 18mm; right: 18mm; display: flex; justify-content: space-between; align-items: flex-start; font-family: Arial, sans-serif; font-size: 9px; color: #999; line-height: 1.5; }
        .op-header img { height: 32px; opacity: 0.55; }
        .op-footer { position: fixed; bottom: 8mm; left: 18mm; right: 18mm; text-align: center; font-family: Arial, sans-serif; font-size: 9px; color: #999; }
        .op-watermark { position: fixed; bottom: 0; right: 0; width: 320px; max-width: 45vw; pointer-events: none; z-index: -1; }
        .op-cover-img { width: 100%; }
        .op-content h2 { color: #1a3a5c; font-size: 16px; border-bottom: 2px solid #c8a84b; padding-bottom: 4px; margin-top: 26px; }
        .op-content h3 { color: #1a3a5c; font-size: 13px; margin: 14px 0 4px; }
        .op-content p { font-size: 12px; line-height: 1.6; color: #222; margin: 4px 0 10px; }
        .op-content ul { font-size: 12px; line-height: 1.5; padding-left: 18px; }
        .op-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 8px; }
        .op-table th, .op-table td { border: 1px solid #ddd; padding: 5px 7px; text-align: right; }
        .op-table th:first-child, .op-table td:first-child { text-align: left; }
        .op-table th { background: #1a3a5c; color: #fff; font-weight: 600; }
        .op-table tr:nth-child(even) td { background: #f7f6f3; }
        .op-final { font-weight: 700; color: #1a3a5c; }
      `}</style>

      <div className="op-no-print" style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button onClick={() => navigate('offer-detail', { offerId })} style={{ padding: '8px 16px', background: '#f7f6f3', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' }}>← Voltar</button>
        <button onClick={() => window.print()} style={{ padding: '8px 16px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>🖨️ Imprimir / Salvar PDF</button>
      </div>

      {/* Fixed elements repeat on every printed page */}
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
      <img className="op-watermark" src={`${ASSETS}/watermark.png`} alt="" />

      {/* Cover page */}
      <div className="op-page-frame op-cover">
        <img className="op-cover-img" src={`${ASSETS}/cover.png`} alt="Tour Pragenses — Seu parceiro na Europa" />
      </div>

      {/* Content page(s) */}
      <div className="op-page-frame op-content">
        <h2 style={{ marginTop: 0, color: '#0c447c', fontSize: 20 }}>{offer.name}</h2>
        {offer.destinations && <p><b>Destinos:</b> {offer.destinations}</p>}
        {(offer.startDate || offer.endDate) && <p><b>Período:</b> {fmtDate(offer.startDate)} {offer.endDate ? `a ${fmtDate(offer.endDate)}` : ''}</p>}

        {hotels.length > 0 && (
          <>
            <h2>Hotéis</h2>
            <ul>
              {hotels.map(h => (
                <li key={h.id}>
                  <b>{h.name || 'Hotel'}</b>{(h.dateFrom || h.dateTo) ? ` — ${fmtDate(h.dateFrom)} a ${fmtDate(h.dateTo)}` : ''}
                </li>
              ))}
            </ul>
          </>
        )}

        {programParagraphs.length > 0 && (
          <div className="op-section">
            <h2>Roteiro</h2>
            {programParagraphs.map((p, i) => <p key={i} style={{ whiteSpace: 'pre-wrap' }}>{p}</p>)}
          </div>
        )}

        <div className="op-section">
          <h2>Investimento</h2>
          <p style={{ fontSize: 11, color: '#666' }}>
            Valores por pessoa, em EUR. Inclui hotéis, taxas municipais, refeições e ingressos indicados, transporte e guias durante o roteiro.
          </p>
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
          {rows.length === 0 && <p style={{ color: '#999' }}>Nenhum valor calculado — verifique os itens e o número de participantes na nabídka.</p>}
          <p style={{ fontSize: 10, color: '#999', marginTop: 10 }}>
            Custo base por pessoa (DBL): € {perPaxDblEUR.toFixed(2)} · (SNGL): € {perPaxSnglEUR.toFixed(2)} · Suplemento individual: € {snglSupplementEUR.toFixed(2)}
          </p>
        </div>

        <div className="op-section" style={{ marginTop: 24, textAlign: 'center' }}>
          <p style={{ fontWeight: 700 }}>Equipe Tour Pragenses</p>
          <p style={{ fontStyle: 'italic', color: '#666' }}>Seu parceiro na Europa.</p>
        </div>
      </div>
    </div>
  );
}
