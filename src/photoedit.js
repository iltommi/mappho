import { downloadFullFile, overwriteFile, getFileStat } from './pcloud.js';
import { injectExif } from './exif.js';
import { syncMapphoOnEdit } from './organize.js';
import { deleteRecord, deleteOrphan, getCached } from './db.js';
import { removeMarker } from './map.js';
import { isVideo } from './mp4.js';
import { viewOpened, viewClosed } from './nav.js';
import { log } from './log.js';
import { createStepProgress, createEditQueue } from './editqueue.js';

const overlay     = document.getElementById('photoedit-overlay');
const canvas      = document.getElementById('photoedit-canvas');
const rotLBtn     = document.getElementById('photoedit-rotl');
const rotRBtn     = document.getElementById('photoedit-rotr');
const flipBtn     = document.getElementById('photoedit-flip');
const enhanceBtn  = document.getElementById('photoedit-enhance');
const saveBtn     = document.getElementById('photoedit-save');
const cancelBtn   = document.getElementById('photoedit-cancel');

let _statusFn = null;
export function setPhotoEditStatusFn(fn) { _statusFn = fn; }

// Drives the app's top progress bar (0–100) while re-uploading the edited
// photo. Optional — falls back to a plain upload with no progress if unset.
let _progressFn = null;
export function setPhotoEditProgressFn(fn) { _progressFn = fn; }

const { setStep, withUploadProgress, setBulkMode } = createStepProgress(() => _progressFn);

let _photo    = null;
let _onSaved  = null;
let _rotation = 0;      // 0 | 90 | 180 | 270
let _flipH    = false;
let _enhanced = false;
let _thumbImg = null;

// ── Enhance ───────────────────────────────────────────────────────────────────

function _buildLUT(hist, n) {
  const clip = Math.ceil(n * 0.02);
  let lo = 0, hi = 255, c = 0;
  for (let i = 0;   i < 256; i++) { c += hist[i]; if (c >= clip) { lo = i; break; } }
  c = 0;
  for (let i = 255; i >= 0;  i--) { c += hist[i]; if (c >= clip) { hi = i; break; } }
  const range = hi - lo || 1;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round((i - lo) * 255 / range)));
  return lut;
}

function _applyEnhance(ctx, w, h) {
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data, n = d.length / 4;
  const hR = new Uint32Array(256), hG = new Uint32Array(256), hB = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { hR[d[i]]++; hG[d[i+1]]++; hB[d[i+2]]++; }
  const lR = _buildLUT(hR, n), lG = _buildLUT(hG, n), lB = _buildLUT(hB, n);
  for (let i = 0; i < d.length; i += 4) { d[i] = lR[d[i]]; d[i+1] = lG[d[i+1]]; d[i+2] = lB[d[i+2]]; }
  ctx.putImageData(id, 0, 0);
}

// ── Preview ───────────────────────────────────────────────────────────────────

function _redraw() {
  if (!_thumbImg?.complete || !_thumbImg.naturalWidth) return;
  const isOdd = _rotation === 90 || _rotation === 270;
  const sw = _thumbImg.naturalWidth, sh = _thumbImg.naturalHeight;
  const cw = isOdd ? sh : sw, ch = isOdd ? sw : sh;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(_rotation * Math.PI / 180);
  if (_flipH) ctx.scale(-1, 1);
  ctx.drawImage(_thumbImg, -sw / 2, -sh / 2);
  ctx.restore();
  if (_enhanced) _applyEnhance(ctx, cw, ch);
}

// ── Controls ──────────────────────────────────────────────────────────────────

rotLBtn.addEventListener('click', () => { _rotation = (_rotation - 90 + 360) % 360; _redraw(); });
rotRBtn.addEventListener('click', () => { _rotation = (_rotation + 90) % 360; _redraw(); });
flipBtn.addEventListener('click', () => { _flipH = !_flipH; _redraw(); });
enhanceBtn.addEventListener('click', () => {
  _enhanced = !_enhanced;
  enhanceBtn.classList.toggle('active', _enhanced);
  _redraw();
});

cancelBtn.addEventListener('click', _close);

// ── Apply (the actual pCloud + organize work for one photo) ───────────────────

// Same rationale as geotag.js's/main.js's identical StaleFileError/
// withStaleCheck: a cached fileid that 404s is permanently gone (pCloud
// never reuses ids), so retrying the same photo can only ever fail again —
// purge the local record now instead of leaving a dead entry that fails the
// exact same way forever.
class StaleFileError extends Error {
  constructor() {
    super('File no longer exists on pCloud');
    this.staleFile = true;
  }
}
async function purgeAndThrowStale(fileid) {
  removeMarker(fileid);
  await Promise.all([deleteRecord(fileid), deleteOrphan(fileid)]).catch(() => {});
  log('photoedit', `Purged stale record — fileid ${fileid} no longer exists on pCloud`);
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

// Downloads, applies rotate/flip/enhance, and re-uploads one photo. Mirrors
// applyGeotagToPhoto/applyFixDateToPhoto's scope exactly (pCloud + organize
// work only) — the caller (main.js's setEditHandler) does local cache/marker
// bookkeeping, same division of labor as those two.
async function applyPhotoEditToPhoto(photo, { rotation, flipH, enhanced }) {
  const { fileid, ts, lat, lng, name } = photo;

  setStep('download');
  const buf = await withStaleCheck(fileid, () => downloadFullFile(fileid));

  setStep('process');
  // Explicit imageOrientation — without it, some WebView versions decode the
  // raw sensor pixels and ignore EXIF Orientation entirely, while the
  // on-screen preview (a plain <img>) always auto-rotates. Without this,
  // that mismatch would bake the wrong rotation into the saved file, and the
  // unconditional Orientation:1 stamp below leaves no EXIF trail to recover
  // the original orientation from afterward.
  const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
  const isOdd = rotation === 90 || rotation === 270;
  const sw = bmp.width, sh = bmp.height;
  const cw = isOdd ? sh : sw, ch = isOdd ? sw : sh;

  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d');
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(rotation * Math.PI / 180);
  if (flipH) ctx.scale(-1, 1);
  ctx.drawImage(bmp, -sw / 2, -sh / 2);
  ctx.restore();
  bmp.close();
  if (enhanced) _applyEnhance(ctx, cw, ch);

  const outBlob = await new Promise((res, rej) =>
    c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/jpeg', 0.92));
  let outBuf = await outBlob.arrayBuffer();

  // preserveFrom carries forward the original file's camera EXIF (make/
  // model, exposure, lens, ...) that the canvas re-encode above discarded —
  // buf is still valid here, the Blob/createImageBitmap calls above copied
  // it rather than consuming it.
  outBuf = injectExif(outBuf, { ts, lat, lng, resetOrientation: true, preserveFrom: buf });

  const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));
  setStep('upload');
  const newFileid = await withUploadProgress(onProgress => overwriteFile(fileid, outBuf, { onProgress }));
  const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
  const syncedName = await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts });

  return { oldFileid: fileid, newFileid, newName: syncedName ?? name, newHash: newHash ?? null, ts, lat, lng };
}

// A photo edit save always queues as a single-item batch — there's no bulk
// photo-edit UI, but routing through the same engine as bulk geotag/fix-date
// gets it the same background-sync protection and resume-after-kill for
// free (see editqueue.js). A second save started while one's already
// uploading would queue behind it rather than race it, though in practice
// that can't happen today since the editor is modal and Save disables itself
// while a save is in flight.
const photoEditQueue = createEditQueue({
  storageKey: 'mappho_pending_photoedit',
  resumeLabel: 'photo edit',
  notificationTitle: 'Mappho — editing photo',
  icon: '✏️',
  verb: () => 'Editing',
  pastVerb: () => 'Edited',
  apply: (photo, params) => applyPhotoEditToPhoto(photo, params),
  statusFn: () => _statusFn,
  progressFn: () => _progressFn,
  bulkModeCtl: { setBulkMode },
  resumeReconstruct: async fileid => {
    const cached = await getCached(fileid);
    return cached ? { fileid: cached.fileid, name: cached.name, ts: cached.ts, lat: cached.lat, lng: cached.lng } : null;
  },
});

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', () => {
  if (!_photo) return;
  const photo = _photo;
  const params = { rotation: _rotation, flipH: _flipH, enhanced: _enhanced };
  // Rendered here (synchronously, before the network work) rather than from
  // the queue's applied result, since it needs the live editor canvas —
  // gone by the time a resumed-after-kill save (no editor open) completes.
  const thumbSrc = canvas.toDataURL('image/jpeg', 0.85);

  saveBtn.disabled = true;
  saveBtn.textContent = '⏳';
  cancelBtn.disabled = true;

  photoEditQueue.enqueue([photo], params, ({ success, results }) => {
    if (success && results[0]) {
      const { newFileid, newName, newHash } = results[0].result;
      _onSaved?.({ newFileid, newName, newHash, thumbSrc });
      _close();
    } else {
      log('photoedit save error', `failed to save ${photo.name}`);
      saveBtn.textContent = '❌ Retry';
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });
});

// ── Open / close ──────────────────────────────────────────────────────────────

function _close() {
  overlay.style.display = 'none';
  viewClosed('photoedit');
  saveBtn.disabled = false;
  saveBtn.textContent = '💾 Save';
  cancelBtn.disabled = false;
  _photo = null; _onSaved = null; _thumbImg = null;
  _rotation = 0; _flipH = false; _enhanced = false;
  enhanceBtn.classList.remove('active');
}

export function openPhotoEdit(photo, thumbSrc, onSaved) {
  if (isVideo(photo.name) || /\.heic$/i.test(photo.name)) return;
  _photo = photo; _onSaved = onSaved;
  _rotation = 0; _flipH = false; _enhanced = false;
  enhanceBtn.classList.remove('active');
  _thumbImg = new Image();
  _thumbImg.onload = _redraw;
  _thumbImg.src = thumbSrc;
  overlay.style.display = 'flex';
  // Back acts like Cancel, but not while a save is in flight.
  viewOpened('photoedit', { close: () => { if (!cancelBtn.disabled) _close(); } });
}

// Offered on next launch if the background-sync service didn't manage to
// keep the app alive through a save after all — see checkPendingResume in
// editqueue.js. No live editor session to resume into after a kill+
// relaunch, so this just re-derives the photo and re-applies the same
// rotation/flip/enhance from scratch (same re-download-and-reapply approach
// geotag/fix-date already use — never trusts stale bytes).
export async function checkPendingPhotoEditResume(reloadFn) {
  await photoEditQueue.checkPendingResume(reloadFn);
}
