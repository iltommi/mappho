import { openDB } from 'idb';

const DB_NAME = 'sharpho';
const DB_VERSION = 2;
const STORE = 'photos';
const ORPHAN_STORE = 'orphans';

let _db;
async function db() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore(STORE, { keyPath: 'fileid' });
      }
      if (oldVersion < 2) {
        const s = db.createObjectStore(ORPHAN_STORE, { keyPath: 'fileid' });
        s.createIndex('by_ts', 'ts');
      }
    },
  });
  return _db;
}

export async function getCached(fileid) {
  return (await db()).get(STORE, fileid);
}

export async function putCached(photo) {
  return (await db()).put(STORE, photo);
}

export async function getAllCached() {
  return (await db()).getAll(STORE);
}

export async function countCached() {
  return (await db()).count(STORE);
}

export async function clearAll() {
  return (await db()).clear(STORE);
}

// Orphans: photos without GPS, indexed by ts for sorted pagination.
// ts is stored as ts ?? 0 so null dates become 0 (1970) and remain indexable.

export async function putOrphan({ fileid, name, ts }) {
  return (await db()).put(ORPHAN_STORE, { fileid, name, ts: ts ?? 0 });
}

export async function bulkPutOrphans(records) {
  if (!records.length) return;
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readwrite');
  for (const r of records) tx.store.put({ fileid: r.fileid, name: r.name, ts: r.ts ?? 0 });
  await tx.done;
}

export async function countOrphans() {
  return (await db()).count(ORPHAN_STORE);
}

export async function clearOrphans() {
  return (await db()).clear(ORPHAN_STORE);
}

export async function deleteRecord(fileid) {
  return (await db()).delete(STORE, fileid);
}

export async function deleteOrphan(fileid) {
  return (await db()).delete(ORPHAN_STORE, fileid);
}

// Returns the geotagged photo closest in time to ts, plus delta in ms.
// Returns null if no geotagged photos with known dates exist.
export async function findClosestGeotagged(ts) {
  const d = await db();
  const all = await d.getAll(STORE);
  let best = null, bestDiff = Infinity;
  for (const p of all) {
    if (p.lat == null || !p.ts) continue;
    const diff = Math.abs(p.ts - ts);
    if (diff < bestDiff) { bestDiff = diff; best = p; }
  }
  return best ? { ...best, delta: bestDiff } : null;
}

export async function exportDb() {
  const d = await db();
  const photos = await d.getAll(STORE);
  return { version: 2, photos };
}

export async function importDb(backup) {
  const d = await db();
  const tx = d.transaction([STORE, ORPHAN_STORE], 'readwrite');
  tx.objectStore(STORE).clear();
  tx.objectStore(ORPHAN_STORE).clear();
  const photos = backup.photos ?? [];
  for (const r of photos) tx.objectStore(STORE).put(r);
  // Reconstruct orphan store from non-GPS photos (v1 backups had a separate orphans array)
  const orphanSource = backup.version >= 2
    ? photos.filter(r => r.lat == null)
    : (backup.orphans ?? []);
  for (const r of orphanSource) tx.objectStore(ORPHAN_STORE).put({ fileid: r.fileid, name: r.name, ts: r.ts ?? 0 });
  await tx.done;
}

export async function getOrphansPage(offset, limit, fromTs = null, toTs = null) {
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readonly');
  const index = tx.store.index('by_ts');
  const range = (fromTs != null && toTs != null) ? IDBKeyRange.bound(fromTs, toTs) : null;
  let cursor = await index.openCursor(range, 'next');
  if (offset > 0 && cursor) cursor = await cursor.advance(offset);
  const results = [];
  while (cursor && results.length < limit) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

export async function countOrphansInRange(fromTs, toTs) {
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readonly');
  return tx.store.index('by_ts').count(IDBKeyRange.bound(fromTs, toTs));
}

// Returns { min, max } ms timestamps across all dated orphans, or null if none.
export async function getOrphanDateRange() {
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readonly');
  const index = tx.store.index('by_ts');
  const dated = IDBKeyRange.lowerBound(1); // exclude ts=0 (no-date sentinel)
  const minCursor = await index.openCursor(dated, 'next');
  const maxCursor = await index.openCursor(dated, 'prev');
  if (!minCursor || !maxCursor) return null;
  return { min: minCursor.value.ts, max: maxCursor.value.ts };
}
