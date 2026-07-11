import React, { useRef, useEffect, useCallback, useState } from 'react';

const PAGE_W = 680;
const PAGE_H = Math.round(PAGE_W * 297 / 210);
const MARGIN_TOP = 60;
const MARGIN_SIDE = 60;
const MARGIN_BOTTOM = 52;
const HEADER_H = 50;
const FOOTER_H = 36;
const CONTENT_H = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM - HEADER_H - FOOTER_H;

function PageHeader({ logoSrc }) {
  return (
    <div style={{
      position: 'absolute', top: MARGIN_TOP, left: MARGIN_SIDE, right: MARGIN_SIDE,
      height: HEADER_H, display: 'flex', justifyContent: 'space-between',
      alignItems: 'flex-start', borderBottom: '1px solid #ddd', paddingBottom: 4,
      pointerEvents: 'none', zIndex: 2, background: 'white',
    }}>
      <div style={{ fontSize: 7.5, color: '#555', lineHeight: 1.5 }}>
        <div style={{ fontWeight: 700 }}>TOUR PRAGENSES</div>
        <div>www.tour-pragenses.com</div>
        <div>+420 777 079 997</div>
        <div>info@tour-pragenses.com</div>
      </div>
      <img src={logoSrc} alt="logo" style={{ height: 28, objectFit: 'contain' }}
        onError={e => e.target.style.display = 'none'} />
    </div>
  );
}

function PageFooter() {
  return (
    <div style={{
      position: 'absolute', bottom: MARGIN_BOTTOM, left: MARGIN_SIDE, right: MARGIN_SIDE,
      height: FOOTER_H, display: 'flex', alignItems: 'center', justifyContent: 'center',
      borderTop: '1px solid #ddd', pointerEvents: 'none', zIndex: 2, background: 'white',
    }}>
      <span style={{ fontSize: 7, color: '#555', textAlign: 'center' }}>
        Pragenses s.r.o. | Lipnická 688, Praha 9 - Kyje, Czech Republic | IČO: 284 45 961 | DIČ: CZ284 45 961
      </span>
    </div>
  );
}

export default function PagedEditor({ value, onChange, colors }) {
  const logoSrc = process.env.PUBLIC_URL + '/offer-assets/logo.png';
  const [pages, setPages] = useState(['']);
  const measureRef = useRef(null);
  const editRef = useRef(null);
  const reflowTimer = useRef(null);
  const contentWidth = PAGE_W - 2 * MARGIN_SIDE;

  const reflow = useCallback((html) => {
    if (!measureRef.current) return;
    const el = measureRef.current;
    el.innerHTML = html || '';

    const nodes = Array.from(el.childNodes);
    const pageContents = [];
    let currentNodes = [];
    let currentH = 0;

    // Measure each node individually
    for (const node of nodes) {
      // Measure by temporarily isolating
      el.innerHTML = '';
      const clone = node.cloneNode(true);
      el.appendChild(clone);
      const h = el.scrollHeight || 20;

      el.innerHTML = html || ''; // restore for next measurement

      if (currentH + h > CONTENT_H && currentNodes.length > 0) {
        pageContents.push(currentNodes);
        currentNodes = [];
        currentH = 0;
      }
      currentNodes.push({ html: clone.outerHTML || (node.textContent || ''), height: h });
      currentH += h;
    }
    if (currentNodes.length > 0 || pageContents.length === 0) {
      pageContents.push(currentNodes);
    }

    setPages(pageContents.map(p => p.map(n => n.html).join('')));
  }, [contentWidth]);

  // Initial reflow and reflow on value change
  useEffect(() => {
    if (editRef.current && editRef.current.innerHTML !== value) {
      editRef.current.innerHTML = value || '';
    }
    reflow(value || '');
  }, [value]); // eslint-disable-line

  const handleInput = useCallback(() => {
    if (!editRef.current) return;
    const html = editRef.current.innerHTML;
    onChange(html);
    if (reflowTimer.current) clearTimeout(reflowTimer.current);
    reflowTimer.current = setTimeout(() => reflow(html), 500);
  }, [onChange, reflow]);

  return (
    <div style={{ background: '#e8e8e8', borderRadius: 8, padding: '16px 0 24px' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap', padding: '0 16px' }}>
        <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => document.execCommand('bold')}
          style={{ width: 32, height: 32, fontWeight: 700, background: 'white', border: '1px solid #ccc', borderRadius: 6, cursor: 'pointer' }}>B</button>
        <span style={{ fontSize: 11, color: '#666', alignSelf: 'center' }}>
          Náhled stránek se aktualizuje automaticky po úpravě
        </span>
      </div>

      {/* Hidden measurement div */}
      <div ref={measureRef} style={{
        position: 'fixed', top: -9999, left: -9999,
        width: contentWidth, fontFamily: 'Arial, sans-serif',
        fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', visibility: 'hidden',
      }} />

      {/* Page previews */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, marginBottom: 24 }}>
        {pages.map((pageHtml, idx) => (
          <div key={idx} style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', top: -18, left: 0, right: 0, textAlign: 'center', fontSize: 11, color: '#888' }}>
              Stránka {idx + 1} / {pages.length}
            </div>
            <div style={{
              width: PAGE_W, height: PAGE_H, background: 'white',
              boxShadow: '0 2px 16px rgba(0,0,0,0.18)', position: 'relative',
              fontFamily: 'Arial, sans-serif', border: '1px solid #ccc',
            }}>
              <PageHeader logoSrc={logoSrc} />
              <div dangerouslySetInnerHTML={{ __html: pageHtml }} style={{
                position: 'absolute', top: MARGIN_TOP + HEADER_H,
                left: MARGIN_SIDE, right: MARGIN_SIDE, height: CONTENT_H,
                fontSize: 11, lineHeight: 1.6, color: '#222',
                overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                pointerEvents: 'none',
              }} />
              <PageFooter />
            </div>
            {idx < pages.length - 1 && (
              <div style={{ position: 'absolute', bottom: -20, left: 0, right: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 1, background: '#C0392B', opacity: 0.3 }} />
                <span style={{ fontSize: 9, color: '#C0392B', whiteSpace: 'nowrap' }}>— zlom stránky —</span>
                <div style={{ flex: 1, height: 1, background: '#C0392B', opacity: 0.3 }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Editable area */}
      <div style={{ padding: '0 20px' }}>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 6, textAlign: 'center' }}>
          ✏️ Edituj text níže — náhled stránek výše se aktualizuje automaticky
        </div>
        <div
          ref={editRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          style={{
            width: '100%', minHeight: 300, padding: '12px 16px',
            border: '2px solid #C0392B', borderRadius: 8, background: 'white',
            fontFamily: 'Arial, sans-serif', fontSize: 11, lineHeight: 1.6,
            color: '#222', outline: 'none', whiteSpace: 'pre-wrap',
            boxSizing: 'border-box',
          }}
        />
      </div>
    </div>
  );
}
