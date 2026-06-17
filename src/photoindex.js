import { uploadJsonToFolder, downloadJsonFile } from './pcloud.js';
import { isHashOrganized, normHash } from './organize.js';
import { getAllCached, bulkPutCached } from './db.js';
import { log } from './log.js';

const FILENAME   = 'index.json';
const FILEID_KEY = 'sharpho_photo_index_fileid';

let _fileid = null;

function storedFileid() {
  if (_fileid) return _fileid;
  const s = localStorage.getItem(FILEID_KEY);
  if (s) _fileid = Number(s);
  return _fileid;
}

// Saves all organized, non-ignored cache entries to Photos/index.json.
// Called fire-and-forget at the end of every scan and rebuild.
export async function flushPhotoIndex(rootFolderId) {
  try {
    const all = await getAllCached();
    const entries = all
      .filter(r => !r.ignored && r.hash != null && isHashOrganized(normHash(r.hash)))
      .map(({ fileid, name, lat, lng, ts, hash }) => ({ fileid, name, lat, lng, ts, hash }));
    const json = JSON.stringify({ version: 1, entries });
    const newId = await uploadJsonToFolder(rootFolderId, FILENAME, json, storedFileid());
    _fileid = newId;
    if (newId) localStorage.setItem(FILEID_KEY, String(newId));
    log('PhotoIndex', `saved ${entries.length} entries`);
  } catch (e) {
    log('PhotoIndex', `save failed: ${e.message}`);
  }
}

// Downloads Photos/index.json and bulk-inserts into IDB.
// Only called when the local cache is empty (fresh install / cache cleared).
// Returns the number of entries loaded, or 0 if unavailable.
export async function loadPhotoIndex() {
  const fid = storedFileid();
  if (!fid) return 0;
  try {
    const data = await downloadJsonFile(fid);
    if (!Array.isArray(data?.entries) || !data.entries.length) return 0;
    await bulkPutCached(data.entries);
    log('PhotoIndex', `loaded ${data.entries.length} entries`);
    return data.entries.length;
  } catch (e) {
    log('PhotoIndex', `load failed: ${e.message}`);
    return 0;
  }
}
