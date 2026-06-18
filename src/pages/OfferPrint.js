import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc } from 'firebase/firestore';
import { DEFAULT_RATES, computeOfferPricing, evalAmount } from '../lib/offerCalc';
import coverBase64 from '../lib/coverBase64';
import watermarkBase64 from '../lib/watermarkBase64';
import logoBase64 from '../lib/logoBase64';

const ASSETS = process.env.PUBLIC_URL + '/offer-assets';
const SPLIT_CURRENCIES = ['CHF', 'GBP'];
const CUR_SYMBOL = { EUR: '€', CHF: 'CHF', GBP: '£' };
const CUR_FLAG = { EUR: '🇪🇺', CHF: '🇨🇭', GBP: '🇬🇧' };

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
      } catch (err) { console.error('Failed to fetch rates', err); }
    })();
  }, []);

  if (loading) return <div style={{ padding: 20 }}>Loading...</div>;
  if (!offer) return <div style={{ padding: 20 }}>Offer not found.</div>;

  const items = offer.items || [];
  const margin = offer.margin || 15;
  const paxList = offer.paxList || '15,20,25,30,35';
  const activeItems = items.filter(it => it.enabled !== false);
  const { rows } = computeOfferPricing(items, margin, paxList, rates);

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
    const sRows = paxCounts.map(pax => {
      const costDbl = groupTotal / pax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const focShare = perPaxDbl / pax;
      const finalDbl = costDbl + marginAmount + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, finalDbl, finalSngl };
    });
    return { cur, rows: sRows };
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
    const sRows = paxCounts.map(pax => {
      const costDbl = groupTotal / pax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const focShare = perPaxDbl / pax;
      const finalDbl = costDbl + marginAmount + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, finalDbl, finalSngl };
    });
    return { cur: 'EUR', rows: sRows };
  };

  const splitData = hasSplit
    ? [...activeCurrencies.map(c => computeByCurrency(c)), computeEurOnly()]
    : null;

  const hotels = activeItems.filter(it => it.type === 'per_pax' && it.subType === 'hotel');
  const programParagraphs = (offer.programText || '').split(/\n/).filter(p => p.trim());
  const createdDate = offer.createdAt ? new Date(offer.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';

  const includedLines = (offer.includedText || '').split('\n').filter(l => l.trim());
  const notIncludedLines = (offer.notIncludedText || 'Voos internacionais e taxas de embarque\nBebidas e refeições não mencionadas\nGorjetas e despesas de caráter pessoal\nMaleteiros\nSeguro viagem').split('\n').filter(l => l.trim());

  // Shared styles
  const HEADER_H = '28mm';
  const FOOTER_H = '16mm';
  const MARGIN_H = '18mm';
  const PAGE = { fontFamily: 'Arial, sans-serif', position: 'relative', width: '210mm', boxSizing: 'border-box', overflow: 'hidden', background: 'white' };
  const PAGE_FIXED = { ...PAGE, height: '297mm' };
  const CONTENT_STYLE = { padding: `4mm ${MARGIN_H} 0`, position: 'relative', zIndex: 1 };
  const P = { fontSize: 11, lineHeight: 1.6, color: '#222', margin: '4px 0 8px', fontFamily: 'Arial, sans-serif' };
  const UL = { fontSize: 11, lineHeight: 1.7, paddingLeft: 18, fontFamily: 'Arial, sans-serif', color: '#222' };

  const Watermark = () => (
    <img src={watermarkBase64} alt="" style={{ position: 'absolute', top: 0, right: 0, width: '55%', height: '100%', objectFit: 'cover', objectPosition: 'top right', opacity: 0.45, pointerEvents: 'none', zIndex: 0 }} />
  );

  const Header = () => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: `8mm ${MARGIN_H} 0`, height: HEADER_H, boxSizing: 'border-box', position: 'relative', zIndex: 1 }}>
      <div style={{ fontSize: 9, color: '#999', lineHeight: 1.6 }}>
        TOUR PRAGENSES<br />
        www.tour-pragenses.com<br />
        +420 777 079 997<br />
        info@tour-pragenses.com
      </div>
      <img src={logoBase64} alt="Tour Pragenses" style={{ height: 36, opacity: 0.6 }} />
    </div>
  );

  const Footer = () => (
    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: FOOTER_H, display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: '1px solid #eee', zIndex: 1 }}>
      <div style={{ fontSize: 9, color: '#999', textAlign: 'center' }}>
        <b>Pragenses s.r.o.</b> | Lipnická 688, Praha 9 - Kyje, Czech Republic | IČO: 284 45 961 | DIČ: CZ284 45 961
      </div>
    </div>
  );

  const H2 = ({ children, style }) => (
    <h2 style={{ color: '#c0392b', fontSize: 16, borderBottom: '2px solid #c0392b', paddingBottom: 4, marginTop: 20, marginBottom: 8, fontFamily: 'Arial, sans-serif', ...style }}>{children}</h2>
  );

  const TableInvestimento = ({ curLabel, symbol, tRows }) => (
    <div style={{ marginBottom: 16 }}>
      {curLabel && <div style={{ fontSize: 11, fontWeight: 700, color: '#1a3a5c', marginBottom: 4 }}>{curLabel}</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            {['Participantes', 'Quarto duplo (por pessoa)', 'Quarto individual (por pessoa)'].map(h => (
              <th key={h} style={{ background: '#1a3a5c', color: 'white', padding: '8px 10px', textAlign: h === 'Participantes' ? 'left' : 'right', fontFamily: 'Arial, sans-serif', fontSize: 11 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tRows.map((r, i) => (
            <tr key={r.pax} style={{ background: i % 2 === 0 ? 'white' : '#f5f5f5' }}>
              <td style={{ padding: '8px 10px', borderBottom: '1px solid #eee', fontSize: 12, fontFamily: 'Arial, sans-serif' }}>{r.pax} + 1 cortesia</td>
              <td style={{ padding: '8px 10px', borderBottom: '1px solid #eee', textAlign: 'right', fontWeight: 700, fontSize: 14, color: '#1a3a5c', fontFamily: 'Arial, sans-serif' }}>{symbol} {r.finalDbl.toFixed(2)}</td>
              <td style={{ padding: '8px 10px', borderBottom: '1px solid #eee', textAlign: 'right', fontWeight: 700, fontSize: 14, color: '#1a3a5c', fontFamily: 'Arial, sans-serif' }}>{symbol} {r.finalSngl.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // Helper to create a full A4 page with header/footer
  const Page = ({ children }) => (
    <div className="op-page" style={{ ...PAGE, minHeight: '297mm' }}>
      <Watermark />
      <Header />
      <div style={CONTENT_STYLE}>
        {children}
      </div>
      <div style={{ height: FOOTER_H }} />
      <Footer />
    </div>
  );

  // Split roteiro paragraphs into chunks that fit on a page (~25 paragraphs per page)
  const PARAS_PER_PAGE = 20;
  const roteiroParagraphs = programParagraphs;
  const roteiroPagesCount = Math.ceil(roteiroParagraphs.length / PARAS_PER_PAGE);
  const roteiroPages = Array.from({ length: roteiroPagesCount }, (_, i) =>
    roteiroParagraphs.slice(i * PARAS_PER_PAGE, (i + 1) * PARAS_PER_PAGE)
  );

  return (
    <div>
      <style>{`
        @media print {
          .op-no-print { display: none !important; }
          .app-sidebar { display: none !important; }
          .app-main { padding: 0 !important; background: white !important; }
          @page { size: A4; margin: 0; }
          .op-page { page-break-after: always; }
          .op-page:last-child { page-break-after: auto; }
          .op-avoid-break { page-break-inside: avoid; }
        }
        @media screen {
          .op-page { max-width: 210mm; margin: 0 auto 20px; box-shadow: 0 2px 16px rgba(0,0,0,0.15); }
        }
      `}</style>

      <div className="op-no-print" style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', padding: '16px', background: '#f7f6f3' }}>
        <button onClick={() => navigate('offer-detail', { offerId })} style={{ padding: '8px 16px', background: '#f7f6f3', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' }}>← Voltar</button>
        <button onClick={() => window.print()} style={{ padding: '8px 16px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>🖨️ Imprimir / Salvar PDF</button>
        {createdDate && <span style={{ fontSize: 12, color: colors.muted }}>Criado em: {createdDate}</span>}
      </div>

      {/* PAGE 1 — Cover */}
      <div className="op-page" style={{ ...PAGE_FIXED }}>
        <Watermark />
        <div style={{ position: 'relative', zIndex: 2 }}><Header /></div>
        <div style={{ position: 'relative', zIndex: 1, padding: `2mm ${MARGIN_H} 0`, height: `calc(297mm - ${HEADER_H} - ${FOOTER_H})`, overflow: 'hidden' }}>
          <img src={coverBase64} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
        <Footer />
      </div>

      {/* PAGE 2 — Hotéis + Investimento */}
      <Page>
        <H2 style={{ marginTop: 8 }}>{offer.name}</H2>
        {createdDate && <p style={{ ...P, color: '#999', fontSize: 10, marginTop: -4 }}>Proposta elaborada em: {createdDate}</p>}
        {offer.destinations && <p style={P}><b>Destinos:</b> {offer.destinations}</p>}
        {(offer.startDate || offer.endDate) && <p style={P}><b>Período:</b> {fmtDate(offer.startDate)}{offer.endDate ? ` a ${fmtDate(offer.endDate)}` : ''}</p>}

        {hotels.length > 0 && (
          <div className="op-avoid-break">
            <H2>Hotéis</H2>
            <ul style={UL}>
              {hotels.map(h => (
                <li key={h.id}><b>{h.city ? `${h.city}: ` : ''}{h.name || 'Hotel'}</b>{(h.dateFrom || h.dateTo) ? ` — ${fmtDate(h.dateFrom)} a ${fmtDate(h.dateTo)}` : ''}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="op-avoid-break">
          <H2>Investimento</H2>
          <p style={{ ...P, fontSize: 13, lineHeight: 1.4, marginBottom: 10 }}>
            Valores por pessoa. Inclui hotéis, taxas municipais, refeições e ingressos indicados, transporte e guias durante o roteiro. Pax gratis no quarto DBL.
          </p>
          {hasSplit ? splitData.map(({ cur, rows: sRows }) => (
            <TableInvestimento key={cur} curLabel={`${CUR_FLAG[cur]} Serviços faturados em ${cur}`} symbol={CUR_SYMBOL[cur]} tRows={sRows} />
          )) : (
            <TableInvestimento symbol="€" tRows={rows} />
          )}
        </div>
      </Page>

      {/* PAGE 3 — Incluído + Não incluído */}
      {(includedLines.length > 0 || notIncludedLines.length > 0) && (
        <Page>
          {includedLines.length > 0 && (
            <div>
              <H2>Incluído no preço</H2>
              <ul style={UL}>{includedLines.map((line, i) => <li key={i}>{line}</li>)}</ul>
            </div>
          )}
          {notIncludedLines.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <H2>Não incluído</H2>
              <ul style={UL}>{notIncludedLines.map((line, i) => <li key={i}>{line}</li>)}</ul>
            </div>
          )}
        </Page>
      )}

      {/* PAGE 4+ — Roteiro split into pages of 15 paragraphs */}
      {roteiroParagraphs.length > 0 && (() => {
        const CHUNK = 15;
        const pages = [];
        for (let i = 0; i < roteiroParagraphs.length; i += CHUNK) {
          pages.push(roteiroParagraphs.slice(i, i + CHUNK));
        }
        return pages.map((paras, pageIdx) => (
          <Page key={pageIdx}>
            {pageIdx === 0 && <H2>Roteiro</H2>}
            {paras.map((p, i) => <p key={i} style={{ ...P, whiteSpace: 'pre-wrap' }}>{p}</p>)}
            {pageIdx === pages.length - 1 && (
              <div style={{ marginTop: 24, textAlign: 'center', paddingBottom: 20 }}>
                <p style={{ ...P, fontWeight: 700 }}>Equipe Tour Pragenses</p>
                <p style={{ ...P, fontStyle: 'italic', color: '#666' }}>Seu parceiro na Europa.</p>
              </div>
            )}
          </Page>
        ));
      })()}

      {/* If no roteiro, add closing page */}
      {roteiroPages.length === 0 && (
        <Page>
          <div style={{ marginTop: 24, textAlign: 'center', paddingBottom: 20 }}>
            <p style={{ ...P, fontWeight: 700 }}>Equipe Tour Pragenses</p>
            <p style={{ ...P, fontStyle: 'italic', color: '#666' }}>Seu parceiro na Europa.</p>
          </div>
        </Page>
      )}
    </div>
  );
}
