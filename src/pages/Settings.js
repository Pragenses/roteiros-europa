import React, { useState, useEffect, useRef } from 'react';
import { db } from '../lib/firebase';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';

export default function Settings({ colors }) {
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');
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

      const collections = ['offers', 'orders', 'clients', 'providers'];
      const wb = XLSX.utils.book_new();

      for (const colName of collections) {
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
        const ws = rows.length > 0
          ? XLSX.utils.json_to_sheet(rows)
          : XLSX.utils.aoa_to_sheet([['(sem dados)']]);
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
        <div style={{ fontSize: 15, fontWeight: 600, color: colors.primary, marginBottom: 8 }}>💾 Backup de segurança</div>
        <div style={{ fontSize: 13, color: colors.muted, marginBottom: '1.25rem', lineHeight: 1.5 }}>
          Baixa um arquivo Excel com todas as suas nabídky, objednávky, clientes e fornecedores — uma cópia de segurança independente do sistema. Recomendado fazer regularmente (ex: uma vez por semana).
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button onClick={handleBackup} disabled={backingUp} style={{ padding: '9px 20px', background: '#27500A', color: colors.white, border: 'none', borderRadius: 7, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500, opacity: backingUp ? 0.6 : 1 }}>
            {backingUp ? 'Gerando...' : '💾 Baixar backup completo'}
          </button>
          {backupStatus && <span style={{ fontSize: 13, color: backupStatus.startsWith('❌') ? '#dc2626' : '#27500A' }}>{backupStatus}</span>}
        </div>
      </div>
    </div>
  );
}
