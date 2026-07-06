import { db } from './firebase';
import { collection, addDoc, doc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';

// Maps a short entityType key to its real Firestore collection name.
const COLLECTION_MAP = {
  client: 'clients',
  offer: 'offers',
  order: 'orders',
  hotel: 'hotels',
};

// Call this BEFORE actually deleting a document, so it can be restored later
// from the History page. `data` should be the full document data (without id).
export async function logDeletion(entityType, entityId, entityName, data) {
  try {
    await addDoc(collection(db, 'activityLog'), {
      action: 'delete',
      entityType,
      entityId,
      entityName: entityName || '',
      data,
      deletedAt: serverTimestamp(),
      restored: false,
    });
  } catch (err) {
    // Logging failure should never block the actual delete the user asked for.
    console.error('logDeletion failed (delete will still proceed):', err);
  }
}

// Restores a previously-logged deletion by recreating the document with its
// original ID, then marks the log entry as restored.
export async function restoreFromLog(logEntry) {
  const collectionName = COLLECTION_MAP[logEntry.entityType];
  if (!collectionName) throw new Error('Unknown entity type: ' + logEntry.entityType);
  await setDoc(doc(db, collectionName, logEntry.entityId), logEntry.data);
  await updateDoc(doc(db, 'activityLog', logEntry.id), { restored: true });
}
