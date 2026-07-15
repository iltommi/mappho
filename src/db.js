import { openDB } from 'idb';

const DB_NAME = 'mappho';
const DB_VERSION = 11;
const STORE = 'photos';
const ORPHAN_STORE = 'orphans';
const MAPPHO_INDEX_STORE = 'mappho_index';
const FACES_STORE = 'faces';
const LOCATIONS_STORE = 'locations';
const EMBEDDINGS_STORE = 'embeddings_blob';
const EMBEDDINGS_KEY = 'current'; // single record — the whole quantized matrix as one blob, not one row per photo
const TEXT_MODEL_STORE = 'text_model_files'; // key = relative filename (e.g. 'onnx/text_model_quantized.onnx'), value = ArrayBuffer

// Sentinel used in place of ts=0 for orphans with no known date, so they sort
// to the end of the by_ts index instead of poisoning the front of date-sorted
// listings (e.g. the grid view). Exported so callers can recognize/query
// "no real date" orphans (e.g. the by_ts index has no concept of null).
export const UNDATED_TS = Number.MAX_SAFE_INTEGER;

let _db;
async function db() {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    async upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        db.createObjectStore(STORE, { keyPath: 'fileid' });
      }
      if (oldVersion < 2) {
        const s = db.createObjectStore(ORPHAN_STORE, { keyPath: 'fileid' });
        s.createIndex('by_ts', 'ts');
      }
      if (oldVersion < 3) {
        const store = tx.objectStore(STORE);
        store.createIndex('by_ignored', 'ignored');
        // IDB indexes require numeric keys; migrate any boolean ignored:true → 1
        let cursor = await store.openCursor();
        while (cursor) {
          if (cursor.value.ignored === true) await cursor.update({ ...cursor.value, ignored: 1 });
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 4) {
        db.createObjectStore(MAPPHO_INDEX_STORE, { keyPath: 'hash' });
      }
      if (oldVersion < 5) {
        tx.objectStore(STORE).createIndex('by_ts', 'ts');
      }
      if (oldVersion < 6) {
        const store = tx.objectStore(ORPHAN_STORE);
        let cursor = await store.openCursor();
        while (cursor) {
          if (!cursor.value.ts) await cursor.update({ ...cursor.value, ts: UNDATED_TS });
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 7) {
        // UNDATED_TS must never leak into the geotagged STORE; if it did (old
        // geotag bug), normalise those records back to ts=null so they are
        // treated as "located, no date" consistently everywhere.
        const store = tx.objectStore(STORE);
        let cursor = await store.openCursor();
        while (cursor) {
          if (cursor.value.ts === UNDATED_TS) await cursor.update({ ...cursor.value, ts: null });
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 8) {
        db.createObjectStore(FACES_STORE, { keyPath: 'hash' });
      }
      if (oldVersion < 9) {
        db.createObjectStore(LOCATIONS_STORE, { keyPath: 'hash' });
      }
      if (oldVersion < 10) {
        db.createObjectStore(EMBEDDINGS_STORE);
      }
      if (oldVersion < 11) {
        db.createObjectStore(TEXT_MODEL_STORE);
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

export async function bulkPutCached(records) {
  if (!records.length) return;
  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  for (const r of records) tx.store.put(r);
  await tx.done;
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

export async function clearNonIgnored() {
  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  const saved = await tx.store.index('by_ignored').getAll(IDBKeyRange.only(1));
  await tx.store.clear();
  for (const r of saved) tx.store.put(r);
  await tx.done;
}

// Orphans: photos without GPS, indexed by ts for sorted pagination.
// ts is stored as ts ?? UNDATED_TS so null dates sort to the end and remain indexable.

export async function putOrphan({ fileid, name, ts, hash, rotation }) {
  return (await db()).put(ORPHAN_STORE, { fileid, name, ts: ts ?? UNDATED_TS, hash: hash ?? null, rotation: rotation ?? null });
}

export async function bulkPutOrphans(records) {
  if (!records.length) return;
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readwrite');
  for (const r of records) tx.store.put({ fileid: r.fileid, name: r.name, ts: r.ts ?? UNDATED_TS, hash: r.hash ?? null, rotation: r.rotation ?? null });
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

export async function ignorePhoto(fileid) {
  const d = await db();
  const tx = d.transaction([STORE, ORPHAN_STORE], 'readwrite');
  const existing = await tx.objectStore(STORE).get(fileid);
  if (existing) tx.objectStore(STORE).put({ ...existing, ignored: 1 });
  tx.objectStore(ORPHAN_STORE).delete(fileid);
  await tx.done;
}

export async function countIgnored() {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  return tx.store.index('by_ignored').count(IDBKeyRange.only(1));
}

export async function getIgnoredPage(offset, limit) {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  let cursor = await tx.store.index('by_ignored').openCursor(IDBKeyRange.only(1));
  if (offset > 0 && cursor) cursor = await cursor.advance(offset);
  const results = [];
  while (cursor && results.length < limit) {
    results.push(cursor.value);
    cursor = await cursor.continue();
  }
  return results;
}

// Returns every ignored photo, unpaginated. Ignored records aren't indexed
// by ts on their own, so "Same day" filters this full set client-side —
// fine since the ignored set is a deliberately curated, generally small one.
export async function getAllIgnored() {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  return tx.store.index('by_ignored').getAll(IDBKeyRange.only(1));
}

// Clears the ignored flag and, for photos without GPS, restores the orphan row
// so the photo reappears in the fix-up lists. Returns the updated record.
export async function unignorePhoto(fileid) {
  const d = await db();
  const tx = d.transaction([STORE, ORPHAN_STORE], 'readwrite');
  const existing = await tx.objectStore(STORE).get(fileid);
  if (!existing) { await tx.done; return null; }
  const { ignored, ...rest } = existing; // dropping the key removes it from by_ignored
  tx.objectStore(STORE).put(rest);
  if (rest.lat == null) {
    tx.objectStore(ORPHAN_STORE).put({ fileid: rest.fileid, name: rest.name, ts: rest.ts ?? UNDATED_TS, hash: rest.hash ?? null });
  }
  await tx.done;
  return rest;
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

// Returns every orphan (no GPS) with ts in [fromTs, toTs], unpaginated. Meant
// for small, inherently bounded ranges — e.g. "every dated-but-unlocated
// photo from one calendar day" — where a full fetch is cheap and pagination
// would just get in the way of selecting the whole set at once.
export async function getOrphansInRange(fromTs, toTs) {
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readonly');
  return tx.store.index('by_ts').getAll(IDBKeyRange.bound(fromTs, toTs));
}

export async function countOrphansInRange(fromTs, toTs) {
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readonly');
  return tx.store.index('by_ts').count(IDBKeyRange.bound(fromTs, toTs));
}

// Counts geotagged (non-ignored) photos in STORE with ts in [fromTs, toTs].
export async function countGeotaggedInRange(fromTs, toTs) {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  let cursor = await tx.store.index('by_ts').openCursor(IDBKeyRange.bound(fromTs, toTs));
  let count = 0;
  while (cursor) {
    if (cursor.value.lat != null && cursor.value.ignored !== 1) count++;
    cursor = await cursor.continue();
  }
  return count;
}

// Every cached (non-ignored) photo regardless of category — the "Total" tile
// view in Settings. A plain cursor scan rather than the by_ts index: ts can
// be null for some records (e.g. located-but-undated ones), and null isn't a
// valid IDB key so those would silently drop out of an index-based query.
// Sorted by fileid (the store's natural key order) rather than chronologically.
export async function countAllNonIgnored() {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  let cursor = await tx.store.openCursor();
  let count = 0;
  while (cursor) {
    if (cursor.value.ignored !== 1) count++;
    cursor = await cursor.continue();
  }
  return count;
}

export async function getAllNonIgnoredPage(offset, limit) {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  let cursor = await tx.store.openCursor();
  const results = [];
  let skipped = 0;
  while (cursor) {
    if (cursor.value.ignored !== 1) {
      if (skipped < offset) { skipped++; }
      else { results.push(cursor.value); if (results.length >= limit) break; }
    }
    cursor = await cursor.continue();
  }
  return results;
}

// Photos with both GPS and a real date — "Position & Date" in Settings.
// Unlike countAllNonIgnored above, this subset is defined by having a valid
// ts, so the by_ts index (chronological order, like every other grid) is
// safe to use here. Count via the existing countGeotaggedInRange(1, UNDATED_TS-1)
// — same predicate, no need for a separate counter.
export async function getPositionAndDatePage(offset, limit) {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  let cursor = await tx.store.index('by_ts').openCursor(IDBKeyRange.bound(1, UNDATED_TS - 1));
  const results = [];
  let skipped = 0;
  while (cursor) {
    if (cursor.value.lat != null && cursor.value.ignored !== 1) {
      if (skipped < offset) { skipped++; }
      else { results.push(cursor.value); if (results.length >= limit) break; }
    }
    cursor = await cursor.continue();
  }
  return results;
}

export async function countLocatedUndated() {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  let cursor = await tx.store.openCursor();
  let count = 0;
  while (cursor) {
    const v = cursor.value;
    if (v.lat != null && v.ignored !== 1 && !(v.ts > 0 && v.ts < UNDATED_TS)) count++;
    cursor = await cursor.continue();
  }
  return count;
}

export async function getLocatedUndatedPage(offset, limit) {
  const d = await db();
  const tx = d.transaction(STORE, 'readonly');
  let cursor = await tx.store.openCursor();
  const results = [];
  let skipped = 0;
  while (cursor) {
    const v = cursor.value;
    if (v.lat != null && v.ignored !== 1 && !(v.ts > 0 && v.ts < UNDATED_TS)) {
      if (skipped < offset) { skipped++; }
      else { results.push(v); if (results.length >= limit) break; }
    }
    cursor = await cursor.continue();
  }
  return results;
}

// Mappho hash index: hash -> { hash, fileid, folderid, name }.
// Rebuilt from a fresh listfolder of Photos/ at the start of every organize pass
// (Photos' own contents are the ground truth), but cached here so edit-time
// sync hooks (geotag/fix-date) can look up "is this hash already organized?"
// without a full re-listing.

export async function clearMapphoIndex() {
  return (await db()).clear(MAPPHO_INDEX_STORE);
}

export async function putMapphoIndexEntry(entry) {
  return (await db()).put(MAPPHO_INDEX_STORE, entry);
}

export async function bulkPutMapphoIndex(entries) {
  if (!entries.length) return;
  const d = await db();
  const tx = d.transaction(MAPPHO_INDEX_STORE, 'readwrite');
  for (const e of entries) tx.store.put(e);
  await tx.done;
}

export async function getAllMapphoIndex() {
  return (await db()).getAll(MAPPHO_INDEX_STORE);
}

export async function getMapphoIndexEntry(hash) {
  if (!hash) return null;
  return (await db()).get(MAPPHO_INDEX_STORE, hash);
}

export async function deleteMapphoIndexEntry(hash) {
  if (!hash) return;
  return (await db()).delete(MAPPHO_INDEX_STORE, hash);
}

export async function countMapphoIndex() {
  return (await db()).count(MAPPHO_INDEX_STORE);
}

// Faces index: hash → { hash, name, path, width, height, faces: [{person,x,y,w,h}] }.
// Local mirror of Photos/faces.json, which is generated by the external
// face-recognition tool; the app re-keys/renames/removes entries when it
// edits, moves or deletes photos so the two stay joined by content hash.

export async function getFacesEntry(hash) {
  if (!hash) return null;
  return (await db()).get(FACES_STORE, hash);
}

export async function putFacesEntry(entry) {
  return (await db()).put(FACES_STORE, entry);
}

export async function deleteFacesEntry(hash) {
  if (!hash) return;
  return (await db()).delete(FACES_STORE, hash);
}

export async function countFaces() {
  return (await db()).count(FACES_STORE);
}

export async function getAllFaces() {
  return (await db()).getAll(FACES_STORE);
}

export async function clearFaces() {
  return (await db()).clear(FACES_STORE);
}

export async function bulkPutFaces(entries) {
  if (!entries.length) return;
  const d = await db();
  const tx = d.transaction(FACES_STORE, 'readwrite');
  for (const e of entries) tx.store.put(e);
  await tx.done;
}

// Locations index: hash → { hash, name, path, uuid, tags: [{category,score}] }.
// Local mirror of Photos/locations.json (scene/place classification, generated
// by an external tool); the app re-keys/renames/removes entries when it
// edits, moves or deletes photos so the two stay joined by content hash.

export async function getLocationsEntry(hash) {
  if (!hash) return null;
  return (await db()).get(LOCATIONS_STORE, hash);
}

export async function putLocationsEntry(entry) {
  return (await db()).put(LOCATIONS_STORE, entry);
}

export async function deleteLocationsEntry(hash) {
  if (!hash) return;
  return (await db()).delete(LOCATIONS_STORE, hash);
}

export async function countLocations() {
  return (await db()).count(LOCATIONS_STORE);
}

export async function getAllLocations() {
  return (await db()).getAll(LOCATIONS_STORE);
}

export async function clearLocations() {
  return (await db()).clear(LOCATIONS_STORE);
}

export async function bulkPutLocations(entries) {
  if (!entries.length) return;
  const d = await db();
  const tx = d.transaction(LOCATIONS_STORE, 'readwrite');
  for (const e of entries) tx.store.put(e);
  await tx.done;
}

// The synced CLIP photo-embeddings matrix, stored as a single blob rather
// than one record per photo — a search scans every row on every query, so
// one contiguous typed array beats tens of thousands of individual IDB
// reads. See embeddings.js for the sync/parse logic.

export async function getEmbeddingsBlob() {
  return (await db()).get(EMBEDDINGS_STORE, EMBEDDINGS_KEY);
}

export async function putEmbeddingsBlob(blob) {
  return (await db()).put(EMBEDDINGS_STORE, blob, EMBEDDINGS_KEY);
}

export async function clearEmbeddingsBlob() {
  return (await db()).delete(EMBEDDINGS_STORE, EMBEDDINGS_KEY);
}

// The synced CLIP text-tower model files (config/tokenizer/onnx) — a
// handful of records, one per filename, unlike the single-blob embeddings
// matrix above. See textembed.js for the sync/loading logic.

export async function getAllTextModelFiles() {
  const d = await db();
  const keys = await d.getAllKeys(TEXT_MODEL_STORE);
  const values = await d.getAll(TEXT_MODEL_STORE);
  return new Map(keys.map((k, i) => [k, values[i]]));
}

export async function putTextModelFile(name, buf) {
  return (await db()).put(TEXT_MODEL_STORE, buf, name);
}

export async function clearTextModelFiles() {
  return (await db()).clear(TEXT_MODEL_STORE);
}

// Returns { min, max } ms timestamps across all dated orphans, or null if none.
export async function getOrphanDateRange() {
  const d = await db();
  const tx = d.transaction(ORPHAN_STORE, 'readonly');
  const index = tx.store.index('by_ts');
  const dated = IDBKeyRange.bound(1, UNDATED_TS - 1); // exclude the no-date sentinel at the top end too
  const minCursor = await index.openCursor(dated, 'next');
  const maxCursor = await index.openCursor(dated, 'prev');
  if (!minCursor || !maxCursor) return null;
  return { min: minCursor.value.ts, max: maxCursor.value.ts };
}
