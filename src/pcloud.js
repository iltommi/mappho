import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { getToken, getApiHost } from './auth.js';
import { log } from './log.js';
import { PROXY_URL } from './config.js';

const isNative = Capacitor.isNativePlatform();

function buildUrl(endpoint, params = {}) {
  const url = new URL(`${getApiHost()}/${endpoint}`);
  // pCloud web app uses 'auth'; works for all endpoints including getfilelink
  url.searchParams.set('auth', getToken());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url;
}

async function api(endpoint, params = {}) {
  const url = buildUrl(endpoint, params);

  if (isNative) {
    // CapacitorHttp routes through OkHttp — no Origin header sent to pCloud.
    // Pass the fully-built URL string; don't use CapacitorHttp's params option
    // (it silently fails to append query params on Capacitor 8 Android).
    const resp = await CapacitorHttp.request({ method: 'GET', url: url.toString() });
    const data = resp.data;
    if (data.result !== 0) throw new Error(`pCloud ${data.result}: ${data.error}`);
    return data;
  }

  const resp = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.result !== 0) throw new Error(`pCloud ${data.result}: ${data.error}`);
  return data;
}

// Returns immediate child folders of a given folder.
export async function listFolders(folderid = 0) {
  const data = await api('listfolder', { folderid });
  return (data.metadata.contents ?? []).filter(i => i.isfolder);
}

// Async generator: yields every JPEG file under folderid (BFS).
export async function* listImages(folderid = 0) {
  const queue = [folderid];
  while (queue.length > 0) {
    const fid = queue.shift();
    let data;
    try {
      data = await api('listfolder', { folderid: fid });
    } catch (e) {
      log(`listfolder error (id=${fid})`, e.message);
      console.warn('listfolder failed for', fid, e);
      continue;
    }
    for (const item of data.metadata.contents ?? []) {
      if (item.isfolder) {
        queue.push(item.folderid);
      } else if (/\.(jpe?g)$/i.test(item.name)) {
        yield item;
      }
    }
  }
}

// Fetches the first `bytes` of a file for EXIF extraction.
// On Android: uses native HTTP (no CORS). On web: routes through proxy.
export async function fetchFileHead(fileid, bytes = 131072) {
  if (isNative) {
    return fetchFileHeadNative(fileid, bytes);
  }
  return fetchFileHeadProxy(fileid, bytes);
}

async function fetchFileHeadNative(fileid, bytes) {
  const linkResp = await CapacitorHttp.request({
    method: 'GET',
    url: buildUrl('getfilelink', { fileid }).toString(),
  });
  const linkData = linkResp.data;
  if (linkData.result !== 0) throw new Error(`pCloud ${linkData.result}: ${linkData.error}`);

  const cdnUrl = `https://${linkData.hosts[0]}${linkData.path}`;

  // CDN has CORS restrictions — use CapacitorHttp (OkHttp) instead of WebView fetch
  const dlResp = await CapacitorHttp.request({
    method: 'GET',
    url: cdnUrl,
    headers: { Range: `bytes=0-${bytes - 1}` },
    responseType: 'arraybuffer',
  });

  const raw = dlResp.data;
  if (!raw) throw new Error('Empty CDN response');
  // CapacitorHttp returns binary as a base64 string on Android
  if (typeof raw === 'string') return base64ToArrayBuffer(raw);
  return raw;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

async function fetchFileHeadProxy(fileid, bytes) {
  if (!PROXY_URL) throw new Error('PROXY_URL not configured — see src/config.js');

  const linkUrl = new URL(`${PROXY_URL}/getfilelink`);
  linkUrl.searchParams.set('auth_token', getToken());
  linkUrl.searchParams.set('fileid', fileid);
  const linkResp = await fetch(linkUrl);
  if (!linkResp.ok) throw new Error(`getfilelink HTTP ${linkResp.status}`);
  const linkData = await linkResp.json();
  if (linkData.result !== 0) throw new Error(`pCloud ${linkData.result}: ${linkData.error}`);

  const cdnUrl = `https://${linkData.hosts[0]}${linkData.path}`;
  const dlUrl = `${PROXY_URL}/cdn?url=${encodeURIComponent(cdnUrl)}`;
  const dlResp = await fetch(dlUrl, {
    headers: { Range: `bytes=0-${bytes - 1}` },
  });
  if (!dlResp.ok && dlResp.status !== 206) throw new Error(`CDN download failed: ${dlResp.status}`);
  return dlResp.arrayBuffer();
}

// Returns a URL that pCloud will serve as a JPEG thumbnail.
export function thumbUrl(fileid, size = '256x256') {
  const url = new URL(`${getApiHost()}/getthumb`);
  url.searchParams.set('auth_token', getToken());
  url.searchParams.set('fileid', fileid);
  url.searchParams.set('size', size);
  url.searchParams.set('type', 'jpg');
  return url.toString();
}
