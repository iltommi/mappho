import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { handleCallback, getToken, loginWithPassword, loginWithTFA, logout, saveToken, TwoFactorRequired, getApiHost, setApiHost, EU_HOST, US_HOST } from './auth.js';

const BUILD_TIME = new Date(__BUILD_TIME__);
const APP_SHA    = __GIT_SHA__;
import { log, toggleLog } from './log.js';
import { toggleFilter, closeFilter, getActiveFilterRange, setRangeInfoHandler } from './filter.js';
import { listImages, listFolders, fetchFileHead, uploadBackup, downloadBackup, downloadFullFile, overwriteFile, uploadFile, deleteFile, getFileStat } from './pcloud.js';
import { extractEXIF, parseDateFromFilename, injectExif, heicToJpeg, extractHeicMeta } from './exif.js';
import { extractMP4Meta } from './mp4.js';
import { initMap, addMarker, clearMarkers, toggleHeatmap } from './map.js';
import { openLazySlideshow, setGeotagHandler, setFixDateHandler, setIgnoreHandler, setAfterDeleteCallback } from './slideshow.js';
import { startGeotagging } from './geotag.js';
import { openGrid } from './grid.js';
import { organize, findSharphoRootIfExists, syncSharphoOnEdit } from './organize.js';
import { getCached, putCached, getAllCached, clearAll, clearNonIgnored, putOrphan, bulkPutOrphans, countOrphans, countCached, countIgnored, clearOrphans, getOrphansPage, countOrphansInRange, exportDb, importDb, ignorePhoto, deleteRecord, deleteOrphan } from './db.js';
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
let topbarGeotagged = 0;
let topbarDated   = 0;
let topbarUnknown = 0;
let topbarTotal   = 0;
let topbarStatIdx = 0;

const topbarTitle = document.getElementById('topbar-title');
function updateTopbar() {
  if (!topbarTotal) { topbarTitle.textContent = ''; return; }
  const located = topbarGeotagged + sessionGeotagged;
  const labels = [
    `${topbarTotal} total`,
    `📍 ${located} located`,
    `📅 ${topbarDated} dated`,
    `❓ ${topbarUnknown} unknown`,
  ];
  topbarTitle.textContent = labels[topbarStatIdx];
}

topbarTitle.addEventListener('click', () => {
  topbarStatIdx = (topbarStatIdx + 1) % 4;
  updateTopbar();
});

function setScanStatus(scanned, geotagged, dated, total = null) {
  const progress = total ? `${scanned}/${total}` : `${scanned}`;
  scanStatusEl.textContent = `${progress}. ${geotagged} geo. ${dated} date`;
}
function clearScanStatus() { /* status bar stays; last message persists */ }

async function reloadTopbarCounts() {
  const total   = await countCached();
  const ignored = await countIgnored();
  const orphans = await countOrphans();
  const noDate  = await countOrphansInRange(0, 0);
  topbarTotal     = total - ignored;
  topbarGeotagged = total - ignored - orphans;
  topbarDated     = orphans - noDate;
  topbarUnknown   = noDate;
  updateTopbar();
}

function showBriefStatus(msg) {
  setStatus(msg);
}
const progressFill = document.getElementById('progress-fill');
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const totpInput = document.getElementById('totp');
const folderBtn = document.getElementById('folder-btn');
const stopScanBtn = document.getElementById('stop-scan-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const eraseCacheBtn = document.getElementById('erase-cache-btn');

stopScanBtn.addEventListener('click', () => {
  scanCancelled = true;
  stopScanBtn.disabled = true;
  stopScanBtn.textContent = 'Stopping…';
});
const localInput = document.getElementById('local-input');
const menuWrap = document.getElementById('menu-wrap');
const menuBtn = document.getElementById('menu-btn');
const overflowMenu = document.getElementById('overflow-menu');

document.getElementById('export-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  try {
    progressFill.classList.add('indeterminate');
    showBriefStatus('Reading local cache…', 60000);
    log('Backup', 'exporting…');
    const backup = await exportDb();
    showBriefStatus(`Uploading ${backup.photos.length} records to pCloud…`, 120000);
    await uploadBackup(JSON.stringify(backup));
    progressFill.classList.remove('indeterminate');
    setProgress(100);
    log('Backup', `saved ${backup.photos.length} records to pCloud`);
    showBriefStatus(`Backup saved — ${backup.photos.length} photos exported.`);
    setTimeout(() => setProgress(0), 1000);
  } catch (e) {
    progressFill.classList.remove('indeterminate');
    setProgress(0);
    log('Backup error', e.message);
    showBriefStatus(`Backup failed: ${e.message}`);
  }
});

document.getElementById('import-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  try {
    progressFill.classList.add('indeterminate');
    showBriefStatus('Downloading backup from pCloud…', 120000);
    log('Restore', 'downloading from pCloud…');
    const backup = await downloadBackup();
    if (!backup?.photos) throw new Error('Invalid backup file');
    showBriefStatus(`Importing ${backup.photos.length} records…`);
    await importDb(backup);  // writes both STORE and ORPHAN_STORE in one transaction
    log('Restore', `DB import done (${backup.photos.length} records)`);
    clearMarkers();
    showBriefStatus(`Loading ${backup.photos.length} photos into map…`);
    progressFill.classList.remove('indeterminate');
    setProgress(0);
    const cached = await getAllCached();
    log('Restore', `getAllCached returned ${cached.length} records`);
    let geo = 0, dated = 0, unknown = 0, ignored = 0;
    for (let i = 0; i < cached.length; i++) {
      const p = cached[i];
      if (p.ignored) { ignored++; continue; }
      if (p.lat != null) { addMarker(p); geo++; }
      else if (p.ts != null) dated++;
      else unknown++;
      if (i % 200 === 199) {
        setProgress((i + 1) / cached.length * 100);
        await new Promise(r => setTimeout(r, 0));
      }
    }
    setProgress(100);
    topbarGeotagged = geo;
    topbarDated     = dated;
    topbarUnknown   = unknown;
    topbarTotal     = cached.length - ignored;
    updateTopbar();
    log('Restore', `done — ${geo} geotagged, ${dated} dated, ${unknown} unknown`);
    showBriefStatus(`Restored — ${geo} geotagged out of ${cached.length} photos.`);
    setTimeout(() => setProgress(0), 1000);
  } catch (e) {
    progressFill.classList.remove('indeterminate');
    setProgress(0);
    log('Restore error', e.message);
    showBriefStatus(`Restore failed: ${e.message}`);
  }
});

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
    if (success) { sessionGeotagged++; updateTopbar(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
    openOrphanSlideshow();
  }));
  setFixDateHandler(photo => startFixDate(photo, openOrphanSlideshow));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); await reloadTopbarCounts(); });
  openLazySlideshow(fetcher, total);
}

async function openOrphanGrid() {
  const { total, fetcher, range } = await getOrphanListing();
  if (!total) {
    showBriefStatus(range ? 'No unlocated photos in this date range.' : 'No photos without location — scan a folder first.');
    return;
  }
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; updateTopbar(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
  }));
  setFixDateHandler(photo => startFixDate(photo, () => {}));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); await reloadTopbarCounts(); });
  openGrid(fetcher, total, { reopen: openOrphanGrid });
}

async function openNodatetimeGrid() {
  const allOrphans = await countOrphans();
  const total = await countOrphansInRange(0, 0);
  log('No date/location', `all orphans=${allOrphans}, undated=${total}`);
  if (!total) {
    showBriefStatus(allOrphans > 0
      ? `No photos without both date and location (${allOrphans} have no location but do have a date).`
      : 'No photos without location in cache.');
    return;
  }
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) { sessionGeotagged++; updateTopbar(); showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`); }
  }));
  setFixDateHandler(photo => startFixDate(photo, () => {}));
  setIgnoreHandler(async photo => { await ignorePhoto(photo.fileid); await reloadTopbarCounts(); });
  openGrid((offset, limit) => getOrphansPage(offset, limit, 0, 0), total, { reopen: openNodatetimeGrid });
}

// ── Fix date panel ────────────────────────────────────────────────────────────

const fixDateBar      = document.getElementById('fix-date-bar');
const fixDateInput    = document.getElementById('fix-date-input');
const fixDateTimeInput = document.getElementById('fix-date-time-input');
const fixDateSaveBtn  = document.getElementById('fix-date-save');
const fixDateCancelBtn = document.getElementById('fix-date-cancel');

let fixDatePhoto = null;
let fixDateOnDone = null;

function startFixDate(photo, onDone) {
  fixDatePhoto  = photo;
  fixDateOnDone = onDone;
  const existing = (photo.ts && photo.ts > 0) ? new Date(photo.ts) : new Date();
  fixDateInput.value = existing.toISOString().split('T')[0];
  fixDateTimeInput.value = existing.toTimeString().slice(0, 5);
  fixDateBar.style.display = 'flex';
}

fixDateSaveBtn.addEventListener('click', async () => {
  if (!fixDatePhoto || !fixDateInput.value) return;
  const origText = fixDateSaveBtn.textContent;
  fixDateSaveBtn.disabled = true;
  try {
    const ts = new Date(`${fixDateInput.value}T${fixDateTimeInput.value || '12:00'}`).getTime();
    const { fileid, name } = fixDatePhoto;
    const isHeic = /\.heic$/i.test(name);
    const isMP4  = /\.mp4$/i.test(name);

    let newFileid = fileid;
    let newName   = name;
    let newHash   = null;

    if (isMP4) {
      log('Fix date', 'MP4: saving date to cache only');
      const { hash } = await getFileStat(fileid).catch(() => ({}));
      newHash = hash ?? null;
      await syncSharphoOnEdit({ oldHash: newHash, newFileid: fileid, newHash, ts });
    } else if (isHeic) {
      fixDateSaveBtn.textContent = '⏳ Fetching…';
      const meta = await extractHeicMeta(fileid);
      const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));
      fixDateSaveBtn.textContent = '⏳ Downloading…';
      const heicBuf = await downloadFullFile(fileid);
      fixDateSaveBtn.textContent = '⏳ Converting…';
      const jpegBuf = await heicToJpeg(heicBuf);
      fixDateSaveBtn.textContent = '⏳ Injecting EXIF…';
      const jpegWithExif = injectExif(jpegBuf, { ts, make: meta.Make, model: meta.Model });
      newName = name.replace(/\.heic$/i, '.jpg');
      const { parentfolderid } = await getFileStat(fileid);
      fixDateSaveBtn.textContent = '⏳ Uploading…';
      newFileid = await uploadFile(parentfolderid, newName, jpegWithExif);
      log('Fix date', 'Removing original HEIC…');
      await deleteFile(fileid);
      ({ hash: newHash } = await getFileStat(newFileid).catch(() => ({})));
      await syncSharphoOnEdit({ oldHash, newFileid, newHash, ts });
    } else {
      const { hash: oldHash } = await getFileStat(fileid).catch(() => ({}));
      fixDateSaveBtn.textContent = '⏳ Downloading…';
      const buffer = await downloadFullFile(fileid);
      const modified = injectExif(buffer, { ts });
      fixDateSaveBtn.textContent = '⏳ Uploading…';
      newFileid = await overwriteFile(fileid, modified);
      ({ hash: newHash } = await getFileStat(newFileid).catch(() => ({})));
      await syncSharphoOnEdit({ oldHash, newFileid, newHash, ts });
    }

    const cached = await getCached(fileid);
    await deleteRecord(fileid);
    await deleteOrphan(fileid);
    if (cached) await putCached({ ...cached, fileid: newFileid, name: newName, ts, hash: newHash ?? cached.hash ?? null });
    else await putOrphan({ fileid: newFileid, name: newName, ts, hash: newHash });

    await reloadTopbarCounts();
    fixDateBar.style.display = 'none';
    fixDateOnDone?.();
  } catch (e) {
    log('Fix date error', e.message);
  } finally {
    fixDateSaveBtn.disabled = false;
    fixDateSaveBtn.textContent = origText;
    fixDatePhoto = null;
    fixDateOnDone = null;
  }
});

fixDateCancelBtn.addEventListener('click', () => {
  fixDateBar.style.display = 'none';
  fixDatePhoto  = null;
  fixDateOnDone = null;
});

document.getElementById('noloc-menu-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  try { await openOrphanGrid(); }
  catch (e) { log('No location error', e.message); showBriefStatus(`Error: ${e.message}`); }
});

document.getElementById('nodatetime-menu-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  try { await openNodatetimeGrid(); }
  catch (e) { log('No date/location error', e.message); showBriefStatus(`Error: ${e.message}`); }
});

document.getElementById('filter-menu-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  toggleFilter();
});


document.getElementById('check-update-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  showBriefStatus('Checking for updates…', 15000);
  try {
    const resp = await CapacitorHttp.request({
      method: 'GET',
      url: 'https://api.github.com/repos/iltommi/sharpho/releases?per_page=1',
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
      showBriefStatus(`Update available — downloading…`, 30000);
      window.open('https://github.com/iltommi/sharpho/releases/download/latest/SharPho.apk', '_system');
    } else {
      showBriefStatus('Already up to date.');
    }
  } catch (e) {
    log('Update check error', e.message);
    showBriefStatus(`Update check failed: ${e.message}`);
  }
});

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  overflowMenu.classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (!menuWrap.contains(e.target)) overflowMenu.classList.remove('open');
});

localInput.addEventListener('change', async () => {
  overflowMenu.classList.remove('open');
  const files = Array.from(localInput.files);
  let found = 0;
  for (const file of files) {
    const buf  = await file.arrayBuffer();
    const exif = await extractEXIF(buf);
    const hasGps = exif.lat != null && !isNaN(exif.lat);
    log(file.name, hasGps ? `GPS: ${exif.lat.toFixed(5)}, ${exif.lng.toFixed(5)}` : 'no GPS');
    if (hasGps) {
      found++;
      addMarker({ fileid: file.name, name: file.name, lat: exif.lat, lng: exif.lng });
    }
  }
  setStatus(`Local test: ${found} geotagged out of ${files.length} files.`);
  localInput.value = '';
});
let pendingTfaToken = null;

const FOLDER_KEY = 'pcloud_folder';

function getSelectedFolder() {
  return JSON.parse(localStorage.getItem(FOLDER_KEY) ?? '{"id":0}');
}

const folderPicker  = document.getElementById('folder-picker');
const fpBack        = document.getElementById('fp-back');
const fpClose       = document.getElementById('fp-close');
const fpBreadcrumb  = document.getElementById('fp-breadcrumb');
const fpList        = document.getElementById('fp-list');

// Stack of { id, name } — root entry is always { id: 0, name: 'All photos' }
let fpStack = [];

async function fpRender() {
  const current = fpStack[fpStack.length - 1];
  fpBreadcrumb.textContent = current.name;
  fpBack.disabled = fpStack.length <= 1;
  fpList.innerHTML = '';

  // "Select this folder" row
  const selectRow = document.createElement('button');
  selectRow.className = 'fp-item fp-select';
  selectRow.textContent = `▶ Scan "${current.name}"`;
  selectRow.addEventListener('click', () => {
    if (clearCacheBtn.disabled) return; // scan already running
    localStorage.setItem(FOLDER_KEY, JSON.stringify({ id: String(current.id), name: current.name }));
    folderBtn.textContent = current.name;
    folderPicker.style.display = 'none';
    overflowMenu.classList.remove('open');
    clearCacheBtn.disabled = true;
    runScan().finally(() => { clearCacheBtn.disabled = false; });
  });
  fpList.appendChild(selectRow);

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
    row.innerHTML = `<span>📁 ${f.name}</span><span class="fp-item-arrow">›</span>`;
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

function openFolderPicker() {
  fpStack = [{ id: 0, name: 'All photos' }];
  folderPicker.style.display = 'flex';
  fpRender();
}

fpBack.addEventListener('click', () => {
  if (fpStack.length > 1) { fpStack.pop(); fpRender(); }
});
fpClose.addEventListener('click', () => { folderPicker.style.display = 'none'; });
folderBtn.addEventListener('click', () => { overflowMenu.classList.remove('open'); openFolderPicker(); });

async function populateFolderPicker() {
  const saved = getSelectedFolder();
  folderBtn.textContent = saved.name ?? 'All photos';
}

eraseCacheBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  await Promise.all([clearAll(), clearOrphans()]);
  clearMarkers();
  heatmapBtn.classList.remove('active');
  closeFilter();
  topbarGeotagged = 0;
  topbarDated     = 0;
  topbarUnknown   = 0;
  topbarTotal     = 0;
  sessionGeotagged = 0;
  updateTopbar();
  log('Cache erased');
  setStatus('Cache erased — pick a folder to scan.');
});

clearCacheBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  await Promise.all([clearNonIgnored(), clearOrphans()]);
  log('Cache cleared');
  setStatus('Cache cleared — scanning…');
  clearCacheBtn.disabled = true;
  await runScan();
  clearCacheBtn.disabled = false;
});

const organizeBtn = document.getElementById('organize-btn');
organizeBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  if (organizeBtn.disabled) return;
  organizeBtn.disabled = true;
  try { await runOrganize(); }
  finally { organizeBtn.disabled = false; }
});

document.getElementById('use-token-btn').addEventListener('click', async () => {
  const token = document.getElementById('token-input').value.trim();
  if (!token) { loginError.textContent = 'Please paste your auth token.'; return; }
  saveToken(token);
  showApp();
  await startScan();
});

function setStatus(msg) {
  scanStatusEl.textContent = msg;
  log('status', msg);
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

function showApp() {
  loginOverlay.style.display = 'none';
  menuWrap.style.display = '';
  heatmapBtn.style.display = '';
  authBtn.onclick = () => { logout(); location.reload(); };
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
  const cached = await getAllCached();
  let cachedGeo = 0, cachedDated = 0, cachedUnknown = 0, cachedIgnored = 0;
  const toMigrate = [];
  for (const p of cached) {
    if (p.ignored) { cachedIgnored++; continue; }
    if (p.lat != null) { addMarker(p); cachedGeo++; }
    else { toMigrate.push(p); if (p.ts != null) cachedDated++; else cachedUnknown++; }
  }
  topbarGeotagged = cachedGeo;
  topbarDated     = cachedDated;
  topbarUnknown   = cachedUnknown;
  topbarTotal     = cached.length - cachedIgnored;

  // Populate orphan store in one transaction so the No-location / No-date buttons work immediately.
  if (toMigrate.length > 0) {
    try { await bulkPutOrphans(toMigrate); }
    catch (e) { log('orphan migration error', e.message); }
  }

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

async function runOrganize() {
  scanCancelled = false;
  stopScanBtn.style.display = '';
  stopScanBtn.disabled = false;
  stopScanBtn.textContent = '✕ Stop';
  setProgress(0);
  try {
    setStatus('Organize: indexing SharPho…');
    const { copied, skipped, failed } = await organize({
      isCancelled: () => scanCancelled,
      onProgress: p => {
        if (p.phase === 'indexing') {
          setStatus(`Organize: indexing SharPho… ${p.done} found`);
        } else if (p.phase === 'copying') {
          setStatus(`Organize: ${p.done}/${p.total} · ${p.copied} copied · ${p.skipped} already organized`);
          setProgress((p.done / p.total) * 100);
        }
      },
    });
    setProgress(100);
    const failedNote = failed > 0 ? ` (${failed} failed)` : '';
    setStatus(scanCancelled
      ? `Organize stopped — ${copied} copied, ${skipped} already organized${failedNote}.`
      : `Organize done — ${copied} copied, ${skipped} already organized${failedNote}.`);
  } catch (e) {
    setStatus(`Organize error: ${e.message}`);
    console.error(e);
  } finally {
    stopScanBtn.style.display = 'none';
  }
}

async function runScan() {
  scanCancelled = false;
  stopScanBtn.style.display = '';
  stopScanBtn.disabled = false;
  stopScanBtn.textContent = '✕ Stop';
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
  }
}

// Returns true on success, false on network/download failure (file not written to DB so retry works).
async function processFile(file, stats) {
  const hit = await getCached(file.fileid);
  if (hit) {
    if (hit.ignored) return true;
    log(`${file.name} [cached]`, hit.lat != null ? `GPS: ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}` : 'no GPS');
    if (hit.lat != null) { stats.geotagged++; addMarker(hit); }
    return true;
  }
  let exif;
  try {
    const isHeic = /\.heic$/i.test(file.name);
    const isMP4  = /\.mp4$/i.test(file.name);
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
  await putCached(record);
  if (hasGps) { stats.geotagged++; addMarker(record); }
  else { if (record.ts != null) stats.dated++; await putOrphan(record); }
  return true;
}

async function scan() {
  const stats = { scanned: 0, geotagged: 0, dated: 0, completed: 0 };
  const pool = new Set();
  const inFlight = new Map();

  const { id: folderId, name: folderName } = getSelectedFolder();
  log('Scanning folder', `${folderName ?? 'All photos'} (id=${folderId})`);

  // Phase 1: BFS all folders to discover the full file list
  setStatus('Discovering files…');
  const sharphoFolderId = await findSharphoRootIfExists();
  const allFiles = [];
  for await (const file of listImages(folderId, sharphoFolderId)) {
    allFiles.push(file);
    setStatus(`Discovering… ${allFiles.length} files found`);
  }
  const total = allFiles.length;
  log('Discovery done', `${total} JPEG files`);
  setProgress(0);

  // Phase 2: process with accurate progress bar
  const failedFiles = [];
  await processFiles(allFiles, total, stats, pool, inFlight, failedFiles);

  log('Drain', `waiting for: ${[...inFlight.values()].join(', ') || 'none'}`);
  await Promise.all(pool);
  clearScanStatus();
  await reloadTopbarCounts();
  const manualNote = sessionGeotagged > 0 ? ` + ${sessionGeotagged} manually tagged` : '';
  if (scanCancelled) {
    setStatus(`Stopped — ${stats.geotagged + sessionGeotagged} geotagged out of ${stats.completed} scanned${manualNote} (${total - stats.completed} remaining).`);
    setProgress(0);
  } else {
    setStatus(`Done — ${stats.geotagged + sessionGeotagged} geotagged out of ${total}${manualNote}.`);
    setProgress(100);
  }

  if (failedFiles.length > 0) {
    log('Scan errors', `${failedFiles.length} files failed to download`);
    retryQueue = failedFiles;
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

  for (const file of files) {
    if (scanCancelled) break;
    stats.scanned++;
    setScanStatus(stats.scanned, stats.geotagged, stats.dated, total);

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
    const total = files.length;
    const stats = { scanned: 0, geotagged: 0, dated: 0, completed: 0 };
    const pool = new Set(), inFlight = new Map(), stillFailed = [];
    scanCancelled = false;
    stopScanBtn.style.display = '';
    stopScanBtn.disabled = false;
    stopScanBtn.textContent = '✕ Stop';
    setProgress(0);
    await processFiles(files, total, stats, pool, inFlight, stillFailed);
    await Promise.all(pool);
    stopScanBtn.style.display = 'none';
    clearScanStatus();
    await reloadTopbarCounts();
    retryQueue = stillFailed;
    updateRetryBtn();
    setProgress(stillFailed.length === 0 ? 100 : 0);
    log('Retry done', `${stillFailed.length} still failing after retry`);
    if (stillFailed.length > 0) showRetryDialog(stillFailed);
  });
}

async function main() {
  handleCallback();
  initMap();
  setAfterDeleteCallback(() => reloadTopbarCounts());
  document.getElementById('retry-menu-btn').addEventListener('click', () => {
    if (retryQueue.length > 0) showRetryDialog(retryQueue);
  });

  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) {
      sessionGeotagged++;
      updateTopbar();
      showBriefStatus(`📍 Geotagged! ${sessionGeotagged} photo${sessionGeotagged > 1 ? 's' : ''} tagged this session`);
    }
    openOrphanSlideshow();
  }));

  const token = getToken();
  setupAuthBtn(!!token);

  if (!token) {
    return; // login form is shown
  }

  await startScan();
}

main();
