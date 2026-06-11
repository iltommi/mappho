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
        yield item;
      }
    }
  }
}

// Fetches the first `bytes` of a file (enough for EXIF) via a Range request.
export async function fetchFileHead(fileid, bytes = 131072) {
  const data = await api('getfilelink', { fileid });
  const downloadUrl = `https://${data.hosts[0]}${data.path}`;
  const resp = await fetch(downloadUrl, {
    headers: { Range: `bytes=0-${bytes - 1}` },
    referrerPolicy: 'no-referrer',
  });
  log('fetchFileHead', { status: resp.status, url: downloadUrl.split('?')[0] });
  if (!resp.ok && resp.status !== 206) throw new Error(`Download failed: ${resp.status}`);
  return resp.arrayBuffer();
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
