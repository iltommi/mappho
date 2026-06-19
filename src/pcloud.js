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

export async function folderExists(folderid) {
  try {
    await api('stat', { folderid });
    return true;
  } catch {
    return false;
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

export async function getPublicLink(fileid) {
  const data = await api('getfilepublink', { fileid });
  return data.link;
}

const _dimCache = new Map();
const _fileParentCache = new Map();
const _folderNameCache   = new Map(); // folderid → name
const _folderParentCache = new Map(); // folderid → parentfolderid

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

export async function getFileDimensions(fileid) {
  if (_dimCache.has(fileid)) return _dimCache.get(fileid);
  try {
    const meta = await getFileStat(fileid);
    const dim = (meta.width && meta.height) ? { w: meta.width, h: meta.height } : null;
    _dimCache.set(fileid, dim);
    if (!_fileParentCache.has(fileid)) _fileParentCache.set(fileid, meta.parentfolderid ?? null);
    return dim;
  } catch {
    _dimCache.set(fileid, null);
    return null;
  }
}

// Returns the parent folder name for display. Photos inside Photos/YYYY/MM
// return '' — the filename already encodes the date. Everything else returns
// the immediate parent folder name.
export async function getFileFolderName(fileid) {
  if (!_fileParentCache.has(fileid)) {
    try {
      const meta = await getFileStat(fileid);
      _fileParentCache.set(fileid, meta.parentfolderid ?? null);
      if (!_dimCache.has(fileid)) {
        _dimCache.set(fileid, (meta.width && meta.height) ? { w: meta.width, h: meta.height } : null);
      }
    } catch {
      _fileParentCache.set(fileid, null);
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
  const bytes = new Uint8Array(arrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  const b64 = btoa(bin);
  const boundary = 'MapphoUpload' + crypto.randomUUID().replace(/-/g, '');
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
  await deleteFile(fileid);
  return uploadFile(parentfolderid, name, arrayBuffer);
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

export async function downloadJsonFile(fileid) {
  const link = await api('getfilelink', { fileid });
  const host = link.hosts?.[0];
  if (!host) throw new Error('pCloud getfilelink: no CDN host');
  const resp = await CapacitorHttp.request({
    method: 'GET',
    url: `https://${host}${link.path}`,
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
    if (typeof raw === 'object' && raw.result !== undefined) {
      const err = new Error(`pCloud ${raw.result}: ${raw.error ?? 'unknown error'}`);
      err.pcloudResult = raw.result;
      throw err;
    }
    const b64 = (typeof raw === 'string' ? raw : btoa(String.fromCharCode(...new Uint8Array(raw)))).replace(/\s/g, '');
    return `data:image/jpeg;base64,${b64}`;
  } catch (e) {
    if (e.pcloudResult) throw e; // propagate pCloud errors (e.g. 2009 file not found)
    log('fetchThumb error', e.message);
    return null;
  }
}
