import { getToken, getApiHost } from './auth.js';
import { log } from './log.js';

async function api(endpoint, params = {}) {
  const url = new URL(`${getApiHost()}/${endpoint}`);
  url.searchParams.set('auth_token', getToken());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

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
    const folderid = queue.shift();
    let data;
    try {
      data = await api('listfolder', { folderid });
    } catch (e) {
      console.warn('listfolder failed for', folderid, e);
      continue;
    }
    for (const item of data.metadata.contents ?? []) {
      if (item.isfolder) {
        queue.push(item.folderid);
      } else if (/\.(jpe?g)$/i.test(item.name)) {
        log('file metadata', item);
        yield item;
      }
    }
  }
}

// Fetches the first `bytes` of a file via pCloud's file streaming API.
// Avoids getfilelink (which is blocked by pCloud's referer check from browser).
export async function fetchFileHead(fileid, bytes = 131072) {
  const openData = await api('file_open', { flags: 0, fileid });
  const fd = openData.fd;
  log('file_open', { fd, fileid });

  try {
    const url = new URL(`${getApiHost()}/file_pread`);
    url.searchParams.set('auth_token', getToken());
    url.searchParams.set('fd', fd);
    url.searchParams.set('count', bytes);
    url.searchParams.set('offset', 0);

    const resp = await fetch(url, { referrerPolicy: 'no-referrer' });
    log('file_pread', { status: resp.status, contentType: resp.headers.get('content-type') });
    if (!resp.ok) throw new Error(`file_pread failed: ${resp.status}`);
    return resp.arrayBuffer();
  } finally {
    api('file_close', { fd }).catch(() => {});
  }
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
