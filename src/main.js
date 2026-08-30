import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileTransfer } from '@capacitor/file-transfer';
import { handleCallback, getToken, loginWithPassword, loginWithTFA, logout, saveToken, TwoFactorRequired, getApiHost, setApiHost, EU_HOST, US_HOST } from './auth.js';
import { viewOpened, viewClosed, navBack, restoreTop } from './nav.js';

const BUILD_TIME = new Date(__BUILD_TIME__);
const APP_SHA    = __GIT_SHA__;
import { log, toggleLog } from './log.js';
import { toggleFilter, closeFilter, getActiveFilterRange, setRangeInfoHandler } from './filter.js';
import { listImages, listFolders, folderExists, fetchFileHead, LARGE_FILE_TIMEOUT } from './pcloud.js';
import { extractEXIF, parseDateFromFilename } from './exif.js';
import { extractMP4Meta, isVideo } from './mp4.js';
import { initMap, addMarker, bulkAddMarkers, removeMarker, clearMarkers, toggleHeatmap, getHeatmapActive, setMediaTypeFilter, getMediaTypeFilter, updateMarkerName, setMarkerGeotagHandler, setMarkerFixDateHandler, setMarkerFixTimeHandler, setMarkerIgnoreHandler, setMarkerBulkIgnoreHandler, getViewportBounds, browsePinsInView, flyToSearchResult } from './map.js';
import { searchLocation } from './geocode.js';
import { openLazySlideshow, setGeotagHandler, setFixDateHandler, setFixTimeHandler, setIgnoreHandler, setEditHandler, setAfterDeleteCallback, updateCurrentSlideshowItem, refreshSlideshowImage, getCurrentSlideshowIndex, resumeAfterHandoff } from './slideshow.js';
import { openPhotoEdit, setPhotoEditProgressFn, setPhotoEditStatusFn, checkPendingPhotoEditResume } from './photoedit.js';
import { checkPendingShare, listenForShares } from './import.js';
import { startGeotagging, setGeotagStatusFn, setGeotagProgressFn, getPendingBulkGeotag, resumeBulkGeotag, discardPendingBulkGeotag } from './geotag.js';
import { startFixDate, startFixTime, startBulkFixDate, setFixDateStatusFn, setFixDateProgressFn, setFixDateBriefStatusFn, setFixDateReloadCountsFn, checkPendingBulkFixDateResume } from './fixdate.js';
import { openGrid, setBulkFixDateHandler, setBulkIgnoreHandler, setAfterBulkGeotagCallback, updateGridItem } from './grid.js';
import { findMapphoRootIfExists, getMapphoRoot, loadOrganizeIndex, flushOrganizeIndex, organizeFile, resetOrganizeState, isHashOrganized, normHash } from './organize.js';
import { applyVideoMeta } from './videometa.js';
import { setIgnoredEntry, removeIgnoredEntry, applyIgnored } from './ignoremeta.js';
import { refreshFaces, getPeopleStats, getEntriesForPeople } from './faces.js';
import { refreshLocations } from './locations.js';
import { refreshFlags } from './flags.js';
import { flushPhotoIndex, loadPhotoIndex } from './photoindex.js';
import { startSyncTimer, flushAll } from './syncmanager.js';
import { askResume, waitForVisible } from './confirm.js';
import { getCached, putCached, bulkPutCached, getAllCached, clearAll, clearNonIgnored, putOrphan, bulkPutOrphans, countOrphans, countCached, countIgnored, getIgnoredPage, getAllIgnored, unignorePhoto, clearOrphans, getOrphansPage, getOrphansInRange, countOrphansInRange, countLocatedUndated, getLocatedUndatedPage, countAllNonIgnored, getAllNonIgnoredPage, getPositionAndDatePage, countGeotaggedInRange, ignorePhoto, deleteRecord, deleteOrphan, clearTextModelFiles, UNDATED_TS } from './db.js';
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
// and its local record was already purged (see geotag.js/fixdate.js's own
// StaleFileError classes) — surface that distinctly instead of leaving it looking
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
const mapSearchBar = document.getElementById('map-search-bar');
mapSearchBar.addEventListener('click', () => {
  openPeoplePopup().catch(e => { log('Search popup error', e.message); showBriefStatus(`Error: ${e.message}`); });
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
      const apkUrl = 'https://github.com/iltommi/mappho/releases/download/latest/Mappho.apk';
      showBriefStatus('Update available — downloading…', 60000);
      let listener = null;
      try {
        const { uri: path } = await Filesystem.getUri({ path: 'Mappho.apk', directory: Directory.Cache });
        listener = await FileTransfer.addListener('progress', p => {
          if (p.url !== apkUrl || !p.contentLength) return;
          showBriefStatus(`Downloading update… ${Math.round((p.bytes / p.contentLength) * 100)}%`, 60000);
        });
        const result = await FileTransfer.downloadFile({
          url: apkUrl, path, progress: true,
          connectTimeout: LARGE_FILE_TIMEOUT, readTimeout: LARGE_FILE_TIMEOUT,
        });
        if (!result.path) throw new Error('FileTransfer.downloadFile returned no path');
        await Capacitor.Plugins.Downloader.installApk({ path: result.path });
      } catch (e) {
        log('Update download error', e.message);
        window.open(apkUrl, '_system');
      } finally {
        listener?.remove();
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
  // embeddings.js is loaded dynamically (not statically imported here) the
  // same way search itself is — it doesn't pull in the heavy ML bundle on
  // its own (that's textembed.js), but there's no reason to eagerly import
  // it just for the rare "erase cache" tap either.
  await Promise.all([
    clearAll(), clearOrphans(), clearTextModelFiles(),
    import('./embeddings.js').then(({ clearEmbeddings }) => clearEmbeddings()),
  ]);
  clearMarkers(); // also resets the map's heatmap + media-type filter state
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

// ── Layers sheet: media-type, heatmap, date-range ─────────────────────────────
const layersBtn        = document.getElementById('layers-btn');
const layersSheet      = document.getElementById('layers-sheet');
const layersMediaType  = document.getElementById('layers-mediatype');
const layersHeatmap    = document.getElementById('layers-heatmap-check');

function closeLayersSheet() {
  layersSheet.style.display = 'none';
  viewClosed('layers');
}

function openLayersSheet() {
  // Reflect live map state each open — media-type is a settable filter, and
  // the heatmap/date-range can also be reset elsewhere (e.g. erase cache).
  const type = getMediaTypeFilter();
  layersMediaType.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  layersHeatmap.checked = getHeatmapActive();
  layersSheet.style.display = 'flex';
  viewOpened('layers', { close: closeLayersSheet });
}

layersBtn.addEventListener('click', openLayersSheet);
layersSheet.addEventListener('click', e => { if (e.target === layersSheet) closeLayersSheet(); });

layersMediaType.addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  setMediaTypeFilter(btn.dataset.type);
  layersMediaType.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
});
layersHeatmap.addEventListener('change', () => {
  // toggleHeatmap flips and returns the new state; keep the checkbox in sync
  // with what actually happened rather than assuming.
  layersHeatmap.checked = toggleHeatmap();
});
document.getElementById('layers-daterange-row').addEventListener('click', () => {
  closeLayersSheet();
  toggleFilter();
});

const pinBrowseBtn = document.getElementById('pin-browse-btn');
pinBrowseBtn.addEventListener('click', () => browsePinsInView());

// The search popup's two segments: Photos (people/scene — the default) and
// Places (type a city/country to fly the map there). setSearchSeg toggles
// which section shows; the Places search is otherwise self-contained here.
const searchSeg          = document.getElementById('search-seg');
const searchPhotos       = document.getElementById('search-photos');
const searchPlaces       = document.getElementById('search-places');
const placeSearchInput   = document.getElementById('place-search-input');
const placeSearchBtn     = document.getElementById('place-search-btn');
const placeSearchResults = document.getElementById('place-search-results');

function setSearchSeg(seg) {
  searchPhotos.style.display = seg === 'places' ? 'none' : '';
  searchPlaces.style.display = seg === 'places' ? '' : 'none';
  searchSeg.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.seg === seg));
  if (seg === 'places') placeSearchInput.focus();
}
searchSeg.addEventListener('click', e => {
  const b = e.target.closest('.seg-btn');
  if (b) setSearchSeg(b.dataset.seg);
});

async function doPlaceSearch() {
  const q = placeSearchInput.value.trim();
  if (!q) return;
  placeSearchBtn.disabled = true;
  placeSearchBtn.textContent = '⏳';
  placeSearchResults.innerHTML = '';
  try {
    const results = await searchLocation(q);
    if (!results.length) {
      placeSearchResults.textContent = 'No results found.';
    } else {
      for (const r of results) {
        const btn = document.createElement('button');
        btn.className = 'pin-drop-result-btn';
        btn.textContent = r.label;
        btn.addEventListener('click', () => {
          flyToSearchResult(r);
          closePeoplePopup(); // tapping a place flies the map and dismisses search
        });
        placeSearchResults.appendChild(btn);
      }
    }
  } catch (e) {
    placeSearchResults.textContent = `Error: ${e.message}`;
  } finally {
    placeSearchBtn.disabled = false;
    placeSearchBtn.textContent = '🔍';
  }
}

placeSearchBtn.addEventListener('click', doPlaceSearch);
placeSearchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doPlaceSearch(); } });

const infoPopup      = document.getElementById('info-popup');
const infoRowsEl     = document.getElementById('info-rows');

let _peopleCount   = null; // people recognised in faces.json; null = unknown/none

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
const peopleSearchClear  = document.getElementById('people-search-clear');
const peopleSceneInput   = document.getElementById('people-scene-input');
const peopleSelectBar    = document.getElementById('people-select-bar');
const peopleSelectCount  = document.getElementById('people-select-count');
const peopleSelectOkBtn  = document.getElementById('people-select-ok');
const mediaTypePhotos    = document.getElementById('people-mediatype-photos');
const mediaTypeVideos    = document.getElementById('people-mediatype-videos');
const viewportCheck      = document.getElementById('people-viewport-check');

// Read at search time, not live-reactive (same as the scene text input and
// people/location selections — nothing re-runs until the user taps a row,
// hits OK, or presses Enter). Unchecking both media types is allowed but
// treated as "no filter" rather than "match nothing" — see openTaggedGrid's
// mediaType handling — so there's no invalid state to guard against here.
function currentSearchFiltersQuery() {
  return {
    includePhotos: mediaTypePhotos.checked,
    includeVideos: mediaTypeVideos.checked,
    inViewport: viewportCheck.checked,
  };
}

// Remembers the last search actually run (any entry point — a row tap or
// the OK button) so reopening the popup later starts from it instead of a
// blank slate. Stores ids only (not the {id,name,count} objects themselves,
// which can go stale — a person's name or photo count changes over time) —
// resolved back against the freshly-loaded list on the next open, so a
// since-deleted person is silently dropped instead of restored broken.
const LAST_SEARCH_KEY = 'mappho_last_search';
function saveLastSearch(query) {
  try {
    localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify({
      peopleIds: (query.people ?? []).map(p => p.id),
      searchText: query.searchText ?? '',
      includePhotos: query.includePhotos ?? true,
      includeVideos: query.includeVideos ?? true,
      inViewport: query.inViewport ?? false,
    }));
  } catch {}
}
function loadLastSearch() {
  try {
    const raw = localStorage.getItem(LAST_SEARCH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function closePeoplePopup() {
  peoplePopup.style.display = 'none';
  placeSearchResults.innerHTML = '';
  placeSearchInput.value = '';
  viewClosed('search');
}
peoplePopup.addEventListener('click', e => { if (e.target === peoplePopup) closePeoplePopup(); });

let _peopleList     = []; // full list from the last openPeoplePopup() — filtered locally as the user types
let _peopleSelected = new Map(); // id -> {id, name, count} — persists across search filtering

function updatePeopleSelectBar() {
  const n = _peopleSelected.size;
  const hasSearch = peopleSceneInput.value.trim().length > 0;
  const viewportOnly = viewportCheck.checked;
  const parts = [];
  if (n) parts.push(`${n} selected`);
  if (hasSearch) parts.push('scene search');
  if (viewportOnly) parts.push('current map view');
  peopleSelectCount.textContent = parts.join(' + ');
  peopleSelectBar.style.display = (n || hasSearch || viewportOnly) ? 'flex' : 'none';
}
viewportCheck.addEventListener('change', updatePeopleSelectBar);

function renderPeopleRows(filterText) {
  const q = filterText.trim().toLowerCase();
  const filtered = q ? _peopleList.filter(p => p.name.toLowerCase().includes(q)) : _peopleList;
  // Selected rows float to the top so a multi-selection stays visible above
  // the fold; each group otherwise keeps _peopleList's own order (by count,
  // then name — see getPeopleStats), so unchecking a row returns it to
  // exactly where it'd naturally sort rather than wherever it last was.
  const sorted = [
    ...filtered.filter(p => _peopleSelected.has(p.id)),
    ...filtered.filter(p => !_peopleSelected.has(p.id)),
  ];
  peopleRowsEl.innerHTML = '';
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'people-empty';
    empty.textContent = _peopleList.length ? 'No matches.' : 'No people recognised.';
    peopleRowsEl.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const p of sorted) {
    const row = document.createElement('div');
    row.className = 'info-row people-row info-row-btn';

    const label = document.createElement('span');
    label.className = 'info-row-label';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'people-row-check';
    check.checked = _peopleSelected.has(p.id);
    const name = document.createElement('span');
    name.className = 'people-row-name';
    name.textContent = `👤 ${p.name}`;
    label.append(check, name);

    const value = document.createElement('span');
    value.className = 'info-row-value';
    value.textContent = p.count;

    row.append(label, value);

    check.addEventListener('click', e => {
      e.stopPropagation(); // don't also trigger the row's "open this item's grid" tap
      if (check.checked) _peopleSelected.set(p.id, p);
      else _peopleSelected.delete(p.id);
      renderPeopleRows(peopleSearchInput.value); // re-sort: move this row to/from the top
      updatePeopleSelectBar();
    });

    row.addEventListener('click', () => {
      // Hide the popup but leave it on the nav stack — closing the results
      // grid restores it with the query and selections intact. If the grid
      // never opens (no matches, error), re-show it right away.
      peoplePopup.style.display = 'none';
      const query = { searchText: peopleSceneInput.value, ...currentSearchFiltersQuery(), people: [p] };
      saveLastSearch(query);
      openTaggedGrid(query)
        .then(opened => { if (!opened) restoreTop(); })
        .catch(e => { log('Tagged grid error', e.message); showBriefStatus(`Error: ${e.message}`); restoreTop(); });
    });
    frag.appendChild(row);
  }
  peopleRowsEl.appendChild(frag);
}

function updatePeopleSearchClear() {
  peopleSearchClear.style.display = peopleSearchInput.value ? '' : 'none';
}
peopleSearchInput.addEventListener('input', () => {
  renderPeopleRows(peopleSearchInput.value);
  updatePeopleSearchClear();
});
peopleSearchClear.addEventListener('click', () => {
  peopleSearchInput.value = '';
  renderPeopleRows('');
  updatePeopleSearchClear();
  peopleSearchInput.focus();
});

function runTaggedSearch() {
  // "Only in current map view" checked with nothing else selected is a
  // valid, standalone search (everything currently on screen) — the empty
  // guard below only blocks a totally criteria-less tap/Enter.
  if (!_peopleSelected.size && !peopleSceneInput.value.trim() && !viewportCheck.checked) return;
  const query = {
    people: [..._peopleSelected.values()],
    searchText: peopleSceneInput.value,
    ...currentSearchFiltersQuery(),
  };
  saveLastSearch(query);
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
  const { list: people } = await getPeopleStats();
  // Note: no early return when empty — the scene-search box is a standalone
  // capability that doesn't depend on the faces mirror having data.
  infoPopup.style.display = 'none';
  _peopleList = people;

  // Restores the last search actually run, rather than always starting
  // blank — ids are resolved against the freshly-loaded list so a
  // since-deleted person is silently dropped instead of restored broken.
  // peopleSearchInput (the row-filter box) is deliberately not part of
  // this — it's a transient way to find a row in a long list, not part of
  // "the search that was run".
  const last = loadLastSearch();
  _peopleSelected = new Map((last?.peopleIds ?? []).map(id => people.find(p => p.id === id)).filter(Boolean).map(p => [p.id, p]));
  peopleSearchInput.value = '';
  updatePeopleSearchClear();
  peopleSceneInput.value  = last?.searchText ?? '';
  mediaTypePhotos.checked = last?.includePhotos ?? true;
  mediaTypeVideos.checked = last?.includeVideos ?? true;
  viewportCheck.checked   = last?.inViewport ?? false;
  updatePeopleSelectBar();
  renderPeopleRows('');
  setSearchSeg('photos'); // always open on the richer Photos segment
  peoplePopup.style.display = 'flex';
  // Restore just re-shows the popup as it was — the query text and selected
  // people survive, so a returning user can refine and re-run.
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

// Grid of all photos matching every selected person AND the free-text scene
// query together (a single-item selection is the plain "this person's
// photos" case; combining narrows to the intersection, e.g. one person +
// "mountains" + "snow"). Faces/embeddings entries are all joined to cached
// photo records by content hash — the grid needs fileids for thumbnails, so
// matches with no cached record are silently dropped.
async function openTaggedGrid(query = {}) {
  const { people = [], searchText = '', includePhotos = true, includeVideos = true, inViewport = false } = query;
  let hashSet = null; // null = no constraint applied yet
  let scoreByHash = null; // set only when searchText ranked results — drives sort order
  const labelParts = [];

  if (people.length) {
    const entries = await getEntriesForPeople(people.map(p => p.id));
    hashSet = intersectHashSets(hashSet, new Set(entries.map(e => e.hash)));
    labelParts.push(`👤 ${people.map(p => p.name).join(' + ')}`);
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
  // Both checked (the default) or both unchecked both mean "no constraint" —
  // there's no useful meaning for "match neither type", so an accidentally-
  // empty selection fails open to showing everything instead of nothing.
  const mediaTypeFilter = includePhotos !== includeVideos ? (includeVideos ? 'videos' : 'photos') : null;
  if (mediaTypeFilter) labelParts.push(mediaTypeFilter === 'videos' ? '🎬 Videos only' : '📷 Photos only');
  // Grabbed once up front (not re-read after the map might have moved) so
  // the results match what was actually on screen when the search ran.
  const bounds = inViewport ? getViewportBounds() : null;
  if (bounds) labelParts.push('🗺️ in view');
  const label = labelParts.join(' · ');
  // hashSet stays null when people/searchText were both empty — normally
  // unreachable (callers require at least one of those or inViewport before
  // calling this), but a bare "everything in view" search is a real case:
  // fall through to every cached record instead of bailing.
  if (!hashSet && !bounds) { showBriefStatus(`No photos found for ${label}.`); return false; }
  if (hashSet && !hashSet.size) { showBriefStatus(`No photos found for ${label}.`); return false; }

  const byHash = new Map();
  for (const r of await getAllCached()) {
    if (r.hash != null && !r.ignored) byHash.set(String(r.hash), r);
  }
  let items = [];
  let missing = 0;
  if (hashSet) {
    for (const hash of hashSet) {
      const rec = byHash.get(hash);
      if (rec) items.push(rec); else missing++;
    }
    if (missing) log('Tagged grid', `${label}: ${missing} of ${hashSet.size} entries have no cached record`);
  } else {
    items = [...byHash.values()];
  }
  if (mediaTypeFilter) items = items.filter(r => isVideo(r.name) === (mediaTypeFilter === 'videos'));
  if (bounds) items = items.filter(r => r.lat != null && r.lng != null && bounds.contains([r.lat, r.lng]));
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
}

function closeInfoPopup() {
  infoPopup.style.display = 'none';
  viewClosed('settings');
}

// Re-derives the cached people count and re-renders the Menu sheet's
// Organize section if it's open and the count actually changed (e.g. after a
// background faces.json refresh). Search itself is always reachable from the
// top bar, so there's no FAB state to keep in sync any more.
function refreshPeopleCount() {
  getPeopleStats().then(({ peopleCount }) => {
    const n = peopleCount || null;
    const changed = n !== _peopleCount;
    _peopleCount = n;
    if (changed && infoPopup.style.display !== 'none') renderInfoRows();
  }).catch(e => log('People stats error', e.message));
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
  mapSearchBar.style.display = '';
  menuFab.style.display = '';
  layersBtn.style.display = '';
  pinBrowseBtn.style.display = '';
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

// Checked together at every startup entry point.
async function checkPendingBulkResume() {
  await checkPendingBulkGeotagResume();
  await checkPendingBulkFixDateResume(() => reloadTopbarCounts());
  await checkPendingPhotoEditResume(() => reloadTopbarCounts());
  // Not a resume in the same sense as the three above (nothing was
  // interrupted mid-flight to offer resuming) — just: the app may have just
  // been launched by an incoming share, and this is the first point after
  // startScan where organize.js's hash index is guaranteed loaded, which
  // importNewFile needs.
  await checkPendingShare(() => reloadTopbarCounts());
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

  // try/finally so the diagnostic interval is always cleared — otherwise a
  // throw out of the loop (e.g. waitForVisible rejecting) would leave it
  // firing every 15s for the rest of the app's life.
  try {
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
  } finally {
    clearInterval(diagTimer);
  }
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
  setFixDateStatusFn(setStatus);
  setFixDateProgressFn(setProgress);
  setFixDateBriefStatusFn(showBriefStatus);
  setFixDateReloadCountsFn(reloadTopbarCounts);
  setPhotoEditStatusFn(setStatus);
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
  // Live "go check now" signal for a share arriving while already running —
  // checkPendingBulkResume's own checkPendingShare call is what actually
  // covers cold start (see MediaExchangePlugin's handleOnNewIntent comment).
  listenForShares(() => reloadTopbarCounts());

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
      .catch(e => log('Locations refresh error', e.message));
    refreshFlags().catch(e => log('Flags refresh error', e.message));
  });
}

main();
