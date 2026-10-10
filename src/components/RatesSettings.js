import React, { useEffect, useState } from 'react';
import { RATE_CURRENCIES, ratesState, loadRatesDoc, refreshFromEcb, setManualRate, takeEcbRate, setLocked } from '../lib/rates';

// Nastavení → „💱 Kurzy měn“. Jedno místo pro kurzy celé aplikace.
// Krok 1+2 (10. 10. 2026): jen přehled a nastavení — výpočty v nabídkách
// tuto tabulku zatím NEPOUŽÍVAJÍ (přepnou se až v dalším kroku).

const fmtD = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const fmtDay = (s) => { const t = String(s || '').slice(0, 10); if (t.length < 10) return t; const [y, m, d] = t.split('-'); return `${d}.${m}.${y}`; };
const num = (n, d = 4) => (Number(n) || 0).toLocaleString('cs-CZ', { minimumFractionDigits: d, maximumFractionDigits: d });
const SOURCE = { default: 'výchozí z programu', ecb: 'ECB (středový)', manual: 'ručně' };

export default function RatesSettings({ colors, canEdit }) {
  const [data, setData] = useState(undefined);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [edit, setEdit] = useState({}); // cur -> text
  const [showHist, setShowHist] = useState(false);

  useEffect(() => { loadRatesDoc().then(d => setData(d)).catch(e => { setMsg('❌ Kurzy se nepodařilo načíst: ' + (e.message || e)); setData(null); }); }, []);

  const run = async (key, fn, okText) => {
    setBusy(key); setMsg('');
    try { const d = await fn(); setData(d); if (okText) setMsg('✓ ' + okText); }
    catch (e) { setMsg('❌ ' + (e.message || e)); }
    setBusy('');
  };

  if (data === undefined) return null;
  const st = ratesState(data);
  const ecb = st.ecb;
  const btn = (bg, fg = '#fff', border = 'none') => ({ padding: '3px 9px', background: bg, color: fg, border, borderRadius: 5, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' });
  const th = { padding: '6px 8px', fontSize: 11, textAlign: 'left', color: colors.muted, textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: `1px solid ${colors.border}` };
  const td = { padding: '7px 8px', fontSize: 13, borderBottom: `1px solid ${colors.border}`, verticalAlign: 'middle' };

  return (
    <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', maxWidth: 1000, marginTop: '1.5rem' }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: 8 }}>💱 Kurzy měn (→ EUR)</div>
      <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1rem', lineHeight: 1.5 }}>
        Jedno místo pro kurzy celé aplikace. Částky se nikdy nepřepisují do jiné měny — kurz slouží jen k převodu na EUR pro zobrazení a součet.
        Uložené verze nabídek (NR) a zamčené ceny v Realizaci se změnou kurzu nemění.<br />
        <b>Zatím jen přehled:</b> nabídky, PDF, zakázky a Realizace tuto tabulku začnou používat až v dalším kroku.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        {canEdit && (
          <button onClick={() => run('ecb', () => refreshFromEcb(data), 'Načteny dnešní kurzy ECB. Odemčené měny se aktualizovaly, zamčené zůstaly beze změny.')}
            disabled={!!busy} style={{ ...btn(colors.primary), padding: '8px 16px', fontSize: 14, opacity: busy ? 0.6 : 1 }}>
            {busy === 'ecb' ? 'Načítám…' : '🔄 Načíst dnešní kurzy (ECB)'}
          </button>
        )}
        <span style={{ fontSize: 12, color: colors.muted }}>
          {ecb ? <>Kurzy ECB z {fmtDay(ecb.date)} · načteno {fmtD(ecb.loadedAt)}{ecb.loadedBy ? ` – ${ecb.loadedBy}` : ''}</> : 'Dnešní kurzy ECB zatím nebyly načteny.'}
        </span>
      </div>
      {msg && <div style={{ fontSize: 13, marginBottom: 10, color: msg.startsWith('❌') ? '#b91c1c' : '#27500A' }}>{msg}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 820 }}>
          <thead><tr>
            <th style={th}>Měna</th><th style={th}>Kurz v aplikaci</th><th style={th}>Stav</th>
            <th style={th}>Naposledy změněno</th><th style={th}>ECB pro srovnání</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {RATE_CURRENCIES.map(c => {
              const x = st.currencies[c];
              const e = ecb && ecb.rates ? ecb.rates[c] : null;
              const diff = e ? (x.value - e) / e * 100 : null;
              const editing = edit[c] !== undefined;
              return (
                <tr key={c}>
                  <td style={{ ...td, fontWeight: 700 }}>{c}</td>
                  <td style={td}>
                    {editing ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        1 {c} =
                        <input value={edit[c]} onChange={ev => setEdit(s => ({ ...s, [c]: ev.target.value }))} autoFocus inputMode="decimal"
                          style={{ width: 90, padding: '3px 6px', border: `1px solid ${colors.border}`, borderRadius: 5, fontSize: 13 }} /> €
                        <button disabled={!!busy} style={btn('#27500A')} onClick={() => {
                          const v = parseFloat(String(edit[c]).replace(/\s/g, '').replace(',', '.'));
                          if (!(v > 0)) { setMsg('❌ Zadejte kladné číslo, např. 1,0738'); return; }
                          run('m' + c, () => setManualRate(data, c, v), `${c} nastaveno ručně na ${num(v)} € a zamčeno.`).then(() => setEdit(s => { const n = { ...s }; delete n[c]; return n; }));
                        }}>Uložit</button>
                        <button style={btn('#64748b')} onClick={() => setEdit(s => { const n = { ...s }; delete n[c]; return n; })}>Zrušit</button>
                      </span>
                    ) : (
                      <span><b>1 {c} = {num(x.value)} €</b><span style={{ color: colors.muted, fontSize: 11 }}> · 1 € = {num(1 / x.value)} {c}</span></span>
                    )}
                  </td>
                  <td style={td}>
                    {x.locked
                      ? <span style={{ color: '#9a3412', fontWeight: 600 }}>🔒 zamčený</span>
                      : <span style={{ color: '#1d4ed8', fontWeight: 600 }}>🔓 aktualizuje se tlačítkem</span>}
                  </td>
                  <td style={{ ...td, fontSize: 12, color: colors.muted }}>
                    {SOURCE[x.source] || x.source}{x.ecbDate ? ` ${fmtDay(x.ecbDate)}` : ''}
                    {x.updatedAt ? <><br />{fmtD(x.updatedAt)}{x.updatedBy ? ` – ${x.updatedBy}` : ''}</> : null}
                  </td>
                  <td style={{ ...td, fontSize: 12 }}>
                    {e ? <>{num(e)} €{diff !== null && Math.abs(diff) >= 0.005 && (
                      <span style={{ color: Math.abs(diff) >= 1 ? '#b91c1c' : colors.muted }}> ({diff > 0 ? '+' : ''}{diff.toFixed(2)} %)</span>
                    )}</> : <span style={{ color: colors.muted }}>—</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {canEdit && !editing && (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <button disabled={!!busy} style={btn('#fff', colors.text, `1px solid ${colors.border}`)} onClick={() => setEdit(s => ({ ...s, [c]: String(x.value).replace('.', ',') }))}>✏ Upravit</button>
                        {e && Math.abs(x.value - e) > 1e-9 && (
                          <button disabled={!!busy} style={btn('#fff', '#1d4ed8', '1px solid #1d4ed8')} onClick={() => run('t' + c, () => takeEcbRate(data, c), `${c} převzato z ECB (${num(e)} €).`)}>⇐ Převzít ECB</button>
                        )}
                        <button disabled={!!busy} style={btn('#fff', x.locked ? '#1d4ed8' : '#9a3412', `1px solid ${x.locked ? '#1d4ed8' : '#9a3412'}`)}
                          onClick={() => run('l' + c, () => setLocked(data, c, !x.locked), x.locked ? `${c} odemčeno — změní se při příštím „Načíst dnešní kurzy“.` : `${c} zamčeno.`)}>
                          {x.locked ? '🔓 Odemknout' : '🔒 Zamknout'}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: colors.muted, marginTop: 8, lineHeight: 1.5 }}>
        🔒 zamčený = kurz se nemění, ani tlačítkem „Načíst dnešní kurzy“. 🔓 = při načtení se nastaví dnešní středový kurz ECB. Ruční úprava měnu zamkne.
        Rozdíl proti ECB nad 1 % je červeně.
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={() => setShowHist(v => !v)} style={{ ...btn('#fff', colors.primary, `1px solid ${colors.border}`) }}>
          {showHist ? '▾' : '▸'} Historie změn ({st.history.length})
        </button>
        {showHist && (
          <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto', border: `1px solid ${colors.border}`, borderRadius: 8 }}>
            {st.history.length === 0 && <div style={{ padding: 10, fontSize: 12, color: colors.muted }}>Zatím žádné změny.</div>}
            {st.history.map((h, i) => (
              <div key={i} style={{ padding: '6px 10px', fontSize: 12, borderTop: i ? `1px solid ${colors.border}` : 'none' }}>
                {fmtD(h.at)} · <b>{h.cur}</b> · {h.from === h.to ? h.source : <>{num(h.from)} → <b>{num(h.to)}</b> € ({SOURCE[h.source] || h.source})</>}{h.by ? ` · ${h.by}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
