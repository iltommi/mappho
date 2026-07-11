// Maintains Photos/mappho-flags.json — a small, user-curated list of photos
// flagged from the slideshow as "has people, but wasn't tagged" (missed
// entirely, or under-detected) for the external face-recognition tool to
// pick up on its next run. Mappho only ever adds/removes entries the user
// explicitly toggles; it never reads facetag's own detections to decide
// what's flagged.
//
// Keyed by pCloud content hash rather than fileid, matching faces.json's
// identity model, and kept in sync with it: organize.js calls
// renameFlagEntry/removeFlagEntry from the same edit/delete hooks it already
// calls renameFacesEntry/removeFacesEntry from, so a flag survives a geotag
// or fix-date on the flagged photo instead of silently pointing at a
// deleted fileid.
import { statByPath, downloadJsonFile, uploadJsonToFolder, getFileStat } from './pcloud.js';
import { scheduleUpload } from './syncmanager.js';
import { log } from './log.js';
import { getMapphoRoot } from './organize.js';

const REMOTE_PATH     = '/Photos/mappho-flags.json';
const FILENAME        = 'mappho-flags.json';
const FILEID_KEY      = 'mappho_flags_fileid';
const CONTENT_KEY     = 'mappho_flags_content';   // mirrors JSON content locally
const REMOTE_HASH_KEY = 'mappho_flags_remotehash'; // pCloud hash of the last synced remote copy
const DIRTY_KEY       = 'mappho_flags_dirty';

let _loaded  = false;
let _loading = null;
let _entries = new Map(); // hash -> { name, path, flaggedAt }

function normHash(h) {
  if (h == null) return null;
  const n = Number(h);
  return Number.isFinite(n) ? String(n) : String(h);
}

function readLocal() {
  try {
    const raw = localStorage.getItem(CONTENT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!Array.isArray(data?.entries)) return null;
    return data;
  } catch { return null; }
}

function applyEntries(list) {
  _entries = new Map();
  for (const e of list) {
    const hash = normHash(e.hash);
    if (hash) _entries.set(hash, { name: e.name ?? null, path: e.path ?? null, flaggedAt: e.flaggedAt ?? null });
  }
}

function persistLocal() {
  const entries = [..._entries.entries()].map(([hash, e]) => ({ hash, ...e }));
  localStorage.setItem(CONTENT_KEY, JSON.stringify({ version: 1, entries }));
}

async function replaceFromRemote(stat) {
  const data = await downloadJsonFile(stat.fileid);
  if (!Array.isArray(data?.entries)) throw new Error('malformed mappho-flags.json');
  applyEntries(data.entries);
  persistLocal();
  localStorage.setItem(FILEID_KEY, String(stat.fileid));
  localStorage.setItem(REMOTE_HASH_KEY, String(stat.hash ?? ''));
  localStorage.removeItem(DIRTY_KEY);
  log('Flags', `loaded ${_entries.size} entries`);
}

function load() {
  if (_loaded) return Promise.resolve();
  if (!_loading) {
    _loading = (async () => {
      try {
        const local = readLocal();
        if (local) {
          applyEntries(local.entries);
          const fid = localStorage.getItem(FILEID_KEY);
          if (fid) log('Flags', `using local mirror — ${_entries.size} entries`);
          return;
        }
        const stat = await statByPath(REMOTE_PATH);
        await replaceFromRemote(stat);
      } catch (e) {
        log('Flags', `not available yet: ${e.message}`);
      } finally {
        _loaded = true;
        _loading = null;
      }
    })();
  }
  return _loading;
}

// Startup/resume sync — same "adopt the remote if it changed" policy as
// faces.js, in case facetag itself prunes entries it has processed.
export async function refreshFlags() {
  if (_loading) await _loading;
  _loading = (async () => {
    let stat = null;
    try { stat = await statByPath(REMOTE_PATH); } catch { return; }
    try {
      const known = localStorage.getItem(REMOTE_HASH_KEY);
      if (String(stat.hash ?? '') !== known) {
        await replaceFromRemote(stat);
      } else {
        localStorage.setItem(FILEID_KEY, String(stat.fileid));
        if (localStorage.getItem(DIRTY_KEY)) flush();
      }
    } catch (e) {
      log('Flags', `refresh failed: ${e.message}`);
    }
  })();
  try { await _loading; } finally { _loaded = true; _loading = null; }
}

function markDirty() {
  localStorage.setItem(DIRTY_KEY, '1');
  flush();
}

function flush() {
  if (!localStorage.getItem(DIRTY_KEY)) return;
  scheduleUpload('flags', doUpload);
}

async function doUpload() {
  let stat = null;
  try { stat = await statByPath(REMOTE_PATH); } catch {}
  const known = localStorage.getItem(REMOTE_HASH_KEY);
  if (stat && known && String(stat.hash ?? '') !== known) {
    log('Flags', 'remote changed since last sync — adopting it instead of uploading');
    await replaceFromRemote(stat);
    return;
  }
  persistLocal();
  const entries = [..._entries.entries()].map(([hash, e]) => ({ hash, ...e }));
  const json = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries });
  const folderId = stat?.parentfolderid ?? (await getMapphoRoot());
  const prevFileid = stat?.fileid ?? (Number(localStorage.getItem(FILEID_KEY)) || null);
  const newFileid = await uploadJsonToFolder(folderId, FILENAME, json, prevFileid);
  if (newFileid) {
    localStorage.setItem(FILEID_KEY, String(newFileid));
    const { hash } = await getFileStat(newFileid).catch(() => ({}));
    localStorage.setItem(REMOTE_HASH_KEY, String(hash ?? ''));
  }
  localStorage.removeItem(DIRTY_KEY);
  log('Flags', `uploaded ${entries.length} entries`);
}

export async function isFlagged(hash) {
  await load();
  const key = normHash(hash);
  return key ? _entries.has(key) : false;
}

// Toggles the flag for a photo. Returns the new flagged state.
export async function toggleFlag({ hash, name, path }) {
  await load();
  const key = normHash(hash);
  if (!key) return false;
  const nowFlagged = !_entries.has(key);
  if (nowFlagged) _entries.set(key, { name: name ?? null, path: path ?? null, flaggedAt: new Date().toISOString() });
  else _entries.delete(key);
  markDirty();
  log('Flags', `${nowFlagged ? 'flagged' : 'unflagged'} ${name ?? key}`);
  return nowFlagged;
}

// Re-keys a flag after an edit changed the photo's content hash and/or name —
// called from organize.js alongside renameFacesEntry.
export async function renameFlagEntry(oldHash, { newHash = null, name = null, path = null } = {}) {
  await load();
  const key = normHash(oldHash);
  if (!key) return;
  const entry = _entries.get(key);
  if (!entry) return;
  const newKey = normHash(newHash) ?? key;
  const updated = { name: name ?? entry.name, path: path ?? entry.path, flaggedAt: entry.flaggedAt };
  if (newKey !== key) _entries.delete(key);
  _entries.set(newKey, updated);
  markDirty();
}

// Drops a flag when its photo is deleted — called from organize.js alongside
// removeFacesEntry.
export async function removeFlagEntry(hash) {
  await load();
  const key = normHash(hash);
  if (!key || !_entries.has(key)) return;
  _entries.delete(key);
  markDirty();
}
