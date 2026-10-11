import React, { useEffect, useMemo, useRef, useState } from 'react';
import { db, storage, auth } from '../lib/firebase';
import {
  DATA_PARTS, FILE_PARTS, scanSystem, createBackup, verifyBackup,
  formatBytes, backupFileName,
} from '../lib/backup';

// Okno „Kompletní záloha“.
// 1) Zjistí, co v systému je (data + seznam souborů s velikostmi) — nic nestahuje.
// 2) Ukáže seznam k odškrtání s počty a velikostmi.
// 3) Vytvoří ZIP, sám ho zkontroluje a uloží na disk počítače:
//    – Chrome/Edge: okno „Uložit jako“ (vyberete složku),
//    – Safari/Brave/ostatní: do složky Stažené soubory.
// Nic v databázi ani v úložišti nemění.

const canPickLocation = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
const nf = (n) => Number(n || 0).toLocaleString('cs-CZ');

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

export default function BackupDialog({ onClose, colors }) {
  const [stage, setStage] = useState('scanning'); // scanning | choose | running | done | error
  const [progress, setProgress] = useState('');
  const [pct, setPct] = useState(null);
  const [scan, setScan] = useState(null);
  const [selected, setSelected] = useState(() => new Set([...DATA_PARTS.filter(p => !p.defaultOff).map(p => p.key), ...FILE_PARTS.map(p => p.key)]));
  const [result, setResult] = useState(null);   // { blob, manifest, fileName, savedTo }
  const [error, setError] = useState('');
  const abortRef = useRef(null);

  const runScan = async () => {
    setStage('scanning'); setError(''); setPct(null);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const s = await scanSystem({
        db, storage, signal: ac.signal,
        onProgress: (p) => {
          if (p.phase === 'data') setProgress(`Načítám data — ${p.label} (celkem ${nf(p.docsDone)} záznamů)…`);
          else if (p.phase === 'files-list') setProgress('Zjišťuji seznam souborů v úložišti…');
          else if (p.phase === 'files-meta') { setProgress(`Zjišťuji velikosti souborů — ${nf(p.done)} z ${nf(p.total)}…`); setPct(p.total ? p.done / p.total : null); }
        },
      });
      setScan(s); setStage('choose');
    } catch (e) {
      if (e && e.name === 'AbortError') { onClose(); return; }
      console.error(e);
      setError('Nepodařilo se načíst přehled: ' + (e.message || e)); setStage('error');
    }
  };

  useEffect(() => { runScan(); return () => abortRef.current && abortRef.current.abort(); }, []);

  const rows = useMemo(() => {
    if (!scan) return { data: [], files: [] };
    return {
      data: DATA_PARTS.map(p => ({ ...p, count: scan.parts[p.key].total, bytes: scan.parts[p.key].bytes })),
      files: FILE_PARTS.map(g => ({ ...g, count: scan.fileGroups[g.key].count, bytes: scan.fileGroups[g.key].bytes })),
    };
  }, [scan]);

  const totalBytes = [...rows.data, ...rows.files].filter(r => selected.has(r.key)).reduce((s, r) => s + r.bytes, 0);
  const allNormal = [...DATA_PARTS.filter(p => !p.defaultOff), ...FILE_PARTS].map(p => p.key);
  const isPartial = !allNormal.every(k => selected.has(k));

  const toggle = (k) => setSelected(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const selectAll = () => setSelected(prev => { const n = new Set(prev); allNormal.forEach(k => n.add(k)); return n; });
  const selectNone = () => setSelected(new Set());

  const start = async () => {
    // V Chrome se nejdřív zeptáme, kam uložit (musí to být hned po kliknutí).
    let handle = null;
    if (canPickLocation()) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: backupFileName(new Date(), isPartial),
          types: [{ description: 'Záloha (ZIP)', accept: { 'application/zip': ['.zip'] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') return; // uživatel okno zavřel → zůstáváme u výběru
        handle = null; // okno nejde otevřít → uloží se do Stažených souborů
      }
    }
    setStage('running'); setError(''); setPct(0);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const res = await createBackup({
        storage, scan, selected, signal: ac.signal,
        user: (auth.currentUser && auth.currentUser.email) || '',
        onProgress: (p) => {
          if (p.phase === 'zip-data') { setProgress(`Ukládám data — ${p.label}…`); setPct(0.02); }
          else if (p.phase === 'files') { setProgress(`Stahuji soubory — ${nf(p.done)} z ${nf(p.total)} (${formatBytes(p.doneBytes)} z ${formatBytes(p.totalBytes)})`); setPct(p.totalBytes ? 0.05 + 0.8 * (p.doneBytes / p.totalBytes) : 0.85); }
          else if (p.phase === 'finish') { setProgress('Dokončuji soubor zálohy…'); setPct(0.86); }
        },
      });
      setProgress('Kontroluji hotovou zálohu (otevírám ji znovu a ověřuji každý soubor)…');
      const ver = await verifyBackup(res.blob, { onProgress: (p) => setPct(0.87 + 0.1 * (p.total ? p.done / p.total : 1)) });
      if (!ver.ok) {
        setError('Kontrola zálohy našla chyby — záloha NEBYLA uložena. Zkuste to prosím znovu.\n' + ver.problems.slice(0, 10).join('\n'));
        setStage('error'); return;
      }
      let savedTo = '';
      if (handle) {
        setProgress('Ukládám na disk…'); setPct(0.98);
        try {
          const w = await handle.createWritable();
          await w.write(res.blob); await w.close();
          savedTo = `do zvolené složky jako „${handle.name}“`;
        } catch (e) {
          console.error(e);
          savedTo = ''; // nepovedlo se → nabídneme tlačítko pro stažení
        }
      }
      setResult({ ...res, savedTo, entries: ver.entries });
      setPct(1); setStage('done');
    } catch (e) {
      if (e && e.name === 'AbortError') { setStage('choose'); setProgress(''); return; }
      console.error(e);
      setError('Zálohu se nepodařilo vytvořit: ' + (e.message || e)); setStage('error');
    }
  };

  const saveToDownloads = () => {
    downloadBlob(result.blob, result.fileName);
    setResult(r => ({ ...r, savedTo: `do složky Stažené soubory (Downloads) jako „${r.fileName}“` }));
  };

  const busy = stage === 'scanning' || stage === 'running';
  const btn = (bg, fg = colors.white) => ({ padding: '9px 18px', background: bg, color: fg, border: bg === colors.white ? `1px solid ${colors.border}` : 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 });

  const Row = ({ r }) => (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 4px', borderBottom: `1px solid ${colors.border}`, cursor: 'pointer' }}>
      <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} style={{ marginTop: 3, width: 16, height: 16 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: r.sensitive ? colors.warning : colors.text, fontWeight: 500 }}>{r.sensitive ? '⚠ ' : ''}{r.label}</div>
        {r.hint && <div style={{ fontSize: 12, color: colors.muted, lineHeight: 1.4 }}>{r.hint}</div>}
      </div>
      <div style={{ fontSize: 12, color: colors.muted, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {r.count ? <>{nf(r.count)} {r.group === 'files' ? 'souborů' : 'záznamů'}<br />{formatBytes(r.bytes)}</> : 'prázdné'}
      </div>
    </label>
  );

  return (
    <div onClick={busy ? undefined : onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: colors.white, borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' }}>
        <div style={{ padding: '1.1rem 1.5rem', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: colors.primary, flex: 1 }}>💾 Kompletní záloha</div>
          {!busy && <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: colors.muted }}>×</button>}
        </div>

        <div style={{ padding: '1rem 1.5rem', overflowY: 'auto', flex: 1 }}>
          {busy && (
            <div style={{ padding: '1.5rem 0' }}>
              <div style={{ fontSize: 14, color: colors.text, marginBottom: 12 }}>{progress || 'Pracuji…'}</div>
              <div style={{ height: 8, background: colors.bg, borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: pct == null ? '30%' : `${Math.round(pct * 100)}%`, background: colors.success, transition: 'width .3s' }} />
              </div>
              <div style={{ fontSize: 12, color: colors.muted, marginTop: 10 }}>Okno nechte otevřené. Ostatní mohou v aplikaci dál pracovat.</div>
            </div>
          )}

          {stage === 'choose' && scan && (
            <>
              <div style={{ fontSize: 13, color: colors.muted, marginBottom: 10, lineHeight: 1.5 }}>
                Vyberte, co se má zálohovat. Stav dat k {new Date(scan.at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}.
                Poznámky, úkoly, Realizace a zálohy dodavatelům jsou součástí záznamů, ukládají se s nimi.
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button onClick={selectAll} style={{ ...btn(colors.white, colors.text), padding: '5px 12px', fontSize: 13 }}>Vybrat vše</button>
                <button onClick={selectNone} style={{ ...btn(colors.white, colors.text), padding: '5px 12px', fontSize: 13 }}>Zrušit vše</button>
                <button onClick={runScan} style={{ ...btn(colors.white, colors.text), padding: '5px 12px', fontSize: 13, marginLeft: 'auto' }}>↻ Načíst znovu</button>
              </div>
              <div style={{ fontSize: 12, fontWeight: 600, color: colors.primary, margin: '12px 0 2px', textTransform: 'uppercase', letterSpacing: '.04em' }}>Data</div>
              {rows.data.map(r => <Row key={r.key} r={{ ...r, group: 'data' }} />)}
              <div style={{ fontSize: 12, fontWeight: 600, color: colors.primary, margin: '16px 0 2px', textTransform: 'uppercase', letterSpacing: '.04em' }}>Soubory</div>
              {rows.files.map(r => <Row key={r.key} r={{ ...r, group: 'files' }} />)}

              {(scan.listError || scan.missing.length > 0) && (
                <div style={{ marginTop: 12, padding: '10px 12px', background: '#fdf6e9', border: '1px solid #f0d9a8', borderRadius: 8, fontSize: 12, color: colors.warning, lineHeight: 1.5 }}>
                  {scan.listError && <div>⚠ Úložiště nedovolilo vypsat seznam všech souborů — zálohují se soubory, na které odkazují záznamy ({nf(scan.files.length)}). Nepropojené staré soubory se mohou vynechat.</div>}
                  {scan.missing.length > 0 && <div>⚠ {nf(scan.missing.length)} odkazů vede na soubory, které už v úložišti nejsou (byly dřív smazány). Budou uvedeny v soupisu zálohy.</div>}
                </div>
              )}
            </>
          )}

          {stage === 'done' && result && (
            <div style={{ padding: '0.5rem 0' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: colors.success, marginBottom: 8 }}>✓ Záloha je hotová a zkontrolovaná</div>
              <div style={{ fontSize: 13, color: colors.text, lineHeight: 1.7 }}>
                Soubor: <b>{result.fileName}</b><br />
                Velikost: {formatBytes(result.blob.size)}<br />
                Záznamů: {nf(result.manifest.parts.filter(p => p.included).reduce((s, p) => s + p.total, 0))} · souborů: {nf(result.manifest.files.length)}<br />
                {result.manifest.complete ? 'Záloha je úplná.' : 'Záloha je částečná (jen vybrané části).'}
              </div>
              {result.manifest.failedFiles.length > 0 && (
                <div style={{ marginTop: 10, padding: '10px 12px', background: '#fdecec', border: '1px solid #f3c2c2', borderRadius: 8, fontSize: 12, color: colors.danger, lineHeight: 1.5 }}>
                  ⚠ {nf(result.manifest.failedFiles.length)} souborů se nepodařilo zálohovat ani na třetí pokus:
                  <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>{result.manifest.failedFiles.slice(0, 8).map(f => <li key={f.path}>{f.path.split('/').pop()} — {f.error}</li>)}</ul>
                  Zbytek zálohy je v pořádku. Zkuste zálohu za chvíli zopakovat.
                </div>
              )}
              {result.savedTo ? (
                <div style={{ marginTop: 14, fontSize: 13, color: colors.success }}>Uloženo {result.savedTo}.</div>
              ) : (
                <div style={{ marginTop: 14 }}>
                  <button onClick={saveToDownloads} style={btn(colors.success)}>⬇ Uložit zálohu do počítače</button>
                  <div style={{ fontSize: 12, color: colors.muted, marginTop: 6 }}>Uloží se do složky Stažené soubory (Downloads).</div>
                </div>
              )}
              {result.savedTo && <div style={{ fontSize: 12, color: colors.muted, marginTop: 8 }}>Doporučení: kopii zálohy si dejte i na OneDrive.</div>}
            </div>
          )}

          {stage === 'error' && (
            <div style={{ padding: '1rem 0', fontSize: 13, color: colors.danger, whiteSpace: 'pre-wrap' }}>❌ {error}</div>
          )}
        </div>

        <div style={{ padding: '0.9rem 1.5rem', borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {stage === 'choose' && (
            <>
              <div style={{ fontSize: 12, color: colors.muted, flex: 1, minWidth: 200 }}>
                Celkem cca <b style={{ color: colors.text }}>{formatBytes(totalBytes)}</b>
                {' · '}{canPickLocation() ? 'po kliknutí vyberete, kam na disk zálohu uložit' : 'uloží se do složky Stažené soubory'}
              </div>
              <button onClick={onClose} style={btn(colors.white, colors.text)}>Zrušit</button>
              <button onClick={start} disabled={selected.size === 0} style={{ ...btn('#27500A'), opacity: selected.size === 0 ? 0.5 : 1 }}>💾 Zálohovat vybrané</button>
            </>
          )}
          {busy && <button onClick={() => abortRef.current && abortRef.current.abort()} style={{ ...btn(colors.white, colors.text), marginLeft: 'auto' }}>Přerušit</button>}
          {stage === 'done' && <button onClick={onClose} style={{ ...btn(colors.primary), marginLeft: 'auto' }}>Zavřít</button>}
          {stage === 'error' && (
            <>
              <button onClick={onClose} style={{ ...btn(colors.white, colors.text), marginLeft: 'auto' }}>Zavřít</button>
              <button onClick={scan ? () => setStage('choose') : runScan} style={btn(colors.primary)}>Zkusit znovu</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
