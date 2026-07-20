import { registerPlugin } from '@capacitor/core';
import { downloadFullFile, overwriteFile, getFileStat, bufToBase64, base64ToArrayBuffer } from './pcloud.js';
import { injectExif } from './exif.js';
import { syncMapphoOnEdit } from './organize.js';
import { deleteRecord, deleteOrphan, getCached } from './db.js';
import { removeMarker } from './map.js';
import { isVideo } from './mp4.js';
import { log } from './log.js';
import { createStepProgress, createEditQueue } from './editqueue.js';

// Native (Android-only) bridge to MediaExchangePlugin.java's editExternally —
// hands a photo to whatever editor app the user picks (Google Photos,
// Snapseed, the stock Gallery editor, ...) via Intent.ACTION_EDIT and reads
// back whatever it leaves behind. See that plugin's own comments for the
// "editors don't all honor the same return contract" caveats — { changed:
// false } covers both "user cancelled" and "editor didn't cooperate", which
// this module treats identically (a clean no-op, not an error).
const MediaExchange = registerPlugin('MediaExchange');

let _statusFn = null;
export function setExternalEditStatusFn(fn) { _statusFn = fn; }

let _progressFn = null;
export function setExternalEditProgressFn(fn) { _progressFn = fn; }

const { setStep, withUploadProgress, setBulkMode } = createStepProgress(() => _progressFn);

// Same rationale as geotag.js's/main.js's/photoedit.js's identical
// StaleFileError/withStaleCheck: a cached fileid that 404s is permanently
// gone, so retrying can only ever fail again — purge the local record now.
class StaleFileError extends Error {
  constructor() {
    super('File no longer exists on pCloud');
    this.staleFile = true;
  }
}
async function purgeAndThrowStale(fileid) {
  removeMarker(fileid);
  await Promise.all([deleteRecord(fileid), deleteOrphan(fileid)]).catch(() => {});
  log('externaledit', `Purged stale record — fileid ${fileid} no longer exists on pCloud`);
  throw new StaleFileError();
}
async function withStaleCheck(fileid, fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.pcloudResult === 2009) return purgeAndThrowStale(fileid);
    throw e;
  }
}

// Uploads whatever bytes the external editor handed back. Mirrors
// applyGeotagToPhoto/applyFixDateToPhoto/applyPhotoEditToPhoto's scope
// exactly (pCloud + organize work only, no local cache/marker writes — the
// caller does that, same division of labor as the other three). Unlike the
// in-app editor, this can't preserveFrom the original camera EXIF (make/
// model/lens, ...) — the external app may have already altered or dropped
// it, so injectExif here only guarantees Mappho's own tracked ts/lat/lng
// survive, not necessarily everything else.
async function applyExternalEditToPhoto(photo, { editedBase64 }) {
  const { fileid, ts, lat, lng, name } = photo;

  setStep('process');
  let outBuf = base64ToArrayBuffer(editedBase64);
  outBuf = injectExif(outBuf, { ts, lat, lng, resetOrientation: true });

  const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));
  setStep('upload');
  const newFileid = await withStaleCheck(fileid, () =>
    withUploadProgress(onProgress => overwriteFile(fileid, outBuf, { onProgress })));
  const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
  const syncedName = await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts });

  return { oldFileid: fileid, newFileid, newName: syncedName ?? name, newHash: newHash ?? null, ts, lat, lng };
}

// A single photo hand-off always queues as a one-item batch — there's no
// bulk "send 10 photos to another app" flow here, but routing through the
// same engine as bulk geotag/fix-date/photo-edit gets the upload leg the
// same background-sync protection and resume-after-kill for free (see
// editqueue.js). Unlike the other three kinds, a resumed batch here would
// persist the *edited bytes themselves* (base64) in localStorage rather
// than just a small identifier — fine for one typical phone photo;
// editqueue.js's save() already fails silently if that ever blew past the
// browser's storage quota, degrading to "no resume offered" rather than
// crashing, so this isn't specially handled here.
const externalEditQueue = createEditQueue({
  storageKey: 'mappho_pending_externaledit',
  resumeLabel: 'external photo edit',
  notificationTitle: 'Mappho — saving edited photo',
  icon: '🔗',
  verb: () => 'Saving',
  pastVerb: () => 'Saved',
  apply: (photo, params) => applyExternalEditToPhoto(photo, params),
  statusFn: () => _statusFn,
  progressFn: () => _progressFn,
  bulkModeCtl: { setBulkMode },
  resumeReconstruct: async fileid => {
    const cached = await getCached(fileid);
    return cached ? { fileid: cached.fileid, name: cached.name, ts: cached.ts, lat: cached.lat, lng: cached.lng } : null;
  },
});

// Downloads the photo, hands it to whatever editor the user picks, and — if
// they actually saved something — queues the upload. `onDone` receives
// either the queue's usual batch result, or { success:false, cancelled:true
// } if the user backed out / the editor didn't return anything usable (see
// MediaExchangePlugin's own comment on why that's not treated as an error).
export async function startExternalEdit(photo, onDone) {
  if (isVideo(photo.name) || /\.heic$/i.test(photo.name)) {
    onDone?.({ success: false, unsupported: true });
    return;
  }
  try {
    const buf = await withStaleCheck(photo.fileid, () => downloadFullFile(photo.fileid));
    const result = await MediaExchange.editExternally({
      base64Data: bufToBase64(buf),
      filename: photo.name,
      mimeType: 'image/jpeg',
    });
    if (!result?.changed) {
      onDone?.({ success: false, cancelled: true });
      return;
    }
    externalEditQueue.enqueue([photo], { editedBase64: result.base64Data }, onDone);
  } catch (e) {
    if (e.staleFile) { onDone?.({ success: false, stale: true }); return; }
    log('externaledit', `start failed: ${e.message}`);
    onDone?.({ success: false, error: e.message });
  }
}

export async function checkPendingExternalEditResume(reloadFn) {
  await externalEditQueue.checkPendingResume(reloadFn);
}
