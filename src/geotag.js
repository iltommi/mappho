import { parseDateFromFilename, injectGPS, heicToJpeg, fetchHeicExifForPreserve, injectExif } from './exif.js';
import { deleteRecord, deleteOrphan, putCached, getCached, UNDATED_TS, findClosestGeotagged } from './db.js';
import { downloadFullFile, overwriteFile, uploadFile, deleteFile, getFileStat } from './pcloud.js';
import { enterPinDropMode, exitPinDropMode, flyToAndPlacePin, addMarker, removeMarker } from './map.js';
import { syncMapphoOnEdit, ensureInPhotos } from './organize.js';
import { isVideo } from './mp4.js';
import { setVideoMetaEntry } from './videometa.js';
import { flushPhotoIndex } from './photoindex.js';
import { viewOpened, viewClosed } from './nav.js';
import { searchLocation } from './geocode.js';
import { log } from './log.js';
import { askRetry } from './confirm.js';
import { startBackgroundSync, updateBackgroundSync, stopBackgroundSync } from './backgroundsync.js';

const bar        = document.getElementById('pin-drop-bar');
const hintEl     = document.getElementById('pin-drop-hint');
const saveBtn    = document.getElementById('pin-drop-save');
const cancelBtn  = document.getElementById('pin-drop-cancel');
const searchInput = document.getElementById('pin-drop-search');
const searchBtn   = document.getElementById('pin-drop-search-btn');
const resultsEl   = document.getElementById('pin-drop-results');
const skipExistingLabel = document.getElementById('pin-drop-skip-existing-label');
const skipExistingBox   = document.getElementById('pin-drop-skip-existing');

let _statusFn = null;
export function setGeotagStatusFn(fn) { _statusFn = fn; }

// Drives the app's top progress bar (0–100) while re-uploading an edited
// photo. Optional — falls back to a plain upload with no progress if unset.
let _progressFn = null;
export function setGeotagProgressFn(fn) { _progressFn = fn; }

// Tracks a running bulk geotag queue's remaining work in localStorage
// (survives an app kill, unlike anything in-memory) so it can be offered as
// a resume on next launch if the background-sync service didn't manage to
// keep the process alive after all — see resumeBulkGeotag below and
// main.js's startup check. Stored as an array of { lat, lng, fileids }
// batches (one queue can hold several, each with its own target location)
// rather than a single one, now that a second bulk geotag started while one
// is already running joins the queue instead of racing it.
const PENDING_KEY = 'mappho_pending_bulk_geotag';

function savePendingBulkQueue(batches) {
  try {
    if (batches.length) localStorage.setItem(PENDING_KEY, JSON.stringify(batches));
    else localStorage.removeItem(PENDING_KEY);
  } catch {}
}

function clearPendingBulkGeotag() {
  try { localStorage.removeItem(PENDING_KEY); } catch {}
}

// Exported for main.js's startup prompt, when the user declines to resume.
export function discardPendingBulkGeotag() {
  clearPendingBulkGeotag();
}

// Exported for main.js's startup check — just reads, doesn't act. Returns
// an array of { lat, lng, fileids } batches, or null.
export function getPendingBulkGeotag() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed) return null;
    // Back-compat: earlier (single-batch) builds stored one bare object.
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return null; }
}

// Bulk mode runs 2 photos' download/modify/upload concurrently (see
// runBulkGeotagBatch), so a single item's byte-level progress no longer
// means anything on its own — two uploads would just fight over the same
// bar. runBulkGeotagBatch drives the bar itself instead, as a queue-wide
// completed/total, while this suppresses the single-item version for its
// duration.
let _bulkMode = false;

// Drives the progress bar through the 3 stages of applying an edit —
// download, rewrite EXIF, upload — instead of leaving it sitting at 0 until
// the upload starts. Download and EXIF-rewrite have no byte-level progress
// of their own, so those two just jump to their checkpoint; only the upload
// leg (the slow one, and the only one FileTransfer reports progress for)
// actually animates within its 66–100 share.
function setStep(step) {
  if (!_progressFn || _bulkMode) return;
  if (step === 'download') _progressFn(0);
  else if (step === 'process') _progressFn(33);
  else if (step === 'upload')  _progressFn(66);
}

// Wraps an upload call so the progress bar always gets reset once the
// upload settles (success or failure) instead of being left stuck mid-way.
async function withUploadProgress(fn) {
  if (!_progressFn || _bulkMode) return fn(undefined);
  try {
    return await fn((bytes, total) => _progressFn(66 + (total ? (bytes / total) * 34 : 0)));
  } finally {
    _progressFn(0);
  }
}

async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  searchBtn.textContent = '⏳';
  resultsEl.innerHTML = '';
  try {
    const results = await searchLocation(q);
    if (!results.length) {
      resultsEl.textContent = 'No results found.';
    } else {
      for (const r of results) {
        const btn = document.createElement('button');
        btn.className = 'pin-drop-result-btn';
        btn.textContent = r.label;
        btn.addEventListener('click', () => {
          flyToAndPlacePin(r.lat, r.lng);
          resultsEl.innerHTML = '';
          searchInput.value = r.label.split(',')[0].trim();
        });
        resultsEl.appendChild(btn);
      }
    }
  } catch (e) {
    resultsEl.textContent = `Error: ${e.message}`;
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = '🔍';
  }
}

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

let mode          = null; // 'single' | 'bulk'
let pendingPhoto  = null;
let pendingPhotos = null;
let pendingLatLng = null;
let onDone        = null;

function fmtDelta(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60), ss = s % 60;
  if (m < 60)   return `${m}m ${ss}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function startGeotagging(photo, callback) {
  mode          = 'single';
  pendingPhoto  = photo;
  pendingPhotos = null;
  pendingLatLng = null;
  onDone        = callback;

  // Resolve a timestamp to compare with geotagged photos
  const ts = (photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS) ? photo.ts : parseDateFromFilename(photo.name);

  let initialPin = null;
  let hint       = 'Tap map to place pin';

  if (ts) {
    const closest = await findClosestGeotagged(ts);
    if (closest) {
      initialPin = { lat: closest.lat, lng: closest.lng };
      pendingLatLng = initialPin;
      const delta  = fmtDelta(closest.delta);
      const before = ts < closest.ts ? 'before' : 'after';
      hint = `Nearest: ${closest.name} · ${delta} ${before}`;
    }
  }

  hintEl.textContent  = hint;
  saveBtn.disabled    = pendingLatLng === null;
  saveBtn.textContent = '💾 Save';
  bar.style.display   = 'flex';
  document.body.classList.add('action-bar-open');
  viewOpened('pindrop', { close: cancelPinDrop }); // back = Cancel

  enterPinDropMode({
    initialPin,
    onPlace: ({ lat, lng }) => {
      pendingLatLng    = { lat, lng };
      saveBtn.disabled = false;
    },
  });
}

// Places one pin and applies it to every photo in `photos` on save.
// `callback` receives { success, count, failed }.
export async function startBulkGeotagging(photos, callback) {
  mode          = 'bulk';
  pendingPhoto  = null;
  pendingPhotos = photos;
  pendingLatLng = null;
  onDone        = callback;

  const countLabel = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;

  // Suggest a starting pin the same way the single-photo flow does — find
  // the geotagged photo closest in time to the selection's median date, so
  // the map isn't left blank for a batch that's obviously from one outing.
  const validTs = photos
    .map(p => (p.ts && p.ts > 0 && p.ts < UNDATED_TS) ? p.ts : parseDateFromFilename(p.name))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const ts = validTs.length ? validTs[Math.floor(validTs.length / 2)] : null;

  let initialPin = null;
  let hint = `Tap map to place pin for ${countLabel}`;

  if (ts) {
    const closest = await findClosestGeotagged(ts);
    if (closest) {
      initialPin = { lat: closest.lat, lng: closest.lng };
      pendingLatLng = initialPin;
      const delta  = fmtDelta(closest.delta);
      const before = ts < closest.ts ? 'before' : 'after';
      hint = `Nearest: ${closest.name} · ${delta} ${before} — pin for ${countLabel}`;
    }
  }

  hintEl.textContent  = hint;
  saveBtn.disabled    = pendingLatLng === null;
  saveBtn.textContent = '💾 Save';
  bar.style.display   = 'flex';
  document.body.classList.add('action-bar-open');

  // Only relevant (and only shown) when the selection actually mixes
  // located and unlocated photos — e.g. "Same day" pulled in photos that
  // were already geotagged alongside ones that weren't. Defaults to
  // checked: safer for a selection built by a helper like that, and a
  // no-op for the common case (a Fix-position selection) where nothing in
  // the list has a location yet anyway.
  const hasExisting = photos.some(p => p.lat != null);
  skipExistingLabel.style.display = hasExisting ? 'flex' : 'none';
  skipExistingBox.checked = true;
  viewOpened('pindrop', { close: cancelPinDrop }); // back = Cancel

  enterPinDropMode({
    initialPin,
    onPlace: ({ lat, lng }) => {
      pendingLatLng    = { lat, lng };
      saveBtn.disabled = false;
    },
  });
}

// Thrown when a photo's fileid no longer resolves on pCloud (2009) — distinct
// from a generic failure so callers know the local record has already been
// purged (see purgeAndThrowStale) and there's nothing left to retry.
class StaleFileError extends Error {
  constructor() {
    super('File no longer exists on pCloud');
    this.staleFile = true;
  }
}

// A cached fileid that 404s is permanently gone — pCloud never reuses ids —
// so unlike a transient network failure, retrying the same photo can never
// help. Remove it from the local cache/map now rather than leaving a dead
// entry that will just fail the exact same way forever.
async function purgeAndThrowStale(fileid) {
  removeMarker(fileid);
  await Promise.all([deleteRecord(fileid), deleteOrphan(fileid)]).catch(() => {});
  log('Geotag', `Purged stale record — fileid ${fileid} no longer exists on pCloud`);
  throw new StaleFileError();
}

// Runs `fn` (a call that touches `fileid` on pCloud) and turns a 2009 "file
// not found" into the stale-purge path above; any other error propagates as-is.
async function withStaleCheck(fileid, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.pcloudResult === 2009) return purgeAndThrowStale(fileid);
    throw e;
  }
}

// Writes `lat, lng` into one photo (EXIF on pCloud for JPEG/HEIC, cache-only
// for MP4), syncs its Photos copy if any, and updates the local cache/map.
async function applyGeotagToPhoto(photo, lat, lng) {
  const { fileid, name, ts } = photo;
  const realTs = (ts && ts > 0 && ts < UNDATED_TS) ? ts : parseDateFromFilename(name);
  const isHeic = /\.heic$/i.test(name);
  const isMP4  = isVideo(name);

  if (isMP4) {
    removeMarker(fileid);
    await deleteRecord(fileid);
    await deleteOrphan(fileid);
    await putCached({ fileid, name, lat, lng, ts: realTs, hash: photo.hash ?? null, rotation: photo.rotation ?? null });
    addMarker({ fileid, name, lat, lng, ts: realTs, rotation: photo.rotation ?? null });
    await setVideoMetaEntry(fileid, { lat, lng, ts: realTs });
    return { oldFileid: fileid, newFileid: fileid, newName: name, ts: realTs, lat, lng };
  }

  if (isHeic) {
    setStep('download');
    log('Geotag', `HEIC → JPEG: fetching original EXIF…`);
    const preserveFrom = await withStaleCheck(fileid, () => fetchHeicExifForPreserve(fileid));

    log('Geotag', `Downloading ${name}…`);
    const heicBuf = await withStaleCheck(fileid, () => downloadFullFile(fileid));

    setStep('process');
    log('Geotag', 'Converting to JPEG…');
    const jpegBuf = await heicToJpeg(heicBuf);

    log('Geotag', `Injecting EXIF (${lat.toFixed(5)}, ${lng.toFixed(5)})…`);
    const jpegWithExif = injectExif(jpegBuf, { lat, lng, ts: realTs, resetOrientation: true, preserveFrom });

    const jpegName = name.replace(/\.heic$/i, '.jpg');
    const { parentfolderid, hash: oldHash } = await getFileStat(fileid);

    setStep('upload');
    log('Geotag', `Uploading ${jpegName}…`);
    const newFileid = await withUploadProgress(onProgress => uploadFile(parentfolderid, jpegName, jpegWithExif, { onProgress }));

    log('Geotag', `Removing original HEIC…`);
    removeMarker(fileid); // before deleteFile — same race-condition fix as JPEG path
    await deleteFile(fileid);

    const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
    await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts: realTs, newName: jpegName });
    const orgName = await ensureInPhotos({ fileid: newFileid, name: jpegName, ts: realTs, hash: newHash ?? null });
    await deleteRecord(fileid);
    await deleteOrphan(fileid);
    await putCached({ fileid: newFileid, name: orgName ?? jpegName, lat, lng, ts: realTs, hash: newHash ?? null });
    addMarker({ fileid: newFileid, name: orgName ?? jpegName, lat, lng, ts: realTs });
    log('Geotag', `Done — HEIC replaced by ${orgName ?? jpegName} (fileid ${newFileid})`);
    return { oldFileid: fileid, newFileid, newName: orgName ?? jpegName, ts: realTs, lat, lng };
  }

  const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));

  setStep('download');
  log('Geotag', `Downloading ${name}…`);
  const buffer = await withStaleCheck(fileid, () => downloadFullFile(fileid));

  setStep('process');
  log('Geotag', `Injecting GPS ${lat.toFixed(5)}, ${lng.toFixed(5)}…`);
  const modified = injectGPS(buffer, lat, lng);

  // Remove before overwrite: overwriteFile deletes the old file first, so the
  // marker would point to a deleted fileid during the upload + syncMapphoOnEdit
  // round-trips, causing popup opens to hit pCloud 2009 and auto-purge the marker.
  removeMarker(fileid);

  setStep('upload');
  log('Geotag', 'Uploading to pCloud…');
  const newFileid = await withUploadProgress(onProgress => overwriteFile(fileid, modified, { onProgress }));

  const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
  await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts: realTs });
  const orgName = await ensureInPhotos({ fileid: newFileid, name, ts: realTs, hash: newHash ?? null });

  await deleteRecord(fileid);
  await deleteOrphan(fileid);
  await putCached({ fileid: newFileid, name: orgName ?? name, lat, lng, ts: realTs, hash: newHash ?? null });
  addMarker({ fileid: newFileid, name: orgName ?? name, lat, lng, ts: realTs });
  log('Geotag', `Saved — new fileid ${newFileid}${orgName ? ` → organized as ${orgName}` : ''}`);
  return { oldFileid: fileid, newFileid, newName: orgName ?? name, ts: realTs, lat, lng };
}

saveBtn.addEventListener('click', async () => {
  if (!pendingLatLng) return;
  const { lat, lng } = pendingLatLng;

  if (mode === 'bulk') {
    const all = pendingPhotos;
    const cb  = onDone;
    const skipExisting = skipExistingLabel.style.display !== 'none' && skipExistingBox.checked;
    const list = skipExisting ? all.filter(p => p.lat == null) : all;
    const skipped = all.length - list.length;
    finish();
    if (!list.length) {
      _statusFn?.(`📍 All ${skipped} photo${skipped === 1 ? '' : 's'} already had a location — nothing to do.`);
      cb?.({ success: false, count: 0, failed: 0, skipped });
      return;
    }
    enqueueBulkGeotag(list, lat, lng, cb, skipped);
    return;
  }

  if (!pendingPhoto) return;
  saveBtn.disabled    = true;
  saveBtn.textContent = '⏳ Saving…';
  try {
    const r = await applyGeotagToPhoto(pendingPhoto, lat, lng);
    finish();
    flushPhotoIndex();
    onDone?.({ success: true, ...r });
  } catch (e) {
    log('Geotag error', e.message);
    // A stale photo's record is already purged (see applyGeotagToPhoto) —
    // nothing to retry, so close instead of re-enabling Save on a dead photo.
    if (e.staleFile) { finish(); onDone?.({ success: false, stale: true }); return; }
    hintEl.textContent  = `Error: ${e.message}`;
    saveBtn.disabled    = false;
    saveBtn.textContent = '💾 Save';
  }
});

function cancelPinDrop() {
  const wasBulk = mode === 'bulk';
  const cb = onDone;
  finish();
  cb?.(wasBulk ? { success: false, count: 0, failed: 0 } : { success: false });
}
cancelBtn.addEventListener('click', cancelPinDrop);

function finish() {
  exitPinDropMode();
  bar.style.display = 'none';
  document.body.classList.remove('action-bar-open');
  resultsEl.innerHTML = '';
  searchInput.value   = '';
  skipExistingLabel.style.display = 'none';
  mode          = null;
  pendingPhoto  = null;
  pendingPhotos = null;
  pendingLatLng = null;
  // The completion callback decides what shows next (reopen the grid,
  // resume the slideshow) — don't also re-show a hidden parent popup here.
  viewClosed('pindrop', { restoreParent: false });
}

// pCloud doesn't throttle concurrent requests from one account (confirmed
// against another app doing 8 in parallel), so 2 concurrent download/
// modify/upload cycles is safe on that front — the real constraint was
// organize.js's shared name-picking state, now self-serializing internally
// (see withOrganizeLock there) so it's safe regardless of what calls it
// concurrently.
const BULK_CONCURRENCY = 2;

// A second bulk geotag started while one's already running joins this queue
// instead of racing it as a second, competing run — the progress bar,
// resume persistence, and the background-sync service itself are all
// single shared things that only make sense for one run at a time (they'd
// otherwise clobber each other's state, and whichever batch finished first
// would tear down background-sync out from under the other). One session
// drains the whole queue batch after batch; background-sync/progress span
// the session and only tear down once the queue is empty.
const _bulkQueue = []; // batches not yet started: { list, lat, lng, cb, skipped }
let _bulkQueueRunning = false;
let _current = null; // batch actively being processed: { remaining: Set<fileid> }
let _queueTotal     = 0; // grand total across every batch this session has seen
let _queueCompleted = 0; // grand total processed (any outcome) so far this session

function persistBulkQueueState() {
  const batches = [];
  if (_current) batches.push({ lat: _current.lat, lng: _current.lng, fileids: [..._current.remaining] });
  for (const b of _bulkQueue) batches.push({ lat: b.lat, lng: b.lng, fileids: b.list.map(p => p.fileid) });
  savePendingBulkQueue(batches);
}

// Queues a batch to be geotagged to (lat, lng), starting the queue runner if
// it isn't already going. Joining an already-running session updates the
// live status/progress/notification immediately to include the addition,
// rather than waiting for the next processed item to catch up.
export function enqueueBulkGeotag(list, lat, lng, cb, skipped = 0) {
  _bulkQueue.push({ list, lat, lng, cb, skipped });
  _queueTotal += list.length;
  if (_bulkQueueRunning) {
    persistBulkQueueState();
    _statusFn?.(`📍 Placing… ${_queueCompleted}/${_queueTotal} (+${list.length} just added)`, 0);
    updateBackgroundSync('Mappho — geotagging', `Placing… ${_queueCompleted}/${_queueTotal}`);
  } else {
    runBulkQueue();
  }
}

async function runBulkQueue() {
  _bulkQueueRunning = true;
  // No waitForVisible() pause here (unlike bulk fix-date) — the background
  // sync service below is what makes it safe to keep going while hidden;
  // pausing until the app comes back to the foreground would defeat it.
  // Awaited so the foreground service (and its permission prompt, the first
  // time) is fully up before any work starts, not still racing a background
  // tap.
  const protectedRun = await startBackgroundSync('Mappho — geotagging', `Placing… 0/${_queueTotal}`);
  const bgNote = protectedRun ? '' : ' — keep Mappho open, background sync unavailable';
  try {
    while (_bulkQueue.length) {
      const { list, lat, lng, cb, skipped } = _bulkQueue.shift();
      await runBulkGeotagBatch(list, lat, lng, cb, skipped, bgNote);
    }
  } finally {
    _current = null;
    _queueTotal = 0;
    _queueCompleted = 0;
    clearPendingBulkGeotag();
    stopBackgroundSync();
    _bulkQueueRunning = false;
  }
}

// Processes one queued batch to completion, including any retry rounds the
// user asks for — the queue runner above only moves on to the next batch
// once this fully settles, so a retry loops in place rather than (as the
// single-batch version used to) recursing and relying on the caller to stop.
async function runBulkGeotagBatch(initialList, lat, lng, cb, skipped, bgNote) {
  let list = initialList;
  let totalOk = 0, totalStale = 0;

  for (;;) {
    let ok = 0, staleCount = 0;
    const failedItems = [];
    _current = { lat, lng, remaining: new Set(list.map(p => p.fileid)) };
    persistBulkQueueState();

    _bulkMode = true;
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < list.length) {
        const item = list[nextIndex++];
        log('Bulk geotag', item.name);
        try {
          await applyGeotagToPhoto(item, lat, lng);
          ok++;
        } catch (e) {
          // A stale photo's record is already purged (see applyGeotagToPhoto) —
          // it's permanently gone, not a transient failure, so don't offer to
          // retry it: retrying the same dead fileid can only ever fail again.
          if (e.staleFile) { staleCount++; log('Bulk geotag', `${item.name}: no longer exists on pCloud — removed`); }
          else { failedItems.push(item); log('Bulk geotag error', `${item.name}: ${e.message}`); }
        }
        // Recorded as done regardless of outcome — a genuine failure is already
        // captured in failedItems for the retry prompt below, and re-resuming it
        // here too would just fail the exact same way again.
        _queueCompleted++;
        _current.remaining.delete(item.fileid);
        _statusFn?.(`📍 Placing… ${_queueCompleted}/${_queueTotal}${bgNote}`, 0);
        updateBackgroundSync('Mappho — geotagging', `Placing… ${_queueCompleted}/${_queueTotal}`);
        _progressFn?.((_queueCompleted / _queueTotal) * 100);
        persistBulkQueueState();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, list.length) }, worker));
    } finally {
      _bulkMode = false;
      _progressFn?.(0);
    }
    flushPhotoIndex();

    totalOk += ok;
    totalStale += staleCount;
    // skipNote only ever reflects this batch's original skip count — dropped
    // on a retry round (matches the prior single-batch behavior, where the
    // recursive retry call didn't pass skipped through either).
    const skipNote  = skipped > 0 ? ` (${skipped} already located, skipped)` : '';
    const staleNote = totalStale > 0 ? ` (${totalStale} no longer existed, removed)` : '';
    skipped = 0;

    if (failedItems.length > 0) {
      _statusFn?.(`📍 Placed ${totalOk}/${initialList.length} — ${failedItems.length} failed${staleNote}${skipNote}`, 0);
      const retry = await askRetry(failedItems.length, 'photo');
      if (retry) { list = failedItems; continue; }
      cb?.({ success: totalOk > 0, count: totalOk, failed: failedItems.length, stale: totalStale, skipped: 0 });
      return;
    }
    _statusFn?.(`📍 Placed ${totalOk} photo${totalOk !== 1 ? 's' : ''}${staleNote}${skipNote}`, totalStale > 0 ? 6000 : 4000);
    cb?.({ success: totalOk > 0, count: totalOk, failed: 0, stale: totalStale, skipped: 0 });
    return;
  }
}

// Offered on next launch when the background-sync service didn't manage to
// keep the app alive through a whole bulk geotag queue after all (OS memory
// pressure can still win). Re-derives full photo objects for every pending
// batch from the persisted fileids via the cache rather than trying to
// serialize/restore them directly, dropping any that got a location some
// other way or vanished from the cache since, then re-queues whatever's
// left. Returns false (and clears the stale entry either way) if there's
// nothing left worth resuming.
export async function resumeBulkGeotag(callback) {
  const batches = getPendingBulkGeotag();
  clearPendingBulkGeotag();
  if (!batches?.length) return false;

  let queued = false;
  for (const { lat, lng, fileids } of batches) {
    if (!fileids?.length) continue;
    const photos = [];
    for (const fileid of fileids) {
      const cached = await getCached(fileid);
      if (cached && cached.lat == null) photos.push({ fileid: cached.fileid, name: cached.name, ts: cached.ts, hash: cached.hash ?? null });
    }
    if (photos.length) { enqueueBulkGeotag(photos, lat, lng, callback); queued = true; }
  }
  return queued;
}
