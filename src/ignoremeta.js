import { uploadJsonToFolder, downloadJsonFile, statByPath } from './pcloud.js';
import { getSharphoRoot } from './organize.js';
import { getCached, putCached, deleteOrphan } from './db.js';
import { removeMarker } from './map.js';
import { log } from './log.js';

const FILENAME   = 'ignored.json';
const FILEID_KEY = 'sharpho_ignored_fileid';

let _loaded  = false;
let _fileid  = null;
let _ignored = new Set(); // Set<number>

async function load() {
  if (_loaded) return;
  _loaded = true;
  let stored = localStorage.getItem(FILEID_KEY);
  if (!stored) {
    try {
      const meta = await statByPath('/Photos/ignored.json');
      _fileid = meta.fileid;
      localStorage.setItem(FILEID_KEY, String(_fileid));
      stored = String(_fileid);
    } catch {
      return;
    }
  }
  _fileid = Number(stored);
  try {
    const data = await downloadJsonFile(_fileid);
    for (const id of data.fileids ?? []) _ignored.add(Number(id));
    log('Ignored', `loaded ${_ignored.size} entries`);
  } catch (e) {
    log('Ignored', `load failed (${e.message}) — resetting`);
    _fileid = null;
    _ignored = new Set();
    localStorage.removeItem(FILEID_KEY);
  }
}

async function flush() {
  try {
    const rootFolderId = await getSharphoRoot();
    const jsonStr = JSON.stringify({ version: 1, fileids: [..._ignored] });
    const newFileid = await uploadJsonToFolder(rootFolderId, FILENAME, jsonStr, _fileid);
    _fileid = newFileid;
    if (newFileid) localStorage.setItem(FILEID_KEY, String(newFileid));
  } catch (e) {
    log('Ignored', `save failed: ${e.message}`);
  }
}

export async function setIgnoredEntry(fileid) {
  await load();
  _ignored.add(fileid);
  await flush();
}

export async function removeIgnoredEntry(fileid) {
  await load();
  if (!_ignored.has(fileid)) return;
  _ignored.delete(fileid);
  await flush();
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
  if (applied) log('Ignored', `applied ${applied} ignored flags from pCloud`);
}
