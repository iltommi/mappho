import { parseDateFromFilename, injectGPS, heicToJpeg, extractHeicMeta, injectExif } from './exif.js';
import { deleteRecord, deleteOrphan, putCached } from './db.js';
import { downloadFullFile, overwriteFile, uploadFile, deleteFile, getFileStat } from './pcloud.js';
import { enterPinDropMode, exitPinDropMode, addMarker, findClosestMarker } from './map.js';
import { syncSharphoOnEdit } from './organize.js';
import { setVideoMetaEntry } from './videometa.js';
import { flushPhotoIndex } from './photoindex.js';
import { log } from './log.js';

const bar      = document.getElementById('pin-drop-bar');
const hintEl   = document.getElementById('pin-drop-hint');
const saveBtn  = document.getElementById('pin-drop-save');
const cancelBtn = document.getElementById('pin-drop-cancel');

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
// for MP4), syncs its SharPho copy if any, and updates the local cache/map.
async function applyGeotagToPhoto(photo, lat, lng) {
  const { fileid, name, ts } = photo;
  const realTs = (ts && ts > 0) ? ts : parseDateFromFilename(name);
  const isHeic = /\.heic$/i.test(name);
  const isMP4  = /\.(mp4|mov|3gp|3gpp)$/i.test(name);

  if (isMP4) {
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
    await deleteFile(fileid);

    const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
    await syncSharphoOnEdit({ oldHash, newFileid, newHash, ts: realTs });

    await deleteRecord(fileid);
    await deleteOrphan(fileid);
    await putCached({ fileid: newFileid, name: jpegName, lat, lng, ts: realTs, hash: newHash ?? null });
    addMarker({ fileid: newFileid, name: jpegName, lat, lng, ts: realTs });
    log('Geotag', `Done — HEIC replaced by ${jpegName} (fileid ${newFileid})`);
    return;
  }

  const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));

  log('Geotag', `Downloading ${name}…`);
  const buffer = await downloadFullFile(fileid);

  log('Geotag', `Injecting GPS ${lat.toFixed(5)}, ${lng.toFixed(5)}…`);
  const modified = injectGPS(buffer, lat, lng);

  log('Geotag', 'Uploading to pCloud…');
  const newFileid = await overwriteFile(fileid, modified);

  const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
  await syncSharphoOnEdit({ oldHash, newFileid, newHash, ts: realTs });

  await deleteRecord(fileid);
  await deleteOrphan(fileid);
  await putCached({ fileid: newFileid, name, lat, lng, ts: realTs, hash: newHash ?? null });
  addMarker({ fileid: newFileid, name, lat, lng, ts: realTs });
  log('Geotag', `Saved — new fileid ${newFileid}`);
}

saveBtn.addEventListener('click', async () => {
  if (!pendingLatLng) return;
  const { lat, lng } = pendingLatLng;

  if (mode === 'bulk') {
    const list = pendingPhotos;
    saveBtn.disabled = true;
    let ok = 0, failed = 0;
    for (let i = 0; i < list.length; i++) {
      saveBtn.textContent = `⏳ ${i + 1}/${list.length}…`;
      try {
        await applyGeotagToPhoto(list[i], lat, lng);
        ok++;
      } catch (e) {
        failed++;
        log('Bulk geotag error', `${list[i].name}: ${e.message}`);
      }
    }
    finish();
    flushPhotoIndex().catch(e => log('PhotoIndex flush error', e.message));
    onDone?.({ success: ok > 0, count: ok, failed });
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
  mode          = null;
  pendingPhoto  = null;
  pendingPhotos = null;
  pendingLatLng = null;
}
