import { CapacitorHttp, Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { getToken, getApiHost } from './auth.js';
import { log } from './log.js';

const API_TIMEOUT = 20000;  // ms — pCloud JSON API calls
const CDN_TIMEOUT = 30000;  // ms — binary CDN downloads (photos/videos)

// For large synced assets (ML text-tower model, embeddings corpus — tens of
// MB). Only matters for downloadFullFileNative below now — see its comment
// for why CapacitorHttp itself (30s CDN_TIMEOUT) can't just be given more
// time here instead.
export const LARGE_FILE_TIMEOUT = 600000; // ms (10 min)

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

// Resolves false only when pCloud confirms the folder is gone (2005).
// Network/transient errors throw so callers don't mistake them for deletion.
export async function folderExists(folderid) {
  try {
    await api('stat', { folderid });
    return true;
  } catch (e) {
    if (/pCloud 2005:/.test(e.message ?? '')) return false;
    throw e;
  }
}

export async function* listImages(folderid = 0, excludeFolderId = null) {
  const queue = [folderid];
  while (queue.length > 0) {
    const fid = queue.shift();
    if (excludeFolderId != null && fid === excludeFolderId) continue;
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
        if (excludeFolderId == null || item.folderid !== excludeFolderId) queue.push(item.folderid);
      } else if (/\.(jpe?g|heic|mp4|mov|3gp|3gpp|avi)$/i.test(item.name)) {
        yield item;
      }
    }
  }
}

// Returns pCloud metadata for a file at an absolute path, or throws if not found.
export async function statByPath(path) {
  const data = await api('stat', { path });
  return data.metadata;
}

// Idempotently create a folder under `folderid`, returns the (new or existing) folderid.
export async function createFolderIfNotExists(folderid, name) {
  const data = await api('createfolderifnotexists', { folderid, name });
  return data.metadata.folderid;
}

// Server-side copy — no bandwidth cost regardless of file size. Returns the new fileid.
// renameifexists=1 prevents pCloud from creating _original backup files on name conflicts.
export async function copyFile(fileid, tofolderid) {
  const data = await api('copyfile', { fileid, tofolderid, renameifexists: 1 });
  return data.metadata.fileid;
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

// Chunked to avoid String.fromCharCode(...bytes) blowing the call stack on
// multi-megabyte buffers.
export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  return btoa(bin);
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

// For photos/videos (a few MB at most) — routes bytes through the JS<->native
// bridge as base64, which is fine at this size. For tens-of-MB downloads
// (the ML model, embeddings corpus) use downloadFullFileNative instead; see
// its comment for why this path doesn't just scale up with a longer timeout.
export async function downloadFullFile(fileid, timeoutMs = CDN_TIMEOUT) {
  const cdnUrl = await getCdnUrl(fileid);
  const dlResp = await withTimeout(
    CapacitorHttp.request({ method: 'GET', url: cdnUrl, responseType: 'arraybuffer', connectTimeout: timeoutMs, readTimeout: timeoutMs }),
    timeoutMs,
  );
  const raw = dlResp.data;
  if (!raw) throw new Error('Empty file response');
  return typeof raw === 'string' ? base64ToArrayBuffer(raw) : raw;
}

// Downloads a large file via the native FileTransfer plugin instead of
// CapacitorHttp. CapacitorHttp routes response bytes through the JS<->native
// bridge as base64 — fine for a few MB, but for tens of MB that's real
// CPU/memory-bound serialization overhead that a fast connection doesn't
// help with (confirmed: timed out at 600s over WiFi). FileTransfer instead
// writes straight to native storage with no bridge involvement for the
// bytes, and reports real progress. Reading the result back also avoids the
// bridge: Capacitor.convertFileSrc() + fetch() goes through the WebView's
// own resource handler rather than a plugin RPC call. Falls back to
// Filesystem.readFile (which does cross the bridge, base64-encoded) only if
// that fails, so a change in Capacitor's local-file-serving behavior
// degrades gracefully instead of breaking the sync outright.
export async function downloadFullFileNative(fileid, { onProgress } = {}) {
  const cdnUrl = await getCdnUrl(fileid);
  const path = `mappho-dl-${fileid}-${Date.now()}`;

  let listener = null;
  if (onProgress) {
    listener = await FileTransfer.addListener('progress', p => {
      if (p.url === cdnUrl) onProgress(p.bytes, p.contentLength);
    });
  }
  try {
    const result = await FileTransfer.downloadFile({
      url: cdnUrl, path, directory: Directory.Cache, progress: !!onProgress,
      connectTimeout: LARGE_FILE_TIMEOUT, readTimeout: LARGE_FILE_TIMEOUT,
    });
    if (!result.path) throw new Error('FileTransfer.downloadFile returned no path');

    try {
      const src = Capacitor.convertFileSrc(result.path);
      const resp = await fetch(src);
      if (!resp.ok) throw new Error(`local file fetch failed: ${resp.status}`);
      return await resp.arrayBuffer();
    } catch (e) {
      log('pcloud', `convertFileSrc/fetch read-back failed (${e.message}), falling back to Filesystem.readFile`);
      const { data } = await Filesystem.readFile({ path: result.path });
      return typeof data === 'string' ? base64ToArrayBuffer(data) : data;
    } finally {
      Filesystem.deleteFile({ path: result.path }).catch(() => {});
    }
  } finally {
    if (listener) listener.remove();
  }
}

export async function fetchVideoSrc(fileid) {
  return getCdnUrl(fileid);
}

export async function getFileStat(fileid) {
  const data = await api('stat', { fileid });
  return data.metadata;
}

// Returns the full pCloud path for a file (e.g. /Photos/2023/06/photo.jpg).
export async function getFileFullPath(fileid) {
  const meta = await getFileStat(fileid);
  const parts = [meta.name];
  let fid = meta.parentfolderid;
  while (fid) {
    const folder = await _statFolder(fid);
    if (!folder.name) break;
    parts.unshift(folder.name);
    fid = folder.parentfolderid;
  }
  return '/' + parts.join('/');
}

export async function getPublicLink(fileid) {
  const data = await api('getfilepublink', { fileid });
  return data.link;
}

const _fileParentCache = new Map();
const _folderNameCache   = new Map(); // folderid → name
const _folderParentCache = new Map(); // folderid → parentfolderid

const MAX_FILE_CACHE = 2000;
function _cacheSet(map, k, v) {
  map.set(k, v);
  if (map.size > MAX_FILE_CACHE) map.delete(map.keys().next().value);
}

async function _statFolder(folderid) {
  if (_folderNameCache.has(folderid)) {
    return { name: _folderNameCache.get(folderid), parentfolderid: _folderParentCache.get(folderid) ?? 0 };
  }
  try {
    const data = await api('stat', { folderid });
    const name = data.metadata?.name ?? '';
    const parent = data.metadata?.parentfolderid ?? 0;
    _folderNameCache.set(folderid, name);
    _folderParentCache.set(folderid, parent);
    return { name, parentfolderid: parent };
  } catch {
    _folderNameCache.set(folderid, '');
    _folderParentCache.set(folderid, 0);
    return { name: '', parentfolderid: 0 };
  }
}

// Returns the parent folder name for display. Photos inside Photos/YYYY/MM
// return '' — the filename already encodes the date. Everything else returns
// the immediate parent folder name.
export async function getFileFolderName(fileid) {
  if (!_fileParentCache.has(fileid)) {
    try {
      const meta = await getFileStat(fileid);
      _cacheSet(_fileParentCache, fileid, meta.parentfolderid ?? null);
    } catch {
      _cacheSet(_fileParentCache, fileid, null);
      return '';
    }
  }
  const parentfolderid = _fileParentCache.get(fileid);
  if (!parentfolderid) return '';

  const level1 = await _statFolder(parentfolderid);           // MM (or immediate folder)
  if (!level1.name || !level1.parentfolderid) return level1.name;

  const level2 = await _statFolder(level1.parentfolderid);    // YYYY
  if (!level2.name || !level2.parentfolderid) return level1.name;

  const level3 = await _statFolder(level2.parentfolderid);    // Photos (or higher)
  if (level3.name === 'Photos') return '';

  return level1.name;
}

export async function uploadFile(folderid, filename, arrayBuffer) {
  const b64 = bufToBase64(arrayBuffer);
  // dataType:'formData' uses Capacitor's native multipart builder which base64-decodes
  // the value to raw bytes before writing — the plain string path would store the
  // base64 text literally on pCloud instead of the binary JPEG.
  const resp = await CapacitorHttp.request({
    method: 'POST',
    url: buildUrl('uploadfile', { folderid, nopartial: 1 }).toString(),
    headers: { 'Content-Type': 'multipart/form-data' },
    dataType: 'formData',
    data: [{ type: 'base64File', key: 'file', fileName: filename, contentType: 'image/jpeg', value: b64 }],
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

// Rename and/or move a file server-side. Returns the (unchanged) fileid.
export async function renameFile(fileid, { toname, tofolderid } = {}) {
  const params = { fileid };
  if (toname != null)     params.toname = toname;
  if (tofolderid != null) params.tofolderid = tofolderid;
  await api('renamefile', params);
  return fileid;
}

export async function overwriteFile(fileid, arrayBuffer) {
  const { name, parentfolderid } = await getFileStat(fileid);
  // Upload under a temp name first so the original survives a failed upload,
  // then delete the original and rename the temp into place. Uploading with
  // the final name directly would conflict with the existing file, and
  // deleting first risks losing the photo if the upload never completes.
  // The temp suffix keeps the file out of listImages' extension filter, and
  // is deterministic so a retry overwrites a leftover temp instead of piling up.
  const tmpName = `${name}.mappho-tmp`;
  const newFileid = await uploadFile(parentfolderid, tmpName, arrayBuffer);
  await deleteFile(fileid);
  await renameFile(newFileid, { toname: name });
  return newFileid;
}

export async function uploadJsonToFolder(folderid, filename, jsonStr, existingFileid = null) {
  if (existingFileid) {
    try { await api('deletefile', { fileid: existingFileid }); } catch {}
  }
  const boundary = 'Mappho' + crypto.randomUUID().replace(/-/g, '');
  const crlf = '\r\n';
  const body = `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}Content-Type: application/json${crlf}${crlf}${jsonStr}${crlf}--${boundary}--`;
  const resp = await CapacitorHttp.request({
    method: 'POST',
    url: buildUrl('uploadfile', { folderid, nopartial: 1 }).toString(),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    data: body,
    connectTimeout: CDN_TIMEOUT, readTimeout: CDN_TIMEOUT,
  });
  if (resp.data?.result !== 0) throw new Error(`pCloud upload ${resp.data?.result}: ${resp.data?.error}`);
  return resp.data.fileids?.[0] ?? null;
}

export async function downloadJsonFile(fileid, timeoutMs = CDN_TIMEOUT) {
  const link = await api('getfilelink', { fileid });
  const host = link.hosts?.[0];
  if (!host) throw new Error('pCloud getfilelink: no CDN host');
  const resp = await CapacitorHttp.request({
    method: 'GET',
    url: `https://${host}${link.path}`,
    connectTimeout: timeoutMs, readTimeout: timeoutMs,
  });
  return typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
}


// Rotates a data: URL by `deg` (0/90/180/270) via canvas, swapping the
// canvas width/height for 90/270 so the result renders upright. pCloud's
// getthumb does not apply a video's tkhd rotation matrix to the poster it
// generates, so callers pass the video's stored rotation (see mp4.js) to
// correct it here, once, rather than in every place a thumbnail is shown.
async function rotateDataUrl(dataUrl, deg) {
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload  = () => resolve(im);
    im.onerror = () => reject(new Error('rotateDataUrl: image decode failed'));
    im.src = dataUrl;
  });
  const odd = deg === 90 || deg === 270;
  const cw = odd ? img.naturalHeight : img.naturalWidth;
  const ch = odd ? img.naturalWidth  : img.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(deg * Math.PI / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export async function fetchThumbSrc(fileid, size = '512x512', rotation = 0) {
  if (!/^\d+$/.test(String(fileid))) return null;
  const url = new URL(`${getApiHost()}/getthumb`);
  url.searchParams.set('auth', getToken());
  url.searchParams.set('fileid', fileid);
  url.searchParams.set('size', size);
  url.searchParams.set('type', 'jpg');
  // Note: never log the URL — it carries the auth token, and the debug log
  // is user-shareable.
  try {
    const resp = await CapacitorHttp.request({
      method: 'GET', url: url.toString(), responseType: 'arraybuffer',
      connectTimeout: API_TIMEOUT, readTimeout: API_TIMEOUT,
    });
    const raw = resp.data;
    if (!raw) { log('fetchThumb', 'empty response'); return null; }
    if (typeof raw === 'object' && raw.result !== undefined) {
      const err = new Error(`pCloud ${raw.result}: ${raw.error ?? 'unknown error'}`);
      err.pcloudResult = raw.result;
      throw err;
    }
    const b64 = (typeof raw === 'string' ? raw : bufToBase64(raw)).replace(/\s/g, '');
    const dataUrl = `data:image/jpeg;base64,${b64}`;
    if (!rotation) return dataUrl;
    try { return await rotateDataUrl(dataUrl, rotation); }
    catch (e) { log('fetchThumb rotate error', e.message); return dataUrl; }
  } catch (e) {
    if (e.pcloudResult) throw e; // propagate pCloud errors (e.g. 2009 file not found)
    log('fetchThumb error', e.message);
    return null;
  }
}
