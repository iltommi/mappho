import { uploadJsonToFolder, downloadJsonFile, statByPath } from './pcloud.js';
import { getMapphoRoot } from './organize.js';
import { getCached, putCached, deleteOrphan } from './db.js';
import { addMarker } from './map.js';
import { scheduleUpload } from './syncmanager.js';
import { log } from './log.js';

const FILENAME    = 'mappho-video-meta.json';
const FILEID_KEY  = 'mappho_video_meta_fileid';
const CONTENT_KEY = 'mappho_videometa_content'; // mirrors JSON content locally

let _loaded  = false;
let _fileid  = null;
let _entries = new Map(); // string(fileid) → { lat, lng, ts }

async function load() {
  if (_loaded) return;
  _loaded = true;

  // Fast path: content cached locally — no network needed
  const local = localStorage.getItem(CONTENT_KEY);
  if (local) {
    try {
      const data = JSON.parse(local);
      for (const [id, entry] of Object.entries(data.entries ?? {})) _entries.set(id, entry);
      const fid = localStorage.getItem(FILEID_KEY);
      if (fid) _fileid = Number(fid);
      log('VideoMeta', `loaded ${_entries.size} entries from local cache`);
      return;
    } catch { localStorage.removeItem(CONTENT_KEY); }
  }

  // Download from pCloud
  let stored = localStorage.getItem(FILEID_KEY);
  if (!stored) {
    try {
      const meta = await statByPath('/Photos/mappho-video-meta.json');
      _fileid = meta.fileid;
      localStorage.setItem(FILEID_KEY, String(_fileid));
      stored = String(_fileid);
    } catch { return; }
  }
  _fileid = Number(stored);
  try {
    const data = await downloadJsonFile(_fileid);
    for (const [id, entry] of Object.entries(data.entries ?? {})) _entries.set(id, entry);
    localStorage.setItem(CONTENT_KEY, JSON.stringify({ version: 1, entries: Object.fromEntries(_entries) }));
    log('VideoMeta', `loaded ${_entries.size} entries from pCloud`);
  } catch (e) {
    log('VideoMeta', `load failed (${e.message}) — resetting`);
    _fileid = null; _entries = new Map();
    localStorage.removeItem(FILEID_KEY);
    localStorage.removeItem(CONTENT_KEY);
  }
}

async function doUpload() {
  const rootFolderId = await getMapphoRoot();
  const jsonStr = JSON.stringify({ version: 1, entries: Object.fromEntries(_entries) });
  const newFileid = await uploadJsonToFolder(rootFolderId, FILENAME, jsonStr, _fileid);
  _fileid = newFileid;
  if (newFileid) localStorage.setItem(FILEID_KEY, String(newFileid));
  log('VideoMeta', `uploaded ${_entries.size} entries`);
}

function flush() {
  // Mirror to localStorage immediately so the next session loads without network
  localStorage.setItem(CONTENT_KEY, JSON.stringify({ version: 1, entries: Object.fromEntries(_entries) }));
  // Schedule pCloud upload — batched by syncmanager
  scheduleUpload('videometa', doUpload);
}

export async function setVideoMetaEntry(fileid, { lat, lng, ts }) {
  await load();
  _entries.set(String(fileid), { lat, lng, ts });
  flush();
}

export async function removeVideoMetaEntry(fileid) {
  await load();
  if (!_entries.has(String(fileid))) return;
  _entries.delete(String(fileid));
  flush();
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
  if (applied) log('VideoMeta', `applied ${applied} GPS entries from local cache`);
}
