import React, { useState, useEffect, useRef } from 'react';
import { db, auth, storage } from '../lib/firebase';
import { collection, onSnapshot, addDoc, doc, updateDoc, deleteDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { codeForEmail } from '../lib/people';

// Import starých akcí — KROK 1: importní složky.
// Ke každé staré akci (dělané mimo systém) se založí složka a do ní se
// postupně nahrávají podklady: Excel, PDF, text, fotky a scany.
// V tomto kroku se NIC nečte ani nezapisuje do nabídek a zakázek —
// složka jen sbírá soubory. Čtení (krok 2) a zápis (krok 3) přijdou později.
//
// Firestore: kolekce importFolders
//   { name, note, status: 'collecting', files: [ {id, name, path, url, kind, size, uploadedAt, uploadedBy} ],
//     createdAt, createdBy, updatedAt }
// Storage: offers/_import/<folderId>/<čas>_<název>
//   (pod offers/, kde už nahrávání příloh prokazatelně funguje)

const COLLECTION = 'importFolders';
const OPEN_KEY = 'importOpenFolder';
const MAX_MB = 50;

// Druh souboru podle přípony / typu — určuje ikonku a jestli ho krok 2 umí číst.
const KINDS = {
  excel: { icon: '📊', label: 'Excel / tabulka' },
  pdf: { icon: '📄', label: 'PDF' },
  image: { icon: '📷', label: 'Fotka / scan' },
  text: { icon: '📝', label: 'Text / Word' },
  other: { icon: '❓', label: 'Jiný soubor' },
};

const kindOf = (file) => {
  const n = (file.name || '').toLowerCase();
  const t = (file.type || '').toLowerCase();
  if (/\.(xlsx|xlsm|xls|csv|ods)$/.test(n)) return 'excel';
  if (/\.pdf$/.test(n) || t === 'application/pdf') return 'pdf';
  if (t.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/.test(n)) return 'image';
  if (/\.(txt|docx|doc|rtf|eml|html?|md)$/.test(n) || t.startsWith('text/')) return 'text';
  return 'other';
};

const fmtSize = (b) => {
  if (!b && b !== 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} kB`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
};

const fmtWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const who = (email) => codeForEmail(email) || (email ? email.split('@')[0] : '');

export default function Import({ colors }) {
  const [folders, setFolders] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [openId, setOpenId] = useState(() => {
    try { return sessionStorage.getItem(OPEN_KEY) || null; } catch (e) { return null; }
  });
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, COLLECTION),
      (snap) => {
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
        setFolders(list);
      },
      (err) => setLoadError(err.code || err.message || 'Načtení selhalo'));
    return () => unsub();
  }, []);

  const open = (id) => {
    setOpenId(id);
    try { if (id) sessionStorage.setItem(OPEN_KEY, id); else sessionStorage.removeItem(OPEN_KEY); } catch (e) { /* nic */ }
    window.scrollTo(0, 0);
  };

  const createFolder = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const now = new Date().toISOString();
      const ref = await addDoc(collection(db, COLLECTION), {
        name, note: '', status: 'collecting', files: [],
        createdAt: now, createdBy: auth.currentUser?.email || '', updatedAt: now,
      });
      setNewName('');
      open(ref.id);
    } catch (err) {
      alert('Složku se nepodařilo založit: ' + (err.code || err.message));
    }
    setCreating(false);
  };

  const box = { background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '1rem 1.25rem' };

  if (loadError) {
    return <div style={{ ...box, color: colors.danger }}>Import se nepodařilo načíst ({loadError}).</div>;
  }
  if (!folders) return <div style={{ color: colors.muted, fontSize: 14 }}>Načítám…</div>;

  const current = openId ? folders.find(f => f.id === openId) : null;
  if (openId && current) {
    return <FolderDetail folder={current} colors={colors} box={box} onBack={() => open(null)} />;
  }

  return (
    <div>
      <div style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>Import starých akcí</h1>
        <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>
          Ke každé akci dělané mimo systém založte složku a nahrajte do ní všechny podklady — Excel, PDF, text, fotky.
          Zatím se nic nečte ani nezapisuje do nabídek a zakázek.
        </div>
      </div>

      <div style={{ ...box, marginBottom: '1.25rem', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createFolder(); }}
          placeholder="Název akce, např. BALCAS SOCAL – Balkán 2027"
          style={{ flex: 1, minWidth: 220, padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, fontFamily: 'inherit' }} />
        <button type="button" onClick={createFolder} disabled={!newName.trim() || creating}
          style={{ padding: '8px 16px', border: 'none', borderRadius: 7, background: newName.trim() ? colors.primary : '#b9b4ab', color: '#fff', fontSize: 14, fontFamily: 'inherit', cursor: newName.trim() ? 'pointer' : 'default' }}>
          {creating ? 'Zakládám…' : '＋ Založit složku'}
        </button>
      </div>

      {folders.length === 0 ? (
        <div style={{ ...box, color: colors.muted, fontSize: 14 }}>Zatím tu není žádná složka.</div>
      ) : (
        <div style={{ ...box, padding: 0 }}>
          {folders.map((f, i) => {
            const files = f.files || [];
            const counts = {};
            files.forEach(x => { counts[x.kind] = (counts[x.kind] || 0) + 1; });
            return (
              <button key={f.id} type="button" onClick={() => open(f.id)}
                style={{ display: 'flex', width: '100%', gap: 12, alignItems: 'center', padding: '12px 1.25rem', border: 'none', borderTop: i ? `1px solid ${colors.border}` : 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                <span style={{ fontSize: 20 }}>📁</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: colors.text }}>{f.name || '(bez názvu)'}</span>
                  <span style={{ display: 'block', fontSize: 12, color: colors.muted, marginTop: 2 }}>
                    {files.length === 0 ? 'zatím prázdná' : `${files.length} ${files.length === 1 ? 'soubor' : files.length < 5 ? 'soubory' : 'souborů'}`}
                    {Object.keys(counts).length > 0 && ' · ' + Object.entries(counts).map(([k, n]) => `${(KINDS[k] || KINDS.other).icon} ${n}`).join('  ')}
                  </span>
                </span>
                <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 10, background: '#FAEEDA', color: '#633806', whiteSpace: 'nowrap' }}>Sbírám podklady</span>
                <span style={{ fontSize: 12, color: colors.muted, whiteSpace: 'nowrap' }}>{who(f.createdBy)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FolderDetail({ folder, colors, box, onBack }) {
  const [name, setName] = useState(folder.name || '');
  const [note, setNote] = useState(folder.note || '');
  const [queue, setQueue] = useState([]); // nahrávané soubory: {key, name, pct, error}
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef(null);
  const cameraInput = useRef(null);
  const files = folder.files || [];

  // Když složku upraví někdo jiný, převezmi nový název/poznámku (pokud zrovna nepíšu).
  const editing = useRef({ name: false, note: false });
  useEffect(() => { if (!editing.current.name) setName(folder.name || ''); }, [folder.name]);
  useEffect(() => { if (!editing.current.note) setNote(folder.note || ''); }, [folder.note]);

  const ref = doc(db, COLLECTION, folder.id);

  const saveField = async (field, value) => {
    editing.current[field] = false;
    if ((folder[field] || '') === value) return;
    if (field === 'name' && !value.trim()) { setName(folder.name || ''); return; }
    try { await updateDoc(ref, { [field]: value, updatedAt: new Date().toISOString() }); }
    catch (err) { alert('Uložení selhalo: ' + (err.code || err.message)); }
  };

  const uploadOne = (file, displayName) => new Promise((resolve) => {
    const key = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const setQ = (patch) => setQueue(q => q.map(x => x.key === key ? { ...x, ...patch } : x));
    setQueue(q => [...q, { key, name: displayName, pct: 0, error: '' }]);

    if (file.size > MAX_MB * 1024 * 1024) {
      setQ({ error: `Soubor je větší než ${MAX_MB} MB.` });
      resolve(); return;
    }
    const safe = displayName.normalize('NFD').replace(/[^a-zA-Z0-9._-]+/g, '_');
    const path = `offers/_import/${folder.id}/${key}_${safe}`;
    const task = uploadBytesResumable(storageRef(storage, path), file);
    task.on('state_changed',
      (s) => setQ({ pct: Math.round((s.bytesTransferred / s.totalBytes) * 100) }),
      (err) => { setQ({ error: err.code || err.message || 'Nahrání selhalo' }); resolve(); },
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          const entry = {
            id: key, name: displayName, path, url, kind: kindOf(file), size: file.size,
            uploadedAt: new Date().toISOString(), uploadedBy: auth.currentUser?.email || '',
          };
          await updateDoc(ref, { files: arrayUnion(entry), updatedAt: new Date().toISOString() });
          setQueue(q => q.filter(x => x.key !== key));
        } catch (err) {
          setQ({ error: err.code || err.message || 'Uložení selhalo' });
        }
        resolve();
      });
  });

  const addFiles = async (fileList) => {
    const list = Array.from(fileList || []);
    if (!list.length) return;
    // iPhone pojmenuje každou fotku „image.jpg" — přejmenujeme na Foto 1, Foto 2…
    let photoNo = files.filter(f => /^Foto \d+/.test(f.name)).length;
    const now = new Date();
    const stamp = `${now.getDate()}-${now.getMonth() + 1}-${now.getFullYear()}`;
    const named = list.map(f => {
      if (/^image\.(jpe?g|png|heic|heif)$/i.test(f.name)) {
        photoNo += 1;
        return [f, `Foto ${photoNo} (${stamp}).${f.name.split('.').pop().toLowerCase()}`];
      }
      return [f, f.name];
    });
    // Po jednom, ať telefon na mobilních datech nepadá.
    for (const [f, n] of named) { await uploadOne(f, n); }
  };

  const removeFile = async (entry) => {
    if (!window.confirm(`Odebrat soubor „${entry.name}" ze složky?`)) return;
    try {
      await updateDoc(ref, { files: arrayRemove(entry), updatedAt: new Date().toISOString() });
      try { await deleteObject(storageRef(storage, entry.path)); } catch (e) { console.error('Storage delete failed:', e); }
    } catch (err) {
      alert('Odebrání selhalo: ' + (err.code || err.message));
    }
  };

  const deleteFolder = async () => {
    if (!window.confirm(`Smazat celou složku „${folder.name}" i se všemi ${files.length} soubory?`)) return;
    if (files.length && !window.confirm('Opravdu? Soubory se smažou natrvalo.')) return;
    for (const f of files) {
      try { await deleteObject(storageRef(storage, f.path)); } catch (e) { console.error('Storage delete failed:', e); }
    }
    try { await deleteDoc(ref); onBack(); }
    catch (err) { alert('Smazání selhalo: ' + (err.code || err.message)); }
  };

  const btn = (primary) => ({
    padding: '9px 16px', border: primary ? 'none' : `1px solid ${colors.border}`, borderRadius: 7,
    background: primary ? colors.primary : colors.white, color: primary ? '#fff' : colors.text,
    fontSize: 14, fontFamily: 'inherit', cursor: 'pointer',
  });

  const sorted = [...files].sort((a, b) => String(a.uploadedAt || '').localeCompare(String(b.uploadedAt || '')));

  return (
    <div>
      <button type="button" onClick={onBack}
        style={{ background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 13, padding: 0, marginBottom: 10, fontFamily: 'inherit' }}>
        ← Všechny složky
      </button>

      <div style={{ ...box, marginBottom: '1rem' }}>
        <label style={{ display: 'block', fontSize: 12, color: colors.muted, marginBottom: 4 }}>Název akce</label>
        <input value={name}
          onFocus={() => { editing.current.name = true; }}
          onChange={e => setName(e.target.value)}
          onBlur={() => saveField('name', name.trim())}
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 16, fontWeight: 600, fontFamily: 'inherit', color: colors.primary }} />
        <label style={{ display: 'block', fontSize: 12, color: colors.muted, margin: '12px 0 4px' }}>Poznámka (nepovinné — klient, termín, co ještě chybí…)</label>
        <textarea value={note} rows={2}
          onFocus={() => { editing.current.note = true; }}
          onChange={e => setNote(e.target.value)}
          onBlur={() => saveField('note', note)}
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: `1px solid ${colors.border}`, borderRadius: 7, fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }} />
        <div style={{ fontSize: 11, color: colors.muted, marginTop: 6 }}>
          Založil(a) {who(folder.createdBy)} {fmtWhen(folder.createdAt)} · ukládá se samo
        </div>
      </div>

      {/* Nahrávání */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        style={{ ...box, marginBottom: '1rem', borderStyle: 'dashed', borderWidth: 2, borderColor: dragOver ? colors.accent : colors.border, background: dragOver ? '#fbf6e8' : colors.white, textAlign: 'center', padding: '1.25rem' }}>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={btn(true)} onClick={() => fileInput.current && fileInput.current.click()}>📎 Přidat soubory</button>
          <button type="button" style={btn(false)} onClick={() => cameraInput.current && cameraInput.current.click()}>📷 Vyfotit</button>
        </div>
        <div style={{ fontSize: 12, color: colors.muted, marginTop: 10 }}>
          nebo soubory přetáhněte sem · Excel, PDF, Word, text, fotky · víc souborů najednou · max {MAX_MB} MB na soubor
        </div>
        <input ref={fileInput} type="file" multiple style={{ display: 'none' }}
          accept=".xlsx,.xlsm,.xls,.csv,.ods,.pdf,.txt,.doc,.docx,.rtf,.eml,.htm,.html,image/*"
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
          onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {queue.length > 0 && (
        <div style={{ ...box, marginBottom: '1rem' }}>
          {queue.map(q => (
            <div key={q.key} style={{ fontSize: 13, padding: '4px 0', color: q.error ? colors.danger : colors.text }}>
              {q.error ? `⚠ ${q.name} — nenahráno: ${q.error}` : `⏳ ${q.name} — ${q.pct} %`}
              {q.error && (
                <button type="button" onClick={() => setQueue(x => x.filter(y => y.key !== q.key))}
                  style={{ marginLeft: 8, background: 'none', border: 'none', color: colors.muted, cursor: 'pointer', fontSize: 12 }}>zavřít</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Seznam souborů */}
      <div style={{ ...box, padding: 0, marginBottom: '1.5rem' }}>
        <div style={{ padding: '10px 1.25rem', fontSize: 13, fontWeight: 600, color: colors.primary, borderBottom: `1px solid ${colors.border}` }}>
          Podklady ve složce ({files.length})
        </div>
        {sorted.length === 0 ? (
          <div style={{ padding: '14px 1.25rem', fontSize: 13, color: colors.muted }}>Zatím žádné soubory.</div>
        ) : sorted.map((f, i) => {
          const k = KINDS[f.kind] || KINDS.other;
          return (
            <div key={f.id || f.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 1.25rem', borderTop: i ? `1px solid ${colors.border}` : 'none' }}>
              <span style={{ fontSize: 18 }} title={k.label}>{k.icon}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <a href={f.url} target="_blank" rel="noopener noreferrer"
                  style={{ display: 'block', fontSize: 14, color: colors.info, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</a>
                <span style={{ fontSize: 11, color: colors.muted }}>
                  {k.label} · {fmtSize(f.size)} · {who(f.uploadedBy)} {fmtWhen(f.uploadedAt)}
                  {f.kind === 'other' && ' · ⚠ tento typ zatím neumím přečíst'}
                </span>
              </span>
              <button type="button" onClick={() => removeFile(f)} title="Odebrat"
                style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: 6, color: colors.muted, cursor: 'pointer', fontSize: 13, padding: '3px 8px' }}>✕</button>
            </div>
          );
        })}
      </div>

      <div style={{ textAlign: 'right' }}>
        <button type="button" onClick={deleteFolder}
          style={{ background: 'none', border: `1px solid #e5b4b4`, borderRadius: 7, color: colors.danger, cursor: 'pointer', fontSize: 12, padding: '6px 12px', fontFamily: 'inherit' }}>
          🗑 Smazat celou složku
        </button>
      </div>
    </div>
  );
}
