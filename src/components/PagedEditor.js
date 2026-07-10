import React, { useRef, useEffect, useCallback, useState } from 'react';

// A4 at 96dpi scaled to fit screen
const PAGE_W = 680;
const PAGE_H = Math.round(PAGE_W * 297 / 210); // 965px
const MARGIN_TOP = 60;
const MARGIN_SIDE = 60;
const MARGIN_BOTTOM = 52;
const HEADER_H = 50;
const FOOTER_H = 36;
const CONTENT_H = PAGE_H - MARGIN_TOP - MARGIN_BOTTOM - HEADER_H - FOOTER_H;
const PAGE_BREAK_MARKER = '<!--PAGE_BREAK-->';

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

// Split HTML by PAGE_BREAK_MARKER into pages
function splitByMarkers(html) {
  return (html || '').split(PAGE_BREAK_MARKER).map(p => p.trim());
}

// Join pages back with marker
function joinPages(pages) {
  return pages.join(PAGE_BREAK_MARKER);
}

export default function PagedEditor({ value, onChange, colors }) {
  const logoSrc = process.env.PUBLIC_URL + '/offer-assets/logo.png';
  const [pages, setPages] = useState(() => splitByMarkers(value));
  const pageRefs = useRef([]);
  const isInternalUpdate = useRef(false);

  // Sync when value changes externally
  useEffect(() => {
    if (isInternalUpdate.current) { isInternalUpdate.current = false; return; }
    const newPages = splitByMarkers(value);
    setPages(newPages);
  }, [value]);

  // Update editor content when pages change
  useEffect(() => {
    pages.forEach((pageHtml, i) => {
      const el = pageRefs.current[i];
      if (el && el.innerHTML !== pageHtml) {
        el.innerHTML = pageHtml;
      }
    });
  }, [pages]);

  const handleInput = useCallback((pageIdx) => {
    const el = pageRefs.current[pageIdx];
    if (!el) return;
    const newPages = [...pages];
    newPages[pageIdx] = el.innerHTML;
    setPages(newPages);
    isInternalUpdate.current = true;
    onChange(joinPages(newPages));
  }, [pages, onChange]);

  const insertPageBreak = useCallback(() => {
    // Find which page has focus
    let focusedIdx = -1;
    for (let i = 0; i < pageRefs.current.length; i++) {
      if (pageRefs.current[i] && pageRefs.current[i].contains(document.activeElement)) {
        focusedIdx = i; break;
      }
      if (pageRefs.current[i] === document.activeElement) {
        focusedIdx = i; break;
      }
    }
    if (focusedIdx === -1) focusedIdx = pages.length - 1;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const el = pageRefs.current[focusedIdx];
    if (!el) return;

    // Get HTML before and after cursor
    const beforeRange = document.createRange();
    beforeRange.setStart(el, 0);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const afterRange = document.createRange();
    afterRange.setStart(range.endContainer, range.endOffset);
    afterRange.setEnd(el, el.childNodes.length);

    const div1 = document.createElement('div');
    div1.appendChild(beforeRange.cloneContents());
    const div2 = document.createElement('div');
    div2.appendChild(afterRange.cloneContents());

    const htmlBefore = div1.innerHTML.trim();
    const htmlAfter = div2.innerHTML.trim();

    const newPages = [...pages];
    newPages[focusedIdx] = htmlBefore;
    newPages.splice(focusedIdx + 1, 0, htmlAfter);
    setPages(newPages);
    isInternalUpdate.current = true;
    onChange(joinPages(newPages));

    // Focus next page after state update
    setTimeout(() => {
      const nextEl = pageRefs.current[focusedIdx + 1];
      if (nextEl) {
        nextEl.focus();
        const r = document.createRange();
        r.setStart(nextEl, 0);
        r.collapse(true);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
    }, 50);
  }, [pages, onChange]);

  const removePage = useCallback((pageIdx) => {
    if (pages.length <= 1) return;
    const newPages = [...pages];
    // Merge content with previous page
    if (pageIdx > 0) {
      newPages[pageIdx - 1] = (newPages[pageIdx - 1] + ' ' + newPages[pageIdx]).trim();
    }
    newPages.splice(pageIdx, 1);
    setPages(newPages);
    isInternalUpdate.current = true;
    onChange(joinPages(newPages));
  }, [pages, onChange]);

  return (
    <div style={{ background: '#e8e8e8', borderRadius: 8, padding: '16px 0 24px' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 16 }}>
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={insertPageBreak}
          style={{
            padding: '7px 16px', background: '#C0392B', color: 'white',
            border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12,
            fontFamily: 'inherit', fontWeight: 500,
          }}
        >
          ↵ Nová stránka (zlom na místě kurzoru)
        </button>
        <button
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => document.execCommand('bold')}
          style={{
            width: 32, height: 32, fontWeight: 700, background: 'white',
            border: '1px solid #ccc', borderRadius: 6, cursor: 'pointer',
          }}
        >B</button>
      </div>

      {/* Pages */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
        {pages.map((pageHtml, idx) => (
          <div key={idx} style={{ position: 'relative' }}>
            {/* Page number */}
            <div style={{ position: 'absolute', top: -18, left: 0, right: 0, textAlign: 'center', fontSize: 11, color: '#888' }}>
              Stránka {idx + 1} {pages.length > 1 && (
                <button
                  type="button"
                  onClick={() => removePage(idx)}
                  style={{ marginLeft: 8, fontSize: 10, color: '#C0392B', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  ✕ Sloučit s předchozí
                </button>
              )}
            </div>

            {/* A4 Page */}
            <div style={{
              width: PAGE_W, height: PAGE_H, background: 'white',
              boxShadow: '0 2px 16px rgba(0,0,0,0.18)',
              position: 'relative', fontFamily: 'Arial, sans-serif',
              border: '1px solid #ccc',
            }}>
              <PageHeader logoSrc={logoSrc} />

              {/* Content area */}
              <div
                ref={el => pageRefs.current[idx] = el}
                contentEditable
                suppressContentEditableWarning
                onInput={() => handleInput(idx)}
                style={{
                  position: 'absolute',
                  top: MARGIN_TOP + HEADER_H,
                  left: MARGIN_SIDE,
                  right: MARGIN_SIDE,
                  height: CONTENT_H,
                  fontSize: 11,
                  lineHeight: 1.6,
                  color: '#222',
                  outline: 'none',
                  overflowY: 'hidden',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  cursor: 'text',
                }}
              />

              {/* Overflow warning line */}
              <div style={{
                position: 'absolute',
                top: MARGIN_TOP + HEADER_H + CONTENT_H,
                left: 0, right: 0, height: 1,
                background: 'rgba(192,57,43,0.2)',
                pointerEvents: 'none', zIndex: 1,
              }} />

              <PageFooter />
            </div>

            {/* Page break indicator between pages */}
            {idx < pages.length - 1 && (
              <div style={{
                position: 'absolute', bottom: -19, left: 0, right: 0,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <div style={{ flex: 1, height: 1, background: '#C0392B', opacity: 0.4 }} />
                <span style={{ fontSize: 9, color: '#C0392B', whiteSpace: 'nowrap' }}>— zlom stránky —</span>
                <div style={{ flex: 1, height: 1, background: '#C0392B', opacity: 0.4 }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
