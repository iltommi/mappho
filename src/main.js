import { handleCallback, getToken, loginWithPassword, loginWithTFA, logout, saveToken, TwoFactorRequired } from './auth.js';
import { log, toggleLog } from './log.js';
import { listImages, listFolders, fetchFileHead } from './pcloud.js';
import { extractGPS } from './exif.js';
import { initMap, addMarker } from './map.js';
import { getCached, putCached, getAllCached, clearAll } from './db.js';
import { registerSW } from 'virtual:pwa-register';
import './style.css';

registerSW({ onNeedRefresh() { window.location.reload(); } });

const authBtn = document.getElementById('auth-btn');
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

document.getElementById('log-menu-btn').addEventListener('click', () => {
  overflowMenu.classList.remove('open');
  toggleLog();
});

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  overflowMenu.classList.toggle('open');
});

document.addEventListener('click', () => {
  overflowMenu.classList.remove('open');
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
  const folders = await listFolders(0);
  folderSelect.innerHTML = '<option value="0">All photos</option>';
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = String(f.folderid);
    opt.textContent = f.name;
    folderSelect.appendChild(opt);
  }
  const saved = getSelectedFolder();
  folderSelect.value = String(saved.id);
  folderSelect.style.display = '';
}

folderSelect.addEventListener('change', () => {
  const id = folderSelect.value;
  const name = folderSelect.options[folderSelect.selectedIndex].text;
  localStorage.setItem(FOLDER_KEY, JSON.stringify({ id, name }));
});

scanBtn.addEventListener('click', async () => {
  scanBtn.disabled = true;
  clearCacheBtn.disabled = true;
  await runScan();
  scanBtn.disabled = false;
  clearCacheBtn.disabled = false;
});

eraseCacheBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  await clearAll();
  log('Cache erased');
  setStatus('Cache erased — click Scan to rebuild.');
});

clearCacheBtn.addEventListener('click', async () => {
  overflowMenu.classList.remove('open');
  await clearAll();
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
  folderSelect.style.display = '';
  scanBtn.style.display = '';
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
  const cached = await getAllCached();
  let cachedGeo = 0;
  for (const p of cached) {
    if (p.lat != null) { addMarker(p); cachedGeo++; }
  }
  setStatus(cached.length > 0
    ? `${cachedGeo} geotagged photos from cache. Pick a folder and click Scan.`
    : 'Pick a folder and click Scan.');

  // Populate folder picker separately — a network failure here shouldn't lose the markers.
  try {
    await populateFolderPicker();
  } catch (e) {
    log('folder picker error', e.message);
    setStatus(`Could not load folders: ${e.message}`);
  }
}

async function runScan() {
  setProgress(0);
  try {
    await scan();
  } catch (e) {
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
  let gps = null;
  try {
    const buf = await fetchFileHead(file.fileid);
    log(`${file.name}`, `buffer: ${buf.byteLength}B`);
    gps = await extractGPS(buf);
    log(`${file.name} → GPS`, gps ?? 'null');
  } catch (e) {
    log(`${file.name} ERROR`, e.message);
    console.warn('Failed to process', file.name, e);
  }
  const record = { fileid: file.fileid, name: file.name, lat: gps?.lat ?? null, lng: gps?.lng ?? null };
  await putCached(record);
  if (gps) { stats.geotagged++; addMarker(record); }
}

async function scan() {
  const CONCURRENCY = 6;
  const stats = { scanned: 0, geotagged: 0 };
  const pool = new Set();

  const { id: folderId, name: folderName } = getSelectedFolder();
  log('Scanning folder', `${folderName ?? 'All photos'} (id=${folderId})`);
  for await (const file of listImages(folderId)) {
    stats.scanned++;
    setStatus(`Scanning… ${stats.scanned} images found, ${stats.geotagged} geotagged`);

    const p = processFile(file, stats).finally(() => pool.delete(p));
    pool.add(p);

    if (pool.size >= CONCURRENCY) await Promise.race(pool);
  }

  await Promise.all(pool);
  setStatus(`Done — ${stats.geotagged} geotagged photos out of ${stats.scanned} total.`);
  setProgress(100);
}

async function main() {
  handleCallback();
  initMap();

  const token = getToken();
  setupAuthBtn(!!token);

  if (!token) {
    return; // login form is shown
  }

  await startScan();
}

main();
