import { uploadJsonToFolder, downloadJsonFile, statByPath } from './pcloud.js';
import { getSharphoRoot } from './organize.js';
import { getCached, putCached, deleteOrphan } from './db.js';
import { removeMarker } from './map.js';
import { scheduleUpload } from './syncmanager.js';
import { log } from './log.js';

const FILENAME    = 'ignored.json';
const FILEID_KEY  = 'sharpho_ignored_fileid';
const CONTENT_KEY = 'sharpho_ignored_content'; // mirrors JSON content locally

let _loaded  = false;
let _fileid  = null;
let _ignored = new Set(); // Set<number>

async function load() {
  if (_loaded) return;
  _loaded = true;

  // Fast path: content cached locally — no network needed
  const local = localStorage.getItem(CONTENT_KEY);
  if (local) {
    try {
      const data = JSON.parse(local);
      for (const id of data.fileids ?? []) _ignored.add(Number(id));
      const fid = localStorage.getItem(FILEID_KEY);
      if (fid) _fileid = Number(fid);
      log('Ignored', `loaded ${_ignored.size} entries from local cache`);
      return;
    } catch { localStorage.removeItem(CONTENT_KEY); }
  }

  // Download from pCloud
  let stored = localStorage.getItem(FILEID_KEY);
  if (!stored) {
    try {
      const meta = await statByPath('/Photos/ignored.json');
      _fileid = meta.fileid;
      localStorage.setItem(FILEID_KEY, String(_fileid));
      stored = String(_fileid);
    } catch { return; }
  }
  _fileid = Number(stored);
  try {
    const data = await downloadJsonFile(_fileid);
    for (const id of data.fileids ?? []) _ignored.add(Number(id));
    localStorage.setItem(CONTENT_KEY, JSON.stringify({ version: 1, fileids: [..._ignored] }));
    log('Ignored', `loaded ${_ignored.size} entries from pCloud`);
  } catch (e) {
    log('Ignored', `load failed (${e.message}) — resetting`);
    _fileid = null; _ignored = new Set();
    localStorage.removeItem(FILEID_KEY);
    localStorage.removeItem(CONTENT_KEY);
  }
}

async function doUpload() {
  const rootFolderId = await getSharphoRoot();
  const jsonStr = JSON.stringify({ version: 1, fileids: [..._ignored] });
  const newFileid = await uploadJsonToFolder(rootFolderId, FILENAME, jsonStr, _fileid);
  _fileid = newFileid;
  if (newFileid) localStorage.setItem(FILEID_KEY, String(newFileid));
  log('Ignored', `uploaded ${_ignored.size} entries`);
}

function flush() {
  // Mirror to localStorage immediately so the next session loads without network
  localStorage.setItem(CONTENT_KEY, JSON.stringify({ version: 1, fileids: [..._ignored] }));
  // Schedule pCloud upload — batched by syncmanager
  scheduleUpload('ignored', doUpload);
}

export async function setIgnoredEntry(fileid) {
  await load();
  _ignored.add(fileid);
  flush();
}

export async function removeIgnoredEntry(fileid) {
  await load();
  if (!_ignored.has(fileid)) return;
  _ignored.delete(fileid);
  flush();
}

// Re-applies ignored flags to any cache records that lost them (e.g. after
// a cache rebuild). Called on startup and after every scan/rebuild.
export async function applyIgnored() {
  await load();
  if (!_ignored.size) return;
  let applied = 0;
  for (const fileid of _ignored) {
    const cached = await getCached(fileid);
    if (!cached || cached.ignored) continue;
    await putCached({ ...cached, ignored: 1 });
    await deleteOrphan(fileid);
    removeMarker(fileid);
    applied++;
  }
  if (applied) log('Ignored', `applied ${applied} ignored flags from local cache`);
}
