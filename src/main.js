import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { handleCallback, getToken, loginWithPassword, loginWithTFA, logout, saveToken, TwoFactorRequired, getApiHost, setApiHost, EU_HOST, US_HOST } from './auth.js';

const BUILD_TIME = new Date(__BUILD_TIME__);
const APP_SHA    = __GIT_SHA__;
import { log, toggleLog } from './log.js';
import { toggleFilter, closeFilter, getActiveFilterRange, setRangeInfoHandler } from './filter.js';
import { listImages, listFolders, folderExists, fetchFileHead, downloadFullFile, overwriteFile, uploadFile, deleteFile, getFileStat } from './pcloud.js';
import { extractEXIF, parseDateFromFilename, injectExif, heicToJpeg, extractHeicMeta } from './exif.js';
import { extractMP4Meta, isVideo } from './mp4.js';
import { initMap, addMarker, removeMarker, clearMarkers, toggleHeatmap, cycleMediaTypeFilter, MEDIA_ALL_ICON, updateMarkerName, setMarkerGeotagHandler, setMarkerFixDateHandler } from './map.js';
import { openLazySlideshow, setGeotagHandler, setFixDateHandler, setIgnoreHandler, setAfterDeleteCallback } from './slideshow.js';
import { startGeotagging } from './geotag.js';
import { openGrid, setBulkFixDateHandler } from './grid.js';
import { findMapphoRootIfExists, syncMapphoOnEdit, getMapphoRoot, loadOrganizeIndex, flushOrganizeIndex, organizeFile, resetOrganizeState, isHashOrganized, normHash } from './organize.js';
import { applyVideoMeta } from './videometa.js';
import { setIgnoredEntry, removeIgnoredEntry, applyIgnored } from './ignoremeta.js';
import { flushPhotoIndex, loadPhotoIndex } from './photoindex.js';
import { startSyncTimer, flushAll } from './syncmanager.js';
import { askRetry } from './confirm.js';
import { getCached, putCached, bulkPutCached, getAllCached, clearAll, clearNonIgnored, putOrphan, bulkPutOrphans, countOrphans, countCached, countIgnored, clearOrphans, getOrphansPage, countOrphansInRange, countLocatedUndated, getLocatedUndatedPage, ignorePhoto, deleteRecord, deleteOrphan, UNDATED_TS } from './db.js';
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
let retryQueue = [];
let retryContext = null; // { prevStats, prevTotal } from the scan that produced the queue
let topbarGeotagged      = 0;
let topbarDated          = 0;
let topbarUnknown        = 0;
let topbarLocatedUndated = 0;
let topbarTotal          = 0;
function updateTopbar() { /* stats available via Info popup */ }

function setScanStatus(scanned, geotagged, dated, total = null, cached = 0) {
  const progress = total ? `${scanned}/${total}` : `${scanned}`;
  const dupNote  = cached > 0 ? ` ${cached}🔁` : '';
  setStatus(`${progress}. ${geotagged}📍 ${dated}📅${dupNote}`);
}
function clearScanStatus() { /* status bar stays; last message persists, then auto-hides */ }

async function reloadTopbarCounts() {
  const total   = await countCached();
  const ignored = await countIgnored();
  const orphans = await countOrphans();
  const noDate  = await countOrphansInRange(UNDATED_TS, UNDATED_TS);
  topbarTotal          = total - ignored;
  topbarGeotagged      = total - ignored - orphans;
  topbarDated          = orphans - noDate;
  topbarUnknown        = noDate;
  topbarLocatedUndated = await countLocatedUndated();
  updateTopbar();
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
const overflowMenu = document.getElementById('overflow-menu');


async function getOrphanListing() {
  const range = getActiveFilterRange();
  if (range) {
    return {
      total: await countOrphansInRange(range.from, range.to),
      fetcher: (offset, limit) => getOrphansPage(offset, limit, range.from, range.to),
      range,
    };
  }
  return { total: await countOrphans(), fetcher: (offset, limit) => getOrphansPage(offset, limit), range: null };
}

async function openOrphanSlideshow() {
  const { total, fetcher, range } = await getOrphanListing();
  log('No location', `total orphans=${await countOrphans()}, in range=${total}`);
  if (!total) {
    showBriefStatus(range ? 'No unlocated photos in this date range.' : 'No photos without location — scan a folder first.');
    return;
  }
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
    openOrphanSlideshow();
  }));
  setFixDateHandler(photo => startFixDate(photo, openOrphanSlideshow));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); setIgnoredEntry(photo.fileid); await reloadTopbarCounts(); });
  openLazySlideshow(fetcher, total);
}

async function openOrphanGrid() {
  const { total, fetcher, range } = await getOrphanListing();
  if (!total) {
    showBriefStatus(range ? 'No unlocated photos in this date range.' : 'No photos without location — scan a folder first.');
    return;
  }
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
    openOrphanGrid();
  }));
  setFixDateHandler(photo => startFixDate(photo, () => {}));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); setIgnoredEntry(photo.fileid); await reloadTopbarCounts(); });
  openGrid(fetcher, total, { reopen: openOrphanGrid });
}

async function openNodatetimeGrid() {
  const allOrphans = await countOrphans();
  const total = await countOrphansInRange(UNDATED_TS, UNDATED_TS);
  log('No date/location', `all orphans=${allOrphans}, undated=${total}`);
  if (!total) {
    showBriefStatus(allOrphans > 0
      ? `No photos without both date and location (${allOrphans} have no location but do have a date).`
      : 'No photos without location in cache.');
    return;
  }
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
    openNodatetimeGrid();
  }));
  setFixDateHandler(photo => startFixDate(photo, () => {}));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); setIgnoredEntry(photo.fileid); await reloadTopbarCounts(); });
  openGrid((offset, limit) => getOrphansPage(offset, limit, UNDATED_TS, UNDATED_TS), total, { reopen: openNodatetimeGrid });
}

// ── Fix date panel ────────────────────────────────────────────────────────────

const fixDateBar      = document.getElementById('fix-date-bar');
const fixDateInput    = document.getElementById('fix-date-input');
const fixDateTimeInput = document.getElementById('fix-date-time-input');
const fixDateSaveBtn  = document.getElementById('fix-date-save');
const fixDateCancelBtn = document.getElementById('fix-date-cancel');

let fixDatePhoto   = null;
let fixDatePhotos  = null; // bulk mode
let fixDateOnDone  = null;
let _lastFixDateTs = null; // ts of the last successfully saved fix-date

async function applyFixDateToPhoto(photo, ts) {
  const { fileid, name } = photo;
  const isHeic = /\.heic$/i.test(name);
  const isMP4  = isVideo(name);
  log('Fix date', `start ${name} (${fileid})`);

  let newFileid = fileid;
  let newName   = name;
  let newHash   = null;

  if (isMP4) {
    log('Fix date', 'stat (mp4)');
    const { hash } = await getFileStat(fileid).catch(() => ({}));
    newHash = hash ?? null;
    log('Fix date', 'sync organize');
    await syncMapphoOnEdit({ oldHash: newHash, newFileid: fileid, newHash, ts });
  } else if (isHeic) {
    log('Fix date', 'extract HEIC meta');
    const meta = await extractHeicMeta(fileid);
    log('Fix date', 'stat (heic)');
    const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));
    log('Fix date', 'download HEIC');
    const heicBuf = await downloadFullFile(fileid);
    log('Fix date', `convert to JPEG (${heicBuf.byteLength}B)`);
    const jpegBuf = await heicToJpeg(heicBuf);
    const jpegWithExif = injectExif(jpegBuf, { ts, make: meta.Make, model: meta.Model });
    newName = name.replace(/\.heic$/i, '.jpg');
    log('Fix date', 'stat for parent folder');
    const { parentfolderid } = await getFileStat(fileid);
    log('Fix date', `upload JPEG ${newName}`);
    newFileid = await uploadFile(parentfolderid, newName, jpegWithExif);
    log('Fix date', `delete original HEIC ${fileid}`);
    await deleteFile(fileid);
    log('Fix date', 'stat new file');
    ({ hash: newHash } = await getFileStat(newFileid).catch(() => ({})));
    log('Fix date', 'sync organize');
    await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts });
  } else {
    log('Fix date', 'stat (jpeg)');
    const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));
    log('Fix date', 'download');
    const buffer = await downloadFullFile(fileid);
    log('Fix date', `inject EXIF (${buffer.byteLength}B)`);
    const modified = injectExif(buffer, { ts });
    log('Fix date', 'overwrite');
    newFileid = await overwriteFile(fileid, modified);
    log('Fix date', 'stat new file');
    ({ hash: newHash } = await getFileStat(newFileid).catch(() => ({})));
    log('Fix date', 'sync organize');
    await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts });
  }

  log('Fix date', 'update cache');
  const cached = await getCached(fileid);
  await deleteRecord(fileid);
  await deleteOrphan(fileid);
  if (cached) await putCached({ ...cached, fileid: newFileid, name: newName, ts, hash: newHash ?? cached.hash ?? null });
  else await putOrphan({ fileid: newFileid, name: newName, ts, hash: newHash });
  log('Fix date', `done → newFileid=${newFileid}`);
  return { oldFileid: fileid, newFileid, newName, ts, lat: cached?.lat ?? null, lng: cached?.lng ?? null };
}

function startFixDate(photo, onDone) {
  fixDatePhoto  = photo;
  fixDatePhotos = null;
  fixDateOnDone = onDone;
  const hasOwnDate = photo.ts && photo.ts > 0 && photo.ts < UNDATED_TS;
  const seed = hasOwnDate ? new Date(photo.ts) : (_lastFixDateTs ? new Date(_lastFixDateTs) : new Date());
  fixDateInput.value = seed.toISOString().split('T')[0];
  fixDateTimeInput.value = seed.toTimeString().slice(0, 5);
  fixDateSaveBtn.textContent = '💾 Save';
  fixDateBar.style.display = 'flex';
  document.body.classList.add('action-bar-open');
}

function startBulkFixDate(photos, onDone) {
  fixDatePhoto  = null;
  fixDatePhotos = photos;
  fixDateOnDone = onDone;
  const seed = _lastFixDateTs ? new Date(_lastFixDateTs) : new Date();
  fixDateInput.value = seed.toISOString().split('T')[0];
  fixDateTimeInput.value = seed.toTimeString().slice(0, 5);
  fixDateSaveBtn.textContent = `💾 Save (${photos.length})`;
  fixDateBar.style.display = 'flex';
  document.body.classList.add('action-bar-open');
}

fixDateSaveBtn.addEventListener('click', () => {
  if (!fixDateInput.value) return;
  const ts = new Date(`${fixDateInput.value}T${fixDateTimeInput.value || '12:00'}`).getTime();

  if (fixDatePhotos) {
    const list = fixDatePhotos;
    const cb   = fixDateOnDone;
    fixDateBar.style.display = 'none';
    document.body.classList.remove('action-bar-open');
    fixDatePhoto = null; fixDatePhotos = null; fixDateOnDone = null;
    _runBulkFixDate(list, ts, cb);
    return;
  }

  if (!fixDatePhoto) return;
  const photo = fixDatePhoto;
  const cb    = fixDateOnDone;
  fixDateBar.style.display = 'none';
  document.body.classList.remove('action-bar-open');
  fixDatePhoto = null; fixDateOnDone = null;
  _runFixDate(photo, ts, cb);
});

async function _runFixDate(photo, ts, onDone) {
  try {
    const r = await applyFixDateToPhoto(photo, ts);
    if (r.lat != null && r.newFileid !== r.oldFileid) {
      removeMarker(r.oldFileid);
      addMarker({ fileid: r.newFileid, name: r.newName, lat: r.lat, lng: r.lng, ts: r.ts });
    }
    _lastFixDateTs = ts;
    await reloadTopbarCounts().catch(e => log('Fix date', `reloadTopbarCounts error: ${e.message}`));
    flushPhotoIndex().catch(e => log('PhotoIndex flush error', e.message));
    onDone?.();
  } catch (e) {
    log('Fix date error', e.message);
    // Re-open the bar so the user can retry.
    startFixDate(photo, onDone);
    showBriefStatus(`❌ Fix date failed — try again`);
  }
}

async function _runBulkFixDate(list, ts, cb) {
  let ok = 0;
  const failedItems = [];
  for (let i = 0; i < list.length; i++) {
    setStatus(`📅 Fixing dates… ${i + 1}/${list.length}`, 0);
    try {
      const r = await applyFixDateToPhoto(list[i], ts);
      if (r.lat != null && r.newFileid !== r.oldFileid) {
        removeMarker(r.oldFileid);
        addMarker({ fileid: r.newFileid, name: r.newName, lat: r.lat, lng: r.lng, ts: r.ts });
      }
      ok++;
    } catch (e) {
      failedItems.push(list[i]);
      log('Bulk fix date error', `${list[i].name}: ${e.message}`);
    }
  }
  if (ok > 0) _lastFixDateTs = ts;
  try {
    log('Fix date', 'reloading topbar counts');
    await reloadTopbarCounts();
    log('Fix date', 'topbar counts done');
  } catch (e) {
    log('Fix date', `reloadTopbarCounts error: ${e.message}`);
  }
  flushPhotoIndex().catch(e => log('PhotoIndex flush error', e.message));

  if (failedItems.length > 0) {
    showBriefStatus(`📅 Dated ${ok}/${list.length} — ${failedItems.length} failed`, 0);
    const retry = await askRetry(failedItems.length, 'photo');
    if (retry) { _runBulkFixDate(failedItems, ts, cb); return; }
  } else {
    showBriefStatus(`📅 Dated ${ok} photo${ok !== 1 ? 's' : ''}`);
  }
  cb?.({ success: ok > 0, count: ok, failed: failedItems.length });
}

fixDateCancelBtn.addEventListener('click', () => {
  fixDateBar.style.display = 'none';
  document.body.classList.remove('action-bar-open');
  const wasBulk = !!fixDatePhotos;
  const cb = fixDateOnDone;
  fixDatePhoto  = null;
  fixDatePhotos = null;
  fixDateOnDone = null;
  if (wasBulk) cb?.({ success: false, count: 0, failed: 0 });
});


document.getElementById('filter-menu-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  toggleFilter();
});


document.getElementById('check-update-btn').addEventListener('click', async () => {
  infoPopup.style.display = 'none';
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
  overflowMenu.classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (!overflowMenu.contains(e.target) && e.target !== menuFab) overflowMenu.classList.remove('open');
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
  fpRender();

  // Validate saved folders in the background — remove any that no longer exist on pCloud.
  for (const [key, f] of [...fpSelected.entries()]) {
    const exists = await folderExists(f.id);
    if (!exists) {
      fpSelected.delete(key);
      fpRender();
    }
  }
}

function closeFolderPicker() {
  folderPicker.style.display = 'none';
  const folders = [...fpSelected.values()];
  if (!folders.length) return;
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
  infoPopup.style.display = 'none';
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
  sessionGeotagged = 0;
  updateTopbar();
  log('Cache erased');
  setStatus('Cache erased — pick a folder to scan.');
});


document.getElementById('rebuild-btn').addEventListener('click', async () => {
  infoPopup.style.display = 'none';
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
const infoPopupClose = document.getElementById('info-popup-close');

function renderInfoRows() {
  const X = (e) => `<span class="icon-x">${e}</span>`;
  const rows = [
    { icon: '📷',                   label: 'Total',           value: topbarTotal,                            action: null },
    { icon: '📅📍',                 label: 'Position & Date', value: topbarGeotagged - topbarLocatedUndated, action: null },
    { icon: X('📍'),                label: 'Only Date',       value: topbarDated,                            action: 'dated' },
    { icon: X('📅'),                label: 'Only Position',   value: topbarLocatedUndated,                   action: 'located-undated' },
    { icon: X('📅') + X('📍'),     label: 'Nothing',         value: topbarUnknown,                          action: 'unknown' },
  ];
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
      infoPopup.style.display = 'none';
      if (el.dataset.action === 'dated') {
        openDatedOrphanGrid().catch(e => { log('Dated grid error', e.message); showBriefStatus(`Error: ${e.message}`); });
      } else if (el.dataset.action === 'unknown') {
        openNodatetimeGrid().catch(e => { log('Unknown grid error', e.message); showBriefStatus(`Error: ${e.message}`); });
      } else if (el.dataset.action === 'located-undated') {
        openLocatedUndatedGrid().catch(e => { log('Located undated grid error', e.message); showBriefStatus(`Error: ${e.message}`); });
      }
    });
  });
}

function openInfoPopup() {
  overflowMenu.classList.remove('open');
  renderInfoRows();
  infoPopup.style.display = 'flex';
}

async function openDatedOrphanGrid() {
  const range = getActiveFilterRange();
  const from = range?.from ?? 1;
  const to = range?.to ?? UNDATED_TS - 1;
  const total = await countOrphansInRange(from, to);
  if (!total) { showBriefStatus(range ? 'No dated photos without location in this date range.' : 'No dated photos without location.'); return; }
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
    openDatedOrphanGrid();
  }));
  setFixDateHandler(photo => startFixDate(photo, () => {}));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); setIgnoredEntry(photo.fileid); await reloadTopbarCounts(); });
  openGrid((offset, limit) => getOrphansPage(offset, limit, from, to), total, { reopen: openDatedOrphanGrid });
}

infoPopupClose.addEventListener('click', () => { infoPopup.style.display = 'none'; });
infoPopup.addEventListener('click', e => { if (e.target === infoPopup) infoPopup.style.display = 'none'; });
document.getElementById('info-btn').addEventListener('click', openInfoPopup);

document.getElementById('fix-date-only-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  openLocatedUndatedGrid().catch(e => { log('Fix date error', e.message); showBriefStatus(`Error: ${e.message}`); });
});

document.getElementById('fix-position-only-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  openDatedOrphanGrid().catch(e => { log('Fix position error', e.message); showBriefStatus(`Error: ${e.message}`); });
});

document.getElementById('fix-date-and-pos-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  openNodatetimeGrid().catch(e => { log('Fix date & position error', e.message); showBriefStatus(`Error: ${e.message}`); });
});

async function openLocatedUndatedGrid() {
  const total = topbarLocatedUndated;
  if (!total) { showBriefStatus('No located photos without a date.'); return; }
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
    openLocatedUndatedGrid();
  }));
  setFixDateHandler(photo => startFixDate(photo, () => { openLocatedUndatedGrid(); }));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); setIgnoredEntry(photo.fileid); await reloadTopbarCounts(); });
  openGrid((offset, limit) => getLocatedUndatedPage(offset, limit), total, { reopen: openLocatedUndatedGrid });
}
document.getElementById('log-open-btn').addEventListener('click', () => { infoPopup.style.display = 'none'; toggleLog(); });

function showApp() {
  loginOverlay.style.display = 'none';
  menuFab.style.display = '';
  heatmapBtn.style.display = '';
  mediaTypeBtn.style.display = '';
  mediaTypeBtn.innerHTML = MEDIA_ALL_ICON;
  authBtn.onclick = () => { infoPopup.style.display = 'none'; logout(); location.reload(); };
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  loginError.textContent = '';
  try {
    if (pendingTfaToken) {
      await loginWithTFA(pendingTfaToken, totpInput.value);
    } else {
      await loginWithPassword(
        document.getElementById('email').value,
        document.getElementById('password').value,
      );
    }
    showApp();
    await startScan();
  } catch (err) {
    if (err instanceof TwoFactorRequired) {
      pendingTfaToken = err.tfaToken;
      totpInput.style.display = '';
      totpInput.required = true;
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

let startScanInProgress = false;
async function startScan() {
  if (startScanInProgress) return;
  startScanInProgress = true;
  // Load cached markers first — no network needed, works immediately after wake.
  showBriefStatus('Loading cache…', 30000);
  setProgress(0);
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
  const cacheTotal = cached.length;
  for (let i = 0; i < cacheTotal; i++) {
    const p = cached[i];
    if (p.ignored) { cachedIgnored++; }
    else if (p.lat != null) {
      addMarker(p);
      cachedGeo++;
      if (!(p.ts > 0 && p.ts < UNDATED_TS)) cachedLocatedUndated++;
    }
    else { toMigrate.push(p); if (p.ts != null) cachedDated++; else cachedUnknown++; }
    if (i % 100 === 0) {
      setProgress(cacheTotal > 0 ? (i / cacheTotal) * 100 : 0);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  topbarGeotagged      = cachedGeo;
  topbarLocatedUndated = cachedLocatedUndated;
  topbarDated          = cachedDated;
  topbarUnknown        = cachedUnknown;
  topbarTotal          = cached.length - cachedIgnored;

  // Populate orphan store in one transaction so the No-location / No-date buttons work immediately.
  if (toMigrate.length > 0) {
    try { await bulkPutOrphans(toMigrate); }
    catch (e) { log('orphan migration error', e.message); }
  }

  await applyVideoMeta().catch(e => log('VideoMeta apply error', e.message));
  await applyIgnored().catch(e => log('Ignored apply error', e.message));

  setProgress(100);
  setTimeout(() => setProgress(0), 500);
  updateTopbar();
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


// Per-scan organize state. Reset at the start of each scan.
let _organizeRoot = null;  // Photos/ folderid (null = organize not ready)
let _organizeLock = Promise.resolve(); // serialises concurrent organizeFile calls

let scanOperationInProgress = false;

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
    clearScanStatus();
    if (e.message?.includes('1000') || e.message?.includes('2000') || e.message?.includes('auth')) {
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
    clearScanStatus();
    if (e.message?.includes('1000') || e.message?.includes('2000') || e.message?.includes('auth')) {
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
  _organizeLock = Promise.resolve();
  const stats = { scanned: 0, geotagged: 0, dated: 0, completed: 0, cached: 0 };
  const pool = new Set(), inFlight = new Map(), failedFiles = [];
  await processFiles(allFiles, total, stats, pool, inFlight, failedFiles);
  await Promise.all(pool);

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

  clearScanStatus();
  await reloadTopbarCounts();
  applyVideoMeta().catch(e => log('VideoMeta apply error', e.message));
  applyIgnored().catch(e => log('Ignored apply error', e.message));
  const manualNote = sessionGeotagged > 0 ? ` + ${sessionGeotagged} manually tagged` : '';
  if (scanCancelled) {
    setStatus(`Rebuild stopped — ${stats.geotagged + sessionGeotagged} geotagged, ${stats.completed} processed${manualNote}.`);
    setProgress(0);
  } else {
    setStatus(`Rebuild done — ${stats.geotagged + sessionGeotagged} geotagged, ${total} total${manualNote}.`);
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
}

// Returns true on success, false on network/download failure (file not written to DB so retry works).
async function processFile(file, stats) {
  // Fast path: file already organised into Photos/ — it's a duplicate in the source folder.
  if (_organizeRoot && isHashOrganized(normHash(file.hash))) {
    stats.cached++;
    log(`${file.name} [organized duplicate]`, 'skipped');
    return true;
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
  const record = { fileid: file.fileid, name: file.name, lat: hasGps ? exif.lat : null, lng: hasGps ? exif.lng : null, ts: exif.ts ?? null, hash: file.hash != null ? String(file.hash) : null };

  // Organize: serialize name-pick + rename so concurrent processFile calls
  // don't race on _takenNames / _nameCounters.
  if (_organizeRoot) {
    let resolveOrganizeLock;
    const prevLock = _organizeLock;
    _organizeLock = new Promise(r => { resolveOrganizeLock = r; });
    await prevLock;
    try {
      const newName = await organizeFile(record, _organizeRoot);
      if (newName) {
        record.name = newName;
        updateMarkerName(record.fileid, newName);
      }
    } finally {
      resolveOrganizeLock();
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
  _organizeLock = Promise.resolve();
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

  clearScanStatus();
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

// Pause while the app is backgrounded. Android throttles the WebView JS thread
// and may abort CapacitorHttp requests when backgrounded, causing CDN downloads
// to fail silently. We wait for the page to become visible before dispatching
// each new file so in-flight requests (already on native threads) can finish
// cleanly without new ones piling up behind them.
async function waitForForeground() {
  while (document.hidden) {
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function processFiles(files, total, stats, pool, inFlight, failedFiles) {
  let concurrency = MAX_CONCURRENCY;
  const recentOutcomes = [];

  const diagTimer = setInterval(() => {
    if (inFlight.size > 0)
      log('in-flight', `${inFlight.size} pending: ${[...inFlight.values()].join(', ')}`);
  }, 15000);

  for (const file of files) {
    await waitForForeground();
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
      setScanStatus(stats.scanned, stats.geotagged, stats.dated, total);
    });
    pool.add(p);
    inFlight.set(p, file.name);

    if (pool.size >= concurrency) await Promise.race(pool);
  }

  clearInterval(diagTimer);
}

function updateRetryBtn() {
  const btn = document.getElementById('retry-menu-btn');
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
        <button id="retry-no">Dismiss</button>
        <button id="retry-discard">Cancel &amp; Discard</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);

  document.getElementById('retry-no').addEventListener('click', () => dialog.remove());
  document.getElementById('retry-discard').addEventListener('click', () => {
    dialog.remove();
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
    dialog.remove();
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
    }
    clearScanStatus();
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
  document.getElementById('retry-menu-btn').addEventListener('click', () => {
    if (retryQueue.length > 0) showRetryDialog(retryQueue);
  });

  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
  }));
  setFixDateHandler(photo => startFixDate(photo, () => {}));
  setBulkFixDateHandler((photos, cb) => startBulkFixDate(photos, cb));

  // Handlers for map marker slideshow — update in place, no redirect.
  setMarkerGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; reloadTopbarCounts(); showBriefStatus(`📍 Location updated!`); }
  }));
  setMarkerFixDateHandler(photo => startFixDate(photo, () => {}));

  const token = getToken();
  setupAuthBtn(!!token);

  if (!token) {
    return; // login form is shown
  }

  await startScan();
}

main();
