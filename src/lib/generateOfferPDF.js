import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';
pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts;

const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  if (!y || !m || !day) return d;
  return `${day}/${m}/${y}`;
};

const RED = '#C0392B';
const GRAY = '#555555';
const LIGHT_GRAY = '#999999';

// Convert HTML-stripped paragraph text to pdfmake content
const paraToContent = (html) => {
  const text = html.replace(/<[^>]+>/g, '').trim();
  if (!text) return null;
  return { text, fontSize: 10, color: '#222', margin: [0, 0, 0, 6], lineHeight: 1.5 };
};

export async function generateOfferPDF(offer, programParagraphs, hotelItems, pricingRows, hasSplit, splitData, includedLines, notIncludedLines, rates) {
  // Load images as base64
  const loadImage = async (url) => {
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    } catch { return null; }
  };

  const baseUrl = process.env.PUBLIC_URL + '/offer-assets';
  const [logoData, watermarkData, coverData] = await Promise.all([
    loadImage(baseUrl + '/logo.png'),
    loadImage(baseUrl + '/watermark.png'),
    loadImage(baseUrl + '/cover.png'),
  ]);

  const CUR_SYMBOL = { EUR: '€', CHF: 'CHF', GBP: '£' };
  const CUR_FLAG = { EUR: '🇪🇺', CHF: '🇨🇭', GBP: '🇬🇧' };

  // Header definition — repeated on every page
  const headerDef = (currentPage, pageCount) => {
    if (currentPage === 1) return null; // cover page has no header
    return {
      columns: [
        {
          stack: [
            { text: 'TOUR PRAGENSES', fontSize: 8, bold: true, color: '#222' },
            { text: 'www.tour-pragenses.com', fontSize: 7, color: GRAY },
            { text: '+420 777 079 997', fontSize: 7, color: GRAY },
            { text: 'info@tour-pragenses.com', fontSize: 7, color: GRAY },
          ],
          margin: [18, 10, 0, 0],
        },
        logoData ? {
          image: logoData,
          width: 60,
          alignment: 'right',
          margin: [0, 8, 18, 0],
        } : { text: '' },
      ],
    };
  };

  // Footer definition — repeated on every page
  const footerDef = (currentPage, pageCount) => ({
    columns: [
      {
        text: 'Pragenses s.r.o. | Lipnická 688, Praha 9 - Kyje, Czech Republic | IČO: 284 45 961 | DIČ: CZ284 45 961',
        fontSize: 7,
        color: GRAY,
        alignment: 'center',
        margin: [18, 0, 18, 8],
      }
    ],
    margin: [0, 4, 0, 0],
    decoration: 'overline' // gives a top border look
  });

  // Build content
  const content = [];

  // --- PAGE 1: Cover ---
  if (coverData) {
    content.push({
      image: coverData,
      width: 595 - 2 * 18, // A4 width minus margins
      pageBreak: 'after',
    });
  }

  // --- PAGE 2: Offer summary + pricing ---
  content.push(
    { text: offer.name || '', fontSize: 16, bold: true, color: RED, margin: [0, 0, 0, 4] },
    { text: `Proposta elaborada em: ${new Date().toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}`, fontSize: 9, color: GRAY, margin: [0, 0, 0, 8] },
  );
  if (offer.destinations) content.push({ text: [{ text: 'Destinos: ', bold: true }, offer.destinations], fontSize: 10, margin: [0, 0, 0, 4] });
  if (offer.startDate || offer.endDate) content.push({ text: [{ text: 'Período: ', bold: true }, `${fmtDate(offer.startDate)}${offer.endDate ? ` a ${fmtDate(offer.endDate)}` : ''}`], fontSize: 10, margin: [0, 0, 0, 12] });

  // Hotels list
  if (hotelItems && hotelItems.length > 0) {
    content.push({ text: 'Hotéis', fontSize: 13, bold: true, color: RED, decoration: 'underline', margin: [0, 0, 0, 8] });
    hotelItems.forEach(h => {
      content.push({
        text: [
          { text: `${h.city || ''}: `, bold: true },
          { text: h.name || '' },
          h.dateFrom ? { text: ` — ${fmtDate(h.dateFrom)}${h.dateTo ? ` a ${fmtDate(h.dateTo)}` : ''}`, color: GRAY } : '',
        ],
        fontSize: 10,
        margin: [0, 0, 0, 3],
        bullet: true,
      });
    });
    content.push({ text: '', margin: [0, 0, 0, 12] });
  }

  // Pricing — Investimento
  content.push({ text: 'Investimento', fontSize: 13, bold: true, color: RED, decoration: 'underline', margin: [0, 0, 0, 8] });
  content.push({
    text: `Valores por pessoa. Inclui hotéis, taxas municipais, refeições e ingressos indicados, transporte e guias durante o roteiro. Pax gratis no quarto ${(offer.focType || 'DBL').toUpperCase()}.`,
    fontSize: 10, margin: [0, 0, 0, 10],
  });

  const buildPricingTable = (label, symbol, rows) => {
    const tableBody = [
      [
        { text: 'Participantes', fontSize: 9, bold: true, fillColor: '#f5f5f5', color: GRAY },
        { text: 'Quarto duplo (por pessoa)', fontSize: 9, bold: true, fillColor: '#f5f5f5', color: GRAY, alignment: 'center' },
        { text: 'Quarto individual (por pessoa)', fontSize: 9, bold: true, fillColor: '#f5f5f5', color: GRAY, alignment: 'center' },
      ],
      ...rows.map(r => ([
        { text: `${r.pax} + 1 cortesia`, fontSize: 10 },
        { text: `${symbol} ${r.finalDbl.toFixed(2)}`, fontSize: 10, bold: true, alignment: 'center' },
        { text: `${symbol} ${r.finalSngl.toFixed(2)}`, fontSize: 10, bold: true, alignment: 'center' },
      ])),
    ];
    return [
      { text: label, fontSize: 10, bold: true, color: '#333', margin: [0, 6, 0, 4] },
      {
        table: { headerRows: 1, widths: ['*', '*', '*'], body: tableBody },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 12],
      },
    ];
  };

  if (hasSplit && splitData) {
    splitData.forEach(({ cur, rows }) => {
      const flag = cur === 'EUR' ? '🇪🇺' : cur === 'CHF' ? '🇨🇭' : '🇬🇧';
      buildPricingTable(`${flag} Serviços faturados em ${cur}`, CUR_SYMBOL[cur] || cur, rows)
        .forEach(item => content.push(item));
    });
  } else if (pricingRows) {
    buildPricingTable('', offer.currency === 'GBP' ? '£' : offer.currency === 'CHF' ? 'CHF' : '€', pricingRows)
      .forEach(item => content.push(item));
  }

  content.push({ text: '', pageBreak: 'after' });

  // --- PAGE 3: Incluído / Não incluído ---
  if (includedLines.length > 0 || notIncludedLines.length > 0) {
    if (includedLines.length > 0) {
      content.push({ text: 'Incluído no preço', fontSize: 13, bold: true, color: RED, decoration: 'underline', margin: [0, 0, 0, 8] });
      content.push({ ul: includedLines, fontSize: 10, margin: [0, 0, 0, 12] });
    }
    if (notIncludedLines.length > 0) {
      content.push({ text: 'Não incluído', fontSize: 13, bold: true, color: RED, decoration: 'underline', margin: [0, 0, 0, 8] });
      content.push({ ul: notIncludedLines, fontSize: 10, margin: [0, 0, 0, 12] });
    }
    content.push({ text: '', pageBreak: 'after' });
  }

  // --- PAGES 4+: Roteiro ---
  if (programParagraphs.length > 0) {
    content.push({ text: 'Roteiro', fontSize: 13, bold: true, color: RED, decoration: 'underline', margin: [0, 0, 0, 12] });
    programParagraphs.forEach(para => {
      const item = paraToContent(para);
      if (item) content.push(item);
    });
    content.push(
      { text: '', margin: [0, 16, 0, 0] },
      { text: 'Equipe Tour Pragenses', fontSize: 11, bold: true, alignment: 'center' },
      { text: 'Seu parceiro na Europa.', fontSize: 10, italics: true, color: GRAY, alignment: 'center' },
    );
  }

  // Document definition
  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [51, 70, 51, 50], // left, top, right, bottom (in points, ~18mm)
    header: headerDef,
    footer: footerDef,
    background: watermarkData ? (currentPage) => {
      if (currentPage === 1) return null;
      return {
        image: watermarkData,
        width: 595,
        height: 842,
        absolutePosition: { x: 0, y: 0 },
        opacity: 0.06,
      };
    } : undefined,
    content,
    defaultStyle: { font: 'Roboto', fontSize: 11 },
    styles: {
      header: { fontSize: 8, color: GRAY },
    },
  };

  const filename = `${(offer.name || 'oferta').replace(/[^a-z0-9]/gi, '_')}.pdf`;
  pdfMake.createPdf(docDefinition).download(filename);
}
