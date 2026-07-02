import { parseDateFromFilename, injectGPS, heicToJpeg, extractHeicMeta, injectExif } from './exif.js';
import { deleteRecord, deleteOrphan, putCached, UNDATED_TS } from './db.js';
import { downloadFullFile, overwriteFile, uploadFile, deleteFile, getFileStat } from './pcloud.js';
import { enterPinDropMode, exitPinDropMode, flyToAndPlacePin, addMarker, removeMarker, findClosestMarker } from './map.js';
import { syncMapphoOnEdit, ensureInPhotos } from './organize.js';
import { isVideo } from './mp4.js';
import { setVideoMetaEntry } from './videometa.js';
import { flushPhotoIndex } from './photoindex.js';
import { searchLocation } from './geocode.js';
import { log } from './log.js';
import { askRetry, waitForVisible } from './confirm.js';

const bar        = document.getElementById('pin-drop-bar');
const hintEl     = document.getElementById('pin-drop-hint');
const saveBtn    = document.getElementById('pin-drop-save');
const cancelBtn  = document.getElementById('pin-drop-cancel');
const searchInput = document.getElementById('pin-drop-search');
const searchBtn   = document.getElementById('pin-drop-search-btn');
const resultsEl   = document.getElementById('pin-drop-results');

let _statusFn = null;
export function setGeotagStatusFn(fn) { _statusFn = fn; }

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
  const ts = (photo.ts && photo.ts > 0) ? photo.ts : parseDateFromFilename(photo.name);

  let initialPin = null;
  let hint       = 'Tap map to place pin';

  if (ts) {
    const closest = findClosestMarker(ts);
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

  hintEl.textContent  = `Tap map to place pin for ${photos.length} photo${photos.length === 1 ? '' : 's'}`;
  saveBtn.disabled    = true;
  saveBtn.textContent = '💾 Save';
  bar.style.display   = 'flex';
  document.body.classList.add('action-bar-open');

  enterPinDropMode({
    initialPin: null,
    onPlace: ({ lat, lng }) => {
      pendingLatLng    = { lat, lng };
      saveBtn.disabled = false;
    },
  });
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
    await putCached({ fileid, name, lat, lng, ts: realTs });
    addMarker({ fileid, name, lat, lng, ts: realTs });
    await setVideoMetaEntry(fileid, { lat, lng, ts: realTs });
    return;
  }

  if (isHeic) {
    log('Geotag', `HEIC → JPEG: fetching metadata…`);
    const meta = await extractHeicMeta(fileid);

    log('Geotag', `Downloading ${name}…`);
    const heicBuf = await downloadFullFile(fileid);

    log('Geotag', 'Converting to JPEG…');
    const jpegBuf = await heicToJpeg(heicBuf);

    log('Geotag', `Injecting EXIF (${lat.toFixed(5)}, ${lng.toFixed(5)})…`);
    const jpegWithExif = injectExif(jpegBuf, { lat, lng, ts: realTs, make: meta.Make, model: meta.Model });

    const jpegName = name.replace(/\.heic$/i, '.jpg');
    const { parentfolderid, hash: oldHash } = await getFileStat(fileid);

    log('Geotag', `Uploading ${jpegName}…`);
    const newFileid = await uploadFile(parentfolderid, jpegName, jpegWithExif);

    log('Geotag', `Removing original HEIC…`);
    removeMarker(fileid); // before deleteFile — same race-condition fix as JPEG path
    await deleteFile(fileid);

    const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
    await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts: realTs });
    const orgName = await ensureInPhotos({ fileid: newFileid, name: jpegName, ts: realTs, hash: newHash ?? null });
    await deleteRecord(fileid);
    await deleteOrphan(fileid);
    await putCached({ fileid: newFileid, name: orgName ?? jpegName, lat, lng, ts: realTs, hash: newHash ?? null });
    addMarker({ fileid: newFileid, name: orgName ?? jpegName, lat, lng, ts: realTs });
    log('Geotag', `Done — HEIC replaced by ${orgName ?? jpegName} (fileid ${newFileid})`);
    return;
  }

  const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));

  log('Geotag', `Downloading ${name}…`);
  const buffer = await downloadFullFile(fileid);

  log('Geotag', `Injecting GPS ${lat.toFixed(5)}, ${lng.toFixed(5)}…`);
  const modified = injectGPS(buffer, lat, lng);

  // Remove before overwrite: overwriteFile deletes the old file first, so the
  // marker would point to a deleted fileid during the upload + syncMapphoOnEdit
  // round-trips, causing popup opens to hit pCloud 2009 and auto-purge the marker.
  removeMarker(fileid);

  log('Geotag', 'Uploading to pCloud…');
  const newFileid = await overwriteFile(fileid, modified);

  const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
  await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts: realTs });
  const orgName = await ensureInPhotos({ fileid: newFileid, name, ts: realTs, hash: newHash ?? null });

  await deleteRecord(fileid);
  await deleteOrphan(fileid);
  await putCached({ fileid: newFileid, name: orgName ?? name, lat, lng, ts: realTs, hash: newHash ?? null });
  addMarker({ fileid: newFileid, name: orgName ?? name, lat, lng, ts: realTs });
  log('Geotag', `Saved — new fileid ${newFileid}${orgName ? ` → organized as ${orgName}` : ''}`);
}

saveBtn.addEventListener('click', async () => {
  if (!pendingLatLng) return;
  const { lat, lng } = pendingLatLng;

  if (mode === 'bulk') {
    const list = pendingPhotos;
    const cb   = onDone;
    finish();
    _runBulkGeotag(list, lat, lng, cb);
    return;
  }

  if (!pendingPhoto) return;
  saveBtn.disabled    = true;
  saveBtn.textContent = '⏳ Saving…';
  try {
    await applyGeotagToPhoto(pendingPhoto, lat, lng);
    finish();
    flushPhotoIndex().catch(e => log('PhotoIndex flush error', e.message));
    onDone?.({ success: true });
  } catch (e) {
    log('Geotag error', e.message);
    hintEl.textContent  = `Error: ${e.message}`;
    saveBtn.disabled    = false;
    saveBtn.textContent = '💾 Save';
  }
});

cancelBtn.addEventListener('click', () => {
  const wasBulk = mode === 'bulk';
  finish();
  onDone?.(wasBulk ? { success: false, count: 0, failed: 0 } : { success: false });
});

function finish() {
  exitPinDropMode();
  bar.style.display = 'none';
  document.body.classList.remove('action-bar-open');
  resultsEl.innerHTML = '';
  searchInput.value   = '';
  mode          = null;
  pendingPhoto  = null;
  pendingPhotos = null;
  pendingLatLng = null;
}

async function _runBulkGeotag(list, lat, lng, cb) {
  let ok = 0;
  const failedItems = [];
  for (let i = 0; i < list.length; i++) {
    await waitForVisible();
    _statusFn?.(`📍 Placing… ${i + 1}/${list.length}`, 0);
    log('Bulk geotag', `${i + 1}/${list.length}: ${list[i].name}`);
    try {
      await applyGeotagToPhoto(list[i], lat, lng);
      ok++;
    } catch (e) {
      failedItems.push(list[i]);
      log('Bulk geotag error', `${list[i].name}: ${e.message}`);
    }
  }
  flushPhotoIndex();

  if (failedItems.length > 0) {
    _statusFn?.(`📍 Placed ${ok}/${list.length} — ${failedItems.length} failed`, 0);
  } else {
    _statusFn?.(`📍 Placed ${ok} photo${ok !== 1 ? 's' : ''}`, 4000);
  }

  if (failedItems.length > 0) {
    const retry = await askRetry(failedItems.length, 'photo');
    if (retry) { _runBulkGeotag(failedItems, lat, lng, cb); return; }
  }
  cb?.({ success: ok > 0, count: ok, failed: failedItems.length });
}
