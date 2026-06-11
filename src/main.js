import { handleCallback, getToken, loginWithPassword, logout, TwoFactorRequired } from './auth.js';
import { log } from './log.js';
import { listImages, fetchFileHead } from './pcloud.js';
import { extractGPS } from './exif.js';
import { initMap, addMarker } from './map.js';
import { getCached, putCached, getAllCached } from './db.js';
import './style.css';

const statusEl = document.getElementById('status');
const authBtn = document.getElementById('auth-btn');
const progressFill = document.getElementById('progress-fill');
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const totpInput = document.getElementById('totp');

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setProgress(pct) {
  progressFill.style.width = `${Math.min(100, pct)}%`;
}

function showApp() {
  loginOverlay.style.display = 'none';
  authBtn.style.display = '';
  authBtn.onclick = () => { logout(); location.reload(); };
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  loginError.textContent = '';
  try {
    const code = totpInput.value.replace(/\D/g, '') || null;
    await loginWithPassword(
      document.getElementById('email').value,
      document.getElementById('password').value,
      code,
    );
    showApp();
    await startScan();
  } catch (err) {
    if (err instanceof TwoFactorRequired) {
      totpInput.style.display = '';
      totpInput.required = true;
      totpInput.focus();
      loginError.textContent = 'pCloud sent a verification code to your email — enter it here.';
      log('2FA required');
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
  const cached = await getAllCached();
  let cachedGeo = 0;
  for (const p of cached) {
    if (p.lat != null) { addMarker(p); cachedGeo++; }
  }
  if (cached.length > 0) setStatus(`${cachedGeo} photos from cache — refreshing…`);
  setProgress(0);
  try {
    await scan();
  } catch (e) {
    if (e.message?.includes('2000') || e.message?.includes('auth')) {
      logout();
      setStatus('Session expired — please reconnect.');
      location.reload();
    } else {
      setStatus(`Error: ${e.message}`);
    }
    console.error(e);
  }
}

async function scan() {
  let scanned = 0, geotagged = 0;

  for await (const file of listImages()) {
    scanned++;
    setStatus(`Scanning… ${scanned} images found, ${geotagged} geotagged`);

    // Skip files we already know the answer for.
    const hit = await getCached(file.fileid);
    if (hit) {
      if (hit.lat != null) geotagged++;
      continue;
    }

    let gps = null;
    try {
      const buf = await fetchFileHead(file.fileid);
      gps = await extractGPS(buf);
    } catch (e) {
      console.warn('Failed to process', file.name, e);
    }

    const record = { fileid: file.fileid, name: file.name, lat: gps?.lat ?? null, lng: gps?.lng ?? null };
    await putCached(record);

    if (gps) {
      geotagged++;
      addMarker(record);
    }

    // Gentle pacing to avoid hammering the API.
    await new Promise(r => setTimeout(r, 80));
  }

  setStatus(`Done — ${geotagged} geotagged photos out of ${scanned} total.`);
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
