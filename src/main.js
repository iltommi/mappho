import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { handleCallback, getToken, loginWithPassword, loginWithTFA, logout, saveToken, TwoFactorRequired, getApiHost, setApiHost, EU_HOST, US_HOST } from './auth.js';
import { viewOpened, viewClosed, navBack, restoreTop } from './nav.js';

const BUILD_TIME = new Date(__BUILD_TIME__);
const APP_SHA    = __GIT_SHA__;
import { log, toggleLog } from './log.js';
import { toggleFilter, closeFilter, getActiveFilterRange, setRangeInfoHandler, toDateStr } from './filter.js';
import { listImages, listFolders, folderExists, fetchFileHead, downloadFullFile, overwriteFile, copyFile, uploadFile, deleteFile, getFileStat } from './pcloud.js';
import { extractEXIF, parseDateFromFilename, injectExif, heicToJpeg, fetchHeicExifForPreserve } from './exif.js';
import { extractMP4Meta, isVideo } from './mp4.js';
import { initMap, addMarker, bulkAddMarkers, removeMarker, clearMarkers, toggleHeatmap, cycleMediaTypeFilter, MEDIA_ALL_ICON, updateMarkerName, setMarkerGeotagHandler, setMarkerFixDateHandler, setMarkerFixTimeHandler, setMarkerIgnoreHandler, setMarkerBulkIgnoreHandler } from './map.js';
import { openLazySlideshow, setGeotagHandler, setFixDateHandler, setFixTimeHandler, setIgnoreHandler, setEditHandler, setAfterDeleteCallback, updateCurrentSlideshowItem, refreshSlideshowImage, getCurrentSlideshowIndex, resumeAfterHandoff } from './slideshow.js';
import { openPhotoEdit, setPhotoEditProgressFn } from './photoedit.js';
import { startGeotagging, setGeotagStatusFn, setGeotagProgressFn, getPendingBulkGeotag, resumeBulkGeotag, discardPendingBulkGeotag } from './geotag.js';
import { openGrid, setBulkFixDateHandler, setBulkIgnoreHandler, setAfterBulkGeotagCallback, updateGridItem } from './grid.js';
import { findMapphoRootIfExists, syncMapphoOnEdit, getMapphoRoot, getMapphoMonthFolder, loadOrganizeIndex, flushOrganizeIndex, organizeFile, resetOrganizeState, isHashOrganized, normHash } from './organize.js';
import { applyVideoMeta } from './videometa.js';
import { setIgnoredEntry, removeIgnoredEntry, applyIgnored } from './ignoremeta.js';
import { refreshFaces, getPeopleStats, getEntriesForPeople } from './faces.js';
import { refreshLocations, getLocationStats, getEntriesForLocations } from './locations.js';
import { refreshFlags } from './flags.js';
import { flushPhotoIndex, loadPhotoIndex } from './photoindex.js';
import { startSyncTimer, flushAll } from './syncmanager.js';
import { askRetry, askResume, waitForVisible } from './confirm.js';
import { startBackgroundSync, updateBackgroundSync, stopBackgroundSync } from './backgroundsync.js';
import { getCached, putCached, bulkPutCached, getAllCached, clearAll, clearNonIgnored, putOrphan, bulkPutOrphans, countOrphans, countCached, countIgnored, getIgnoredPage, getAllIgnored, unignorePhoto, clearOrphans, getOrphansPage, getOrphansInRange, countOrphansInRange, countLocatedUndated, getLocatedUndatedPage, countAllNonIgnored, getAllNonIgnoredPage, getPositionAndDatePage, countGeotaggedInRange, ignorePhoto, deleteRecord, deleteOrphan, UNDATED_TS } from './db.js';
import { distinctDayRanges, sameDayFromList } from './dayrange.js';
import './style.css';

const authBtn = document.getElementById('auth-btn');

// Datacenter picker — persists selection in localStorage
const dcRadios = document.querySelectorAll('input[name="dc"]');
const currentHost = getApiHost();
dcRadios.forEach(r => {
  r.checked = (r.value === 'eu' ? EU_HOST : US_HOST) === currentHost;
  r.addEventListener('change', () => setApiHost(r.value === 'eu' ? EU_HOST : US_HOST));
});
const scanStatusEl = document.getElementById('scan-status');

let sessionGeotagged = 0;
let scanCancelled = false;
let _rebuildSeenHashes = null; // Set<string> — active only during rebuildScan, deduplicates Photos/ by content hash
let retryQueue = [];
let retryContext = null; // { prevStats, prevTotal } from the scan that produced the queue
// Stats shown in the Settings/Info popup.
let topbarGeotagged      = 0;
let topbarDated          = 0;
let topbarUnknown        = 0;
let topbarLocatedUndated = 0;
let topbarTotal          = 0;
let topbarIgnored        = 0;

function setScanStatus(scanned, geotagged, dated, total = null, cached = 0) {
  const progress = total ? `${scanned}/${total}` : `${scanned}`;
  const dupNote  = cached > 0 ? ` ${cached}🔁` : '';
  setStatus(`${progress}. ${geotagged}📍 ${dated}📅${dupNote}`);
}

async function reloadTopbarCounts() {
  const [total, ignored, orphans, noDate] = await Promise.all([
    countCached(), countIgnored(), countOrphans(), countOrphansInRange(UNDATED_TS, UNDATED_TS),
  ]);
  topbarTotal     = total - ignored;
  topbarGeotagged = total - ignored - orphans;
  topbarDated     = orphans - noDate;
  topbarUnknown   = noDate;
  topbarIgnored   = ignored;
  // Full cursor scan — runs without blocking the caller
  countLocatedUndated()
    .then(n => { topbarLocatedUndated = n; })
    .catch(e => log('reloadTopbarCounts', `countLocatedUndated error: ${e.message}`));
}

// Shared by every setGeotagHandler/setFixDateHandler/setFixTimeHandler onDone
// callback: `r.stale` means the photo's fileid no longer existed on pCloud
// and its local record was already purged (see geotag.js/applyFixDateToPhoto's
// StaleFileError) — surface that distinctly instead of leaving it looking
// like the tap silently did nothing, then always `advance()` (reopen the
// slideshow / resume the handoff) regardless of the outcome.
function handleEditResult(r, advance) {
  if (r.stale) {
    reloadTopbarCounts();
    showBriefStatus('⚠️ That photo no longer exists on pCloud — removed from your library.');
  } else if (r.newFileid != null && r.newFileid !== r.oldFileid) {
    // Keeps a grid sitting underneath this slideshow in sync — see
    // updateGridItem's comment in grid.js for why this matters beyond looks.
    updateGridItem(r.oldFileid, { fileid: r.newFileid, name: r.newName, ts: r.ts, lat: r.lat, lng: r.lng });
  }
  advance();
}

// Shared by every "problem" grid's setIgnoreHandler (single photo, via the
// slideshow's ignore button) and setBulkIgnoreHandler (multiple, via the
// grid's bulk toolbar) — same underlying operation either way. Also used by
// the map's pin-cluster grid, whose photos do have a marker — removeMarker
// is a no-op for the "problem" grids' photos, which never had one.
async function ignoreOnePhoto(photo) {
  await ignorePhoto(photo.fileid);
  setIgnoredEntry(photo.fileid);
  removeMarker(photo.fileid);
  await reloadTopbarCounts();
}

async function bulkIgnorePhotos(photos, cb) {
  let ok = 0, failed = 0;
  for (const photo of photos) {
    try { await ignoreOnePhoto(photo); ok++; }
    catch (e) { failed++; log('Bulk ignore error', `${photo.name}: ${e.message}`); }
  }
  showBriefStatus(failed > 0 ? `🚫 Ignored ${ok}/${photos.length} — ${failed} failed` : `🚫 Ignored ${ok} photo${ok !== 1 ? 's' : ''}`);
  cb?.({ success: ok > 0, count: ok, failed });
}

// Restore counterpart, used by openIgnoredGrid's bulk toolbar.
async function restoreOnePhoto(photo) {
  const rec = await unignorePhoto(photo.fileid);
  removeIgnoredEntry(photo.fileid);
  if (rec?.lat != null) addMarker(rec);
  await reloadTopbarCounts();
}

async function bulkRestorePhotos(photos, cb) {
  let ok = 0, failed = 0;
  for (const photo of photos) {
    try { await restoreOnePhoto(photo); ok++; }
    catch (e) { failed++; log('Bulk restore error', `${photo.name}: ${e.message}`); }
  }
  showBriefStatus(failed > 0 ? `♻️ Restored ${ok}/${photos.length} — ${failed} failed` : `♻️ Restored ${ok} photo${ok !== 1 ? 's' : ''}`);
  cb?.({ success: ok > 0, count: ok, failed });
}

function showBriefStatus(msg, timeoutMs = 4000) {
  setStatus(msg, timeoutMs);
}
const progressFill = document.getElementById('progress-fill');
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const totpInput = document.getElementById('totp');
const folderBtn = document.getElementById('folder-btn');
const stopScanBtn = document.getElementById('stop-scan-btn');
const eraseCacheBtn = document.getElementById('erase-cache-btn');

stopScanBtn.addEventListener('click', () => {
  scanCancelled = true;
  stopScanBtn.disabled = true;
  stopScanBtn.textContent = '…';
});
const menuFab = document.getElementById('menu-fab');
const peopleFab = document.getElementById('people-fab');
peopleFab.addEventListener('click', () => {
  openPeoplePopup().catch(e => { log('People popup error', e.message); showBriefStatus(`Error: ${e.message}`); });
});


async function openNodatetimeGrid() {
  const allOrphans = await countOrphans();
  const total = await countOrphansInRange(UNDATED_TS, UNDATED_TS);
  log('No date/location', `all orphans=${allOrphans}, undated=${total}`);
  if (!total) {
    showBriefStatus(allOrphans > 0
      ? `No photos without both date and location (${allOrphans} have no location but do have a date).`
      : 'No photos without location in cache.');
    return false;
  }
  const fetcher = (offset, limit) => getOrphansPage(offset, limit, UNDATED_TS, UNDATED_TS);
  async function reopenSlideshow() {
    const savedIdx = getCurrentSlideshowIndex();
    const t = await countOrphansInRange(UNDATED_TS, UNDATED_TS);
    if (!t) { showBriefStatus('All photos have date or location!'); return; }
    openLazySlideshow(fetcher, t, { startIndex: Math.min(savedIdx, t - 1) });
  }
  setGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
    reopenSlideshow();
  })));
  setFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, reopenSlideshow)));
  setFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, reopenSlideshow)));
  setIgnoreHandler(ignoreOnePhoto);
  setBulkIgnoreHandler(bulkIgnorePhotos);
  await openGrid(fetcher, total, { reopen: openNodatetimeGrid });
  return true;
}

// ── Fix date panel ────────────────────────────────────────────────────────────

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

// Bulk fix-date runs 2 photos' download/modify/upload concurrently (see
// runBulkFixDateBatch), so a single item's byte-level progress no longer
// means anything on its own. runBulkFixDateBatch drives the bar itself
// instead, as a queue-wide completed/total, while this suppresses the
// single-item version for its duration.
let _fixDateBulkMode = false;

// Drives the top progress bar through the 3 stages of applying an edit —
// download, rewrite EXIF, upload — instead of leaving it sitting at 0 until
// the upload starts. Download and EXIF-rewrite have no byte-level progress
// of their own, so those two just jump to their checkpoint; only the upload
// leg (the slow one, and the only one FileTransfer reports progress for)
// actually animates within its 66–100 share.
function setStep(step) {
  if (_fixDateBulkMode) return;
  if (step === 'download') setProgress(0);
  else if (step === 'process') setProgress(33);
  else if (step === 'upload')  setProgress(66);
}

// Wraps an upload call so the top progress bar always gets reset once the
// upload settles (success or failure) instead of being left stuck mid-way.
async function withUploadProgress(fn) {
  if (_fixDateBulkMode) return fn(undefined);
  try {
    return await fn((bytes, total) => setProgress(66 + (total ? (bytes / total) * 34 : 0)));
  } finally {
    setProgress(0);
  }
}

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

function startFixDate(photo, onDone) {
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

function startFixTime(photo, onDone) {
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

function startBulkFixDate(photos, onDone) {
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
      if (!deltaMs) { showBriefStatus('Set a shift amount first — tap ‹ or › below.'); return; }
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
    await reloadTopbarCounts().catch(e => log('Fix date', `reloadTopbarCounts error: ${e.message}`));
    flushPhotoIndex();
    onDone?.(r);
  } catch (e) {
    log('Fix date error', e.message);
    // A stale photo's record is already purged (see applyFixDateToPhoto) —
    // reopening the bar for the same dead photo would just fail again.
    if (e.staleFile) { onDone?.({ success: false, stale: true }); return; }
    if (mode === 'time') startFixTime(photo, onDone);
    else startFixDate(photo, onDone);
    showBriefStatus(`❌ Fix date failed — try again`);
  }
}

// pCloud doesn't throttle concurrent requests from one account (see
// geotag.js), and organize.js's shared name-picking state serializes itself
// internally now, so this is safe for bulk fix-date too.
const BULK_CONCURRENCY = 2;

// ── Bulk fix-date queue ──────────────────────────────────────────────────
// Mirrors bulk geotag's queue (see geotag.js) for the same reason: a second
// bulk date-edit started while one's already running must not race it for
// the progress bar, status text, resume persistence, or the background-sync
// service. `computeTs(photo)` decides the new timestamp per photo, so the
// three modes differ only in that function — kept serializable as
// {mode, params} rather than a raw closure so a batch can be persisted for
// resume-after-kill and reconstructed later.

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
  return mode === 'shift'
    ? { verb: 'Shifting', pastVerb: 'Shifted', skipUndated: true }
    : { verb: 'Fixing dates', pastVerb: 'Dated', skipUndated: false };
}

const FIXDATE_PENDING_KEY = 'mappho_pending_bulk_fixdate';

function savePendingBulkFixDateQueue(batches) {
  try {
    if (batches.length) localStorage.setItem(FIXDATE_PENDING_KEY, JSON.stringify(batches));
    else localStorage.removeItem(FIXDATE_PENDING_KEY);
  } catch {}
}
function clearPendingBulkFixDate() {
  try { localStorage.removeItem(FIXDATE_PENDING_KEY); } catch {}
}
function discardPendingBulkFixDate() { clearPendingBulkFixDate(); }
function getPendingBulkFixDate() {
  try {
    const raw = localStorage.getItem(FIXDATE_PENDING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

const _fixDateQueue = []; // batches not yet started: { list, mode, params, cb }
let _fixDateQueueRunning = false;
let _fixDateCurrent = null; // batch actively being processed: { mode, params, remaining: Set<fileid> }
let _fixDateQueueTotal     = 0;
let _fixDateQueueCompleted = 0;

function persistFixDateQueueState() {
  const batches = [];
  if (_fixDateCurrent) {
    batches.push({ mode: _fixDateCurrent.mode, params: _fixDateCurrent.params, fileids: [..._fixDateCurrent.remaining] });
  }
  for (const b of _fixDateQueue) batches.push({ mode: b.mode, params: b.params, fileids: b.list.map(p => p.fileid) });
  savePendingBulkFixDateQueue(batches);
}

function enqueueBulkFixDate(list, mode, params, cb) {
  _fixDateQueue.push({ list, mode, params, cb });
  _fixDateQueueTotal += list.length;
  if (_fixDateQueueRunning) {
    persistFixDateQueueState();
    const { verb } = fixDateVerbsFor(mode);
    setStatus(`📅 ${verb}… ${_fixDateQueueCompleted}/${_fixDateQueueTotal} (+${list.length} just added)`, 0);
    updateBackgroundSync('Mappho — fixing dates', `${verb}… ${_fixDateQueueCompleted}/${_fixDateQueueTotal}`);
  } else {
    runFixDateQueue();
  }
}

async function runFixDateQueue() {
  _fixDateQueueRunning = true;
  // No waitForVisible() pause here — the background-sync service below is
  // what makes it safe to keep going while hidden; pausing until the app
  // comes back to the foreground would defeat it.
  const protectedRun = await startBackgroundSync('Mappho — fixing dates', `Working… 0/${_fixDateQueueTotal}`);
  const bgNote = protectedRun ? '' : ' — keep Mappho open, background sync unavailable';
  try {
    while (_fixDateQueue.length) {
      const { list, mode, params, cb } = _fixDateQueue.shift();
      await runBulkFixDateBatch(list, mode, params, cb, bgNote);
    }
  } finally {
    _fixDateCurrent = null;
    _fixDateQueueTotal = 0;
    _fixDateQueueCompleted = 0;
    clearPendingBulkFixDate();
    stopBackgroundSync();
    _fixDateQueueRunning = false;
  }
}

// Processes one queued batch to completion, including any retry rounds the
// user asks for — the queue runner above only moves on to the next batch
// once this fully settles.
async function runBulkFixDateBatch(initialList, mode, params, cb, bgNote) {
  const { verb, pastVerb, skipUndated } = fixDateVerbsFor(mode);
  const computeTs = computeTsFor(mode, params);
  let list = initialList;
  let totalOk = 0, totalStale = 0, totalSkipped = 0;

  for (;;) {
    let ok = 0, staleCount = 0, skipped = 0;
    const failedItems = [];
    _fixDateCurrent = { mode, params, remaining: new Set(list.map(p => p.fileid)) };
    persistFixDateQueueState();

    _fixDateBulkMode = true;
    let nextIndex = 0;
    async function processOne(photo) {
      try {
        const r = await applyFixDateToPhoto(photo, computeTs(photo));
        if (r.lat != null && r.newFileid !== r.oldFileid) {
          removeMarker(r.oldFileid);
          addMarker({ fileid: r.newFileid, name: r.newName, lat: r.lat, lng: r.lng, ts: r.ts });
        }
        ok++;
      } catch (e) {
        // A stale photo's record is already purged (see applyFixDateToPhoto) —
        // it's permanently gone, not a transient failure, so don't offer to
        // retry it: retrying the same dead fileid can only ever fail again.
        if (e.staleFile) { staleCount++; log('Bulk fix date', `${photo.name}: no longer exists on pCloud — removed`); }
        else { failedItems.push(photo); log('Bulk fix date error', `${photo.name}: ${e.message}`); }
      }
    }
    async function worker() {
      while (nextIndex < list.length) {
        const photo = list[nextIndex++];
        if (skipUndated) {
          const hasOwnDate = photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS;
          if (!hasOwnDate) skipped++; // nothing to shift from
          else await processOne(photo);
        } else {
          await processOne(photo);
        }
        _fixDateQueueCompleted++;
        _fixDateCurrent.remaining.delete(photo.fileid);
        setStatus(`📅 ${verb}… ${_fixDateQueueCompleted}/${_fixDateQueueTotal}${bgNote}`, 0);
        updateBackgroundSync('Mappho — fixing dates', `${verb}… ${_fixDateQueueCompleted}/${_fixDateQueueTotal}`);
        setProgress((_fixDateQueueCompleted / _fixDateQueueTotal) * 100);
        persistFixDateQueueState();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, list.length) }, worker));
    } finally {
      _fixDateBulkMode = false;
      setProgress(0);
    }
    try { await reloadTopbarCounts(); } catch (e) { log('Fix date', `reloadTopbarCounts error: ${e.message}`); }
    flushPhotoIndex();

    totalOk += ok;
    totalStale += staleCount;
    totalSkipped += skipped;
    const staleNote = totalStale > 0 ? ` (${totalStale} no longer existed, removed)` : '';
    const skipNote  = totalSkipped > 0 ? ` (${totalSkipped} had no date to shift from, skipped)` : '';
    const total = initialList.length - totalSkipped;

    if (failedItems.length > 0) {
      showBriefStatus(`📅 ${pastVerb} ${totalOk}/${total} — ${failedItems.length} failed${staleNote}${skipNote}`, 0);
      const retry = await askRetry(failedItems.length, 'photo');
      if (retry) { list = failedItems; continue; }
      if (mode === 'fixed' && totalOk > 0) _lastFixDateTs = params.ts;
      cb?.({ success: totalOk > 0, count: totalOk, failed: failedItems.length, stale: totalStale, skipped: totalSkipped });
      return;
    }
    showBriefStatus(`📅 ${pastVerb} ${totalOk} photo${totalOk !== 1 ? 's' : ''}${staleNote}${skipNote}`);
    if (mode === 'fixed' && totalOk > 0) _lastFixDateTs = params.ts;
    cb?.({ success: totalOk > 0, count: totalOk, failed: 0, stale: totalStale, skipped: totalSkipped });
    return;
  }
}

// Offered on next launch when the background-sync service didn't manage to
// keep the app alive through the whole queue after all (OS memory pressure
// can still win). Re-derives full photo objects for every pending batch
// from the persisted fileids via the cache, then re-queues them — mirrors
// resumeBulkGeotag in geotag.js.
async function resumeBulkFixDate(callback) {
  const batches = getPendingBulkFixDate();
  clearPendingBulkFixDate();
  if (!batches?.length) return false;

  let queued = false;
  for (const { mode, params, fileids } of batches) {
    if (!fileids?.length) continue;
    const photos = [];
    for (const fileid of fileids) {
      const cached = await getCached(fileid);
      if (cached) photos.push({ fileid: cached.fileid, name: cached.name, ts: cached.ts, hash: cached.hash ?? null });
    }
    if (photos.length) { enqueueBulkFixDate(photos, mode, params, callback); queued = true; }
  }
  return queued;
}

async function checkPendingBulkFixDateResume() {
  const pending = getPendingBulkFixDate();
  const total = pending?.reduce((n, b) => n + (b.fileids?.length ?? 0), 0) ?? 0;
  if (!total) return;
  const resume = await askResume(total, 'bulk date fix');
  if (!resume) { discardPendingBulkFixDate(); return; }
  await resumeBulkFixDate(() => reloadTopbarCounts());
}

fixDateCancelBtn.addEventListener('click', cancelFixDate);


document.getElementById('filter-menu-btn').addEventListener('click', () => {
  closeInfoPopup();
  toggleFilter();
});


document.getElementById('check-update-btn').addEventListener('click', async () => {
  closeInfoPopup();
  showBriefStatus('Checking for updates…', 15000);
  try {
    const resp = await CapacitorHttp.request({
      method: 'GET',
      url: 'https://api.github.com/repos/iltommi/mappho/releases?per_page=1',
      headers: { Accept: 'application/vnd.github+json' },
    });
    const releases = resp.data;
    if (!resp.status || resp.status < 200 || resp.status >= 300 || !Array.isArray(releases) || !releases.length) {
      throw new Error((releases?.message) ?? `HTTP ${resp.status}`);
    }
    const release = releases[0];
    if (!release.published_at) throw new Error('No published release found');
    // Compare the SHA embedded in the release notes with the one baked into this build.
    const releaseSha = (release.body ?? '').match(/Built from ([0-9a-f]{40})/i)?.[1];
    const upToDate = releaseSha
      ? releaseSha === APP_SHA
      : new Date(release.published_at) <= BUILD_TIME;
    if (!upToDate) {
      showBriefStatus(`Update available — downloading…`, 60000);
      const apkUrl = 'https://github.com/iltommi/mappho/releases/download/latest/Mappho.apk';
      try {
        await Capacitor.Plugins.Downloader.downloadAndInstall({ url: apkUrl });
      } catch {
        window.open(apkUrl, '_system');
      }
    } else {
      showBriefStatus('Already up to date.');
    }
  } catch (e) {
    log('Update check error', e.message);
    showBriefStatus(`Update check failed: ${e.message}`);
  }
});

menuFab.addEventListener('click', (e) => {
  e.stopPropagation();
  openInfoPopup();
});

// Android hardware/gesture back: unwind the open view stack one level at a
// time; only when nothing is left to close does it exit the app (registering
// any backButton listener disables Capacitor's default exit behavior, so
// this has to be done explicitly).
App.addListener('backButton', () => {
  if (!navBack()) App.exitApp().catch(() => {});
});

let pendingTfaToken = null;

const FOLDERS_KEY = 'pcloud_folders';

function getSelectedFolders() {
  // Migrate old single-folder key if present.
  const old = localStorage.getItem('pcloud_folder');
  if (old) {
    const parsed = JSON.parse(old);
    localStorage.setItem(FOLDERS_KEY, JSON.stringify([parsed]));
    localStorage.removeItem('pcloud_folder');
  }
  const raw = localStorage.getItem(FOLDERS_KEY);
  const arr = raw ? JSON.parse(raw) : [];
  return arr.length ? arr : [{ id: 0, name: '/' }];
}

function saveSelectedFolders(folders) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}

// In-picker working set — what the user has (un)checked this session.
// Committed to localStorage when the picker closes.
let fpSelected = new Map(); // id -> { id, name }

const folderPicker  = document.getElementById('folder-picker');
const fpBack        = document.getElementById('fp-back');
const fpClose       = document.getElementById('fp-close');
const fpBreadcrumb  = document.getElementById('fp-breadcrumb');
const fpCount       = document.getElementById('fp-count');
const fpList        = document.getElementById('fp-list');

// Stack of { id, name } — root entry is always { id: 0, name: '/' }
let fpStack = [];

function fpUpdateCount() {
  const n = fpSelected.size;
  fpCount.textContent = n ? `${n} selected` : '';
}

function updateFolderBtn() {
  folderBtn.textContent = '📁 Folders';
}

async function fpRender() {
  const current = fpStack[fpStack.length - 1];
  fpBreadcrumb.textContent = current.name;
  fpBack.disabled = fpStack.length <= 1;
  fpUpdateCount();
  fpList.innerHTML = '';

  // Selected folders summary — lets user remove any selected folder (incl. deleted ones)
  if (fpSelected.size > 0) {
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 20px 4px;color:#94a3b8;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em';
    header.textContent = 'Selected';
    fpList.appendChild(header);
    for (const [key, f] of fpSelected) {
      const row = document.createElement('div');
      row.className = 'fp-item fp-selected-entry';
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between';
      const label = document.createElement('span');
      label.textContent = `☑ ${f.name}`;
      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.style.cssText = 'background:none;border:none;color:#94a3b8;font-size:1rem;cursor:pointer;padding:0 4px';
      removeBtn.addEventListener('click', e => {
        e.stopPropagation();
        fpSelected.delete(key);
        fpRender();
      });
      row.appendChild(label);
      row.appendChild(removeBtn);
      fpList.appendChild(row);
    }
    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:#334155;margin:6px 0';
    fpList.appendChild(sep);
  }

  // Toggle-include row for the current folder
  const toggleRow = document.createElement('button');
  toggleRow.className = 'fp-item fp-select';
  const isSelected = fpSelected.has(String(current.id));
  toggleRow.textContent = isSelected ? `☑ "${current.name}" included` : `☐ Include "${current.name}"`;
  toggleRow.addEventListener('click', () => {
    const key = String(current.id);
    if (fpSelected.has(key)) {
      fpSelected.delete(key);
    } else {
      fpSelected.set(key, { id: current.id, name: current.name });
    }
    toggleRow.textContent = fpSelected.has(key) ? `☑ "${current.name}" included` : `☐ Include "${current.name}"`;
    fpUpdateCount();
  });
  fpList.appendChild(toggleRow);

  // Loading indicator
  const loadingRow = document.createElement('div');
  loadingRow.style.cssText = 'padding:14px 20px;color:#94a3b8;font-size:.9rem';
  loadingRow.textContent = 'Loading…';
  fpList.appendChild(loadingRow);

  let subfolders;
  try {
    subfolders = await listFolders(current.id);
  } catch (e) {
    loadingRow.textContent = `Error: ${e.message}`;
    return;
  }
  loadingRow.remove();

  for (const f of subfolders) {
    const row = document.createElement('button');
    row.className = 'fp-item';
    const checked = fpSelected.has(String(f.folderid));
    row.innerHTML = `<span>${checked ? '☑' : '📁'} ${f.name}</span><span class="fp-item-arrow">›</span>`;
    row.addEventListener('click', () => {
      fpStack.push({ id: f.folderid, name: f.name });
      fpRender();
    });
    fpList.appendChild(row);
  }

  if (subfolders.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:14px 20px;color:#94a3b8;font-size:.9rem';
    empty.textContent = 'No subfolders';
    fpList.appendChild(empty);
  }
}

async function openFolderPicker() {
  fpSelected = new Map();
  const saved = getSelectedFolders();
  for (const f of saved) {
    if (f.id !== 0) fpSelected.set(String(f.id), f);
  }
  fpStack = [{ id: 0, name: '/' }];
  folderPicker.style.display = 'flex';
  // Back mirrors the ← header button while inside a subfolder — it steps up
  // one level — and only closes the picker (= Done) from the root.
  viewOpened('folders', {
    close: () => {
      if (fpStack.length > 1) { fpStack.pop(); fpRender(); }
      else closeFolderPicker();
    },
  });
  fpRender();

  // Validate saved folders in the background — remove any that no longer exist on pCloud.
  for (const [key, f] of [...fpSelected.entries()]) {
    try {
      if (!(await folderExists(f.id))) {
        fpSelected.delete(key);
        fpRender();
      }
    } catch {
      // Network error — keep the folder rather than pruning the saved selection.
    }
  }
}

function closeFolderPicker() {
  folderPicker.style.display = 'none';
  viewClosed('folders');
  const folders = [...fpSelected.values()];
  if (!folders.length) {
    showBriefStatus('No folders selected — keeping the previous selection.');
    return;
  }
  const oldIds = new Set(getSelectedFolders().map(f => f.id));
  saveSelectedFolders(folders);
  updateFolderBtn();
  const newIds = new Set(folders.map(f => f.id));
  const changed = oldIds.size !== newIds.size || [...oldIds].some(id => !newIds.has(id));
  if (changed) runScan();
}

fpBack.addEventListener('click', () => {
  if (fpStack.length > 1) { fpStack.pop(); fpRender(); }
});
fpClose.addEventListener('click', closeFolderPicker);
folderBtn.addEventListener('click', () => { infoPopup.style.display = 'none'; openFolderPicker(); });

function populateFolderPicker() {
  updateFolderBtn();
}

let eraseCacheConfirmPending = false;
let eraseCacheConfirmTimer  = null;

eraseCacheBtn.addEventListener('click', async () => {
  if (!eraseCacheConfirmPending) {
    eraseCacheConfirmPending = true;
    const orig = eraseCacheBtn.textContent;
    eraseCacheBtn.textContent = '⚠️ Tap again to confirm';
    eraseCacheConfirmTimer = setTimeout(() => {
      eraseCacheConfirmPending = false;
      eraseCacheBtn.textContent = orig;
    }, 3000);
    return;
  }
  clearTimeout(eraseCacheConfirmTimer);
  eraseCacheConfirmPending = false;
  eraseCacheBtn.textContent = '🗑 Erase cache';
  closeInfoPopup();
  await Promise.all([clearAll(), clearOrphans()]);
  clearMarkers();
  heatmapBtn.classList.remove('active');
  mediaTypeBtn.innerHTML = MEDIA_ALL_ICON;
  mediaTypeBtn.classList.remove('active');
  closeFilter();
  topbarGeotagged      = 0;
  topbarDated          = 0;
  topbarUnknown        = 0;
  topbarLocatedUndated = 0;
  topbarTotal          = 0;
  topbarIgnored        = 0;
  sessionGeotagged = 0;
  log('Cache erased');
  setStatus('Cache erased — pick a folder to scan.');
});


document.getElementById('rebuild-btn').addEventListener('click', async () => {
  closeInfoPopup();
  log('Rebuild', 'rebuilding cache from Photos/ folder');
  const btn = document.getElementById('rebuild-btn');
  btn.disabled = true;
  await runRebuild();
  btn.disabled = false;
});

document.getElementById('use-token-btn').addEventListener('click', async () => {
  const token = document.getElementById('token-input').value.trim();
  if (!token) { loginError.textContent = 'Please paste your auth token.'; return; }
  saveToken(token);
  showApp();
  await startScan();
  await checkPendingBulkResume();
});

let statusHideTimer = null;

// Shows `msg` in the status bar, then auto-hides it after `timeoutMs` unless
// another status call (e.g. the next scan-progress tick) replaces it first.
function setStatus(msg, timeoutMs = 6000) {
  clearTimeout(statusHideTimer);
  scanStatusEl.textContent = msg;
  scanStatusEl.classList.remove('hidden');
  log('status', msg);
  if (timeoutMs > 0) {
    statusHideTimer = setTimeout(() => scanStatusEl.classList.add('hidden'), timeoutMs);
  }
}

scanStatusEl.addEventListener('click', () => toggleLog());

setRangeInfoHandler(({ total, withLocation }) => {
  setStatus(`${total} photo${total === 1 ? '' : 's'} in range · ${withLocation} with location`);
});

function setProgress(pct) {
  progressFill.style.width = `${Math.min(100, pct)}%`;
}

const STARTUP_TIMING_KEY = 'mappho_startup_ms';
let _startupTimer = null;

function _startStartupAnimation(durationMs) {
  const start = Date.now();
  function tick() {
    const frac = Math.min((Date.now() - start) / durationMs, 1);
    setProgress(frac * 95); // 0 → 95, leaving a visible jump to 100 when done
    if (frac < 1) _startupTimer = setTimeout(tick, 50);
  }
  _startupTimer = setTimeout(tick, 50);
}

function _stopStartupAnimation() {
  clearTimeout(_startupTimer);
  _startupTimer = null;
}

const heatmapBtn = document.getElementById('heatmap-btn');
heatmapBtn.addEventListener('click', () => {
  const active = toggleHeatmap();
  heatmapBtn.classList.toggle('active', active);
});

const mediaTypeBtn = document.getElementById('media-type-btn');
mediaTypeBtn.addEventListener('click', () => {
  const { label, active } = cycleMediaTypeFilter();
  mediaTypeBtn.innerHTML = label;
  mediaTypeBtn.classList.toggle('active', active);
});

const infoPopup      = document.getElementById('info-popup');
const infoRowsEl     = document.getElementById('info-rows');

let _peopleCount   = null; // people recognised in faces.json; null = unknown/none
let _locationCount = null; // categories recognised in locations.json; null = unknown/none

function renderInfoRows() {
  const X = (e) => `<span class="icon-x">${e}</span>`;
  const rows = [
    { icon: '📷',                   label: 'Total',           value: topbarTotal,                            action: 'all' },
    { icon: '📅📍',                 label: 'Position & Date', value: topbarGeotagged - topbarLocatedUndated, action: 'position-date' },
    { icon: X('📍'),                label: 'Only Date',       value: topbarDated,                            action: 'dated' },
    { icon: X('📅'),                label: 'Only Position',   value: topbarLocatedUndated,                   action: 'located-undated' },
    { icon: X('📅') + X('📍'),     label: 'Nothing',         value: topbarUnknown,                          action: 'unknown' },
    { icon: '🚫',                   label: 'Ignored',         value: topbarIgnored,                          action: 'ignored' },
  ];
  if (_peopleCount) rows.push({ icon: '👤', label: 'People', value: _peopleCount, action: 'people' });
  infoRowsEl.innerHTML = rows.map(r =>
    r.action
      ? `<div class="info-row info-row-btn" data-action="${r.action}">
           <span class="info-row-label">${r.icon} ${r.label}</span>
           <span class="info-row-value">${r.value}</span>
         </div>`
      : `<div class="info-row">
           <span class="info-row-label">${r.icon} ${r.label}</span>
           <span class="info-row-value">${r.value}</span>
         </div>`
  ).join('');
  infoRowsEl.querySelectorAll('.info-row-btn').forEach(el => {
    el.addEventListener('click', () => {
      // Hide Settings but leave it on the nav stack — closing the child view
      // restores it. If the child never opens (empty list, error), restoreTop()
      // re-shows Settings, which is still the top entry.
      infoPopup.style.display = 'none';
      const reshowIfNotOpened = opened => { if (!opened) restoreTop(); };
      const reshowOnError = (label) => (e) => { log(label, e.message); showBriefStatus(`Error: ${e.message}`); restoreTop(); };
      if (el.dataset.action === 'all') {
        openAllGrid().then(reshowIfNotOpened).catch(reshowOnError('All-photos grid error'));
      } else if (el.dataset.action === 'position-date') {
        openPositionAndDateGrid().then(reshowIfNotOpened).catch(reshowOnError('Position & date grid error'));
      } else if (el.dataset.action === 'dated') {
        openDatedOrphanGrid().then(reshowIfNotOpened).catch(reshowOnError('Dated grid error'));
      } else if (el.dataset.action === 'unknown') {
        openNodatetimeGrid().then(reshowIfNotOpened).catch(reshowOnError('Unknown grid error'));
      } else if (el.dataset.action === 'located-undated') {
        openLocatedUndatedGrid().then(reshowIfNotOpened).catch(reshowOnError('Located undated grid error'));
      } else if (el.dataset.action === 'ignored') {
        openIgnoredGrid().then(reshowIfNotOpened).catch(reshowOnError('Ignored grid error'));
      } else if (el.dataset.action === 'people') {
        openPeoplePopup().catch(reshowOnError('People popup error'));
      }
    });
  });
}

// ── People popup ──────────────────────────────────────────────────────────────

// textembed.js/embeddings.js/search.js pull in transformers.js (ONNX
// runtime + WASM) — tens of MB that only matter once the user actually
// opens search. Dynamic import() keeps that out of the main bundle/app
// startup path entirely; Vite splits it into its own chunk fetched here.
let _searchModulesPromise = null;
function loadSearchModules() {
  if (!_searchModulesPromise) {
    _searchModulesPromise = Promise.all([import('./textembed.js'), import('./embeddings.js'), import('./search.js')])
      .then(([textembed, embeddings, search]) => ({ ...textembed, ...embeddings, ...search }));
  }
  return _searchModulesPromise;
}

const peoplePopup        = document.getElementById('people-popup');
const peopleRowsEl       = document.getElementById('people-rows');
const peopleSearchInput  = document.getElementById('people-search-input');
const peopleSceneInput   = document.getElementById('people-scene-input');
const peopleSelectBar    = document.getElementById('people-select-bar');
const peopleSelectCount  = document.getElementById('people-select-count');
const peopleSelectOkBtn  = document.getElementById('people-select-ok');
const peopleTabPeople    = document.getElementById('people-tab-people');
const peopleTabLocations = document.getElementById('people-tab-locations');
function closePeoplePopup() {
  peoplePopup.style.display = 'none';
  viewClosed('search');
}
document.getElementById('people-popup-close').addEventListener('click', closePeoplePopup);
peoplePopup.addEventListener('click', e => { if (e.target === peoplePopup) closePeoplePopup(); });

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _peopleList        = []; // full list from the last openPeoplePopup() — filtered locally as the user types
let _locationsList     = [];
let _peopleSelected    = new Map(); // id -> {id, name, count} — persists across tab switches and search filtering
let _locationsSelected = new Map(); // category -> {id, name, count}
let _peopleTab         = 'people'; // 'people' | 'locations' — which list is currently shown

function updatePeopleSelectBar() {
  const n = _peopleSelected.size + _locationsSelected.size;
  const hasSearch = peopleSceneInput.value.trim().length > 0;
  const parts = [];
  if (n) parts.push(`${n} selected`);
  if (hasSearch) parts.push('scene search');
  peopleSelectCount.textContent = parts.join(' + ');
  peopleSelectBar.style.display = (n || hasSearch) ? 'flex' : 'none';
}

function setPeopleTab(tab) {
  _peopleTab = tab;
  peopleTabPeople.classList.toggle('active', tab === 'people');
  peopleTabLocations.classList.toggle('active', tab === 'locations');
  peopleSearchInput.placeholder = tab === 'people' ? 'Search people…' : 'Search places…';
  renderPeopleRows(peopleSearchInput.value);
}
peopleTabPeople.addEventListener('click', () => setPeopleTab('people'));
peopleTabLocations.addEventListener('click', () => setPeopleTab('locations'));

function renderPeopleRows(filterText) {
  const isPeople = _peopleTab === 'people';
  const list     = isPeople ? _peopleList : _locationsList;
  const selected = isPeople ? _peopleSelected : _locationsSelected;
  const icon     = isPeople ? '👤' : '📍';
  const q = filterText.trim().toLowerCase();
  const filtered = q ? list.filter(p => p.name.toLowerCase().includes(q)) : list;
  peopleRowsEl.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'people-empty';
    empty.textContent = list.length ? 'No matches.' : (isPeople ? 'No people recognised.' : 'No places recognised.');
    peopleRowsEl.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of filtered) {
    const row = document.createElement('div');
    row.className = 'info-row people-row info-row-btn';

    const label = document.createElement('span');
    label.className = 'info-row-label';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'people-row-check';
    check.checked = selected.has(p.id);
    const name = document.createElement('span');
    name.className = 'people-row-name';
    name.textContent = `${icon} ${p.name}`;
    label.append(check, name);

    const value = document.createElement('span');
    value.className = 'info-row-value';
    value.textContent = p.count;

    row.append(label, value);

    check.addEventListener('click', e => {
      e.stopPropagation(); // don't also trigger the row's "open this item's grid" tap
      if (check.checked) selected.set(p.id, p);
      else selected.delete(p.id);
      updatePeopleSelectBar();
    });

    row.addEventListener('click', () => {
      // Hide the popup but leave it on the nav stack — closing the results
      // grid restores it with the query and selections intact. If the grid
      // never opens (no matches, error), re-show it right away.
      peoplePopup.style.display = 'none';
      const query = { searchText: peopleSceneInput.value, ...(isPeople ? { people: [p] } : { locations: [p] }) };
      openTaggedGrid(query)
        .then(opened => { if (!opened) restoreTop(); })
        .catch(e => { log('Tagged grid error', e.message); showBriefStatus(`Error: ${e.message}`); restoreTop(); });
    });
    frag.appendChild(row);
  }
  peopleRowsEl.appendChild(frag);
}

peopleSearchInput.addEventListener('input', () => renderPeopleRows(peopleSearchInput.value));

function runTaggedSearch() {
  if (!_peopleSelected.size && !_locationsSelected.size && !peopleSceneInput.value.trim()) return;
  const query = {
    people: [..._peopleSelected.values()],
    locations: [..._locationsSelected.values()],
    searchText: peopleSceneInput.value,
  };
  // Same hide-don't-close dance as the per-row tap above.
  peoplePopup.style.display = 'none';
  openTaggedGrid(query)
    .then(opened => { if (!opened) restoreTop(); })
    .catch(e => { log('Tagged grid error', e.message); showBriefStatus(`Error: ${e.message}`); restoreTop(); });
}
peopleSceneInput.addEventListener('input', updatePeopleSelectBar);
peopleSceneInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runTaggedSearch(); } });
peopleSelectOkBtn.addEventListener('click', runTaggedSearch);

async function openPeoplePopup() {
  const [{ list: people }, { list: locations }] = await Promise.all([getPeopleStats(), getLocationStats()]);
  // Note: no early return when both are empty — the scene-search box is a
  // standalone capability that doesn't depend on either mirror having data.
  infoPopup.style.display = 'none';
  _peopleList        = people;
  _locationsList      = locations;
  _peopleSelected     = new Map();
  _locationsSelected  = new Map();
  peopleSearchInput.value = '';
  peopleSceneInput.value  = '';
  updatePeopleSelectBar();
  setPeopleTab(people.length ? 'people' : 'locations');
  peoplePopup.style.display = 'flex';
  // Restore just re-shows the popup as it was — the query text and selected
  // people/places survive, so a returning user can refine and re-run.
  viewOpened('search', { close: closePeoplePopup, restore: () => { peoplePopup.style.display = 'flex'; } });
  // Kick off the (large, one-time) text-encoder model and embeddings corpus
  // downloads now rather than waiting for the user to actually submit a
  // scene search — and only re-check the embeddings corpus for staleness
  // here (on open), not on every app resume, since it's tens of MB.
  loadSearchModules().then(async ({ preloadTextEncoder, ensureFresh, setEmbeddingsProgressHandler, setTextEmbedProgressHandler }) => {
    setEmbeddingsProgressHandler(p => reportDownloadProgress('embeddings', p.bytes, p.total));
    setTextEmbedProgressHandler(p => reportDownloadProgress('model', p.bytes, p.total));
    await Promise.allSettled([preloadTextEncoder(), ensureFresh()]);
    _downloadProgress = {};
    setProgress(0);
  }).catch(e => log('Search modules', `failed to load: ${e.message}`));
}

// Combines progress from the two possibly-concurrent downloads (embeddings
// corpus + text-tower model files) into the app's existing top/bottom
// progress bar — reused rather than building a separate one, same as scan
// progress. Falls back to an indeterminate-looking creep if a source
// hasn't reported a content-length yet.
let _downloadProgress = {}; // key -> { bytes, total }
function reportDownloadProgress(key, bytes, total) {
  _downloadProgress[key] = { bytes, total };
  const parts = Object.values(_downloadProgress);
  const totalBytes = parts.reduce((s, p) => s + (p.total || 0), 0);
  const doneBytes  = parts.reduce((s, p) => s + p.bytes, 0);
  if (totalBytes > 0) setProgress((doneBytes / totalBytes) * 100);
}

function intersectHashSets(a, b) {
  if (!a) return b;
  const out = new Set();
  for (const h of a) if (b.has(h)) out.add(h);
  return out;
}

// Grid of all photos matching every selected person AND every selected
// location AND the free-text scene query together (a single-item selection
// is the plain "this person's"/"this place's photos" case; combining
// narrows to the intersection, e.g. one person + "mountains" + "snow").
// Faces/locations/embeddings entries are all joined to cached photo records
// by content hash — the grid needs fileids for thumbnails, so matches with
// no cached record are silently dropped.
async function openTaggedGrid(query = {}) {
  const { people = [], locations = [], searchText = '' } = query;
  let hashSet = null; // null = no constraint applied yet
  let scoreByHash = null; // set only when searchText ranked results — drives sort order
  const labelParts = [];

  if (people.length) {
    const entries = await getEntriesForPeople(people.map(p => p.id));
    hashSet = intersectHashSets(hashSet, new Set(entries.map(e => e.hash)));
    labelParts.push(`👤 ${people.map(p => p.name).join(' + ')}`);
  }
  if (locations.length) {
    const entries = await getEntriesForLocations(locations.map(l => l.id));
    hashSet = intersectHashSets(hashSet, new Set(entries.map(e => e.hash)));
    labelParts.push(`📍 ${locations.map(l => l.name).join(' + ')}`);
  }
  if (searchText.trim()) {
    // The first search after install/erase-cache downloads the text-encoder
    // model and embeddings corpus (tens of MB) before it can rank anything,
    // so give the status message plenty of room instead of it vanishing
    // mid-download and leaving the user staring at nothing.
    showBriefStatus('🔍 Searching… (first search downloads the search model — this can take a while)', 600000);
    const { rankByQuery } = await loadSearchModules();
    const ranked = await rankByQuery(searchText);
    if (!ranked.length) { showBriefStatus('Semantic search isn’t available yet — no embeddings synced from pCloud.'); return false; }
    scoreByHash = new Map(ranked.map(r => [r.hash, r.score]));
    hashSet = intersectHashSets(hashSet, new Set(scoreByHash.keys()));
    labelParts.push(`🔍 “${searchText.trim()}”`);
  }
  const label = labelParts.join(' · ');
  if (!hashSet || !hashSet.size) { showBriefStatus(`No photos found for ${label}.`); return false; }

  const byHash = new Map();
  for (const r of await getAllCached()) {
    if (r.hash != null && !r.ignored) byHash.set(String(r.hash), r);
  }
  const items = [];
  let missing = 0;
  for (const hash of hashSet) {
    const rec = byHash.get(hash);
    if (rec) items.push(rec); else missing++;
  }
  if (missing) log('Tagged grid', `${label}: ${missing} of ${hashSet.size} entries have no cached record`);
  if (!items.length) { showBriefStatus(`No cached photos for ${label} — run a scan or rebuild first.`); return false; }
  // Free-text search results are shown best-match-first; a plain people/
  // places selection stays chronological, matching every other grid in the app.
  if (scoreByHash) items.sort((a, b) => (scoreByHash.get(String(b.hash)) ?? -1) - (scoreByHash.get(String(a.hash)) ?? -1));
  else items.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));

  setGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
    resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts, lat: r.lat, lng: r.lng });
  })));
  setFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, () => resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts }))));
  setFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, () => resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts }))));
  setIgnoreHandler(null);
  setBulkIgnoreHandler(null);
  // Replace the long-lived "Searching…" toast — it outlives the search by
  // design (slow first-time model download) and the status bar sits above
  // every view, so it would otherwise linger over the results grid.
  if (searchText.trim()) showBriefStatus(`🔍 ${items.length} result${items.length === 1 ? '' : 's'}`);
  await openGrid((offset, limit) => Promise.resolve(items.slice(offset, offset + limit)), items.length,
    { title: label, sameDayFetch: sameDayFromList(items), reopen: () => openTaggedGrid(query) });
  return true;
}

// Grid of ignored photos. View/restore only: the tag/date actions are hidden
// and the ignore slot becomes ♻️ Restore, which clears the flag, re-adds the
// photo to the fix-up lists (or the map if it has GPS), and removes it from
// the persisted ignored.json.
async function openIgnoredGrid() {
  const total = await countIgnored();
  if (!total) { showBriefStatus('No ignored photos.'); return false; }
  const fetcher = (offset, limit) => getIgnoredPage(offset, limit);
  setGeotagHandler(null);
  setFixDateHandler(null);
  setFixTimeHandler(null);
  setIgnoreHandler(async photo => { await restoreOnePhoto(photo); showBriefStatus('♻️ Photo restored'); }, { icon: '♻️', title: 'Restore' });
  setBulkIgnoreHandler(bulkRestorePhotos, { icon: '♻️', title: 'Restore' });
  await openGrid(fetcher, total, {
    reopen: openIgnoredGrid,
    sameDayFetch: async anchors => {
      const ranges = distinctDayRanges(anchors);
      if (!ranges.length) return [];
      const all = await getAllIgnored();
      return all.filter(p => p.ts != null && p.ts < UNDATED_TS && ranges.some(r => p.ts >= r.from && p.ts <= r.to));
    },
  });
  return true;
}

function openInfoPopup() {
  renderInfoRows();
  infoPopup.style.display = 'flex';
  // Restore re-runs openInfoPopup so the counts re-render fresh — they may
  // have changed while a child view (grid, log, folder picker) was open.
  viewOpened('settings', { close: closeInfoPopup, restore: openInfoPopup });
  refreshPeopleCount();
  refreshLocationCount();
}

function closeInfoPopup() {
  infoPopup.style.display = 'none';
  viewClosed('settings');
}

// Always enabled — even with zero recognised people/places, the popup's
// scene-search box is a standalone capability that doesn't depend on either
// mirror having data. This just re-renders Settings if it's open and the
// count changed.
function updatePeopleFabState() {
  peopleFab.disabled = false;
}

// Re-derives the cached people count, updates the Persons FAB, and re-renders
// Settings if it's open and the count actually changed (e.g. after a
// background faces.json refresh).
function refreshPeopleCount() {
  getPeopleStats().then(({ peopleCount }) => {
    const n = peopleCount || null;
    const changed = n !== _peopleCount;
    _peopleCount = n;
    updatePeopleFabState();
    if (changed && infoPopup.style.display !== 'none') renderInfoRows();
  }).catch(e => log('People stats error', e.message));
}

// Same as refreshPeopleCount but for locations.json's categories — the FAB
// stays enabled if either mirror has data, since either tab is reachable
// from it.
function refreshLocationCount() {
  getLocationStats().then(({ categoryCount }) => {
    _locationCount = categoryCount || null;
    updatePeopleFabState();
  }).catch(e => log('Location stats error', e.message));
}

async function openDatedOrphanGrid() {
  const range = getActiveFilterRange();
  const from = range?.from ?? 1;
  const to = range?.to ?? UNDATED_TS - 1;
  const total = await countOrphansInRange(from, to);
  if (!total) { showBriefStatus(range ? 'No dated photos without location in this date range.' : 'No dated photos without location.'); return false; }
  const fetcher = (offset, limit) => getOrphansPage(offset, limit, from, to);
  async function reopenSlideshow() {
    const savedIdx = getCurrentSlideshowIndex();
    const t = await countOrphansInRange(from, to);
    if (!t) { showBriefStatus(range ? 'All photos in range have locations!' : 'All photos located!'); return; }
    openLazySlideshow(fetcher, t, { startIndex: Math.min(savedIdx, t - 1) });
  }
  setGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
    reopenSlideshow();
  })));
  setFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, reopenSlideshow)));
  setFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, reopenSlideshow)));
  setIgnoreHandler(ignoreOnePhoto);
  setBulkIgnoreHandler(bulkIgnorePhotos);
  await openGrid(fetcher, total, {
    reopen: openDatedOrphanGrid,
    // Every photo in this grid already has a date but no location — "same
    // day" treats every currently-selected tile as an anchor, resolves the
    // (possibly several) distinct calendar days among them, and pulls in
    // every other dated, unlocated photo from each of those days so one pin
    // can be applied to the whole combined batch at once.
    sameDayFetch: async anchors => {
      const ranges = distinctDayRanges(anchors);
      if (!ranges.length) return [];
      const lists = await Promise.all(ranges.map(r => getOrphansInRange(r.from, r.to)));
      const byId = new Map();
      for (const list of lists) for (const p of list) byId.set(p.fileid, p);
      return [...byId.values()];
    },
  });
  return true;
}

infoPopup.addEventListener('click', e => { if (e.target === infoPopup) closeInfoPopup(); });

document.getElementById('fix-position-only-btn').addEventListener('click', () => {
  openDatedOrphanGrid().catch(e => { log('Fix position error', e.message); showBriefStatus(`Error: ${e.message}`); });
});

async function openLocatedUndatedGrid() {
  const total = await countLocatedUndated();
  if (!total) { showBriefStatus('No located photos without a date.'); return false; }
  const fetcher = (offset, limit) => getLocatedUndatedPage(offset, limit);
  async function reopenSlideshow() {
    const savedIdx = getCurrentSlideshowIndex();
    const t = await countLocatedUndated();
    if (!t) { showBriefStatus('All located photos now have dates!'); return; }
    openLazySlideshow(fetcher, t, { startIndex: Math.min(savedIdx, t - 1) });
  }
  setGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
    reopenSlideshow();
  })));
  setFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, reopenSlideshow)));
  setFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, reopenSlideshow)));
  setIgnoreHandler(ignoreOnePhoto);
  setBulkIgnoreHandler(bulkIgnorePhotos);
  await openGrid(fetcher, total, { reopen: openLocatedUndatedGrid });
  return true;
}

// Every cached photo, regardless of category — the "Total" row in Settings.
async function openAllGrid() {
  const total = await countAllNonIgnored();
  if (!total) { showBriefStatus('No photos in cache.'); return false; }
  const fetcher = (offset, limit) => getAllNonIgnoredPage(offset, limit);
  async function reopenSlideshow() {
    const savedIdx = getCurrentSlideshowIndex();
    const t = await countAllNonIgnored();
    if (!t) { showBriefStatus('No photos left in cache.'); return; }
    openLazySlideshow(fetcher, t, { startIndex: Math.min(savedIdx, t - 1) });
  }
  setGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
    reopenSlideshow();
  })));
  setFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, reopenSlideshow)));
  setFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, reopenSlideshow)));
  setIgnoreHandler(ignoreOnePhoto);
  setBulkIgnoreHandler(bulkIgnorePhotos);
  await openGrid(fetcher, total, { reopen: openAllGrid });
  return true;
}

// Photos with both a date and a location — the "Position & Date" row in Settings.
async function openPositionAndDateGrid() {
  const total = await countGeotaggedInRange(1, UNDATED_TS - 1);
  if (!total) { showBriefStatus('No photos with both date and location.'); return false; }
  const fetcher = (offset, limit) => getPositionAndDatePage(offset, limit);
  async function reopenSlideshow() {
    const savedIdx = getCurrentSlideshowIndex();
    const t = await countGeotaggedInRange(1, UNDATED_TS - 1);
    if (!t) { showBriefStatus('No photos left with both date and location.'); return; }
    openLazySlideshow(fetcher, t, { startIndex: Math.min(savedIdx, t - 1) });
  }
  setGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
    reopenSlideshow();
  })));
  setFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, reopenSlideshow)));
  setFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, reopenSlideshow)));
  setIgnoreHandler(ignoreOnePhoto);
  setBulkIgnoreHandler(bulkIgnorePhotos);
  await openGrid(fetcher, total, { reopen: openPositionAndDateGrid });
  return true;
}

function showApp() {
  loginOverlay.style.display = 'none';
  menuFab.style.display = '';
  document.getElementById('fix-position-only-btn').style.display = '';
  peopleFab.style.display = '';
  heatmapBtn.style.display = '';
  mediaTypeBtn.style.display = '';
  mediaTypeBtn.innerHTML = MEDIA_ALL_ICON;
  authBtn.onclick = () => { closeInfoPopup(); logout(); location.reload(); };
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  loginError.textContent = '';
  try {
    if (pendingTfaToken) {
      await loginWithTFA(pendingTfaToken, totpInput.value, document.getElementById('trust-device').checked);
    } else {
      await loginWithPassword(
        document.getElementById('email').value,
        document.getElementById('password').value,
      );
    }
    showApp();
    await startScan();
    await checkPendingBulkResume();
  } catch (err) {
    if (err instanceof TwoFactorRequired) {
      pendingTfaToken = err.tfaToken;
      totpInput.style.display = '';
      totpInput.required = true;
      document.getElementById('trust-device-label').style.display = '';
      totpInput.focus();
      if (err.tfaToken) {
        loginError.textContent = 'Enter the code from your authenticator app.';
        log('2FA required', { tfaToken: err.tfaToken.slice(0, 8) + '…' });
      } else {
        loginError.textContent = 'pCloud did not return a TFA token — try the "Paste token" option below.';
        log('2FA required but no token in response');
      }
    } else {
      loginError.textContent = err.message;
      log('Login error', err.message);
    }
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
  }
});

function setupAuthBtn(isLoggedIn) {
  if (isLoggedIn) showApp();
}

// Lets a just-set status message actually paint before a synchronous,
// CPU-heavy call blocks the main thread (e.g. the marker-cluster pass below).
const nextFrame = () => new Promise(r => requestAnimationFrame(r));

let startScanInProgress = false;
async function startScan() {
  if (startScanInProgress) return;
  startScanInProgress = true;
  // Load cached markers first — no network needed, works immediately after wake.
  showBriefStatus('Loading cache…', 30000);
  setProgress(0);
  const _startupStart = Date.now();
  const _savedStartupMs = Number(localStorage.getItem(STARTUP_TIMING_KEY) || 0);
  if (_savedStartupMs > 200) _startStartupAnimation(_savedStartupMs);
  let cached = await getAllCached();
  if (cached.length === 0) {
    setStatus('Downloading index from pCloud…', 0);
    const n = await loadPhotoIndex();
    if (n > 0) {
      setStatus(`Index downloaded — ${n} entries. Loading…`, 0);
      cached = await getAllCached();
    }
  }
  let cachedGeo = 0, cachedLocatedUndated = 0, cachedDated = 0, cachedUnknown = 0, cachedIgnored = 0;
  const toMigrate = [];
  const geoToAdd  = [];
  for (const p of cached) {
    if (p.ignored) { cachedIgnored++; }
    else if (p.lat != null) {
      geoToAdd.push(p);
      cachedGeo++;
      if (!(p.ts > 0 && p.ts < UNDATED_TS)) cachedLocatedUndated++;
    }
    else { toMigrate.push(p); if (p.ts != null) cachedDated++; else cachedUnknown++; }
  }
  // One batch call: markercluster does a single cluster pass with chunkedLoading
  // instead of N individual addLayer() calls that each trigger a full re-cluster.
  if (geoToAdd.length) {
    setStatus(`Placing ${geoToAdd.length} pin${geoToAdd.length === 1 ? '' : 's'} on the map…`, 0);
    await nextFrame();
  }
  bulkAddMarkers(geoToAdd);
  topbarGeotagged      = cachedGeo;
  topbarLocatedUndated = cachedLocatedUndated;
  topbarDated          = cachedDated;
  topbarUnknown        = cachedUnknown;
  topbarTotal          = cached.length - cachedIgnored;
  topbarIgnored        = cachedIgnored;

  // Populate orphan store in one transaction so the No-location / No-date buttons work immediately.
  if (toMigrate.length > 0) {
    setStatus(`Indexing ${toMigrate.length} photo${toMigrate.length === 1 ? '' : 's'} without location…`, 0);
    try { await bulkPutOrphans(toMigrate); }
    catch (e) { log('orphan migration error', e.message); }
  }

  setStatus('Syncing video metadata & ignored list…', 0);
  await applyVideoMeta().catch(e => log('VideoMeta apply error', e.message));
  await applyIgnored().catch(e => log('Ignored apply error', e.message));
  // Faces mirror sync runs in the background — 4.5 MB download on first run.
  _lastFacesRefresh = Date.now(); // primes the resume-listener cooldown
  refreshFaces()
    .then(refreshPeopleCount) // enables/grays the Persons FAB once resolved, without waiting for Settings to be opened
    .catch(e => log('Faces refresh error', e.message));
  refreshLocations()
    .then(refreshLocationCount)
    .catch(e => log('Locations refresh error', e.message));
  refreshFlags().catch(e => log('Flags refresh error', e.message));

  _stopStartupAnimation();
  localStorage.setItem(STARTUP_TIMING_KEY, String(Date.now() - _startupStart));
  setProgress(100);
  setTimeout(() => setProgress(0), 500);
  showBriefStatus(cached.length > 0
    ? `Cache loaded — ${cachedGeo} geotagged, ${cached.length - cachedGeo} without location.`
    : 'Cache empty — open the menu and pick a folder to scan.');

  // Populate folder picker — a network failure here shouldn't affect the already-loaded markers.
  try {
    await populateFolderPicker();
  } catch (e) {
    log('folder picker error', e.message);
    showBriefStatus(`Could not load folders: ${e.message}`);
  }
  startScanInProgress = false;
}

// Offers to pick a bulk geotag back up after an app kill the background-sync
// service didn't manage to prevent (OS memory pressure can still win). Runs
// after startScan so resumeBulkGeotag's cache lookups have something to find.
async function checkPendingBulkGeotagResume() {
  const pending = getPendingBulkGeotag(); // array of { lat, lng, fileids } batches
  const total = pending?.reduce((n, b) => n + (b.fileids?.length ?? 0), 0) ?? 0;
  if (!total) return;
  const resume = await askResume(total, 'bulk geotag');
  if (!resume) { discardPendingBulkGeotag(); return; }
  await resumeBulkGeotag(() => reloadTopbarCounts());
}

// Checked together at every startup entry point — see each function's own
// comment for what it resumes.
async function checkPendingBulkResume() {
  await checkPendingBulkGeotagResume();
  await checkPendingBulkFixDateResume();
}

// Per-scan organize state. Reset at the start of each scan.
let _organizeRoot = null;  // Photos/ folderid (null = organize not ready)

let scanOperationInProgress = false;

// True only for pCloud auth-failure result codes (1000 log in required,
// 2000 log in failed, 2094/2095 invalid auth). Matching bare substrings like
// '2000' would also hit "Request timed out after 20000ms".
function isAuthError(e) {
  return /pCloud (1000|2000|2094|2095):/.test(e?.message ?? '');
}

async function runScan() {
  if (scanOperationInProgress) { showBriefStatus('A scan is already in progress.'); return; }
  scanOperationInProgress = true;
  scanCancelled = false;
  stopScanBtn.style.display = '';
  stopScanBtn.disabled = false;
  stopScanBtn.textContent = '■';
  setProgress(0);
  try {
    await scan();
  } catch (e) {
    if (isAuthError(e)) {
      logout();
      setStatus('Session expired — please reconnect.');
      location.reload();
    } else {
      setStatus(`Error: ${e.message}`);
    }
    console.error(e);
  } finally {
    stopScanBtn.style.display = 'none';
    scanOperationInProgress = false;
  }
}

async function runRebuild() {
  if (scanOperationInProgress) { showBriefStatus('A scan is already in progress — stop it first.'); return; }
  scanOperationInProgress = true;
  scanCancelled = false;
  stopScanBtn.style.display = '';
  stopScanBtn.disabled = false;
  stopScanBtn.textContent = '■';
  setProgress(0);
  try {
    await rebuildScan();
  } catch (e) {
    if (isAuthError(e)) {
      logout();
      setStatus('Session expired — please reconnect.');
      location.reload();
    } else {
      setStatus(`Rebuild error: ${e.message}`);
    }
    console.error(e);
  } finally {
    stopScanBtn.style.display = 'none';
    scanOperationInProgress = false;
  }
}

async function rebuildScan() {
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  // Clear EXIF cache and markers — we are rebuilding from Photos/ as source of truth.
  await Promise.all([clearNonIgnored(), clearOrphans()]);
  clearMarkers();

  const root = await getMapphoRoot();

  setStatus('Discovering files in Photos/…', 0);
  const allFiles = [];
  for await (const file of listImages(root, null)) {
    if (scanCancelled) break;
    allFiles.push(file);
    setStatus(`Discovering… ${allFiles.length} files found`, 0);
  }
  const total = allFiles.length;
  log('Rebuild', `${total} files found in Photos/`);
  setProgress(0);

  // Process files for EXIF — already in Photos/, do not re-organise.
  _organizeRoot = null;
  _rebuildSeenHashes = new Set();
  const stats = { scanned: 0, geotagged: 0, dated: 0, completed: 0, cached: 0 };
  const pool = new Set(), inFlight = new Map(), failedFiles = [];
  try {
    await processFiles(allFiles, total, stats, pool, inFlight, failedFiles);
    await Promise.all(pool);
  } finally {
    _rebuildSeenHashes = null;
  }
  // stats.cached during rebuild = files skipped by the hash-dedup check (Photos/ content duplicates).
  const dupCount = stats.cached;

  // Rebuild hash index from scratch (ignore any stale JSON).
  resetOrganizeState();
  setStatus('Rebuilding Photos index…', 0);
  setProgress(0);
  await loadOrganizeIndex(root, n => {
    setStatus(`Rebuilding Photos index… ${n} / ${total}`, 0);
    if (total > 0) setProgress((n / total) * 100);
  }, { forceRebuild: true });
  flushOrganizeIndex();
  flushPhotoIndex(root);
  await flushAll();

  await reloadTopbarCounts();
  applyVideoMeta().catch(e => log('VideoMeta apply error', e.message));
  applyIgnored().catch(e => log('Ignored apply error', e.message));
  const manualNote = sessionGeotagged > 0 ? ` + ${sessionGeotagged} manually tagged` : '';
  const dupNote = dupCount > 0 ? ` (${dupCount} content-duplicate file${dupCount === 1 ? '' : 's'} in Photos/ skipped)` : '';
  if (scanCancelled) {
    setStatus(`Rebuild stopped — ${stats.geotagged + sessionGeotagged} geotagged, ${stats.completed} processed${manualNote}${dupNote}.`);
    setProgress(0);
  } else {
    setStatus(`Rebuild done — ${stats.geotagged + sessionGeotagged} geotagged, ${total} total${manualNote}${dupNote}.`);
    setProgress(100);
    setTimeout(() => setProgress(0), 1000);
  }

  if (failedFiles.length > 0) {
    log('Rebuild errors', `${failedFiles.length} files failed`);
    retryQueue = failedFiles;
    retryContext = { prevStats: { ...stats }, prevTotal: total };
    updateRetryBtn();
    showRetryDialog(failedFiles);
  }

  try { wakeLock?.release(); } catch {}
}

// Returns true on success, false on network/download failure (file not written to DB so retry works).
async function processFile(file, stats) {
  // Fast path: file already organised into Photos/ — it's a duplicate in the source folder.
  if (_organizeRoot && isHashOrganized(normHash(file.hash))) {
    stats.cached++;
    log(`${file.name} [organized duplicate]`, 'skipped');
    return true;
  }

  // During rebuild (_organizeRoot=null, _rebuildSeenHashes active), skip content-duplicate files
  // in Photos/ (same hash = same bytes). Photos/ should never have two files with the same content,
  // but it can happen when the repair tool creates conflict-renamed copies alongside originals.
  if (_organizeRoot === null && _rebuildSeenHashes !== null && file.hash) {
    const h = normHash(file.hash);
    if (h) {
      if (_rebuildSeenHashes.has(h)) {
        stats.cached++;
        log(`${file.name} [rebuild hash duplicate]`, 'skipped — same content as a previously processed Photos/ file');
        return true;
      }
      _rebuildSeenHashes.add(h);
    }
  }

  const hit = await getCached(file.fileid);
  if (hit) {
    if (hit.ignored) return true;
    stats.cached++;
    log(`${file.name} [cached]`, hit.lat != null ? `GPS: ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}` : 'no GPS');
    if (hit.lat != null) { stats.geotagged++; addMarker(hit); }
    return true;
  }
  let exif;
  try {
    const isHeic = /\.heic$/i.test(file.name);
    const isMP4  = isVideo(file.name);
    if (isMP4) {
      const buf = await fetchFileHead(file.fileid);
      if (buf) log(`${file.name}`, `buffer: ${buf.byteLength}B`);
      exif = extractMP4Meta(buf);
      if (!exif.ts) { const ts = parseDateFromFilename(file.name); if (ts) exif.ts = ts; }
    } else {
      const buf = isHeic ? null : await fetchFileHead(file.fileid);
      if (buf) log(`${file.name}`, `buffer: ${buf.byteLength}B`);
      exif = await extractEXIF(buf, file.fileid, file.name);
    }
    log(`${file.name} → GPS`, exif.lat != null ? `${exif.lat.toFixed(4)},${exif.lng.toFixed(4)}` : 'null');
  } catch (e) {
    log(`${file.name} ERROR`, e.message);
    if (e.message.includes('timed out')) await new Promise(r => setTimeout(r, 3000));
    return false;
  }
  const hasGps = exif.lat != null && !isNaN(exif.lat) && exif.lng != null && !isNaN(exif.lng);
  const record = { fileid: file.fileid, name: file.name, lat: hasGps ? exif.lat : null, lng: hasGps ? exif.lng : null, ts: exif.ts ?? null, hash: file.hash != null ? String(file.hash) : null, rotation: exif.rotation ?? null };

  // organizeFile serializes its own name-pick + rename internally now (it
  // has to, since bulk geotag/fix-date can run edits concurrently too) —
  // concurrent processFile workers no longer need to coordinate a lock here.
  if (_organizeRoot) {
    const newName = await organizeFile(record, _organizeRoot);
    if (newName) {
      record.name = newName;
      updateMarkerName(record.fileid, newName);
    }
  }

  await putCached(record);
  if (hasGps) { stats.geotagged++; addMarker(record); }
  else { if (record.ts != null) stats.dated++; await putOrphan(record); }
  return true;
}

async function scan() {
  const stats = { scanned: 0, geotagged: 0, dated: 0, completed: 0, cached: 0 };
  const pool = new Set();
  const inFlight = new Map();

  const folders = getSelectedFolders();
  log('Scanning folders', folders.map(f => `${f.name ?? '/'} (id=${f.id})`).join(', '));

  // Phase 1: BFS all selected folders to discover the full file list
  setStatus('Discovering files…');
  const organizedFolderId = await findMapphoRootIfExists();
  const allFiles = [];
  outer: for (const { id: folderId, name: folderName } of folders) {
    if (scanCancelled) break;
    log('Discovering', `${folderName ?? '/'} (id=${folderId})`);
    for await (const file of listImages(folderId, organizedFolderId)) {
      if (scanCancelled) break outer;
      allFiles.push(file);
      setStatus(`Discovering… ${allFiles.length} files found`);
    }
  }
  const total = allFiles.length;
  log('Discovery done', `${total} JPEG files`);
  setProgress(0);

  // Initialise organize index before Phase 2 so each processFile can move files immediately.
  _organizeRoot = null;
  try {
    const root = await getMapphoRoot();
    resetOrganizeState();
    setStatus('Loading Photos index…', 0);
    await loadOrganizeIndex(root, n => setStatus(`Loading Photos index… ${n} entries`, 0));
    _organizeRoot = root;
    log('Organize', `index ready — ${total} files to process`);
  } catch (e) {
    log('Organize init error', `${e.message} — organizing disabled for this scan`);
  }

  // Phase 2: process with accurate progress bar
  const failedFiles = [];
  await processFiles(allFiles, total, stats, pool, inFlight, failedFiles);

  log('Drain', `waiting for: ${[...inFlight.values()].join(', ') || 'none'}`);
  await Promise.all(pool);

  // Schedule uploads for hash index and photo index, then force-flush immediately.
  if (_organizeRoot) {
    flushOrganizeIndex();
    flushPhotoIndex(_organizeRoot);
  }
  _organizeRoot = null;
  flushAll().catch(e => log('Sync flush error', e.message));

  await reloadTopbarCounts();
  applyVideoMeta().catch(e => log('VideoMeta apply error', e.message));
  applyIgnored().catch(e => log('Ignored apply error', e.message));
  const manualNote = sessionGeotagged > 0 ? ` + ${sessionGeotagged} manually tagged` : '';
  if (scanCancelled) {
    setStatus(`Stopped — ${stats.geotagged + sessionGeotagged} geotagged out of ${stats.completed} scanned${manualNote} (${total - stats.completed} remaining).`);
    setProgress(0);
  } else {
    setStatus(`Done — ${stats.geotagged + sessionGeotagged} geotagged out of ${total}${manualNote}.`);
    setProgress(100);
    setTimeout(() => setProgress(0), 1000);
  }

  if (failedFiles.length > 0) {
    log('Scan errors', `${failedFiles.length} files failed to download`);
    retryQueue = failedFiles;
    retryContext = { prevStats: { ...stats }, prevTotal: total };
    updateRetryBtn();
    showRetryDialog(failedFiles);
  }
}

// Adaptive concurrency: start at MAX_CONCURRENCY and react to the failure rate
// over a rolling window — halve on a high failure rate (likely bandwidth
// contention or congestion), creep back up by one on a clean window.
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 6;
const CONCURRENCY_WINDOW = 10;
const HIGH_FAILURE_RATE = 0.4;
const LOW_FAILURE_RATE  = 0.1;

async function processFiles(files, total, stats, pool, inFlight, failedFiles) {
  let concurrency = MAX_CONCURRENCY;
  const recentOutcomes = [];

  const diagTimer = setInterval(() => {
    if (inFlight.size > 0)
      log('in-flight', `${inFlight.size} pending: ${[...inFlight.values()].join(', ')}`);
  }, 15000);

  // Pause while the app is backgrounded. Android throttles the WebView JS
  // thread and may abort CapacitorHttp requests when backgrounded, so wait for
  // visibility before dispatching each new file; in-flight requests (already on
  // native threads) can finish cleanly without new ones piling up behind them.
  for (const file of files) {
    await waitForVisible();
    if (scanCancelled) break;
    stats.scanned++;
    setScanStatus(stats.scanned, stats.geotagged, stats.dated, total, stats.cached);

    const p = processFile(file, stats).then(ok => {
      if (!ok) failedFiles.push(file);

      recentOutcomes.push(ok);
      if (recentOutcomes.length >= CONCURRENCY_WINDOW) {
        const failureRate = recentOutcomes.filter(o => !o).length / recentOutcomes.length;
        if (failureRate > HIGH_FAILURE_RATE && concurrency > MIN_CONCURRENCY) {
          concurrency = Math.max(MIN_CONCURRENCY, Math.floor(concurrency / 2));
          log('Adaptive concurrency', `failure rate ${Math.round(failureRate * 100)}% — lowering to ${concurrency}`);
        } else if (failureRate < LOW_FAILURE_RATE && concurrency < MAX_CONCURRENCY) {
          concurrency++;
          log('Adaptive concurrency', `failure rate ${Math.round(failureRate * 100)}% — raising to ${concurrency}`);
        }
        recentOutcomes.length = 0;
      }
    }).finally(() => {
      pool.delete(p);
      inFlight.delete(p);
      stats.completed++;
      setProgress((stats.completed / total) * 100);
      setScanStatus(stats.scanned, stats.geotagged, stats.dated, total, stats.cached);
    });
    pool.add(p);
    inFlight.set(p, file.name);

    if (pool.size >= concurrency) await Promise.race(pool);
  }

  clearInterval(diagTimer);
}

function updateRetryBtn() {
  const btn = document.getElementById('retry-info-btn');
  if (!btn) return;
  if (retryQueue.length === 0) {
    btn.style.display = 'none';
  } else {
    btn.textContent = `⚠ ${retryQueue.length} files failed — Retry`;
    btn.style.display = '';
  }
}

function showRetryDialog(files) {
  document.getElementById('retry-dialog')?.remove();
  const dialog = document.createElement('div');
  dialog.id = 'retry-dialog';
  dialog.innerHTML = `
    <div id="retry-box">
      <p>${files.length} file${files.length > 1 ? 's' : ''} failed to download and were skipped.</p>
      <div id="retry-actions">
        <button id="retry-yes">Retry</button>
        <button id="retry-copy">Copy list</button>
        <button id="retry-no">Later</button>
        <button id="retry-discard">Discard list</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  const closeDialog = () => { dialog.remove(); viewClosed('retry'); };
  viewOpened('retry', { close: closeDialog }); // back = Later

  document.getElementById('retry-no').addEventListener('click', closeDialog);
  document.getElementById('retry-discard').addEventListener('click', () => {
    closeDialog();
    retryQueue = [];
    updateRetryBtn();
  });
  document.getElementById('retry-copy').addEventListener('click', async () => {
    const text = files.map(f => f.name).join('\n');
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('retry-copy');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy list'; }, 2000);
  });
  document.getElementById('retry-yes').addEventListener('click', async () => {
    closeDialog();
    if (scanOperationInProgress) { showBriefStatus('A scan is already in progress.'); return; }
    scanOperationInProgress = true;
    const ctx = retryContext;
    const total = ctx?.prevTotal ?? files.length;
    const succeeded = total - files.length;
    const stats = ctx?.prevStats
      ? { ...ctx.prevStats, completed: succeeded, scanned: succeeded }
      : { scanned: 0, geotagged: 0, dated: 0, completed: 0, cached: 0 };
    const pool = new Set(), inFlight = new Map(), stillFailed = [];
    scanCancelled = false;
    stopScanBtn.style.display = '';
    stopScanBtn.disabled = false;
    stopScanBtn.textContent = '■';
    setProgress((stats.completed / total) * 100);
    try {
      await processFiles(files, total, stats, pool, inFlight, stillFailed);
      await Promise.all(pool);
    } finally {
      stopScanBtn.style.display = 'none';
      scanOperationInProgress = false;
    }
    await reloadTopbarCounts();
    retryQueue = stillFailed;
    retryContext = stillFailed.length > 0 ? { prevStats: { ...stats }, prevTotal: total } : null;
    updateRetryBtn();
    if (stillFailed.length === 0) { setProgress(100); setTimeout(() => setProgress(0), 1000); }
    else setProgress((stats.completed / total) * 100);
    log('Retry done', `${stillFailed.length} still failing after retry`);
    if (stillFailed.length > 0) showRetryDialog(stillFailed);
  });
}

async function main() {
  handleCallback();
  startSyncTimer();
  initMap();
  setAfterDeleteCallback(() => reloadTopbarCounts());
  setAfterBulkGeotagCallback(() => reloadTopbarCounts());
  document.getElementById('retry-info-btn').addEventListener('click', () => {
    closeInfoPopup();
    if (retryQueue.length > 0) showRetryDialog(retryQueue);
  });

  setGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
    resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts, lat: r.lat, lng: r.lng });
  })));
  setFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, () => resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts }))));
  setFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, () => resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts }))));
  setBulkFixDateHandler((photos, cb) => startBulkFixDate(photos, cb));
  setGeotagStatusFn(setStatus);
  setGeotagProgressFn(setProgress);
  setPhotoEditProgressFn(setProgress);
  setEditHandler((photo, thumbSrc) => {
    openPhotoEdit(photo, thumbSrc, async ({ newFileid, newName, newHash, thumbSrc: newThumb }) => {
      // Migrate the cache record to the new fileid — overwriteFile replaced the
      // file, so a stale record would 2009-purge on the next thumbnail load.
      try {
        if (newFileid !== photo.fileid) {
          const cached = await getCached(photo.fileid);
          await deleteRecord(photo.fileid);
          await deleteOrphan(photo.fileid);
          const hash = newHash ?? cached?.hash ?? null;
          if (cached) await putCached({ ...cached, fileid: newFileid, name: newName, hash });
          if (!cached || cached.lat == null) await putOrphan({ fileid: newFileid, name: newName, ts: cached?.ts ?? photo.ts, hash });
          if (cached?.lat != null) {
            removeMarker(photo.fileid);
            addMarker({ fileid: newFileid, name: newName, lat: cached.lat, lng: cached.lng, ts: cached.ts });
          }
          // Grid tiles are only this photo's rendered pixels, not just its
          // identity — pass the freshly-edited thumbnail so it doesn't sit
          // there stale until the grid is fully reopened.
          updateGridItem(photo.fileid, { fileid: newFileid, name: newName, hash }, newThumb);
        }
      } catch (e) {
        log('Photo edit cache update error', e.message);
      }
      updateCurrentSlideshowItem({ fileid: newFileid, name: newName, ts: photo.ts });
      refreshSlideshowImage(newFileid, newThumb);
      reloadTopbarCounts();
      flushPhotoIndex();
      showBriefStatus('✅ Photo saved');
    });
  });

  // Handlers for map marker slideshow.
  setMarkerGeotagHandler(photo => startGeotagging(photo, r => handleEditResult(r, () => {
    if (r.success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
    resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts, lat: r.lat, lng: r.lng });
  })));
  setMarkerFixDateHandler(photo => startFixDate(photo, r => handleEditResult(r, () => resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts }))));
  setMarkerFixTimeHandler(photo => startFixTime(photo, r => handleEditResult(r, () => resumeAfterHandoff({ success: r.success, fileid: r.newFileid, name: r.newName, ts: r.ts }))));
  setMarkerIgnoreHandler(ignoreOnePhoto);
  setMarkerBulkIgnoreHandler(bulkIgnorePhotos);

  const token = getToken();
  setupAuthBtn(!!token);

  if (!token) {
    return; // login form is shown
  }

  await startScan();
  await checkPendingBulkResume();
  setupFacesResumeSync();
}

const FACES_RESUME_COOLDOWN_MS = 2 * 60 * 1000; // avoid re-checking on every brief app-switch
let _lastFacesRefresh = 0;

// The external tool runs on a laptop, not the phone — the only way the app
// learns a fresh faces.json exists is by checking on resume. A plain startup
// check (already done in startScan) misses regenerations that happen while
// the app is merely backgrounded, not fully restarted.
function setupFacesResumeSync() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!getToken()) return;
    const now = Date.now();
    if (now - _lastFacesRefresh < FACES_RESUME_COOLDOWN_MS) return;
    _lastFacesRefresh = now;
    log('Faces', 'app resumed — checking for a newer faces.json');
    refreshFaces()
      .then(refreshPeopleCount)
      .catch(e => log('Faces refresh error', e.message));
    refreshLocations()
      .then(refreshLocationCount)
      .catch(e => log('Locations refresh error', e.message));
    refreshFlags().catch(e => log('Flags refresh error', e.message));
  });
}

main();
