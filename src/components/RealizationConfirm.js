import React, { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { isLockableVersion, soldFromVersion, soldSummary, fmtDate } from '../lib/realization';
import { checkBeforeRealization } from '../lib/realizationCheck';

// Okno „Klient potvrdil → Realizace“ (a „Změnit prodanou verzi“).
// Ukáže uložené verze nabídky (NR…) s jejich cenami; předvybraná je ta
// poslední. Pod verzemi je kontrola před převodem (verze vs. nabídka, hotely,
// program, služby) — jen upozorní, nic neblokuje. Nic nezapisuje — vybranou
// verzi předá do onConfirm(version).
export default function RealizationConfirm({ offer, mode, onClose, onConfirm, getCurrentSnapshot, colors }) {
  const [versions, setVersions] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'offerVersions'), where('offerId', '==', offer.id)));
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(isLockableVersion)
          .sort((a, b) => ((b.versionNo || 0) - (a.versionNo || 0)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        if (off) return;
        setVersions(list);
        const current = offer.realization && offer.realization.soldVersionId;
        setPick(list.length ? (mode === 'change' && current && list[0].id === current && list[1] ? list[1].id : list[0].id) : '');
      } catch (e) {
        if (!off) { setError('Verze se nepodařilo načíst: ' + (e.message || e)); setVersions([]); }
      }
    })();
    return () => { off = true; };
  }, [offer.id, offer.realization, mode]);

  const chosen = (versions || []).find(v => v.id === pick);
  const currentId = offer.realization && offer.realization.soldVersionId;

  const checks = useMemo(() => {
    if (!chosen) return [];
    try {
      return checkBeforeRealization({ offer, version: chosen, currentSnapshot: getCurrentSnapshot ? getCurrentSnapshot() : null });
    } catch (e) {
      console.error('Kontrola před převodem selhala:', e);
      return [{ level: 'warn', title: 'Kontrolu se nepodařilo provést: ' + (e.message || e), details: [] }];
    }
  }, [chosen]);
  const nStop = checks.filter(c => c.level === 'stop').length;
  const nWarn = checks.filter(c => c.level === 'warn').length;
  const [openCheck, setOpenCheck] = useState({});

  const go = async () => {
    if (!chosen) return;
    setBusy(true); setError('');
    try { await onConfirm(chosen); } catch (e) { setError('Uložení se nepovedlo: ' + (e.message || e)); setBusy(false); }
  };

  const btn = (bg, disabled) => ({ padding: '8px 18px', background: bg, color: '#fff', border: 'none', borderRadius: 7, fontSize: 14, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', fontWeight: 600, opacity: disabled ? 0.5 : 1 });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: colors.white, borderRadius: 12, padding: '1.25rem 1.5rem', width: 'min(640px, 100%)', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: colors.primary, marginBottom: 6 }}>
          {mode === 'change' ? 'Změnit prodanou verzi' : '✓ Klient potvrdil → Realizace'}
        </div>
        <div style={{ fontSize: 13, color: colors.muted, lineHeight: 1.5, marginBottom: 12 }}>
          Vyberte verzi, kterou klient přijal. Její ceny se <b>zamknou</b> jako prodejní cena pro klienta —
          pozdější úpravy nabídky ani kurz je nezmění, projeví se jen v nákladech a zisku.
        </div>

        {versions === null && <div style={{ fontSize: 13, color: colors.muted }}>Načítám verze…</div>}

        {versions && versions.length === 0 && !error && (
          <div style={{ fontSize: 13, background: '#FFF7ED', border: '1px solid #fdba74', color: '#9a3412', borderRadius: 8, padding: '10px 12px', lineHeight: 1.5 }}>
            <b>Nejdřív uložte verzi, kterou klient přijal.</b><br />
            Klikněte v nabídce na „⬇ Gerar PDF (novo)“ nebo „🖨️ Imprimir“ a zvolte uložení jako verze (NR).
            Pak „Klient potvrdil“ otevřete znovu.
          </div>
        )}

        {versions && versions.length > 0 && (
          <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden' }}>
            {versions.map(v => {
              const sold = soldFromVersion(v);
              return (
                <label key={v.id} style={{ display: 'flex', gap: 10, padding: '9px 12px', borderTop: `1px solid ${colors.border}`, cursor: 'pointer', background: pick === v.id ? '#EAF3DE' : 'transparent', fontSize: 13 }}>
                  <input type="radio" name="soldVersion" checked={pick === v.id} onChange={() => setPick(v.id)} style={{ marginTop: 3 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, wordBreak: 'break-word' }}>
                      {v.fileName || `NR${v.versionNo}`}
                      {v.id === currentId && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#27500A' }}>● teď prodaná</span>}
                    </div>
                    <div style={{ color: colors.muted, fontSize: 12 }}>Uloženo {fmtDate(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ''}</div>
                    <div style={{ marginTop: 2 }}>{soldSummary(sold)}</div>
                    {sold.checkMismatch && <div style={{ color: '#c2410c', fontSize: 12 }}>⚠ U této verze nesouhlasila kontrola mezisoučtů — ceny zkontrolujte.</div>}
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {chosen && checks.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: colors.primary, marginBottom: 6 }}>
              Kontrola před převodem{' '}
              <span style={{ fontSize: 12, fontWeight: 600, color: nStop ? '#b91c1c' : nWarn ? '#c2410c' : '#27500A' }}>
                {nStop ? `⛔ ${nStop}  ` : ''}{nWarn ? `⚠ ${nWarn}` : ''}{!nStop && !nWarn ? '✅ vše v pořádku' : ''}
              </span>
            </div>
            <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden' }}>
              {checks.map((c, i) => {
                const icon = c.level === 'stop' ? '⛔' : c.level === 'warn' ? '⚠' : '✅';
                const col = c.level === 'stop' ? '#b91c1c' : c.level === 'warn' ? '#9a3412' : '#27500A';
                const bg = c.level === 'stop' ? '#FEF2F2' : c.level === 'warn' ? '#FFF7ED' : 'transparent';
                const open = openCheck[i] ?? (c.level !== 'ok');
                return (
                  <div key={i} style={{ borderTop: i ? `1px solid ${colors.border}` : 'none', background: bg, padding: '7px 12px', fontSize: 13 }}>
                    <div onClick={() => c.details.length && setOpenCheck(o => ({ ...o, [i]: !open }))}
                      style={{ color: col, fontWeight: 600, cursor: c.details.length ? 'pointer' : 'default' }}>
                      {icon} {c.title}{c.details.length ? <span style={{ fontWeight: 400, color: colors.muted }}> {open ? '▾' : '▸'}</span> : null}
                    </div>
                    {open && c.details.length > 0 && (
                      <div style={{ marginTop: 3, paddingLeft: 22, color: colors.text, fontSize: 12, lineHeight: 1.5 }}>
                        {c.details.map((d, j) => <div key={j}>{d}</div>)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {(nStop > 0 || nWarn > 0) && (
              <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>
                Kontrola jen upozorňuje — potvrdit jde i tak, když víte, že je to v pořádku.
              </div>
            )}
          </div>
        )}

        {error && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 10 }}>⚠ {error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={{ ...btn('#64748b', false) }}>Zrušit</button>
          {versions && versions.length > 0 && (
            <button onClick={go} disabled={!chosen || busy || (mode === 'change' && chosen.id === currentId)}
              style={btn(nStop || nWarn ? '#c2410c' : '#27500A', !chosen || busy || (mode === 'change' && chosen && chosen.id === currentId))}>
              {busy ? 'Ukládám…' : (nStop || nWarn ? 'Přesto potvrdit' : (mode === 'change' ? 'Změnit prodanou verzi' : 'Potvrdit a zamknout cenu'))}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
