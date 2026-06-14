import { CapacitorHttp } from '@capacitor/core';
import { getToken, getApiHost } from './auth.js';
import { log } from './log.js';

const API_TIMEOUT = 20000;  // ms — pCloud JSON API calls
const CDN_TIMEOUT = 30000;  // ms — binary CDN downloads

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)),
  ]);
}

function buildUrl(endpoint, params = {}) {
  const url = new URL(`${getApiHost()}/${endpoint}`);
  url.searchParams.set('auth', getToken());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  return url;
}

async function api(endpoint, params = {}) {
  const url = buildUrl(endpoint, params);
  const resp = await withTimeout(
    CapacitorHttp.request({ method: 'GET', url: url.toString(), connectTimeout: API_TIMEOUT, readTimeout: API_TIMEOUT }),
    API_TIMEOUT,
  );
  const data = resp.data;
  if (data.result !== 0) throw new Error(`pCloud ${data.result}: ${data.error}`);
  return data;
}

export async function listFolders(folderid = 0) {
  const data = await api('listfolder', { folderid, nofiles: 1 });
  return (data.metadata.contents ?? []).filter(i => i.isfolder);
}

export async function* listImages(folderid = 0) {
  const queue = [folderid];
  while (queue.length > 0) {
    const fid = queue.shift();
    let data;
    try {
      data = await api('listfolder', { folderid: fid });
    } catch (e) {
      log(`listfolder error (id=${fid})`, e.message);
      continue;
    }
    log(`traversing folder`, `${data.metadata.name} (id=${fid})`);
    for (const item of data.metadata.contents ?? []) {
      if (item.isfolder) {
        queue.push(item.folderid);
      } else if (/\.(jpe?g|heic|mp4)$/i.test(item.name)) {
        yield item;
      }
    }
  }
}

async function getCdnUrl(fileid) {
  const linkResp = await withTimeout(
    CapacitorHttp.request({ method: 'GET', url: buildUrl('getfilelink', { fileid }).toString(), connectTimeout: API_TIMEOUT, readTimeout: API_TIMEOUT }),
    API_TIMEOUT,
  );
  const linkData = linkResp.data;
  if (linkData.result !== 0) throw new Error(`pCloud ${linkData.result}: ${linkData.error}`);
  const host = linkData.hosts?.[0];
  if (!host) throw new Error('pCloud getfilelink returned no CDN host');
  return `https://${host}${linkData.path}`;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

export async function fetchFileHead(fileid, bytes = 131072) {
  const cdnUrl = await getCdnUrl(fileid);
  const dlResp = await withTimeout(
    CapacitorHttp.request({ method: 'GET', url: cdnUrl, headers: { Range: `bytes=0-${bytes - 1}` }, responseType: 'arraybuffer', connectTimeout: CDN_TIMEOUT, readTimeout: CDN_TIMEOUT }),
    CDN_TIMEOUT,
  );
  const raw = dlResp.data;
  if (!raw) throw new Error('Empty CDN response');
  return typeof raw === 'string' ? base64ToArrayBuffer(raw) : raw;
}

export async function fetchFileRange(fileid, from, to) {
  const cdnUrl = await getCdnUrl(fileid);
  const dlResp = await withTimeout(
    CapacitorHttp.request({ method: 'GET', url: cdnUrl, headers: { Range: `bytes=${from}-${to}` }, responseType: 'arraybuffer', connectTimeout: CDN_TIMEOUT, readTimeout: CDN_TIMEOUT }),
    CDN_TIMEOUT,
  );
  const raw = dlResp.data;
  if (!raw) throw new Error('Empty CDN response');
  return typeof raw === 'string' ? base64ToArrayBuffer(raw) : raw;
}

export async function downloadFullFile(fileid) {
  const cdnUrl = await getCdnUrl(fileid);
  const dlResp = await withTimeout(
    CapacitorHttp.request({ method: 'GET', url: cdnUrl, responseType: 'arraybuffer', connectTimeout: CDN_TIMEOUT, readTimeout: CDN_TIMEOUT }),
    CDN_TIMEOUT,
  );
  const raw = dlResp.data;
  if (!raw) throw new Error('Empty file response');
  return typeof raw === 'string' ? base64ToArrayBuffer(raw) : raw;
}

export async function fetchVideoSrc(fileid) {
  return getCdnUrl(fileid);
}

export async function getFileStat(fileid) {
  const data = await api('stat', { fileid });
  return data.metadata;
}

export async function uploadFile(folderid, filename, arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  const b64 = btoa(bin);
  const boundary = 'SharPhoUpload' + crypto.randomUUID().replace(/-/g, '');
  const crlf = '\r\n';
  const body = [
    '--' + boundary,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: image/jpeg',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--' + boundary + '--',
  ].join(crlf);
  const resp = await CapacitorHttp.request({
    method: 'POST',
    url: buildUrl('uploadfile', { folderid, nopartial: 1 }).toString(),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    data: body,
    connectTimeout: CDN_TIMEOUT, readTimeout: CDN_TIMEOUT,
  });
  if (resp.data?.result !== 0) throw new Error(`pCloud upload error ${resp.data?.result}: ${resp.data?.error}`);
  const newFileid = resp.data.fileids?.[0] ?? resp.data.metadata?.[0]?.fileid;
  if (!newFileid) throw new Error('Upload succeeded but pCloud returned no file ID');
  return newFileid;
}

export async function deleteFile(fileid) {
  await api('deletefile', { fileid });
}

export async function overwriteFile(fileid, arrayBuffer) {
  const { name, parentfolderid } = await getFileStat(fileid);
  const newFileid = await uploadFile(parentfolderid, name, arrayBuffer);
  await deleteFile(fileid);
  return newFileid;
}

const BACKUP_FILENAME = 'sharpho.json';

export async function uploadBackup(jsonStr) {
  try {
    const stat = await api('stat', { path: `/${BACKUP_FILENAME}` });
    await api('deletefile', { fileid: stat.metadata.fileid });
  } catch { /* file doesn't exist yet */ }

  const boundary = 'SharPhoBoundary' + crypto.randomUUID().replace(/-/g, '');
  const crlf = '\r\n';
  const body =
    '--' + boundary + crlf +
    `Content-Disposition: form-data; name="file"; filename="${BACKUP_FILENAME}"` + crlf +
    'Content-Type: application/json' + crlf +
    crlf +
    jsonStr + crlf +
    '--' + boundary + '--';

  const resp = await CapacitorHttp.request({
    method: 'POST',
    url: buildUrl('uploadfile', { folderid: 0, nopartial: 1 }).toString(),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    data: body,
    connectTimeout: CDN_TIMEOUT, readTimeout: CDN_TIMEOUT,
  });
  if (resp.data?.result !== 0) throw new Error(`pCloud ${resp.data?.result}: ${resp.data?.error}`);
}

export async function downloadBackup() {
  const stat = await api('stat', { path: `/${BACKUP_FILENAME}` });
  const link = await api('getfilelink', { fileid: stat.metadata.fileid });
  const host = link.hosts?.[0];
  if (!host) throw new Error('pCloud getfilelink returned no CDN host');
  const cdnUrl = `https://${host}${link.path}`;
  const resp = await CapacitorHttp.request({
    method: 'GET', url: cdnUrl,
    connectTimeout: CDN_TIMEOUT, readTimeout: CDN_TIMEOUT,
  });
  return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
}

export async function fetchThumbSrc(fileid, size = '512x512') {
  if (!/^\d+$/.test(String(fileid))) return null;
  const url = new URL(`${getApiHost()}/getthumb`);
  url.searchParams.set('auth', getToken());
  url.searchParams.set('fileid', fileid);
  url.searchParams.set('size', size);
  url.searchParams.set('type', 'jpg');
  const urlStr = url.toString();
  log('fetchThumb', urlStr);
  try {
    const resp = await CapacitorHttp.request({
      method: 'GET', url: urlStr, responseType: 'arraybuffer',
      connectTimeout: API_TIMEOUT, readTimeout: API_TIMEOUT,
    });
    log('fetchThumb status', resp.status);
    const raw = resp.data;
    if (!raw) { log('fetchThumb', 'empty response'); return null; }
    if (typeof raw === 'object' && raw.result !== undefined) { log('fetchThumb pCloud error', raw); return null; }
    const b64 = (typeof raw === 'string' ? raw : btoa(String.fromCharCode(...new Uint8Array(raw)))).replace(/\s/g, '');
    return `data:image/jpeg;base64,${b64}`;
  } catch (e) {
    log('fetchThumb error', e.message);
    return null;
  }
}
