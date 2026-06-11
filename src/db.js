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

export async function countOrphans() {
  return (await db()).count(ORPHAN_STORE);
}

export async function clearOrphans() {
  return (await db()).clear(ORPHAN_STORE);
}

export async function getOrphansPage(offset, limit) {
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readonly');
  const index = tx.store.index('by_ts');
  let cursor = await index.openCursor(null, 'next');
  if (offset > 0 && cursor) cursor = await cursor.advance(offset);
  const results = [];
  while (cursor && results.length < limit) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}
