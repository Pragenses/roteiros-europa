import React, { useState, useEffect, useCallback } from 'react';
import { db } from '../lib/firebase';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { restoreFromLog } from '../lib/activityLog';

const ENTITY_LABELS = {
  client: '👤 Klient',
  offer: '📋 Nabídka',
  order: '📦 Zakázka',
  hotel: '🏨 Hotel',
};

const fmt = (ts) => {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('cs-CZ') + ' ' + d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
};

export default function History({ navigate, colors }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const q = query(collection(db, 'activityLog'), orderBy('deletedAt', 'desc'));
      const snap = await getDocs(q);
      setEntries(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
      // Fallback without orderBy in case an index isn't ready yet
      const snap = await getDocs(collection(db, 'activityLog'));
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => (b.deletedAt?.seconds || 0) - (a.deletedAt?.seconds || 0));
      setEntries(items);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleRestore = async (entry) => {
    if (!window.confirm(`Obnovit "${entry.entityName}"? Vrátí se přesně tak, jak bylo smazáno.`)) return;
    setRestoringId(entry.id);
    try {
      await restoreFromLog(entry);
      fetchEntries();
    } catch (err) {
      alert('Obnovení selhalo: ' + err.message);
    }
    setRestoringId(null);
  };

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: colors.primary, margin: 0 }}>🕐 Historie</h1>
        <div style={{ fontSize: 13, color: colors.muted, marginTop: 3 }}>
          Záznam smazaných klientů, nabídek a zakázek — kdykoliv se dá obnovit zpět.
        </div>
      </div>

      {loading ? (
        <div style={{ color: colors.muted, fontSize: 14 }}>Načítám...</div>
      ) : entries.length === 0 ? (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '3rem', textAlign: 'center', color: colors.muted, fontSize: 14 }}>
          Zatím nic nebylo smazáno.
        </div>
      ) : (
        <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, overflow: 'hidden' }}>
          {entries.map((entry, i) => (
            <div key={entry.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 1.25rem',
              borderBottom: i < entries.length - 1 ? `1px solid ${colors.border}` : 'none',
              opacity: entry.restored ? 0.5 : 1,
            }}>
              <div style={{ fontSize: 13, color: colors.muted, width: 130, flexShrink: 0 }}>{fmt(entry.deletedAt)}</div>
              <div style={{ fontSize: 12, width: 110, flexShrink: 0, color: colors.muted }}>{ENTITY_LABELS[entry.entityType] || entry.entityType}</div>
              <div style={{ flex: 1, fontWeight: 600, color: colors.text, fontSize: 14 }}>{entry.entityName}</div>
              {entry.restored ? (
                <span style={{ fontSize: 12, color: colors.success || '#2d6a4f' }}>✓ Obnoveno</span>
              ) : (
                <button onClick={() => handleRestore(entry)} disabled={restoringId === entry.id}
                  style={{ padding: '6px 14px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                  {restoringId === entry.id ? 'Obnovuji…' : '↩ Obnovit'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
