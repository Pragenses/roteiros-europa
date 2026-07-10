import React, { useRef, useEffect, useCallback } from 'react';

// A4 at screen resolution: 680px wide, proportional height
const PAGE_W = 680;
const PAGE_H = Math.round(PAGE_W * 297 / 210); // ~965px
const MARGIN_TOP = 72;
const MARGIN_SIDE = 60;
const MARGIN_BOTTOM = 56;
const HEADER_H = 48;
const FOOTER_H = 36;
const CONTENT_H = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM - HEADER_H - FOOTER_H;

export default function PagedEditor({ value, onChange, colors }) {
  const editorRef = useRef(null);
  const logoSrc = process.env.PUBLIC_URL + '/offer-assets/logo.png';

  // When value changes externally, update editor content
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== value) {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
      editorRef.current.innerHTML = value || '';
      // Restore cursor if possible
      if (range) {
        try { sel.removeAllRanges(); sel.addRange(range); } catch(e) {}
      }
    }
  }, [value]);

  const handleInput = useCallback((e) => {
    onChange(e.currentTarget.innerHTML);
  }, [onChange]);

  const contentTop = MARGIN_TOP + HEADER_H;
  const contentBottom = MARGIN_BOTTOM + FOOTER_H;
  const overflowLineTop = contentTop + CONTENT_H;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 0 24px', background: '#f0f0f0', borderRadius: 8 }}>
      {/* A4 page */}
      <div style={{
        width: PAGE_W,
        height: PAGE_H,
        background: 'white',
        boxShadow: '0 2px 20px rgba(0,0,0,0.18)',
        position: 'relative',
        flexShrink: 0,
        fontFamily: 'Arial, sans-serif',
      }}>
        {/* HEADER */}
        <div style={{
          position: 'absolute',
          top: MARGIN_TOP,
          left: MARGIN_SIDE,
          right: MARGIN_SIDE,
          height: HEADER_H,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          borderBottom: '1px solid #eee',
          paddingBottom: 6,
          pointerEvents: 'none',
          zIndex: 2,
        }}>
          <div style={{ fontSize: 7.5, color: '#555', lineHeight: 1.5 }}>
            <div style={{ fontWeight: 700 }}>TOUR PRAGENSES</div>
            <div>www.tour-pragenses.com</div>
            <div>+420 777 079 997</div>
            <div>info@tour-pragenses.com</div>
          </div>
          <img src={logoSrc} alt="logo" style={{ height: 28, objectFit: 'contain' }} onError={e => e.target.style.display='none'} />
        </div>

        {/* EDITABLE CONTENT AREA */}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          style={{
            position: 'absolute',
            top: contentTop,
            left: MARGIN_SIDE,
            right: MARGIN_SIDE,
            bottom: contentBottom,
            fontSize: 11,
            lineHeight: 1.6,
            color: '#222',
            outline: 'none',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        />

        {/* RED LINE = page break position */}
        <div style={{
          position: 'absolute',
          top: overflowLineTop,
          left: 0,
          right: 0,
          height: 1,
          background: 'rgba(192,57,43,0.25)',
          pointerEvents: 'none',
          zIndex: 3,
        }} />

        {/* FOOTER */}
        <div style={{
          position: 'absolute',
          bottom: MARGIN_BOTTOM,
          left: MARGIN_SIDE,
          right: MARGIN_SIDE,
          height: FOOTER_H,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderTop: '1px solid #eee',
          pointerEvents: 'none',
          zIndex: 2,
        }}>
          <span style={{ fontSize: 7, color: '#555', textAlign: 'center' }}>
            Pragenses s.r.o. | Lipnická 688, Praha 9 - Kyje, Czech Republic | IČO: 284 45 961 | DIČ: CZ284 45 961
          </span>
        </div>
      </div>

      <div style={{ fontSize: 11, color: '#888', marginTop: 10, textAlign: 'center' }}>
        🔴 červená čára = konec stránky v PDF &nbsp;|&nbsp; text pod čárou přejde na další stránku
      </div>
    </div>
  );
}
