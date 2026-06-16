import { listImages, listFolders, createFolderIfNotExists, copyFile, renameFile, deleteFile } from './pcloud.js';
import { getAllCached, getOrphansPage, countOrphans, clearSharphoIndex, bulkPutSharphoIndex, putSharphoIndexEntry, getSharphoIndexEntry, deleteSharphoIndexEntry, UNDATED_TS } from './db.js';
import { log } from './log.js';

const ROOT_NAME = 'SharPho';

// pCloud's `hash` field can come back as a number or string depending on
// endpoint — normalize to string everywhere so it's a stable IndexedDB key.
export function normHash(h) {
  return h != null ? String(h) : null;
}

const UNKNOWN_DATE_FOLDER = 'Unknown date';

let _rootFolderId  = null;
let _unknownFolderId = null;
const _yearFolders  = new Map(); // 'YYYY' -> folderid
const _monthFolders  = new Map(); // 'YYYY-MM' -> folderid
const _nameCounters  = new Map(); // 'YYYY-MM-DD_HH-MM-SS' -> next N to try

// Resolves (creating if needed) SharPho/YYYY/MM, caching folderids for this run.
export async function getSharphoMonthFolder(rootFolderId, ts) {
  const d = new Date(ts);
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

// Resolves (creating if needed) SharPho/Unknown date — for geotagged photos
// with no usable timestamp, which otherwise have nowhere to bucket by date.
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

// Looks up SharPho/'s folderid WITHOUT creating it — used to exclude it from
// the regular scan. Returns null if Organize has never been run.
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

function fmtBase(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function extOf(name) {
  const m = name.match(/\.[^.]+$/);
  return m ? m[0].toLowerCase() : '';
}

// Picks the next unused "BASE_N.ext" name for this exact timestamp, tracking
// counters in-memory for this run only — collisions are checked against the
// live index built from SharPho's own listing, so this is always correct
// even across multiple organize runs.
function nextName(ts, ext, takenNames) {
  const base = fmtBase(ts);
  let n = _nameCounters.get(base) ?? 1;
  let name;
  do {
    name = `${base}_${n}${ext}`;
    n++;
  } while (takenNames.has(name));
  _nameCounters.set(base, n);
  return name;
}

// For geotagged-but-undated photos: no timestamp to build a name from, so
// keep the original filename (deduped against what's already in SharPho).
function nextNameForUnknown(originalName, ext, takenNames) {
  const base = originalName.replace(/\.[^.]+$/, '') || 'photo';
  let name = `${base}${ext}`;
  let n = 1;
  while (takenNames.has(name)) {
    name = `${base}_${n}${ext}`;
    n++;
  }
  return name;
}

// Rebuilds the local hash-index cache from a fresh listing of SharPho/ —
// SharPho's own contents are the ground truth, not our bookkeeping.
export async function buildHashIndex(rootFolderId, onProgress) {
  await clearSharphoIndex();
  const entries = [];
  const takenNames = new Set();
  let count = 0;
  for await (const item of listImages(rootFolderId)) {
    if (!item.hash) continue;
    entries.push({ hash: normHash(item.hash), fileid: item.fileid, folderid: item.parentfolderid, name: item.name });
    takenNames.add(item.name);
    count++;
    if (count % 50 === 0) onProgress?.(count);
  }
  await bulkPutSharphoIndex(entries);
  onProgress?.(count);
  return { count, takenNames };
}

// Photos qualify if they have GPS and/or a real date. STORE holds every
// scanned photo (geotagged or not) so it's restricted to the GPS ones here;
// ORPHAN_STORE holds only non-GPS photos, so a real date is required there —
// this keeps the two loops disjoint (no photo can satisfy both).
async function* allDatedCandidates() {
  for (const p of await getAllCached()) {
    if (p.ignored || p.lat == null) continue;
    yield p;
  }
  const total = await countOrphans();
  const pageSize = 200;
  for (let offset = 0; offset < total; offset += pageSize) {
    const page = await getOrphansPage(offset, pageSize);
    for (const p of page) {
      if (p.ts != null && p.ts !== UNDATED_TS) yield p;
    }
  }
}

// Runs one full organize pass: rebuild the SharPho hash index, then walk every
// dated local record and copy anything not already represented in SharPho.
// `onProgress({ phase, done, total, copied, skipped })` is called periodically.
export async function organize({ onProgress, isCancelled } = {}) {
  const rootFolderId = await getSharphoRoot();

  onProgress?.({ phase: 'indexing', done: 0 });
  const { takenNames } = await buildHashIndex(rootFolderId, done => onProgress?.({ phase: 'indexing', done }));

  const candidates = [];
  for await (const p of allDatedCandidates()) candidates.push(p);

  let copied = 0, skipped = 0, failed = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (isCancelled?.()) break;
    const p = candidates[i];
    onProgress?.({ phase: 'copying', done: i, total: candidates.length, copied, skipped });

    const hash = normHash(p.hash);
    if (!hash) { skipped++; continue; } // not yet rescanned with hash support
    const existing = await getSharphoIndexEntry(hash);
    if (existing) { skipped++; continue; }

    try {
      const hasDate = p.ts != null && p.ts > 0;
      const folderId = hasDate
        ? await getSharphoMonthFolder(rootFolderId, p.ts)
        : await getSharphoUnknownFolder(rootFolderId);
      const name = hasDate
        ? nextName(p.ts, extOf(p.name), takenNames)
        : nextNameForUnknown(p.name, extOf(p.name), takenNames);
      const newFileid = await copyFile(p.fileid, folderId, name);
      takenNames.add(name);
      await putSharphoIndexEntry({ hash, fileid: newFileid, folderid: folderId, name });
      copied++;
    } catch (e) {
      log('Organize error', `${p.name}: ${e.message}`);
      failed++;
    }
  }

  onProgress?.({ phase: 'done', done: candidates.length, total: candidates.length, copied, skipped, failed });
  return { copied, skipped, failed };
}

// ── Edit-time sync ─────────────────────────────────────────────────────────
// Called by geotag.js / the fix-date handler right after a content-mutating
// edit completes. If the pre-edit hash was already represented in SharPho,
// refresh that slot in place (and move it if the date bucket changed) instead
// of waiting for the next organize pass — which would otherwise see the new
// hash as "unrelated new content" and copy it again, leaving a stale orphan
// copy behind.
export async function syncSharphoOnEdit({ oldHash, newFileid, newHash, ts }) {
  oldHash = normHash(oldHash);
  newHash = normHash(newHash);
  if (!oldHash) return;
  const existing = await getSharphoIndexEntry(oldHash);
  if (!existing) return;

  try {
    const rootFolderId = await getSharphoRoot();
    const monthFolderId = (ts != null && ts > 0)
      ? await getSharphoMonthFolder(rootFolderId, ts)
      : await getSharphoUnknownFolder(rootFolderId);

    if (monthFolderId === existing.folderid && newHash === oldHash) {
      return; // nothing actually changed — same content, same bucket
    }

    if (monthFolderId === existing.folderid) {
      // Same bucket: delete the stale copy first, then copy fresh content into
      // its slot — copyFile would otherwise collide with the name still in use.
      await deleteFile(existing.fileid);
      const refreshedFileid = await copyFile(newFileid, monthFolderId, existing.name);
      await deleteSharphoIndexEntry(oldHash);
      await putSharphoIndexEntry({ hash: newHash, fileid: refreshedFileid, folderid: monthFolderId, name: existing.name });
    } else {
      // Date moved: relocate to the new YYYY/MM bucket, keep the name.
      await renameFile(existing.fileid, { tofolderid: monthFolderId });
      await deleteSharphoIndexEntry(oldHash);
      await putSharphoIndexEntry({ hash: newHash, fileid: existing.fileid, folderid: monthFolderId, name: existing.name });
    }
  } catch (e) {
    log('SharPho sync error', e.message);
  }
}
