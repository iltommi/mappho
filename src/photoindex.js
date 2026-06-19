import { uploadJsonToFolder, downloadJsonFile, statByPath } from './pcloud.js';
import { getSharphoRoot } from './organize.js';
import { getAllCached, bulkPutCached } from './db.js';
import { scheduleUpload } from './syncmanager.js';
import { log } from './log.js';

const FILENAME   = 'index.json';
const FILEID_KEY = 'mappho_photo_index_fileid';

let _fileid = null;

function storedFileid() {
  if (_fileid) return _fileid;
  const s = localStorage.getItem(FILEID_KEY);
  if (s) _fileid = Number(s);
  return _fileid;
}

// Schedules a pCloud upload of all non-ignored cache entries.
// The upload runs on the next syncmanager tick or when flushAll() is called.
export function flushPhotoIndex(rootFolderId = null) {
  scheduleUpload('photoindex', async () => {
    const folderId = rootFolderId ?? await getSharphoRoot();
    const all = await getAllCached();
    const entries = all
      .filter(r => !r.ignored)
      .map(({ fileid, name, lat, lng, ts, hash }) => ({ fileid, name, lat, lng, ts, hash }));
    const json = JSON.stringify({ version: 1, entries });
    const newId = await uploadJsonToFolder(folderId, FILENAME, json, storedFileid());
    _fileid = newId;
    if (newId) localStorage.setItem(FILEID_KEY, String(newId));
    log('PhotoIndex', `saved ${entries.length} entries`);
  });
}

// Downloads Photos/index.json and bulk-inserts into IDB.
// Only called when the local cache is empty (fresh install / cache cleared).
// Returns the number of entries loaded, or 0 if unavailable.
export async function loadPhotoIndex() {
  let fid = storedFileid();
  if (!fid) {
    try {
      const meta = await statByPath('/Photos/index.json');
      _fileid = meta.fileid;
      localStorage.setItem(FILEID_KEY, String(_fileid));
      fid = _fileid;
    } catch {
      return 0;
    }
  }
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
