import { toDateStr } from './filter.js';
import { getFileStat, downloadFullFile, overwriteFile, copyFile, uploadFile, deleteFile } from './pcloud.js';
import { heicToJpeg, injectExif, fetchHeicExifForPreserve } from './exif.js';
import { isVideo } from './mp4.js';
import { removeMarker, addMarker } from './map.js';
import { getMapphoRoot, getMapphoMonthFolder, syncMapphoOnEdit } from './organize.js';
import { updateCurrentSlideshowItem } from './slideshow.js';
import { getCached, putCached, putOrphan, deleteRecord, deleteOrphan, UNDATED_TS } from './db.js';
import { createStepProgress, createEditQueue } from './editqueue.js';
import { log } from './log.js';
import { viewOpened, viewClosed } from './nav.js';

const fixDateBar      = document.getElementById('fix-date-bar');
const fixDateHint     = document.getElementById('fix-date-hint');
const fixDateInputsEl = document.getElementById('fix-date-inputs');
const fixDateInput    = document.getElementById('fix-date-input');
const fixDateTimeInput = document.getElementById('fix-date-time-input');
const fixDateSaveBtn  = document.getElementById('fix-date-save');
const fixDateCancelBtn = document.getElementById('fix-date-cancel');
const fixDateShiftRow  = document.getElementById('fix-date-shift-row');
const fixDateShiftDays = document.getElementById('fix-date-shift-days');
const fixDateShiftPrev = document.getElementById('fix-date-shift-prev');
const fixDateShiftNext = document.getElementById('fix-date-shift-next');
const fixTimeShiftRow     = document.getElementById('fix-time-shift-row');
const fixTimeShiftHours   = document.getElementById('fix-time-shift-hours');
const fixTimeShiftHrPrev  = document.getElementById('fix-time-shift-hr-prev');
const fixTimeShiftHrNext  = document.getElementById('fix-time-shift-hr-next');
const fixTimeShiftMinutes = document.getElementById('fix-time-shift-minutes');
const fixTimeShiftMinPrev = document.getElementById('fix-time-shift-min-prev');
const fixTimeShiftMinNext = document.getElementById('fix-time-shift-min-next');
const fixDateApplyModeRow  = document.getElementById('fix-date-apply-mode-row');
const fixDateModeFixed     = document.getElementById('fix-date-mode-fixed');
const fixDateModeShift     = document.getElementById('fix-date-mode-shift');
const fixDateShiftPreview  = document.getElementById('fix-date-shift-preview');
const fixDateKeepTimeLabel = document.getElementById('fix-date-keep-time-label');
const fixDateKeepTime      = document.getElementById('fix-date-keep-time');

// Drives the app's persistent status line (e.g. "nothing to shift" messages).
let _statusFn = null;
export function setFixDateStatusFn(fn) { _statusFn = fn; }

// Drives transient toast-style messages (invalid input, failure notices).
let _briefStatusFn = null;
export function setFixDateBriefStatusFn(fn) { _briefStatusFn = fn; }

// Drives the app's top progress bar (0–100) while re-uploading an edited photo.
let _progressFn = null;
export function setFixDateProgressFn(fn) { _progressFn = fn; }

// Called after a successful single-photo edit, before the completion
// callback fires — refreshes the Settings/Info popup's counters.
let _reloadCountsFn = null;
export function setFixDateReloadCountsFn(fn) { _reloadCountsFn = fn; }

// Bulk mode ('both') offers a choice the other modes don't need: apply one
// fixed date/time to every selected photo, or shift each photo by an amount
// relative to its own current date (e.g. a camera clock that was
// consistently N hours/days off) — very different results for a batch that
// doesn't already share one date. Single-photo modes don't need the choice:
// "shift this one photo's date" and "set this one photo's date" already
// converge to the same field edit, which shiftFixDateTime below still does.
function isBulkShiftMode() { return fixDateMode === 'both' && fixDateModeShift.checked; }

// "Fixed date/time" mode's own sub-choice: apply the same date to everyone
// but let each photo keep its own time-of-day, instead of also collapsing
// the time to one shared value. (Single-photo 'date' mode already does this
// unconditionally — see fixDateSaveBtn's mode==='date' branch below — this
// checkbox is only needed in bulk, where "fixed" otherwise means both
// fields are shared.)
function isBulkKeepTimeMode() { return fixDateMode === 'both' && fixDateModeFixed.checked && fixDateKeepTime.checked; }

// Pending per-photo shift, only meaningful in bulk-shift mode — unlike
// shiftFixDateTime (which edits the single shared date/time value Save
// applies to everyone), these are a delta applied to *each* photo's own ts.
let _pendingShiftDays = 0, _pendingShiftHours = 0, _pendingShiftMinutes = 0;

function updateShiftPreview() {
  if (!isBulkShiftMode()) { fixDateShiftPreview.style.display = 'none'; return; }
  const parts = [];
  if (_pendingShiftDays)    parts.push(`${_pendingShiftDays > 0 ? '+' : ''}${_pendingShiftDays}d`);
  if (_pendingShiftHours)   parts.push(`${_pendingShiftHours > 0 ? '+' : ''}${_pendingShiftHours}h`);
  if (_pendingShiftMinutes) parts.push(`${_pendingShiftMinutes > 0 ? '+' : ''}${_pendingShiftMinutes}m`);
  fixDateShiftPreview.textContent = parts.length ? `Shift: ${parts.join(' ')}` : 'No shift set yet — tap ‹ or › below';
  fixDateShiftPreview.style.display = '';
}

// Bulk mode shows only the controls that matter for whichever choice is
// selected — the absolute date/time pickers for "fixed", or the day/hour/
// minute shift controls for "shift" — rather than both at once. Within
// "fixed", the time input additionally hides when "keep each photo's own
// time" is checked, since that field's value wouldn't be used at save time.
function applyDateModeVisibility() {
  const shift = isBulkShiftMode();
  fixDateInputsEl.style.display  = shift ? 'none' : 'flex';
  fixDateShiftRow.style.display  = shift ? 'flex' : 'none';
  fixTimeShiftRow.style.display  = shift ? 'flex' : 'none';
  fixDateKeepTimeLabel.style.display = shift ? 'none' : '';
  fixDateTimeInput.style.display = isBulkKeepTimeMode() ? 'none' : '';
  updateShiftPreview();
}
fixDateModeFixed.addEventListener('change', applyDateModeVisibility);
fixDateModeShift.addEventListener('change', applyDateModeVisibility);
fixDateKeepTime.addEventListener('change', applyDateModeVisibility);

// Nudges the date/time inputs by the given offsets — a quick fix for a
// whole batch that's systematically off by a known amount (e.g. a camera
// clock set to the wrong date/time), without hand-picking a new value.
// fixDateInput can be blank in fix-time-only mode (its value isn't used at
// save time there — the save handler takes the date straight from the
// photo's own ts instead — see fixDateSaveBtn below), so fall back to
// today's date as an arbitrary base just for the hour/minute arithmetic to
// wrap correctly; a shift big enough to roll into a different day only
// matters when the date input is actually visible (fix-date/bulk modes).
function shiftFixDateTime({ days = 0, hours = 0, minutes = 0 }) {
  const time = fixDateTimeInput.value || '12:00';
  const dateStr = fixDateInput.value || toDateStr(Date.now());
  const base = new Date(`${dateStr}T${time}`);
  base.setDate(base.getDate() + days);
  base.setHours(base.getHours() + hours);
  base.setMinutes(base.getMinutes() + minutes);
  fixDateInput.value = toDateStr(base.getTime());
  fixDateTimeInput.value = `${String(base.getHours()).padStart(2, '0')}:${String(base.getMinutes()).padStart(2, '0')}`;
}
// `|| 1` would coerce an explicitly-typed 0 back to 1 (0 is falsy in JS) —
// checked separately so 0 is a real, tappable shift amount, not just "blank".
const shiftN = el => {
  const n = parseInt(el.value, 10);
  return Number.isNaN(n) ? 1 : Math.max(0, n);
};

// Each button either nudges the single shared date/time value (fixed mode,
// or single-photo modes where there's no separate "shift" concept) or sets
// this unit's pending per-photo delta (bulk-shift mode) — set, not
// accumulated, so the last tap for a given unit is what's applied.
function handleShiftTap(unit, dir, countEl) {
  const n = dir * shiftN(countEl);
  if (isBulkShiftMode()) {
    if (unit === 'days') _pendingShiftDays = n;
    else if (unit === 'hours') _pendingShiftHours = n;
    else _pendingShiftMinutes = n;
    updateShiftPreview();
  } else {
    shiftFixDateTime({ [unit]: n });
  }
}
fixDateShiftPrev.addEventListener('click', () => handleShiftTap('days', -1, fixDateShiftDays));
fixDateShiftNext.addEventListener('click', () => handleShiftTap('days', 1, fixDateShiftDays));
fixTimeShiftHrPrev.addEventListener('click', () => handleShiftTap('hours', -1, fixTimeShiftHours));
fixTimeShiftHrNext.addEventListener('click', () => handleShiftTap('hours', 1, fixTimeShiftHours));
fixTimeShiftMinPrev.addEventListener('click', () => handleShiftTap('minutes', -1, fixTimeShiftMinutes));
fixTimeShiftMinNext.addEventListener('click', () => handleShiftTap('minutes', 1, fixTimeShiftMinutes));

let fixDateMode    = 'date'; // 'date' | 'time' | 'both'
let fixDatePhoto   = null;
let fixDatePhotos  = null; // bulk mode
let fixDateOnDone  = null;
let _lastFixDateTs = null; // ts of the last successfully saved fix-date

function showFixDateBar() {
  fixDateBar.style.display = 'flex';
  document.body.classList.add('action-bar-open');
  viewOpened('fixdate', { close: cancelFixDate }); // back = Cancel
}

function hideFixDateBar() {
  fixDateBar.style.display = 'none';
  document.body.classList.remove('action-bar-open');
  // The completion callback decides what shows next (reopen the slideshow,
  // restore the grid) — don't also re-show a hidden parent popup here.
  viewClosed('fixdate', { restoreParent: false });
}

function cancelFixDate() {
  hideFixDateBar();
  const wasBulk = !!fixDatePhotos;
  const cb = fixDateOnDone;
  fixDatePhoto  = null;
  fixDatePhotos = null;
  fixDateOnDone = null;
  cb?.(wasBulk ? { success: false, count: 0, failed: 0 } : { success: false });
}

// Thrown when a photo's fileid no longer resolves on pCloud (2009) — see
// geotag.js's identical StaleFileError/withStaleCheck for the rationale
// (pCloud never reuses ids, so a 404 here is permanent, not transient).
class StaleFileError extends Error {
  constructor() {
    super('File no longer exists on pCloud');
    this.staleFile = true;
  }
}

async function purgeAndThrowStale(fileid) {
  removeMarker(fileid);
  await Promise.all([deleteRecord(fileid), deleteOrphan(fileid)]).catch(() => {});
  log('Fix date', `Purged stale record — fileid ${fileid} no longer exists on pCloud`);
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

const { setStep, withUploadProgress, setBulkMode: setFixDateBulkMode } = createStepProgress(() => _progressFn);

async function applyFixDateToPhoto(photo, ts) {
  const { fileid, name } = photo;
  const isHeic = /\.heic$/i.test(name);
  const isMP4  = isVideo(name);
  log('Fix date', `start ${name} (${fileid})`);

  let newFileid = fileid;
  let newName   = name;
  let newHash   = null;

  let syncedName = null;
  if (isMP4) {
    log('Fix date', 'stat (mp4)');
    const { hash } = await getFileStat(fileid).catch(() => ({}));
    newHash = hash ?? null;
    log('Fix date', 'sync organize');
    syncedName = await syncMapphoOnEdit({ oldHash: newHash, newFileid: fileid, newHash, ts });
  } else if (isHeic) {
    setStep('download');
    log('Fix date', 'extract HEIC meta');
    const preserveFrom = await withStaleCheck(fileid, () => fetchHeicExifForPreserve(fileid));
    log('Fix date', 'stat (heic)');
    const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));
    log('Fix date', 'download HEIC');
    const heicBuf = await withStaleCheck(fileid, () => downloadFullFile(fileid));
    setStep('process');
    log('Fix date', `convert to JPEG (${heicBuf.byteLength}B)`);
    const jpegBuf = await heicToJpeg(heicBuf);
    const jpegWithExif = injectExif(jpegBuf, { ts, resetOrientation: true, preserveFrom });
    newName = name.replace(/\.heic$/i, '.jpg');
    log('Fix date', 'stat for parent folder');
    const { parentfolderid } = await getFileStat(fileid);
    setStep('upload');
    log('Fix date', `upload JPEG ${newName}`);
    newFileid = await withUploadProgress(onProgress => uploadFile(parentfolderid, newName, jpegWithExif, { onProgress }));
    log('Fix date', `delete original HEIC ${fileid}`);
    await deleteFile(fileid);
    log('Fix date', 'stat new file');
    ({ hash: newHash } = await getFileStat(newFileid).catch(() => ({})));
    log('Fix date', 'sync organize');
    syncedName = await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts, newName });
  } else {
    log('Fix date', 'stat (jpeg)');
    const stat = await getFileStat(fileid).catch(() => ({}));
    const oldHash = stat.hash ?? null;

    // Determine whether the file moves to a different month folder.
    const rootFolderId = await getMapphoRoot();
    const targetFolderId = (stat.parentfolderid != null && ts != null)
      ? await getMapphoMonthFolder(rootFolderId, ts).catch(() => null)
      : null;

    if (targetFolderId != null && targetFolderId !== stat.parentfolderid) {
      // Cross-month: server-side copy to the destination folder first.
      // The original survives until the modified copy is verified and the index
      // is updated, so any failure up to that point leaves the data recoverable.
      setStep('download');
      log('Fix date', `cross-month copy to folder ${targetFolderId}`);
      const copyFileid = await withStaleCheck(fileid, () => copyFile(fileid, targetFolderId));
      log('Fix date', `copy ${copyFileid} — verifying`);
      await getFileStat(copyFileid);
      log('Fix date', 'download copy');
      const buffer = await downloadFullFile(copyFileid);
      setStep('process');
      log('Fix date', `inject EXIF (${buffer.byteLength}B)`);
      const modified = injectExif(buffer, { ts });
      setStep('upload');
      log('Fix date', 'overwrite copy');
      newFileid = await withUploadProgress(onProgress => overwriteFile(copyFileid, modified, { onProgress }));
      log('Fix date', 'stat modified copy');
      ({ hash: newHash } = await getFileStat(newFileid).catch(() => ({})));
      log('Fix date', 'sync organize');
      syncedName = await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts });
      // syncMapphoOnEdit's different-folder branch renames newFileid to the canonical
      // name and then deletes the original. If the rename throws, the original is
      // untouched and newFileid remains as an untracked copy in targetFolderId.
    } else {
      // Same month: content change in place.
      setStep('download');
      log('Fix date', 'download');
      const buffer = await withStaleCheck(fileid, () => downloadFullFile(fileid));
      setStep('process');
      log('Fix date', `inject EXIF (${buffer.byteLength}B)`);
      const modified = injectExif(buffer, { ts });
      setStep('upload');
      log('Fix date', 'overwrite');
      newFileid = await withUploadProgress(onProgress => overwriteFile(fileid, modified, { onProgress }));
      log('Fix date', 'stat new file');
      ({ hash: newHash } = await getFileStat(newFileid).catch(() => ({})));
      log('Fix date', 'sync organize');
      syncedName = await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts });
    }
  }

  // Use the canonical name that syncMapphoOnEdit assigned in Photos/,
  // falling back to the locally computed newName if the file wasn't in Photos/.
  const canonicalName = syncedName ?? newName;
  log('Fix date', 'update cache');
  const cached = await getCached(fileid);
  await deleteRecord(fileid);
  await deleteOrphan(fileid);
  if (cached) await putCached({ ...cached, fileid: newFileid, name: canonicalName, ts, hash: newHash ?? cached.hash ?? null });
  // Photos without GPS live in both stores; without this the photo would
  // drop out of the no-location lists until the next app restart re-migrates it.
  if (!cached || cached.lat == null) await putOrphan({ fileid: newFileid, name: canonicalName, ts, hash: newHash ?? cached?.hash ?? null, rotation: cached?.rotation ?? null });
  log('Fix date', `done → newFileid=${newFileid} name=${canonicalName}`);
  return { oldFileid: fileid, newFileid, newName: canonicalName, ts, lat: cached?.lat ?? null, lng: cached?.lng ?? null };
}

export function startFixDate(photo, onDone) {
  fixDateMode   = 'date';
  fixDatePhoto  = photo;
  fixDatePhotos = null;
  fixDateOnDone = onDone;
  const hasOwnDate = photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS;
  const seed = hasOwnDate ? new Date(photo.ts) : (_lastFixDateTs ? new Date(_lastFixDateTs) : new Date());
  fixDateInput.value     = toDateStr(seed.getTime());
  fixDateInputsEl.style.display  = 'flex';
  fixDateInput.style.display     = '';
  fixDateTimeInput.style.display = 'none';
  fixDateApplyModeRow.style.display = 'none'; // single photo — shift and fixed converge to the same edit
  fixDateShiftPreview.style.display = 'none';
  fixDateShiftRow.style.display  = 'flex';
  fixTimeShiftRow.style.display  = 'none'; // no visible time to shift in date-only mode
  fixDateHint.textContent    = 'Change date for this photo';
  fixDateSaveBtn.textContent = '💾 Save';
  showFixDateBar();
}

export function startFixTime(photo, onDone) {
  fixDateMode   = 'time';
  fixDatePhoto  = photo;
  fixDatePhotos = null;
  fixDateOnDone = onDone;
  const hasOwnDate = photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS;
  const seed = hasOwnDate ? new Date(photo.ts) : (_lastFixDateTs ? new Date(_lastFixDateTs) : new Date());
  fixDateTimeInput.value = seed.toTimeString().slice(0, 5);
  fixDateInputsEl.style.display  = 'flex';
  fixDateInput.style.display     = 'none';
  fixDateTimeInput.style.display = '';
  fixDateApplyModeRow.style.display = 'none'; // single photo — shift and fixed converge to the same edit
  fixDateShiftPreview.style.display = 'none';
  fixDateShiftRow.style.display  = 'none'; // no visible date to shift in time-only mode
  fixTimeShiftRow.style.display  = 'flex';
  fixDateHint.textContent    = 'Change time for this photo';
  fixDateSaveBtn.textContent = '💾 Save';
  showFixDateBar();
}

export function startBulkFixDate(photos, onDone) {
  fixDateMode   = 'both';
  fixDatePhoto  = null;
  fixDatePhotos = photos;
  fixDateOnDone = onDone;
  const seed = _lastFixDateTs ? new Date(_lastFixDateTs) : new Date();
  fixDateInput.value     = toDateStr(seed.getTime());
  fixDateTimeInput.value = seed.toTimeString().slice(0, 5);
  fixDateInput.style.display     = '';
  fixDateApplyModeRow.style.display = 'flex';
  fixDateModeFixed.checked = true; // default to "set all to this exact value", matches prior behavior
  fixDateKeepTime.checked  = false;
  _pendingShiftDays = 0; _pendingShiftHours = 0; _pendingShiftMinutes = 0;
  applyDateModeVisibility(); // sets fixDateTimeInput/fixDateShiftRow/fixTimeShiftRow to match the defaults above
  fixDateHint.textContent    = `Set date & time for ${photos.length} photo${photos.length === 1 ? '' : 's'}`;
  fixDateSaveBtn.textContent = `💾 Save (${photos.length})`;
  showFixDateBar();
}

fixDateSaveBtn.addEventListener('click', () => {
  if (fixDatePhotos) {
    const list = fixDatePhotos;
    const cb   = fixDateOnDone;

    if (isBulkShiftMode()) {
      const deltaMs = _pendingShiftDays * 86400000 + _pendingShiftHours * 3600000 + _pendingShiftMinutes * 60000;
      if (!deltaMs) { _briefStatusFn?.('Set a shift amount first — tap ‹ or › below.'); return; }
      hideFixDateBar();
      fixDatePhoto = null; fixDatePhotos = null; fixDateOnDone = null;
      enqueueBulkFixDate(list, 'shift', { deltaMs }, cb);
      return;
    }

    if (!fixDateInput.value) return;

    if (isBulkKeepTimeMode()) {
      const dateStr = fixDateInput.value;
      hideFixDateBar();
      fixDatePhoto = null; fixDatePhotos = null; fixDateOnDone = null;
      enqueueBulkFixDate(list, 'keeptime', { dateStr }, cb);
      return;
    }

    const ts = new Date(`${fixDateInput.value}T${fixDateTimeInput.value || '12:00'}`).getTime();
    hideFixDateBar();
    fixDatePhoto = null; fixDatePhotos = null; fixDateOnDone = null;
    enqueueBulkFixDate(list, 'fixed', { ts }, cb);
    return;
  }

  if (!fixDatePhoto) return;
  const photo = fixDatePhoto;
  const cb    = fixDateOnDone;
  const mode  = fixDateMode;

  let ts;
  if (mode === 'time') {
    if (!fixDateTimeInput.value) return;
    const hasOwnDate = photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS;
    const existingDate = hasOwnDate ? toDateStr(photo.ts) : toDateStr(Date.now());
    ts = new Date(`${existingDate}T${fixDateTimeInput.value}`).getTime();
  } else {
    if (!fixDateInput.value) return;
    const hasOwnDate = mode === 'date' && photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS;
    const existingTime = hasOwnDate
      ? new Date(photo.ts).toTimeString().slice(0, 5)
      : (fixDateTimeInput.value || '12:00');
    ts = new Date(`${fixDateInput.value}T${existingTime}`).getTime();
  }

  hideFixDateBar();
  fixDatePhoto = null; fixDateOnDone = null;
  _runFixDate(photo, ts, cb, mode);
});

async function _runFixDate(photo, ts, onDone, mode = 'date') {
  try {
    const r = await applyFixDateToPhoto(photo, ts);
    if (r.lat != null && r.newFileid !== r.oldFileid) {
      removeMarker(r.oldFileid);
      addMarker({ fileid: r.newFileid, name: r.newName, lat: r.lat, lng: r.lng, ts: r.ts });
    }
    updateCurrentSlideshowItem({ fileid: r.newFileid, name: r.newName, ts: r.ts });
    _lastFixDateTs = ts;
    await _reloadCountsFn?.().catch(e => log('Fix date', `reloadTopbarCounts error: ${e.message}`));
    onDone?.(r);
  } catch (e) {
    log('Fix date error', e.message);
    // A stale photo's record is already purged (see applyFixDateToPhoto) —
    // reopening the bar for the same dead photo would just fail again.
    if (e.staleFile) { onDone?.({ success: false, stale: true }); return; }
    if (mode === 'time') startFixTime(photo, onDone);
    else startFixDate(photo, onDone);
    _briefStatusFn?.(`❌ Fix date failed — try again`);
  }
}

// `computeTs(photo)` decides the new timestamp per photo, so the three
// modes differ only in that function — kept serializable as {mode, params}
// rather than a raw closure so a batch can be persisted for resume-after-
// kill and reconstructed later.
function computeTsFor(mode, params) {
  if (mode === 'shift')    return photo => photo.ts + params.deltaMs;
  if (mode === 'keeptime') return photo => {
    const hasOwnDate = photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS;
    const existingTime = hasOwnDate ? new Date(photo.ts).toTimeString().slice(0, 5) : '12:00';
    return new Date(`${params.dateStr}T${existingTime}`).getTime();
  };
  return () => params.ts; // 'fixed'
}

function fixDateVerbsFor(mode) {
  return mode === 'shift' ? { verb: 'Shifting', pastVerb: 'Shifted' } : { verb: 'Fixing dates', pastVerb: 'Dated' };
}

// A second bulk date-edit started while one's already running joins this
// queue instead of racing it — see editqueue.js for why.
const fixdateQueue = createEditQueue({
  storageKey: 'mappho_pending_bulk_fixdate',
  resumeLabel: 'bulk date fix',
  notificationTitle: 'Mappho — fixing dates',
  icon: '📅',
  verb: ({ mode }) => fixDateVerbsFor(mode).verb,
  pastVerb: ({ mode }) => fixDateVerbsFor(mode).pastVerb,
  apply: (photo, { mode, params }) => applyFixDateToPhoto(photo, computeTsFor(mode, params)(photo)),
  skipNoteFn: skipped => skipped > 0 ? ` (${skipped} had no date to shift from, skipped)` : '',
  // Pre-refactor builds persisted a top-level { mode, params, fileids } —
  // "mode" sat alongside "params" rather than nested inside it, unlike this
  // engine's { params: { mode, params }, fileids }.
  legacyToParams: raw => ('mode' in raw) ? { mode: raw.mode, params: raw.params } : null,
  statusFn: () => _statusFn,
  progressFn: () => _progressFn,
  bulkModeCtl: { setBulkMode: setFixDateBulkMode },
  resumeReconstruct: async fileid => {
    const cached = await getCached(fileid);
    return cached ? { fileid: cached.fileid, name: cached.name, ts: cached.ts, hash: cached.hash ?? null } : null;
  },
});

// Shift mode's "nothing to shift from" filter has to happen here rather than
// inside the queue (unlike a network-discovered failure, it's knowable up
// front from each photo's own state) — mirrors how geotag's "skip existing"
// filter already runs before its own enqueue call.
function enqueueBulkFixDate(list, mode, params, cb) {
  let effectiveList = list, skipped = 0;
  if (mode === 'shift') {
    effectiveList = list.filter(p => p.ts && p.ts > 0 && p.ts < UNDATED_TS);
    skipped = list.length - effectiveList.length;
  }
  if (!effectiveList.length) {
    _statusFn?.(`📅 All ${skipped} photo${skipped === 1 ? '' : 's'} had no date to shift from — nothing to do.`);
    cb?.({ success: false, count: 0, failed: 0, stale: 0, skipped });
    return;
  }
  fixdateQueue.enqueue(effectiveList, { mode, params }, result => {
    if (mode === 'fixed' && result.count > 0) _lastFixDateTs = params.ts;
    cb?.(result);
  }, skipped);
}

fixDateCancelBtn.addEventListener('click', cancelFixDate);

export function checkPendingBulkFixDateResume(cb) {
  return fixdateQueue.checkPendingResume(cb);
}
