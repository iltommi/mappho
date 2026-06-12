import { handleCallback, getToken, loginWithPassword, loginWithTFA, logout, saveToken, TwoFactorRequired, getApiHost, setApiHost, EU_HOST, US_HOST } from './auth.js';
import { log, toggleLog } from './log.js';
import { toggleFilter } from './filter.js';
import { listImages, listFolders, fetchFileHead, uploadBackup, downloadBackup } from './pcloud.js';
import { extractEXIF } from './exif.js';
import { initMap, addMarker, clearMarkers } from './map.js';
import { openLazySlideshow, setGeotagHandler } from './slideshow.js';
import { startGeotagging } from './geotag.js';
import { getCached, putCached, getAllCached, clearAll, putOrphan, countOrphans, clearOrphans, getOrphansPage, exportDb, importDb } from './db.js';
import { registerSW } from 'virtual:pwa-register';
import './style.css';

registerSW({ onNeedRefresh() { window.location.reload(); } });

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
let briefTimer = null;

function setScanStatus(scanned, geotagged) {
  const extra = sessionGeotagged > 0 ? ` + ${sessionGeotagged} manually tagged` : '';
  scanStatusEl.textContent = `Scanning… ${scanned} scanned, ${geotagged + sessionGeotagged} geotagged${extra}`;
  scanStatusEl.classList.add('visible');
}
function clearScanStatus() {
  scanStatusEl.classList.remove('visible');
}
function showBriefStatus(msg, ms = 3000) {
  clearTimeout(briefTimer);
  scanStatusEl.textContent = msg;
  scanStatusEl.classList.add('visible');
  briefTimer = setTimeout(() => scanStatusEl.classList.remove('visible'), ms);
}
const progressFill = document.getElementById('progress-fill');
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const totpInput = document.getElementById('totp');
const folderSelect = document.getElementById('folder-select');
const scanBtn = document.getElementById('scan-btn');
const clearCacheBtn = document.getElementById('clear-cache-btn');
const eraseCacheBtn = document.getElementById('erase-cache-btn');
const localInput = document.getElementById('local-input');
const menuWrap = document.getElementById('menu-wrap');
const menuBtn = document.getElementById('menu-btn');
const overflowMenu = document.getElementById('overflow-menu');

document.getElementById('export-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  try {
    log('Backup', 'exporting…');
    const backup = await exportDb();
    await uploadBackup(JSON.stringify(backup));
    log('Backup', `saved ${backup.photos.length} records to pCloud`);
    setStatus(`Backup saved — ${backup.photos.length} photos exported.`);
  } catch (e) {
    log('Backup error', e.message);
    setStatus(`Backup failed: ${e.message}`);
  }
});

document.getElementById('import-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  try {
    log('Restore', 'downloading from pCloud…');
    const backup = await downloadBackup();
    if (!backup?.photos) throw new Error('Invalid backup file');
    await importDb(backup);
    clearMarkers();
    const cached = await getAllCached();
    const orphanWrites = [];
    let geo = 0;
    for (const p of cached) {
      if (p.lat != null) { addMarker(p); geo++; }
      else orphanWrites.push(putOrphan(p));
    }
    await Promise.all(orphanWrites);
    log('Restore', `${geo} geotagged, ${backup.orphans?.length ?? 0} unlocalised`);
    setStatus(`Restored — ${geo} geotagged photos loaded.`);
  } catch (e) {
    log('Restore error', e.message);
    setStatus(`Restore failed: ${e.message}`);
  }
});

async function openOrphanSlideshow() {
  const total = await countOrphans();
  if (!total) { log('No location', 'no unlocalised photos in cache — scan first'); return; }
  openLazySlideshow((offset, limit) => getOrphansPage(offset, limit), total);
}

document.getElementById('noloc-menu-btn').addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  await openOrphanSlideshow();
});

document.getElementById('filter-menu-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  toggleFilter();
});

document.getElementById('log-menu-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  toggleLog();
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
    const buf = await file.arrayBuffer();
    const gps = await extractGPS(buf);
    log(file.name, gps ? `GPS: ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : 'no GPS');
    if (gps) {
      found++;
      addMarker({ fileid: file.name, name: file.name, lat: gps.lat, lng: gps.lng });
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

async function populateFolderPicker() {
  folderSelect.innerHTML = '<option value="0">All photos</option>';
  const folders = await listFolders(0);
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = String(f.folderid);
    opt.textContent = f.name;
    folderSelect.appendChild(opt);
  }
  const saved = getSelectedFolder();
  folderSelect.value = String(saved.id);
}

folderSelect.addEventListener('change', () => {
  const id = folderSelect.value;
  const name = folderSelect.options[folderSelect.selectedIndex].text;
  localStorage.setItem(FOLDER_KEY, JSON.stringify({ id, name }));
});

scanBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  scanBtn.disabled = true;
  clearCacheBtn.disabled = true;
  await runScan();
  scanBtn.disabled = false;
  clearCacheBtn.disabled = false;
});

eraseCacheBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  await Promise.all([clearAll(), clearOrphans()]);
  clearMarkers();
  log('Cache erased');
  setStatus('Cache erased — click Scan to rebuild.');
});

clearCacheBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  await Promise.all([clearAll(), clearOrphans()]);
  log('Cache cleared');
  setStatus('Cache cleared — scanning…');
  scanBtn.disabled = true;
  clearCacheBtn.disabled = true;
  await runScan();
  scanBtn.disabled = false;
  clearCacheBtn.disabled = false;
});

document.getElementById('use-token-btn').addEventListener('click', async () => {
  const token = document.getElementById('token-input').value.trim();
  if (!token) { loginError.textContent = 'Please paste your auth token.'; return; }
  saveToken(token);
  showApp();
  await startScan();
});

function setStatus(msg) {
  log('status', msg);
}

function setProgress(pct) {
  progressFill.style.width = `${Math.min(100, pct)}%`;
}

function showApp() {
  loginOverlay.style.display = 'none';
  menuWrap.style.display = '';
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

async function startScan() {
  // Load cached markers first — no network needed, works immediately after wake.
  showBriefStatus('Loading cache…', 30000);
  const cached = await getAllCached();
  let cachedGeo = 0;
  const orphanWrites = [];
  for (const p of cached) {
    if (p.lat != null) { addMarker(p); cachedGeo++; }
    else orphanWrites.push(putOrphan(p)); // migrate existing non-GPS records into orphans store
  }
  await Promise.all(orphanWrites);
  showBriefStatus(cached.length > 0
    ? `Cache loaded — ${cachedGeo} geotagged, ${cached.length - cachedGeo} without location.`
    : 'Cache empty — open the menu and tap Scan.');

  // Populate folder picker separately — a network failure here shouldn't lose the markers.
  try {
    await populateFolderPicker();
  } catch (e) {
    log('folder picker error', e.message);
    showBriefStatus(`Could not load folders: ${e.message}`);
  }
}

async function runScan() {
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
  }
}

async function processFile(file, stats) {
  const hit = await getCached(file.fileid);
  if (hit) {
    log(`${file.name} [cached]`, hit.lat != null ? `GPS: ${hit.lat.toFixed(4)}, ${hit.lng.toFixed(4)}` : 'no GPS');
    if (hit.lat != null) { stats.geotagged++; addMarker(hit); }
    return;
  }
  let exif = {};
  try {
    const buf = await fetchFileHead(file.fileid);
    log(`${file.name}`, `buffer: ${buf.byteLength}B`);
    exif = await extractEXIF(buf);
    log(`${file.name} → GPS`, exif.lat != null ? `${exif.lat.toFixed(4)},${exif.lng.toFixed(4)}` : 'null');
  } catch (e) {
    log(`${file.name} ERROR`, e.message);
    console.warn('Failed to process', file.name, e);
  }
  const record = { fileid: file.fileid, name: file.name, lat: exif.lat ?? null, lng: exif.lng ?? null, ts: exif.ts ?? null };
  await putCached(record);
  if (exif.lat != null) { stats.geotagged++; addMarker(record); }
  else await putOrphan(record);
}

async function scan() {
  const CONCURRENCY = 6;
  const stats = { scanned: 0, geotagged: 0 };
  const pool = new Set();

  const { id: folderId, name: folderName } = getSelectedFolder();
  log('Scanning folder', `${folderName ?? 'All photos'} (id=${folderId})`);
  for await (const file of listImages(folderId)) {
    stats.scanned++;
    setScanStatus(stats.scanned, stats.geotagged);

    const p = processFile(file, stats).finally(() => {
      pool.delete(p);
      setScanStatus(stats.scanned, stats.geotagged);
    });
    pool.add(p);

    if (pool.size >= CONCURRENCY) await Promise.race(pool);
  }

  await Promise.all(pool);
  clearScanStatus();
  const manualNote = sessionGeotagged > 0 ? ` + ${sessionGeotagged} manually tagged` : '';
  setStatus(`Done — ${stats.geotagged + sessionGeotagged} geotagged out of ${stats.scanned}${manualNote}.`);
  setProgress(100);
}

async function main() {
  handleCallback();
  initMap();
  setGeotagHandler(photo => startGeotagging(photo, ({ success }) => {
    if (success) {
      sessionGeotagged++;
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
