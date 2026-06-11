import { getToken, getApiHost } from './auth.js';
import { log } from './log.js';
import { PROXY_URL } from './config.js';

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
    const fid = queue.shift();
    let data;
    try {
      data = await api('listfolder', { folderid: fid });
    } catch (e) {
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

// Fetches the first `bytes` of a file via getfilelink + CDN Range request.
// Routes through the Cloudflare Worker proxy to bypass pCloud's browser-origin block.
export async function fetchFileHead(fileid, bytes = 131072) {
  if (!PROXY_URL) throw new Error('PROXY_URL not configured — see src/config.js');

  // Step 1: get a CDN download link via proxy
  const linkUrl = new URL(`${PROXY_URL}/getfilelink`);
  linkUrl.searchParams.set('auth_token', getToken());
  linkUrl.searchParams.set('fileid', fileid);
  const linkResp = await fetch(linkUrl);
  if (!linkResp.ok) throw new Error(`getfilelink HTTP ${linkResp.status}`);
  const linkData = await linkResp.json();
  if (linkData.result !== 0) throw new Error(`pCloud ${linkData.result}: ${linkData.error}`);

  const cdnUrl = `https://${linkData.hosts[0]}${linkData.path}`;

  // Step 2: download first `bytes` via proxy with Range header
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
