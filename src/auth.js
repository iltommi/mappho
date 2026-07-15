import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { log } from './log.js';

const TOKEN_KEY = 'pcloud_token';
const HOST_KEY = 'pcloud_host';
const DEVICE_KEY = 'pcloud_deviceid';

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '');
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

const EU_HOST = 'https://eapi.pcloud.com';
const US_HOST = 'https://api.pcloud.com';

export { EU_HOST, US_HOST };

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getApiHost() {
  return localStorage.getItem(HOST_KEY) ?? EU_HOST;
}

export function setApiHost(host) {
  localStorage.setItem(HOST_KEY, host);
}

export function logout() {
  // Keep HOST_KEY — the datacenter choice should survive a disconnect.
  localStorage.removeItem(TOKEN_KEY);
}

export function handleCallback() {}

export function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export class TwoFactorRequired extends Error {
  constructor(tfaToken) {
    super('TwoFactorRequired');
    this.tfaToken = tfaToken;
  }
}

async function pcloudFetch(url, options = {}) {
  // On Android: use CapacitorHttp so session cookies land in OkHttp's cookie
  // jar and travel with every subsequent CapacitorHttp API call.
  if (Capacitor.isNativePlatform()) {
    const resp = await CapacitorHttp.request({
      method: options.method ?? 'GET',
      url: url.toString(),
      headers: options.headers ?? {},
      data: options.body ?? undefined,
    });
    return resp.data;
  }
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`Network error: ${resp.status}`);
  return resp.json();
}

export async function loginWithPassword(email, password) {
  const url = new URL(`${getApiHost()}/login`);
  const body = new URLSearchParams({
    username: email, password,
    getauth: '1', logout: '1',
    os: '4', deviceid: getDeviceId(),
  });

  log('login request', `POST ${url} username=${email}`);
  const data = await pcloudFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  // Never log the full response — it contains the auth token and the debug
  // log is user-shareable.
  log('login response', { result: data.result, error: data.error });

  if (data.result === 2297) throw new TwoFactorRequired(data.token);
  if (data.result !== 0) throw new Error(data.error ?? `pCloud error ${data.result}`);

  const authToken = data.auth ?? data.token;
  if (!authToken) throw new Error('No auth token in response.');
  localStorage.setItem(TOKEN_KEY, authToken);
}

export async function loginWithTFA(tfaToken, code, trustDevice = false) {
  const url = new URL(`${getApiHost()}/tfa_login`);
  url.searchParams.set('token', tfaToken);
  url.searchParams.set('code', code.replace(/\D/g, ''));
  url.searchParams.set('trustdevice', trustDevice ? 'true' : 'false');

  log('tfa_login request', { token: tfaToken.slice(0, 8) + '…', code });
  const data = await pcloudFetch(url);
  log('tfa_login response', { result: data.result, error: data.error });

  if (data.result !== 0) throw new Error(data.error ?? `TFA error ${data.result}`);

  const authToken = data.auth ?? data.token ?? data.authtoken;
  if (!authToken) throw new Error('No auth token in TFA response.');
  localStorage.setItem(TOKEN_KEY, authToken);
}
