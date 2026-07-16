import React, { useState, useEffect, useCallback } from 'react';
import { db, storage } from '../lib/firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
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

export default function OfferPrint({ offerId, navigate, colors, isPublic = false }) {
  const [offer, setOffer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rates, setRates] = useState(DEFAULT_RATES);
  const [showVersionDialog, setShowVersionDialog] = useState(false);
  const [versionLabel, setVersionLabel] = useState('');
  const [savingVersion, setSavingVersion] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [versionError, setVersionError] = useState('');

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
  if (isPublic && !offer.publicShareEnabled) return <div style={{ padding: 20 }}>This link is no longer active.</div>;

  const items = offer.items || [];
  const margin = offer.margin || 15;
  const paxList = offer.paxList || '15,20,25,30,35';
  const activeItems = items.filter(it => it.enabled !== false);

  const focCountNum = parseInt(offer.focCount) || 1;
  const focType = offer.focType || 'dbl';

  const activeCurrencies = [...new Set(activeItems.map(it => it.currency))].filter(c => SPLIT_CURRENCIES.includes(c));
  const hasSplit = activeCurrencies.length > 0 && (offer.showSplit ?? false);
  const paxCounts = paxList.split(',').map(s => parseInt(s.trim())).filter(n => n > 0);

  // Shared toEUR helper
  const toEUR = (v, c) => c === 'EUR' ? v : v * (rates[c] || 1);
  const paxItemsAll = activeItems.filter(it => it.type === 'per_pax');
  const groupItemsAll = activeItems.filter(it => it.type === 'group');

  // Per-pax totals (ALL currencies → EUR) — same as OfferDetail's perPaxDblEUR/perPaxSnglEUR
  const getEffDbl = (it) => evalAmount(it.subType === 'hotel'
    ? (((evalAmount(it.pricePerNightDbl) + evalAmount(it.cityTax)) * (parseFloat(it.nights) || 0)) / 2)
    : it.costDbl);
  const getEffSngl = (it) => evalAmount(it.subType === 'hotel'
    ? ((evalAmount(it.pricePerNightSngl) + evalAmount(it.cityTaxSngl || it.cityTax)) * (parseFloat(it.nights) || 0))
    : (it.costSngl || it.costDbl));

  const perPaxDblAllEUR = paxItemsAll.reduce((sum, it) => sum + toEUR(getEffDbl(it), it.currency), 0);
  const perPaxSnglAllEUR = paxItemsAll.reduce((sum, it) => sum + toEUR(getEffSngl(it), it.currency), 0);
  // Hotels-only SNGL (for driver) — same as OfferDetail's hotelOnlySnglEUR
  const hotelOnlySnglEUR = paxItemsAll.filter(it => it.subType === 'hotel')
    .reduce((sum, it) => sum + toEUR(getEffSngl(it), it.currency), 0);

  // Guide/driver hotel cost functions — identical to OfferDetail
  const guideHotelItemsAll = groupItemsAll.filter(it => it.subType === 'guide_hotel');
  const driverHotelItemsAll = groupItemsAll.filter(it => it.subType === 'driver_hotel');
  const regularGroupItemsAll = groupItemsAll.filter(it => it.subType !== 'guide_hotel' && it.subType !== 'driver_hotel');

  const getGuideHotelCostAll = (it) => {
    if (it.guideOverride !== '' && it.guideOverride !== undefined && it.guideOverride !== null)
      return toEUR(evalAmount(it.guideOverride), it.currency || 'EUR');
    return perPaxSnglAllEUR; // hotels + tickets SNGL, all converted to EUR
  };
  const getDriverHotelCostAll = (it) => {
    if (it.guideOverride !== '' && it.guideOverride !== undefined && it.guideOverride !== null)
      return toEUR(evalAmount(it.guideOverride), it.currency || 'EUR');
    return hotelOnlySnglEUR; // hotels only SNGL, no tickets
  };

  const regularGroupTotalAllEUR = regularGroupItemsAll.reduce((sum, it) => sum + toEUR(evalAmount(it.groupCost), it.currency), 0);
  const guideHotelTotalAllEUR = guideHotelItemsAll.reduce((sum, it) => sum + getGuideHotelCostAll(it), 0);
  const driverHotelTotalAllEUR = driverHotelItemsAll.reduce((sum, it) => sum + getDriverHotelCostAll(it), 0);
  const groupTotalAllEUR = regularGroupTotalAllEUR + guideHotelTotalAllEUR + driverHotelTotalAllEUR;

  // computeAllCombinedEUR — for non-split view (all currencies → EUR)
  // Identical logic to OfferDetail's non-split calculation
  const computeAllCombinedEUR = () => {
    const snglSupp = perPaxSnglAllEUR - perPaxDblAllEUR;
    const focPool = focType === 'sngl' ? perPaxSnglAllEUR : perPaxDblAllEUR;
    const sRows = paxCounts.map(pax => {
      const costDbl = groupTotalAllEUR / pax + perPaxDblAllEUR;
      const marginAmount = costDbl * (margin / 100);
      const focShare = (focPool * focCountNum) / pax;
      const finalDbl = costDbl + marginAmount + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, finalDbl, finalSngl };
    });
    return { cur: 'EUR', rows: sRows };
  };

  // computeByCurrency — for split view (one currency at a time, no EUR conversion)
  const computeByCurrency = (cur) => {
    const curPaxItems = paxItemsAll.filter(it => it.currency === cur);
    const curGroupItems = regularGroupItemsAll.filter(it => it.currency === cur);
    const perPaxDbl = curPaxItems.reduce((sum, it) => sum + getEffDbl(it), 0);
    const perPaxSngl = curPaxItems.reduce((sum, it) => sum + getEffSngl(it), 0);
    const groupTotal = curGroupItems.reduce((sum, it) => sum + evalAmount(it.groupCost), 0);
    const snglSupp = perPaxSngl - perPaxDbl;
    const focPool = focType === 'sngl' ? perPaxSngl : perPaxDbl;
    const sRows = paxCounts.map(pax => {
      const costDbl = groupTotal / pax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const focShare = (focPool * focCountNum) / pax;
      const finalDbl = costDbl + marginAmount + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, finalDbl, finalSngl };
    });
    return { cur, perPaxDbl, perPaxSngl, groupTotal, snglSupp, rows: sRows };
  };

  // computeEurOnly — for split view EUR part (EUR-only items + guide/driver hotel)
  const computeEurOnly = () => {
    const eurPaxItems = paxItemsAll.filter(it => !SPLIT_CURRENCIES.includes(it.currency));
    const eurGroupItems = regularGroupItemsAll.filter(it => !SPLIT_CURRENCIES.includes(it.currency));
    const perPaxDbl = eurPaxItems.reduce((sum, it) => sum + toEUR(getEffDbl(it), it.currency), 0);
    const perPaxSngl = eurPaxItems.reduce((sum, it) => sum + toEUR(getEffSngl(it), it.currency), 0);
    // EUR part of regular group + ALL guide/driver hotel costs (they are always in EUR)
    const groupTotal = eurGroupItems.reduce((sum, it) => sum + toEUR(evalAmount(it.groupCost), it.currency), 0)
      + guideHotelTotalAllEUR + driverHotelTotalAllEUR;
    const snglSupp = perPaxSngl - perPaxDbl;
    const focPool = focType === 'sngl' ? perPaxSngl : perPaxDbl;
    const sRows = paxCounts.map(pax => {
      const costDbl = groupTotal / pax + perPaxDbl;
      const marginAmount = costDbl * (margin / 100);
      const focShare = (focPool * focCountNum) / pax;
      const finalDbl = costDbl + marginAmount + focShare;
      const finalSngl = finalDbl + snglSupp;
      return { pax, finalDbl, finalSngl };
    });
    return { cur: 'EUR', perPaxDbl, perPaxSngl, groupTotal, snglSupp, rows: sRows };
  };

  const splitData = hasSplit
    ? [...activeCurrencies.map(c => computeByCurrency(c)), computeEurOnly()]
    : null;
  const rows = computeAllCombinedEUR().rows;

  const hotels = activeItems.filter(it => it.type === 'per_pax' && it.subType === 'hotel');
  // programText may contain HTML (rich text editor) or plain text with \n
  const programParagraphs = (() => {
    const html = offer.programText || '';
    if (!html.trim()) return [];
    // First try HTML splitting (contentEditable creates <div> per line in Chrome)
    const htmlParts = html
      .split(/<div>|<\/div>|<br\s*\/?>/i)
      .map(p => p.trim())
      .filter(p => p && p !== '&nbsp;');
    if (htmlParts.length > 3) return htmlParts;
    // Fallback: plain text with \n (Safari/Firefox contentEditable or copy-pasted text)
    const stripped = html.replace(/<[^>]+>/g, '');
    const plainParts = stripped
      .split(/\n+/)
      .map(p => p.trim())
      .filter(p => p);
    if (plainParts.length > 3) return plainParts;
    // Last resort: split on a day-marker that always starts a new paragraph — the
    // 📅 emoji style, the "Nº DIA –" style (e.g. "2º DIA – 20/05/2027 – FRANKFURT"), or the
    // "DD Mmm (Wkday) -" style (e.g. "22 Jul (Qui) - EDIMBURGO"). The (?<!\d) guard stops
    // two-digit days like "10º DIA" or "22 Jul" from being mis-split between their digits.
    const dayParts = stripped.split(/(?=📅|(?<!\d)\d{1,2}º\s*DIA\s*[–-]|(?<!\d)\d{1,2}\s+[A-Za-zÀ-ÿ]{3}\s+\([A-Za-zÀ-ÿ]{3}\)\s*-)/i).map(p => p.trim()).filter(p => p);
    return dayParts.length > 0 ? dayParts : [html];
  })();
  const createdDate = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const versions = offer.pdfVersions || [];

  const loadHtml2Pdf = () => new Promise((resolve, reject) => {
    if (window.html2pdf) { resolve(window.html2pdf); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    s.onload = () => resolve(window.html2pdf);
    s.onerror = reject;
    document.head.appendChild(s);
  });

  const handleSaveVersion = async () => {
    if (!versionLabel.trim()) { setVersionError('Digite um número/label para esta versão (ex: NR 3).'); return; }
    setSavingVersion(true);
    setVersionError('');
    try {
      const html2pdf = await loadHtml2Pdf();
      // Find the print-only content element to render
      const printEl = document.querySelector('.op-print-only') || document.querySelector('.op-page');
      const opt = {
        margin: 0,
        filename: `${(offer.name || 'oferta').replace(/[^a-z0-9]/gi, '_')}_${versionLabel.replace(/[^a-z0-9]/gi, '_')}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] }
      };
      const worker = html2pdf().set(opt).from(printEl);
      const pdfBlob = await worker.outputPdf('blob');

      const fileName = `offers/${offerId}/${Date.now()}_${versionLabel.replace(/[^a-z0-9]/gi, '_')}.pdf`;
      const fileRef = storageRef(storage, fileName);
      await uploadBytes(fileRef, pdfBlob, { contentType: 'application/pdf' });
      const url = await getDownloadURL(fileRef);

      const newVersion = {
        label: versionLabel.trim(),
        url,
        path: fileName,
        savedAt: new Date().toISOString(),
      };
      const newVersions = [...versions, newVersion];
      await updateDoc(doc(db, 'offers', offerId), { pdfVersions: newVersions });
      setOffer(prev => ({ ...prev, pdfVersions: newVersions }));
      setShowVersionDialog(false);
      setVersionLabel('');
    } catch (err) {
      console.error(err);
      setVersionError('Erro ao salvar versão: ' + err.message);
    }
    setSavingVersion(false);
  };


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

  const Watermark = () => null; // screen watermark handled per-page below

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
              <td style={{ padding: '8px 10px', borderBottom: '1px solid #eee', fontSize: 12, fontFamily: 'Arial, sans-serif' }}>{r.pax} + {focCountNum} cortesia</td>
              <td style={{ padding: '8px 10px', borderBottom: '1px solid #eee', textAlign: 'right', fontWeight: 700, fontSize: 14, color: '#1a3a5c', fontFamily: 'Arial, sans-serif' }}>{symbol} {r.finalDbl.toFixed(2)}</td>
              <td style={{ padding: '8px 10px', borderBottom: '1px solid #eee', textAlign: 'right', fontWeight: 700, fontSize: 14, color: '#1a3a5c', fontFamily: 'Arial, sans-serif' }}>{symbol} {r.finalSngl.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const ScreenWatermark = () => (
    <img src={watermarkBase64} alt="" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', opacity: 0.65, pointerEvents: 'none', zIndex: 0 }} />
  );

  // Helper to create a full A4 page with header/footer
  const Page = ({ children }) => (
    <div className="op-page" style={{ ...PAGE, minHeight: '297mm', position: 'relative', overflow: 'hidden' }}>
      <ScreenWatermark />
      <div style={{ position: 'relative', zIndex: 2 }}><Header /></div>
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
          .op-watermark-print {
            display: none !important;
          }
        }
        @media screen {
          .op-page { max-width: 210mm; margin: 0 auto 20px; box-shadow: 0 2px 16px rgba(0,0,0,0.15); }
        }
      `}</style>

      <style>{`
        @media print {
          .op-wm { display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; object-fit: cover !important; object-position: center !important; opacity: 0.65 !important; z-index: -1 !important; pointer-events: none !important; }
          .op-wm-screen { display: none !important; }
        }
        @media screen {
          .op-wm { display: none !important; }
        }
      `}</style>

      <div className="op-no-print" style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', padding: '16px', background: '#f7f6f3', flexWrap: 'wrap' }}>
        {!isPublic && <button onClick={() => navigate('offer-detail', { offerId })} style={{ padding: '8px 16px', background: '#f7f6f3', border: `1px solid ${colors.border}`, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit' }}>← Voltar</button>}
        <button onClick={() => window.print()} style={{ padding: '8px 16px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>🖨️ Imprimir</button>
        <button onClick={async () => {
          setDownloadingPdf(true);
          try {
            const payload = {
              name: offer.name || '',
              startDate: offer.startDate || '',
              endDate: offer.endDate || '',
              destinations: offer.destinations || '',
              focType: offer.focType || 'dbl',
              items: (() => {
                const enabledOnly = (offer.items || []).filter(it => it.enabled !== false && it.enabled !== 'false');
                // Remove hotel items with no name at all (incomplete entries)
                const withNames = enabledOnly.filter(it => it.subType !== 'hotel' || (it.name && it.name.trim()));
                // Also remove exact duplicate hotel entries (same name+city+dates) in case
                // the offer data itself contains accidental duplicates.
                const seen = new Set();
                return withNames.filter(it => {
                  if (it.subType !== 'hotel') return true;
                  const key = [it.city, it.name, it.dateFrom, it.dateTo].join('|');
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
              })(),
              pricingData: hasSplit ? { splitData } : { singleData: null },
              includedLines: offer.includedText || '',
              notIncludedLines: offer.notIncludedText || '',
              programText: offer.programText || '',
            };
            const res = await fetch('https://tour-pragenses.com/offer_pdf_api.php', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });
            if (!res.ok) {
              const errText = await res.text();
              throw new Error('Erro do servidor: ' + errText.slice(0, 200));
            }
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (offer.name || 'oferta').replace(/[^a-zA-Z0-9]/g, '_') + '.pdf';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
          } catch (err) {
            alert('Erro ao gerar PDF: ' + err.message);
          }
          setDownloadingPdf(false);
        }} disabled={downloadingPdf} style={{ padding: '8px 16px', background: '#854f0b', color: '#fff', border: 'none', borderRadius: 7, cursor: downloadingPdf ? 'default' : 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
          {downloadingPdf ? '⏳ Gerando...' : '⬇ Gerar PDF (novo)'}
        </button>
        {!isPublic && <button onClick={() => { setVersionLabel(''); setVersionError(''); setShowVersionDialog(true); }} style={{ padding: '8px 16px', background: '#27500A', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>📌 Salvar versão (NR)</button>}
        {!isPublic && createdDate && <span style={{ fontSize: 12, color: colors.muted }}>Criado em: {createdDate}</span>}
      </div>

      {!isPublic && versions.length > 0 && (
        <div className="op-no-print" style={{ margin: '0 16px 16px', padding: '14px 16px', background: '#fff', border: `1px solid ${colors.border}`, borderRadius: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: colors.primary, marginBottom: 8 }}>📁 Versões salvas</div>
          {versions.slice().reverse().map((v, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: i < versions.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
              <span style={{ fontWeight: 600, fontSize: 13 }}>{v.label}</span>
              <span style={{ fontSize: 12, color: colors.muted }}>{new Date(v.savedAt).toLocaleString('pt-BR')}</span>
              <a href={v.url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 'auto', fontSize: 12, color: colors.primary, textDecoration: 'underline' }}>📥 Abrir / Baixar</a>
            </div>
          ))}
        </div>
      )}

      {!isPublic && showVersionDialog && (
        <div className="op-no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: '2rem', width: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>📌 Salvar esta versão do PDF</div>
            <div style={{ fontSize: 13, color: colors.muted, marginBottom: 16 }}>Digite o número/identificação desta proposta (ex: NR 3, v2, Final). O PDF exato será salvo e poderá ser reaberto depois.</div>
            <input type="text" value={versionLabel} onChange={e => { setVersionLabel(e.target.value); setVersionError(''); }}
              placeholder="ex: NR 3" autoFocus
              style={{ width: '100%', padding: '10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 15, boxSizing: 'border-box', marginBottom: 8, fontFamily: 'inherit' }} />
            {versionError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{versionError}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleSaveVersion} disabled={savingVersion} style={{ flex: 1, padding: '10px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontWeight: 600, opacity: savingVersion ? 0.6 : 1 }}>
                {savingVersion ? 'Salvando...' : 'Salvar'}
              </button>
              <button onClick={() => setShowVersionDialog(false)} disabled={savingVersion} style={{ flex: 1, padding: '10px', background: '#f7f6f3', color: colors.text, border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, cursor: 'pointer' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Fixed watermark for print — shows on every page */}
      <img src={watermarkBase64} alt="" className="op-wm" style={{ display: 'none' }} />

      {/* PAGE 1 — Cover */}
      <div className="op-page" style={{ ...PAGE_FIXED }}>
        <ScreenWatermark />
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
            Valores por pessoa. Inclui hotéis, taxas municipais, refeições e ingressos indicados, transporte e guias durante o roteiro. Pax gratis no quarto {focType.toUpperCase()}.
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

      {/* PAGE 4+ — Roteiro split into pages of 25 paragraphs */}
      {roteiroParagraphs.length > 0 && (() => {
        const CHUNK = 25;
        const pages = [];
        for (let i = 0; i < roteiroParagraphs.length; i += CHUNK) {
          pages.push(roteiroParagraphs.slice(i, i + CHUNK));
        }
        return pages.map((paras, pageIdx) => (
          <Page key={pageIdx}>
            {pageIdx === 0 && <H2>Roteiro</H2>}
            {paras.map((p, i) => <p key={i} style={{ ...P, whiteSpace: 'pre-wrap' }} dangerouslySetInnerHTML={{ __html: p }} />)}
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
// BUILD_1782348416
