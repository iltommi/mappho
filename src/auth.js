import { log } from './log.js';

const TOKEN_KEY = 'pcloud_token';
const HOST_KEY = 'pcloud_host';

// EU datacenter — change to 'https://api.pcloud.com' if you're on US.
const DEFAULT_HOST = 'https://eapi.pcloud.com';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getApiHost() {
  return localStorage.getItem(HOST_KEY) ?? DEFAULT_HOST;
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(HOST_KEY);
}

export function handleCallback() {}

export function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(HOST_KEY, DEFAULT_HOST);
}

export class TwoFactorRequired extends Error {
  constructor(tfaToken) {
    super('TwoFactorRequired');
    this.tfaToken = tfaToken;
  }
}

// Step 1: username + password via POST /login (matches pCloud web app flow).
// Throws TwoFactorRequired (carrying the tfaToken) when TOTP is needed.
export async function loginWithPassword(email, password) {
  const url = new URL(`${DEFAULT_HOST}/login`);
  const body = new URLSearchParams({ username: email, password, getauth: '1', logout: '1' });

  log('login request', `POST ${url} username=${email} password=***`);
  const resp = await fetch(url, { method: 'POST', body });
  if (!resp.ok) throw new Error(`Network error: ${resp.status}`);
  const data = await resp.json();
  log('login response', data);

  if (data.result === 1022) {
    throw new TwoFactorRequired(data.token ?? null);
  }
  if (data.result !== 0) throw new Error(data.error ?? `pCloud error ${data.result}`);

  // No TFA: store the auth token directly (pCloud returns it without getauth too).
  const authToken = data.auth ?? data.token;
  if (!authToken) throw new Error('No auth token in response.');
  localStorage.setItem(TOKEN_KEY, authToken);
  localStorage.setItem(HOST_KEY, DEFAULT_HOST);
}

// Step 2: verify TOTP code — /tfa_login returns the final auth token on success.
export async function loginWithTFA(tfaToken, code) {
  const url = new URL(`${DEFAULT_HOST}/tfa_login`);
  url.searchParams.set('token', tfaToken);
  url.searchParams.set('code', code.replace(/\D/g, ''));
  url.searchParams.set('trustdevice', 'false');

  log('tfa_login request', { token: tfaToken.slice(0, 8) + '…', code });
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Network error: ${resp.status}`);
  const data = await resp.json();
  log('tfa_login response', data);

  if (data.result !== 0) throw new Error(data.error ?? `TFA error ${data.result}`);

  const authToken = data.auth ?? data.token ?? data.authtoken;
  if (!authToken) throw new Error('No auth token in TFA response. Full response logged above.');
  localStorage.setItem(TOKEN_KEY, authToken);
  localStorage.setItem(HOST_KEY, DEFAULT_HOST);
}
