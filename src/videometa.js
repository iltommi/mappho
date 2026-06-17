import { uploadJsonToFolder, downloadJsonFile } from './pcloud.js';
import { getSharphoRoot } from './organize.js';
import { getCached, putCached, deleteOrphan } from './db.js';
import { addMarker } from './map.js';
import { log } from './log.js';

const FILENAME      = 'sharpho-video-meta.json';
const FILEID_KEY    = 'sharpho_video_meta_fileid';

let _loaded   = false;
let _fileid   = null;             // pCloud fileid of the meta file (null = not yet uploaded)
let _entries  = new Map();        // string(fileid) → { lat, lng, ts }

async function load() {
  if (_loaded) return;
  _loaded = true;
  const stored = localStorage.getItem(FILEID_KEY);
  if (!stored) return;
  _fileid = Number(stored);
  try {
    const data = await downloadJsonFile(_fileid);
    for (const [id, entry] of Object.entries(data.entries ?? {})) {
      _entries.set(id, entry);
    }
    log('VideoMeta', `loaded ${_entries.size} entries`);
  } catch (e) {
    log('VideoMeta', `load failed (${e.message}) — resetting`);
    _fileid = null;
    _entries = new Map();
    localStorage.removeItem(FILEID_KEY);
  }
}

async function flush() {
  try {
    const rootFolderId = await getSharphoRoot();
    const jsonStr = JSON.stringify({ version: 1, entries: Object.fromEntries(_entries) });
    const newFileid = await uploadJsonToFolder(rootFolderId, FILENAME, jsonStr, _fileid);
    _fileid = newFileid;
    if (newFileid) localStorage.setItem(FILEID_KEY, String(newFileid));
  } catch (e) {
    log('VideoMeta', `save failed: ${e.message}`);
  }
}

export async function setVideoMetaEntry(fileid, { lat, lng, ts }) {
  await load();
  _entries.set(String(fileid), { lat, lng, ts });
  await flush();
}

export async function removeVideoMetaEntry(fileid) {
  await load();
  if (!_entries.has(String(fileid))) return;
  _entries.delete(String(fileid));
  await flush();
}

// Applies stored GPS to any cache records that still have lat==null.
// Called on startup and after each scan so manually-tagged videos
// survive cache reloads without a full backup/restore.
export async function applyVideoMeta() {
  await load();
  if (!_entries.size) return;
  let applied = 0;
  for (const [idStr, { lat, lng, ts }] of _entries) {
    const fileid = Number(idStr);
    const cached = await getCached(fileid);
    if (!cached || cached.lat != null) continue;
    const updated = { ...cached, lat, lng, ts: ts ?? cached.ts };
    await putCached(updated);
    await deleteOrphan(fileid);
    addMarker(updated);
    applied++;
  }
  if (applied) log('VideoMeta', `applied ${applied} GPS entries from pCloud`);
}
