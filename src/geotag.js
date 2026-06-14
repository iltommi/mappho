import { parseDateFromFilename, injectGPS } from './exif.js';
import { findClosestGeotagged, deleteRecord, deleteOrphan, putCached } from './db.js';
import { downloadFullFile, overwriteFile } from './pcloud.js';
import { enterPinDropMode, exitPinDropMode, addMarker } from './map.js';
import { log } from './log.js';

const bar      = document.getElementById('pin-drop-bar');
const hintEl   = document.getElementById('pin-drop-hint');
const saveBtn  = document.getElementById('pin-drop-save');
const cancelBtn = document.getElementById('pin-drop-cancel');

let pendingPhoto  = null;
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
  pendingPhoto  = photo;
  pendingLatLng = null;
  onDone        = callback;

  // Resolve a timestamp to compare with geotagged photos
  const ts = (photo.ts && photo.ts > 0) ? photo.ts : parseDateFromFilename(photo.name);

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

  enterPinDropMode({
    initialPin,
    onPlace: ({ lat, lng }) => {
      pendingLatLng    = { lat, lng };
      saveBtn.disabled = false;
    },
  });
}

saveBtn.addEventListener('click', async () => {
  if (!pendingPhoto || !pendingLatLng) return;
  saveBtn.disabled    = true;
  saveBtn.textContent = '⏳ Saving…';

  const { fileid, name, ts } = pendingPhoto;
  const { lat, lng }         = pendingLatLng;

  try {
    const realTs = (ts && ts > 0) ? ts : parseDateFromFilename(name);
    const isHeic = /\.heic$/i.test(name);

    if (isHeic) {
      // HEIC files cannot have GPS injected — save location in local cache only.
      log('Geotag', `HEIC: saving GPS to cache only (file on pCloud unchanged)`);
      await deleteRecord(fileid);
      await deleteOrphan(fileid);
      await putCached({ fileid, name, lat, lng, ts: realTs });
      addMarker({ fileid, name, lat, lng, ts: realTs });
    } else {
      log('Geotag', `Downloading ${name}…`);
      const buffer = await downloadFullFile(fileid);

      log('Geotag', `Injecting GPS ${lat.toFixed(5)}, ${lng.toFixed(5)}…`);
      const modified = injectGPS(buffer, lat, lng);

      log('Geotag', 'Uploading to pCloud…');
      const newFileid = await overwriteFile(fileid, modified);

      await deleteRecord(fileid);
      await deleteOrphan(fileid);
      await putCached({ fileid: newFileid, name, lat, lng, ts: realTs });
      addMarker({ fileid: newFileid, name, lat, lng, ts: realTs });
      log('Geotag', `Saved — new fileid ${newFileid}`);
    }

    finish();
    onDone?.({ success: true });
  } catch (e) {
    log('Geotag error', e.message);
    hintEl.textContent  = `Error: ${e.message}`;
    saveBtn.disabled    = false;
    saveBtn.textContent = '💾 Save';
  }
});

cancelBtn.addEventListener('click', () => {
  finish();
  onDone?.({ success: false });
});

function finish() {
  exitPinDropMode();
  bar.style.display = 'none';
  pendingPhoto  = null;
  pendingLatLng = null;
}
