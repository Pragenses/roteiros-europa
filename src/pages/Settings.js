import React, { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc, setDoc, collection, getDocs, updateDoc } from 'firebase/firestore';
import { normalizeClientCode, yearTwoDigits } from '../lib/offerNumber';

export default function Settings({ colors }) {
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');
  const [smtpPass, setSmtpPass] = useState(() => localStorage.getItem('smtpPass') || '');
  const [smtpSaved, setSmtpSaved] = useState(false);
  const [showSmtpPass, setShowSmtpPass] = useState(false);

  // --- Zpetne ocislovani nabidek -------------------------------------------
  // Nejdriv jen NAVRH: nacte klienty a nabidky, spocita, ktera nabidka dostane
  // ktere cislo, a vypise to. Do databaze se nezapisuje nic, dokud uzivatel
  // nepotvrdi. Poradi v ramci klienta a roku je podle data vzniku nabidky.
  const [numLoading, setNumLoading] = useState(false);
  const [numPlan, setNumPlan] = useState(null);      // [{id, name, clientName, startDate, number}]
  const [numSkipped, setNumSkipped] = useState([]);  // [{name, reason}]
  const [numWriting, setNumWriting] = useState(false);
  const [numResult, setNumResult] = useState('');
  const [numRelink, setNumRelink] = useState([]);   // nabidky se smazanym klientem, ktere lze jednoznacne napojit zpet
  const [numRelinking, setNumRelinking] = useState(false);

  const buildNumberingPlan = async () => {
    setNumLoading(true); setNumResult(''); setNumPlan(null); setNumSkipped([]); setNumRelink([]);
    try {
      const [cliSnap, offSnap] = await Promise.all([
        getDocs(collection(db, 'clients')),
        getDocs(collection(db, 'offers')),
      ]);
      const codeById = {};
      const nameById = {};
      // Podle jmena hledame nahradu za smazaneho klienta. Klice s vice nez
      // jednim klientem se zahodi — tam by oprava byla hadani.
      const byName = {};
      cliSnap.docs.forEach(d => {
        codeById[d.id] = normalizeClientCode(d.data().code);
        nameById[d.id] = d.data().name || '';
        const key = String(d.data().name || '').trim().toUpperCase();
        if (key) byName[key] = byName[key] ? 'AMBIGUOUS' : d.id;
      });
      const relink = [];

      const offers = offSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Cisla, ktera uz jsou obsazena — nova se pridavaji az za ne.
      const maxSeq = {};
      offers.forEach(o => {
        const m = /^([A-Z0-9]{2})-(\d{2})(\d{3})$/.exec(String(o.offerNumber || '').toUpperCase().trim());
        if (m) {
          const key = m[1] + '-' + m[2];
          const seq = parseInt(m[3], 10);
          if (!maxSeq[key] || seq > maxSeq[key]) maxSeq[key] = seq;
        }
      });

      const skipped = [];
      const todo = offers.filter(o => {
        if (String(o.offerNumber || '').trim()) return false;   // uz ma cislo
        if (!o.clientId) { skipped.push({ name: o.name || '(bez nazvu)', reason: 'chybi klient' }); return false; }
        if (!yearTwoDigits(o.startDate)) { skipped.push({ name: o.name || '(bez nazvu)', reason: 'chybi termin' }); return false; }
        if (nameById[o.clientId] === undefined) {
          const key = String(o.clientName || '').trim().toUpperCase();
          const target = byName[key];
          if (target && target !== 'AMBIGUOUS') {
            relink.push({
              id: o.id,
              offerName: o.name || '(bez nazvu)',
              storedName: o.clientName || '',
              targetId: target,
              targetName: nameById[target],
              targetCode: codeById[target] || '(bez kódu)',
            });
          }
          // Nabidka ukazuje na klienta, ktery uz v seznamu klientu neni —
          // byl smazan. Jmeno se porad zobrazuje ze stare kopie v nabidce.
          skipped.push({
            name: o.name || '(bez nazvu)',
            reason: 'klient už neexistuje — v nabídce je uloženo „' + (o.clientName || 'bez názvu') + '“, přiřaď jí klienta znovu',
          });
          return false;
        }
        if (!codeById[o.clientId] || codeById[o.clientId].length !== 2) {
          skipped.push({ name: o.name || '(bez nazvu)', reason: 'klient „' + nameById[o.clientId] + '“ nemá vyplněný kód' });
          return false;
        }
        return true;
      });

      // Poradi podle data vzniku. Nabidky bez data vzniku jdou na konec.
      todo.sort((a, b) => {
        const av = a.createdAt || '', bv = b.createdAt || '';
        if (av && bv) return av < bv ? -1 : av > bv ? 1 : 0;
        if (av) return -1;
        if (bv) return 1;
        return String(a.name || '').localeCompare(String(b.name || ''));
      });

      const plan = todo.map(o => {
        const key = codeById[o.clientId] + '-' + yearTwoDigits(o.startDate);
        const seq = (maxSeq[key] || 0) + 1;
        maxSeq[key] = seq;
        return {
          id: o.id,
          name: o.name || '(bez nazvu)',
          clientName: o.clientName || '',
          startDate: o.startDate || '',
          number: key + String(seq).padStart(3, '0'),
        };
      });

      setNumPlan(plan);
      setNumSkipped(skipped);
      setNumRelink(relink);
    } catch (err) {
      console.error(err);
      setNumResult('❌ Nepodarilo se nacist data: ' + err.message);
    }
    setNumLoading(false);
  };

  // Opravi u nabidek odkaz na klienta, ktery byl smazan, ale existuje jiny
  // klient s presne stejnym jmenem. Cisla nabidek se tim nemeni — jen se
  // obnovi vazba, aby se dalo cislovat. Spousti se rucne a jen po nahledu.
  const applyRelink = async () => {
    if (numRelink.length === 0) return;
    if (!window.confirm('Opravit odkaz na klienta u ' + numRelink.length + ' nabídek?\n\nČísla se tím nepřidělují, jen se obnoví vazba na klienta.')) return;
    setNumRelinking(true); setNumResult('');
    let done = 0;
    try {
      for (const row of numRelink) {
        await updateDoc(doc(db, 'offers', row.id), { clientId: row.targetId, clientName: row.targetName });
        done++;
      }
      setNumResult('✅ Opraveno ' + done + ' vazeb. Klikni znovu na "Zobrazit návrh".');
      setNumRelink([]); setNumPlan(null); setNumSkipped([]);
    } catch (err) {
      console.error(err);
      setNumResult('❌ Opraveno ' + done + ' z ' + numRelink.length + ', pak chyba: ' + err.message);
    }
    setNumRelinking(false);
  };

  const applyNumberingPlan = async () => {
    if (!numPlan || numPlan.length === 0) return;
    if (!window.confirm('Zapsat ' + numPlan.length + ' cisel do nabidek?\n\nUdelal jsi zalohu databaze? Cisla uz pak nepujdou hromadne zmenit.')) return;
    setNumWriting(true); setNumResult('');
    let done = 0;
    try {
      for (const row of numPlan) {
        await updateDoc(doc(db, 'offers', row.id), { offerNumber: row.number });
        done++;
      }
      setNumResult('✅ Zapsano ' + done + ' cisel.');
      setNumPlan(null);
      setNumSkipped([]);
    } catch (err) {
      console.error(err);
      setNumResult('❌ Zapsano ' + done + ' z ' + numPlan.length + ', pak chyba: ' + err.message + '. Spust navrh znovu.');
    }
    setNumWriting(false);
  };

  const saveSmtp = () => {
    localStorage.setItem('smtpPass', smtpPass);
    setSmtpSaved(true);
    setTimeout(() => setSmtpSaved(false), 2000);
  };
  const formRef = useRef(null);

  useEffect(() => {
    const fetchKeys = async () => {
      const snap = await getDoc(doc(db, 'settings', 'apiKeys'));
      if (snap.exists()) {
        const data = snap.data();
        if (formRef.current) {
          formRef.current.anthropicKey.value = data.anthropicKey || '';
          formRef.current.geminiKey.value = data.geminiKey || '';
        }
      }
      setLoading(false);
    };
    fetchKeys();
  }, []);

  const handleBackup = async () => {
    setBackingUp(true);
    setBackupStatus('Carregando dados...');
    try {
      const loadXLSX = () => new Promise((resolve, reject) => {
        if (window.XLSX) { resolve(window.XLSX); return; }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = () => resolve(window.XLSX);
        s.onerror = reject;
        document.head.appendChild(s);
      });
      const XLSX = await loadXLSX();
      const wb = XLSX.utils.book_new();

      // --- OFFERS: split into a summary sheet + a detailed items sheet (readable, not raw JSON) ---
      setBackupStatus('Carregando offers...');
      const offersSnap = await getDocs(collection(db, 'offers'));
      const offerSummaryRows = [];
      const offerItemRows = [];
      offersSnap.forEach(d => {
        const o = d.data();
        offerSummaryRows.push({
          id: d.id,
          nome: o.name || '',
          cliente: o.clientName || '',
          destinos: o.destinations || '',
          status: o.status || '',
          dataInicio: o.startDate || '',
          dataFim: o.endDate || '',
          margem: o.margin || '',
          focCount: o.focCount || '',
          focType: o.focType || '',
          paxList: o.paxList || '',
          criadoEm: o.createdAt || '',
          atualizadoEm: o.updatedAt || '',
          notas: o.notes || '',
        });
        const items = Array.isArray(o.items) ? o.items : [];
        items.forEach(it => {
          offerItemRows.push({
            ofertaNome: o.name || '',
            ofertaId: d.id,
            tipo: it.subType === 'hotel' ? 'Hotel' : it.subType === 'ticket' ? 'Ingresso/Refeição' : it.subType === 'guide_hotel' ? 'Hotel guia/motorista' : it.type === 'group' ? 'Custo de grupo' : (it.subType || it.type || ''),
            nome: it.name || '',
            cidade: it.city || '',
            moeda: it.currency || '',
            dataDe: it.dateFrom || '',
            dataAte: it.dateTo || '',
            noites: it.nights || '',
            precoNoiteDBL: it.pricePerNightDbl || '',
            precoNoiteSNGL: it.pricePerNightSngl || '',
            cityTaxDBL: it.cityTax || '',
            cityTaxSNGL: it.cityTaxSngl || '',
            precoPorPax: it.costDbl || '',
            custoGrupoTotal: it.groupCost || '',
            valorManual: it.guideOverride || '',
            ativo: it.enabled !== false ? 'Sim' : 'Não',
          });
        });
      });
      const wsOffersSummary = offerSummaryRows.length > 0 ? XLSX.utils.json_to_sheet(offerSummaryRows) : XLSX.utils.aoa_to_sheet([['(sem dados)']]);
      XLSX.utils.book_append_sheet(wb, wsOffersSummary, 'Offers');
      const wsOffersItems = offerItemRows.length > 0 ? XLSX.utils.json_to_sheet(offerItemRows) : XLSX.utils.aoa_to_sheet([['(sem dados)']]);
      XLSX.utils.book_append_sheet(wb, wsOffersItems, 'Offers_Hoteis_Servicos');

      // --- ORDERS: summary sheet + services subcollection sheet ---
      setBackupStatus('Carregando orders...');
      const ordersSnap = await getDocs(collection(db, 'orders'));
      const orderSummaryRows = [];
      const orderServiceRows = [];
      for (const d of ordersSnap.docs) {
        const o = d.data();
        orderSummaryRows.push({
          id: d.id,
          nome: o.name || '',
          cliente: o.clientName || '',
          destinos: o.destinations || '',
          status: o.status || '',
          dataInicio: o.startDate || '',
          dataFim: o.endDate || '',
          paxCount: o.paxCount || '',
          margem: o.margin || '',
          criadoEm: o.createdAt || '',
          notas: o.notes || '',
        });
        try {
          const svcSnap = await getDocs(collection(db, 'orders', d.id, 'services'));
          svcSnap.forEach(s => {
            const sv = s.data();
            orderServiceRows.push({
              objednavkaNome: o.name || '',
              objednavkaId: d.id,
              tipo: sv.type || '',
              nome: sv.name || sv.providerName || '',
              cidade: sv.city || '',
              dataDe: sv.dateFrom || '',
              dataAte: sv.dateTo || '',
              noites: sv.nights || '',
              moeda: sv.currency || '',
              status: sv.status || '',
              precoPorPax: sv.pricePerPax || '',
              precoTotal: sv.totalPrice || '',
              precoQuartoDBL: sv.pricePerDblRoom || '',
              precoQuartoSNGL: sv.pricePerSnglRoom || '',
              cityTax: sv.cityTax || '',
              contato: sv.providerPhone || sv.providerEmail || '',
            });
          });
        } catch (e) { /* ignore missing subcollection */ }
      }
      const wsOrdersSummary = orderSummaryRows.length > 0 ? XLSX.utils.json_to_sheet(orderSummaryRows) : XLSX.utils.aoa_to_sheet([['(sem dados)']]);
      XLSX.utils.book_append_sheet(wb, wsOrdersSummary, 'Orders');
      const wsOrderServices = orderServiceRows.length > 0 ? XLSX.utils.json_to_sheet(orderServiceRows) : XLSX.utils.aoa_to_sheet([['(sem dados)']]);
      XLSX.utils.book_append_sheet(wb, wsOrderServices, 'Orders_Servicos');

      // --- CLIENTS and PROVIDERS: simple flat sheets (no nested arrays expected) ---
      for (const colName of ['clients', 'providers']) {
        setBackupStatus(`Carregando ${colName}...`);
        const snap = await getDocs(collection(db, colName));
        const rows = [];
        snap.forEach(d => {
          const data = d.data();
          const flat = { id: d.id };
          Object.entries(data).forEach(([k, v]) => {
            if (v === null || v === undefined) { flat[k] = ''; }
            else if (typeof v === 'object') { flat[k] = JSON.stringify(v); }
            else { flat[k] = v; }
          });
          rows.push(flat);
        });
        const ws = rows.length > 0 ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['(sem dados)']]);
        XLSX.utils.book_append_sheet(wb, ws, colName.charAt(0).toUpperCase() + colName.slice(1));
      }

      setBackupStatus('Gerando arquivo...');
      const dateStr = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `Backup_Roteiros_Europa_${dateStr}.xlsx`);
      setBackupStatus('✓ Backup concluído!');
      setTimeout(() => setBackupStatus(''), 5000);
    } catch (err) {
      console.error(err);
      setBackupStatus('❌ Erro ao gerar backup: ' + err.message);
    }
    setBackingUp(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const f = formRef.current;
    await setDoc(doc(db, 'settings', 'apiKeys'), {
      anthropicKey: f.anthropicKey.value.trim(),
      geminiKey: f.geminiKey.value.trim(),
      updatedAt: new Date().toISOString(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const iStyle = { width: '100%', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 13, fontFamily: 'Georgia, serif', boxSizing: 'border-box' };
  const lbl = (t) => <label style={{ fontSize: 12, color: colors.muted, display: 'block', marginBottom: 4 }}>{t}</label>;

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Settings</h1>
        <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>AI feature configuration</div>
      </div>

      {loading ? <div style={{ color: colors.muted, fontSize: 14 }}>Loading...</div> : (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', maxWidth: 600 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: 8 }}>AI API Keys</div>
          <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1.25rem', lineHeight: 1.5 }}>
            These keys power the "Parse into fields" and "Fill automatically" features in Providers, Clients, and Order details.
            Keys are stored securely in the database, not in the application code, so they won't be exposed publicly.
          </div>
          <form ref={formRef} onSubmit={handleSubmit}>
            <div style={{ marginBottom: 16 }}>
              {lbl('Anthropic API Key (used for "Paste from email", "Parse into fields")')}
              <input name="anthropicKey" type="password" placeholder="sk-ant-api03-..." style={iStyle} />
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
                Get one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: '#0C447C' }}>console.anthropic.com/settings/keys</a>
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              {lbl('Gemini API Key (used for "Fill automatically" / AI search, free tier)')}
              <input name="geminiKey" type="password" placeholder="AIza... or AQ...." style={iStyle} />
              <div style={{ fontSize: 11, color: colors.muted, marginTop: 4 }}>
                Get one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: '#0C447C' }}>aistudio.google.com/apikey</a>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button type="submit" style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
                Save keys
              </button>
              {saved && <span style={{ fontSize: 13, color: '#27500A' }}>✓ Saved</span>}
            </div>
          </form>
        </div>
      )}

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', maxWidth: 600, marginTop: '1.5rem' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: 8 }}>📧 SMTP — odesílání emailů hotelům</div>
        <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1.25rem', lineHeight: 1.5 }}>
          Heslo se uloží pouze v tomto prohlížeči. Nikam se neodesílá, nikdo jiný ho neuvidí.
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>SMTP server</div>
          <input value="smtp.svethostingu.cz" readOnly style={{ ...iStyle, background: colors.bg, color: colors.muted }} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>Port</div>
          <input value="465 (SSL)" readOnly style={{ ...iStyle, background: colors.bg, color: colors.muted }} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>Uživatel</div>
          <input value="grupos@tour-pragenses.com" readOnly style={{ ...iStyle, background: colors.bg, color: colors.muted }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: colors.muted, marginBottom: 4 }}>Heslo</div>
          <div style={{ position: 'relative' }}>
            <input type={showSmtpPass ? 'text' : 'password'} value={smtpPass} onChange={e => setSmtpPass(e.target.value)}
              placeholder="Zadej heslo ke schránce grupos@tour-pragenses.com"
              style={{ ...iStyle, paddingRight: 36 }} />
            <button onClick={() => setShowSmtpPass(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: colors.muted }}>
              {showSmtpPass ? '🙈' : '👁'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={saveSmtp} style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500 }}>
            Uložit heslo
          </button>
          {smtpSaved && <span style={{ fontSize: 13, color: '#27500A' }}>✓ Uloženo</span>}
        </div>
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', maxWidth: 600, marginTop: '1.5rem' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: 8 }}>💾 Backup de segurança</div>
        <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1.25rem', lineHeight: 1.5 }}>
          Baixa um arquivo Excel com várias planilhas legíveis: Offers (resumo), Offers_Hoteis_Servicos (cada hotel/ingresso em sua própria linha), Orders, Orders_Servicos, Clients e Providers. Cópia de segurança independente do sistema. Recomendado fazer regularmente (ex: uma vez por semana).
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={handleBackup} disabled={backingUp} style={{ padding: '9px 20px', background: '#27500A', color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, opacity: backingUp ? 0.6 : 1 }}>
            {backingUp ? 'Gerando...' : '💾 Baixar backup completo'}
          </button>
          {backupStatus && <span style={{ fontSize: 13, color: backupStatus.startsWith('❌') ? '#dc2626' : '#27500A' }}>{backupStatus}</span>}
        </div>
      </div>

      <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '1.5rem', maxWidth: 900, marginTop: '1.5rem' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: 8 }}>🔢 Zpětné očíslování nabídek</div>
        <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1rem', lineHeight: 1.5 }}>
          Přidělí čísla nabídkám, které je ještě nemají. Pořadí v rámci klienta a roku je podle data vzniku nabídky.
          Nabídky, které už číslo mají, se nemění. <strong>Nejdřív si udělej zálohu databáze</strong> — čísla už pak nepůjdou hromadně změnit.
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={buildNumberingPlan} disabled={numLoading || numWriting}
            style={{ padding: '9px 20px', background: colors.primary, color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, opacity: (numLoading || numWriting) ? 0.6 : 1 }}>
            {numLoading ? 'Počítám...' : '1. Zobrazit návrh'}
          </button>
          {numPlan && numPlan.length > 0 && (
            <button onClick={applyNumberingPlan} disabled={numWriting}
              style={{ padding: '9px 20px', background: '#27500A', color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, opacity: numWriting ? 0.6 : 1 }}>
              {numWriting ? 'Zapisuji...' : `2. Zapsat ${numPlan.length} čísel`}
            </button>
          )}
          {numResult && <span style={{ fontSize: 13, color: numResult.startsWith('❌') ? '#dc2626' : '#27500A' }}>{numResult}</span>}
        </div>

        {numRelink.length > 0 && (
          <div style={{ marginTop: 14, background: '#FEF2F2', border: '1px solid #F0C4C4', borderRadius: 8, padding: '12px 14px' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#8A2020', marginBottom: 6 }}>
              Nabídky s odkazem na smazaného klienta ({numRelink.length})
            </div>
            <div style={{ fontSize: 12, color: '#8A2020', marginBottom: 10, lineHeight: 1.5 }}>
              Klient, na kterého tyto nabídky ukazují, už v seznamu není. Existuje ale klient se stejným jménem,
              takže se vazba dá obnovit. Čísla se tím nepřidělí — po opravě klikni znovu na „Zobrazit návrh“.
            </div>
            {numRelink.map(r => (
              <div key={r.id} style={{ fontSize: 12, color: '#8A2020' }}>
                {r.offerName} → {r.targetName} ({r.targetCode})
              </div>
            ))}
            <button onClick={applyRelink} disabled={numRelinking}
              style={{ marginTop: 10, padding: '8px 16px', background: '#8A2020', color: colors.white, border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, opacity: numRelinking ? 0.6 : 1 }}>
              {numRelinking ? 'Opravuji...' : `Opravit ${numRelink.length} vazeb`}
            </button>
          </div>
        )}

        {numPlan && numPlan.length === 0 && (
          <div style={{ fontSize: 13, color: colors.muted, marginTop: 12 }}>Není co číslovat — všechny nabídky, které číslo dostat mohou, ho už mají.</div>
        )}

        {numPlan && numPlan.length > 0 && (
          <div style={{ marginTop: 14, border: `1px solid ${colors.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 180px 110px', gap: 8, padding: '8px 12px', background: '#F4F6F8', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: colors.muted }}>
              <div>Číslo</div><div>Nabídka</div><div>Klient</div><div>Začátek</div>
            </div>
            {numPlan.map(r => (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 180px 110px', gap: 8, padding: '7px 12px', borderTop: `1px solid ${colors.border}`, fontSize: 13 }}>
                <div style={{ fontWeight: 700, letterSpacing: '0.04em' }}>{r.number}</div>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                <div style={{ color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.clientName}</div>
                <div style={{ color: colors.muted }}>{r.startDate}</div>
              </div>
            ))}
          </div>
        )}

        {numSkipped.length > 0 && (
          <div style={{ marginTop: 14, background: '#FDF3D8', border: '1px solid #E7D9AE', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#7A5A00', marginBottom: 6 }}>Číslo nedostanou ({numSkipped.length})</div>
            {numSkipped.map((r, i) => (
              <div key={i} style={{ fontSize: 12, color: '#7A5A00' }}>{r.name} — {r.reason}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
