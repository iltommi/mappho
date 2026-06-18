import { listImages, listFolders, createFolderIfNotExists, renameFile, deleteFile, copyFile, downloadJsonFile, uploadJsonToFolder } from './pcloud.js';
import { clearSharphoIndex, bulkPutSharphoIndex, putSharphoIndexEntry, getSharphoIndexEntry, deleteSharphoIndexEntry } from './db.js';
import { updateMarkerName } from './map.js';
import { log } from './log.js';

const ROOT_NAME = 'Photos';

export function normHash(h) {
  return h != null ? String(h) : null;
}

const UNKNOWN_DATE_FOLDER = 'Unknown';

let _rootFolderId    = null;
let _unknownFolderId = null;
const _yearFolders   = new Map(); // 'YYYY' -> folderid
const _monthFolders  = new Map(); // 'YYYY-MM' -> folderid
const _nameCounters  = new Map(); // 'YYYY-MM-DD_HH-MM-SS' -> next N to try

// ── Hash index ────────────────────────────────────────────────────────────────

const HASH_INDEX_FILENAME   = 'hash-index.json';
const HASH_INDEX_FILEID_KEY = 'sharpho_hash_index_fileid';

const _hashMap    = new Map(); // hash → { fileid, folderid, name }
const _takenNames = new Set(); // filenames currently in Photos/
let _hashFileid   = null;
let _hashDirty    = false;
let _indexReady   = false;

// ── Folder helpers ────────────────────────────────────────────────────────────

export async function getSharphoMonthFolder(rootFolderId, ts) {
  const d    = new Date(ts);
  const yyyy = String(d.getFullYear());
  const mm   = String(d.getMonth() + 1).padStart(2, '0');

  let yearId = _yearFolders.get(yyyy);
  if (yearId == null) {
    yearId = await createFolderIfNotExists(rootFolderId, yyyy);
    _yearFolders.set(yyyy, yearId);
  }
  const key = `${yyyy}-${mm}`;
  let monthId = _monthFolders.get(key);
  if (monthId == null) {
    monthId = await createFolderIfNotExists(yearId, mm);
    _monthFolders.set(key, monthId);
  }
  return monthId;
}

async function getSharphoUnknownFolder(rootFolderId) {
  if (_unknownFolderId == null) {
    _unknownFolderId = await createFolderIfNotExists(rootFolderId, UNKNOWN_DATE_FOLDER);
  }
  return _unknownFolderId;
}

export async function getSharphoRoot() {
  if (_rootFolderId != null) return _rootFolderId;
  _rootFolderId = await createFolderIfNotExists(0, ROOT_NAME);
  return _rootFolderId;
}

export async function findSharphoRootIfExists() {
  if (_rootFolderId != null) return _rootFolderId;
  try {
    const folders = await listFolders(0);
    const found = folders.find(f => f.name === ROOT_NAME);
    if (found) _rootFolderId = found.folderid;
    return _rootFolderId;
  } catch {
    return null;
  }
}

// ── Name helpers ──────────────────────────────────────────────────────────────

function fmtBase(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function extOf(name) {
  const m = name.match(/\.[^.]+$/);
  return m ? m[0].toLowerCase() : '';
}

function nextName(ts, ext) {
  const base = fmtBase(ts);
  let n = _nameCounters.get(base) ?? 1;
  let name;
  do { name = `${base}_${n}${ext}`; n++; } while (_takenNames.has(name));
  _nameCounters.set(base, n);
  return name;
}

function nextNameForUnknown(originalName, ext) {
  const base = originalName.replace(/\.[^.]+$/, '') || 'photo';
  let name = `${base}${ext}`;
  let n = 1;
  while (_takenNames.has(name)) { name = `${base}_${n}${ext}`; n++; }
  return name;
}

// ── Hash index management ─────────────────────────────────────────────────────

// Rebuilds the hash index from a fresh Photos/ listing.
// Also populates the in-memory _hashMap and _takenNames.
export async function buildHashIndex(rootFolderId, onProgress) {
  await clearSharphoIndex();
  _hashMap.clear();
  _takenNames.clear();
  const entries = [];
  let count = 0;
  for await (const item of listImages(rootFolderId)) {
    if (!item.hash) continue;
    const e = { hash: normHash(item.hash), fileid: item.fileid, folderid: item.parentfolderid, name: item.name };
    entries.push(e);
    _hashMap.set(e.hash, { fileid: e.fileid, folderid: e.folderid, name: e.name });
    _takenNames.add(item.name);
    count++;
    if (count % 50 === 0) onProgress?.(count);
  }
  await bulkPutSharphoIndex(entries);
  onProgress?.(count);
  return { count, takenNames: _takenNames };
}

// Loads the hash index from the persisted JSON on pCloud, falling back to a
// full Photos/ listing if the file is absent or corrupt.
export async function loadOrganizeIndex(rootFolderId, onProgress, { forceRebuild = false } = {}) {
  _hashMap.clear();
  _takenNames.clear();
  _hashDirty  = false;
  _indexReady = false;

  const stored = !forceRebuild && localStorage.getItem(HASH_INDEX_FILEID_KEY);
  if (stored) {
    _hashFileid = Number(stored);
    try {
      const data = await downloadJsonFile(_hashFileid);
      if (Array.isArray(data?.entries)) {
        const idbEntries = [];
        for (const e of data.entries) {
          _hashMap.set(e.hash, { fileid: e.fileid, folderid: e.folderid, name: e.name });
          _takenNames.add(e.name);
          idbEntries.push(e);
        }
        await clearSharphoIndex();
        await bulkPutSharphoIndex(idbEntries);
        _indexReady = true;
        log('HashIndex', `loaded ${_hashMap.size} entries from JSON`);
        onProgress?.(_hashMap.size);
        return;
      }
    } catch (e) {
      log('HashIndex', `JSON load failed (${e.message}) — rebuilding from Photos/`);
      _hashFileid = null;
      localStorage.removeItem(HASH_INDEX_FILEID_KEY);
    }
  }

  // Fallback: full Photos/ listing
  _hashDirty = true;
  const { count } = await buildHashIndex(rootFolderId, onProgress);
  _indexReady = true;
  log('HashIndex', `built ${count} entries from Photos/ listing`);
}

// Saves the in-memory index to pCloud as JSON. No-op if nothing changed.
export async function flushOrganizeIndex(rootFolderId) {
  if (!_hashDirty) return;
  const entries = [..._hashMap.entries()].map(([hash, v]) => ({ hash, ...v }));
  try {
    const json = JSON.stringify({ version: 1, entries });
    const newFileid = await uploadJsonToFolder(rootFolderId, HASH_INDEX_FILENAME, json, _hashFileid);
    _hashFileid = newFileid;
    if (newFileid) localStorage.setItem(HASH_INDEX_FILEID_KEY, String(newFileid));
    _hashDirty = false;
    log('HashIndex', `flushed ${entries.length} entries`);
  } catch (e) {
    log('HashIndex flush error', e.message);
  }
}

// Resets per-scan folder/name caches without touching the hash index.
export function resetOrganizeState() {
  _yearFolders.clear();
  _monthFolders.clear();
  _nameCounters.clear();
  _unknownFolderId = null;
}

// Fast check: is this hash already represented in Photos/?
// Use as a pre-lock guard in processFile to skip the serialize queue for known duplicates.
export function isHashOrganized(hash) {
  return hash != null && _hashMap.has(hash);
}

// Organizes one file into Photos/YYYY/MM/ with a date-based name.
// Must be called inside a serialisation lock (see main.js) so that _takenNames
// and _nameCounters are never updated by two concurrent calls at once.
// Returns the new name on success, null if already organized or doesn't qualify.
export async function organizeFile(record, rootFolderId) {
  const hash = record.hash;

  // Double-check inside the lock (another concurrent processFile may have just organized this hash)
  if (hash && _hashMap.has(hash)) return null;

  const hasDate = record.ts != null && record.ts > 0;
  const hasGps  = record.lat != null;

  const folderId = hasDate
    ? await getSharphoMonthFolder(rootFolderId, record.ts)
    : await getSharphoUnknownFolder(rootFolderId);

  const name = hasDate
    ? nextName(record.ts, extOf(record.name))
    : nextNameForUnknown(record.name, extOf(record.name));

  await renameFile(record.fileid, { tofolderid: folderId, toname: name });

  _takenNames.add(name);
  if (hash) {
    _hashMap.set(hash, { fileid: record.fileid, folderid: folderId, name });
    _hashDirty = true;
    await putSharphoIndexEntry({ hash, fileid: record.fileid, folderid: folderId, name });
  }
  return name;
}

// Removes a file's entry from the hash index when the file is deleted.
// Without this, a re-added identical file would be silently skipped by scan.
export async function removeOrganizedEntry(fileid) {
  let foundHash = null;
  let foundName = null;
  for (const [hash, entry] of _hashMap) {
    if (entry.fileid === fileid) { foundHash = hash; foundName = entry.name; break; }
  }
  if (!foundHash) return;
  _hashMap.delete(foundHash);
  if (foundName) _takenNames.delete(foundName);
  _hashDirty = true;
  await deleteSharphoIndexEntry(foundHash);
  try {
    const root = await getSharphoRoot();
    await flushOrganizeIndex(root);
  } catch (e) {
    log('HashIndex remove flush error', e.message);
  }
}

// ── Edit-time sync ─────────────────────────────────────────────────────────────
// Called after a content-mutating edit (geotag/fix-date). If the pre-edit hash
// was already in Photos/, refresh that slot without waiting for the next scan.
export async function syncSharphoOnEdit({ oldHash, newFileid, newHash, ts }) {
  oldHash = normHash(oldHash);
  newHash = normHash(newHash);
  if (!oldHash) return;
  const existing = _hashMap.get(oldHash) ?? await getSharphoIndexEntry(oldHash);
  if (!existing) return;

  try {
    const rootFolderId   = await getSharphoRoot();
    const monthFolderId  = (ts != null && ts > 0)
      ? await getSharphoMonthFolder(rootFolderId, ts)
      : await getSharphoUnknownFolder(rootFolderId);

    if (monthFolderId === existing.folderid && newHash === oldHash) return;

    if (monthFolderId === existing.folderid) {
      await deleteFile(existing.fileid);
      const refreshedFileid = await copyFile(newFileid, monthFolderId, existing.name);
      await deleteSharphoIndexEntry(oldHash);
      await putSharphoIndexEntry({ hash: newHash, fileid: refreshedFileid, folderid: monthFolderId, name: existing.name });
      _hashMap.delete(oldHash);
      _hashMap.set(newHash, { fileid: refreshedFileid, folderid: monthFolderId, name: existing.name });
    } else {
      await renameFile(existing.fileid, { tofolderid: monthFolderId });
      await deleteSharphoIndexEntry(oldHash);
      await putSharphoIndexEntry({ hash: newHash, fileid: existing.fileid, folderid: monthFolderId, name: existing.name });
      _hashMap.delete(oldHash);
      _hashMap.set(newHash, { fileid: existing.fileid, folderid: monthFolderId, name: existing.name });
    }
    _hashDirty = true;
  } catch (e) {
    log('SharPho sync error', e.message);
  }
}
