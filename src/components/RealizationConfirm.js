import React, { useEffect, useState } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { isLockableVersion, soldFromVersion, soldSummary, fmtDate } from '../lib/realization';

// Okno „Klient potvrdil → Realizace“ (a „Změnit prodanou verzi“).
// Ukáže uložené verze nabídky (NR…) s jejich cenami; předvybraná je ta
// poslední. Nic nezapisuje — vybranou verzi předá do onConfirm(version).
export default function RealizationConfirm({ offer, mode, onClose, onConfirm, colors }) {
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

        {error && <div style={{ color: '#dc2626', fontSize: 13, marginTop: 10 }}>⚠ {error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onClose} style={{ ...btn('#64748b', false) }}>Zrušit</button>
          {versions && versions.length > 0 && (
            <button onClick={go} disabled={!chosen || busy || (mode === 'change' && chosen.id === currentId)}
              style={btn('#27500A', !chosen || busy || (mode === 'change' && chosen && chosen.id === currentId))}>
              {busy ? 'Ukládám…' : (mode === 'change' ? 'Změnit prodanou verzi' : 'Potvrdit a zamknout cenu')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
