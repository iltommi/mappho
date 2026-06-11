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

// No-op: kept so main.js doesn't need changes.
export function handleCallback() {}

export class TwoFactorRequired extends Error {}

// Authenticates with pCloud directly and stores the token.
// Pass `code` if the account has 2FA enabled.
// Throws TwoFactorRequired when a TOTP code is needed.
export async function loginWithPassword(email, password, code = null) {
  const url = new URL(`${DEFAULT_HOST}/userinfo`);
  url.searchParams.set('getauth', '1');
  url.searchParams.set('logout', '1');
  url.searchParams.set('username', email);
  url.searchParams.set('password', password);
  if (code) url.searchParams.set('code', code);

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Network error: ${resp.status}`);
  const data = await resp.json();

  if (data.error?.toLowerCase().includes('code')) throw new TwoFactorRequired();
  if (data.result !== 0) throw new Error(data.error ?? `pCloud error ${data.result}`);

  localStorage.setItem(TOKEN_KEY, data.auth);
  localStorage.setItem(HOST_KEY, DEFAULT_HOST);
}
