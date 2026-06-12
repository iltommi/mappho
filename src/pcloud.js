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
  const bin = atob(b64.replace(/\s/g, ''));
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

// Download the full content of a file as ArrayBuffer.
export async function downloadFullFile(fileid) {
  if (isNative) {
    const linkResp = await CapacitorHttp.request({
      method: 'GET',
      url: buildUrl('getfilelink', { fileid }).toString(),
    });
    const linkData = linkResp.data;
    if (linkData.result !== 0) throw new Error(`pCloud ${linkData.result}: ${linkData.error}`);
    const cdnUrl = `https://${linkData.hosts[0]}${linkData.path}`;
    const dlResp = await CapacitorHttp.request({ method: 'GET', url: cdnUrl, responseType: 'arraybuffer' });
    const raw = dlResp.data;
    if (!raw) throw new Error('Empty file response');
    return typeof raw === 'string' ? base64ToArrayBuffer(raw) : raw;
  }
  if (!PROXY_URL) throw new Error('PROXY_URL not configured');
  const linkUrl = new URL(`${PROXY_URL}/getfilelink`);
  linkUrl.searchParams.set('auth_token', getToken());
  linkUrl.searchParams.set('fileid', fileid);
  const linkData = await (await fetch(linkUrl)).json();
  if (linkData.result !== 0) throw new Error(`pCloud ${linkData.result}: ${linkData.error}`);
  const cdnUrl = `https://${linkData.hosts[0]}${linkData.path}`;
  const dlResp = await fetch(`${PROXY_URL}/cdn?url=${encodeURIComponent(cdnUrl)}`);
  if (!dlResp.ok) throw new Error(`CDN download failed: ${dlResp.status}`);
  return dlResp.arrayBuffer();
}

// Delete the original file and re-upload the modified buffer under the same name.
// Returns the new fileid.
export async function overwriteFile(fileid, arrayBuffer) {
  const stat = await api('stat', { fileid });
  const { name, parentfolderid } = stat.metadata;

  await api('deletefile', { fileid });

  // Encode binary as base64 so the multipart body is ASCII-safe
  // (CapacitorHttp serialises strings as UTF-8, which corrupts raw bytes >127)
  const bytes = new Uint8Array(arrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  const b64 = btoa(bin);

  const boundary = 'SharPhoUpload' + Date.now();
  const crlf = '\r\n';
  const body = [
    '--' + boundary,
    `Content-Disposition: form-data; name="file"; filename="${name}"`,
    'Content-Type: image/jpeg',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--' + boundary + '--',
  ].join(crlf);

  const url = buildUrl('uploadfile', { folderid: parentfolderid, nopartial: 1 }).toString();

  if (isNative) {
    const resp = await CapacitorHttp.request({
      method: 'POST',
      url,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      data: body,
    });
    if (resp.data?.result !== 0) throw new Error(`pCloud upload error ${resp.data?.result}: ${resp.data?.error}`);
    return resp.data.fileids?.[0] ?? resp.data.metadata?.[0]?.fileid;
  }

  const formData = new FormData();
  formData.append('file', new Blob([arrayBuffer], { type: 'image/jpeg' }), name);
  const resp = await fetch(url, { method: 'POST', body: formData, referrerPolicy: 'no-referrer' });
  const data = await resp.json();
  if (data.result !== 0) throw new Error(`pCloud upload error ${data.result}: ${data.error}`);
  return data.fileids?.[0] ?? data.metadata?.[0]?.fileid;
}

const BACKUP_FILENAME = 'sharpho.json';

// Upload a JSON string to the pCloud root folder as sharpho.json.
// Deletes any existing file with the same name first to avoid duplicates.
export async function uploadBackup(jsonStr) {
  // Delete existing backup if present
  try {
    const stat = await api('stat', { path: `/${BACKUP_FILENAME}` });
    await api('deletefile', { fileid: stat.metadata.fileid });
  } catch { /* file doesn't exist yet */ }

  const boundary = 'SharPhoBoundary' + Date.now();
  const crlf = '\r\n';
  const body =
    '--' + boundary + crlf +
    `Content-Disposition: form-data; name="file"; filename="${BACKUP_FILENAME}"` + crlf +
    'Content-Type: application/json' + crlf +
    crlf +
    jsonStr + crlf +
    '--' + boundary + '--';

  const url = buildUrl('uploadfile', { folderid: 0, nopartial: 1 }).toString();

  if (isNative) {
    const resp = await CapacitorHttp.request({
      method: 'POST',
      url,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      data: body,
    });
    if (resp.data?.result !== 0) throw new Error(`pCloud ${resp.data?.result}: ${resp.data?.error}`);
    return;
  }

  const formData = new FormData();
  formData.append('file', new Blob([jsonStr], { type: 'application/json' }), BACKUP_FILENAME);
  const resp = await fetch(url, { method: 'POST', body: formData, referrerPolicy: 'no-referrer' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.result !== 0) throw new Error(`pCloud ${data.result}: ${data.error}`);
}

// Download sharpho.json from pCloud root and return its parsed contents.
export async function downloadBackup() {
  const stat = await api('stat', { path: `/${BACKUP_FILENAME}` });
  const link = await api('getfilelink', { fileid: stat.metadata.fileid });
  const cdnUrl = `https://${link.hosts[0]}${link.path}`;

  if (isNative) {
    const resp = await CapacitorHttp.request({ method: 'GET', url: cdnUrl });
    return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  }

  const resp = await fetch(cdnUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function thumbUrl(fileid, size = '512x512') {
  const url = new URL(`${getApiHost()}/getthumb`);
  url.searchParams.set('auth', getToken());
  url.searchParams.set('fileid', fileid);
  url.searchParams.set('size', size);
  url.searchParams.set('type', 'jpg');
  return url.toString();
}

// Returns a src string suitable for <img>.
// On Android, WebView sends an Origin header on cross-origin image requests which
// pCloud blocks, so we fetch via CapacitorHttp (OkHttp, no Origin) and return a
// data URL instead. Returns null for non-numeric fileids (local-test markers).
export async function fetchThumbSrc(fileid, size = '512x512') {
  if (!/^\d+$/.test(String(fileid))) return null;
  const url = thumbUrl(fileid, size);
  log('fetchThumb', url);
  if (!isNative) return url;
  try {
    const resp = await CapacitorHttp.request({ method: 'GET', url, responseType: 'arraybuffer' });
    log('fetchThumb status', resp.status);
    const raw = resp.data;
    log('fetchThumb raw', { type: typeof raw, len: typeof raw === 'string' ? raw.length : null, preview: typeof raw === 'string' ? raw.slice(0, 80) : JSON.stringify(raw)?.slice(0, 80) });
    if (!raw) { log('fetchThumb', 'empty response'); return null; }
    if (typeof raw === 'object' && raw.result !== undefined) {
      log('fetchThumb pCloud error', raw);
      return null;
    }
    const b64 = (typeof raw === 'string' ? raw : btoa(String.fromCharCode(...new Uint8Array(raw)))).replace(/\s/g, '');
    return `data:image/jpeg;base64,${b64}`;
  } catch (e) {
    log('fetchThumb error', e.message);
    return null;
  }
}
