import { registerPlugin } from '@capacitor/core';
import { base64ToArrayBuffer } from './pcloud.js';
import { extractEXIF } from './exif.js';
import { importNewFile, flushOrganizeIndex } from './organize.js';
import { putCached, putOrphan } from './db.js';
import { addMarker } from './map.js';
import { flushPhotoIndex } from './photoindex.js';
import { startBackgroundSync, updateBackgroundSync, stopBackgroundSync } from './backgroundsync.js';
import { BULK_CONCURRENCY } from './editqueue.js';
import { log } from './log.js';

// Native (Android-only) bridge to MediaExchangePlugin.java's share-receiving
// side — see that plugin's own comments. Mappho is registered as an
// ACTION_SEND/ACTION_SEND_MULTIPLE target for image/*, so another app's
// share sheet (Gallery, Files, ...) can hand photos to Mappho the same way
// it would hand them to any other app.
const MediaExchange = registerPlugin('MediaExchange');

// Unlike bulk geotag/fix-date/photo-edit/external-edit, this deliberately
// does NOT go through editqueue.js: that engine's resume-after-kill is keyed
// on re-deriving an existing photo from the cache by fileid, which doesn't
// fit "resume an upload that never got a fileid because we hadn't uploaded
// it yet." Import is not resumable across an app kill — the shared bytes
// only ever live in JS memory here, and a share-import is typically small/
// fast next to a bulk geotag run, so a second, differently-shaped resume
// mechanism isn't worth building for it. It does still reuse
// backgroundsync.js directly (a generic, reference-counted module regardless
// of shape) so a multi-photo share survives being backgrounded mid-upload.

async function importOnePhoto(item) {
  const { buf, filename } = item;
  const exif = await extractEXIF(buf, null, filename);
  const hasGps = exif.lat != null;
  const ts = (exif.ts && exif.ts > 0) ? exif.ts : null;

  const { fileid, name, hash } = await importNewFile({ buf, filename, ts });

  // Matches the exact record shape a normal scan builds (main.js's
  // processFile) — ts: null (not UNDATED_TS) for the cache; putOrphan
  // applies its own UNDATED_TS fallback internally.
  const record = {
    fileid, name,
    lat: hasGps ? exif.lat : null,
    lng: hasGps ? exif.lng : null,
    ts: ts ?? null,
    hash: hash ?? null,
    rotation: null,
  };
  await putCached(record);
  if (hasGps) addMarker(record);
  else await putOrphan(record);
  return record;
}

// items: [{ buf: ArrayBuffer, filename: string }]. `onDone` receives
// { success, count, failed } once every item has settled (no retry-round
// concept here, unlike editqueue.js — a failed import is just reported;
// re-sharing the photo is the retry).
export async function importSharedPhotos(items, onDone) {
  if (!items.length) { onDone?.({ success: false, count: 0, failed: 0 }); return; }

  const protectedRun = await startBackgroundSync('Mappho — importing', `Importing… 0/${items.length}`);
  const bgNote = protectedRun ? '' : ' — keep Mappho open, background sync unavailable';

  let ok = 0, failed = 0, done = 0;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      log('Import', item.filename);
      try {
        await importOnePhoto(item);
        ok++;
      } catch (e) {
        failed++;
        log('Import error', `${item.filename}: ${e.message}`);
      }
      done++;
      updateBackgroundSync('Mappho — importing', `Importing… ${done}/${items.length}${bgNote}`);
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, items.length) }, worker));
  } finally {
    flushOrganizeIndex();
    flushPhotoIndex();
    stopBackgroundSync();
  }
  onDone?.({ success: ok > 0, count: ok, failed });
}

// Pulls whatever photo(s) were shared into Mappho — via the OS share sheet,
// received natively before this ever runs (see MediaExchangePlugin's
// handleOnNewIntent) — and imports them. Called once at startup, *after*
// startScan so organize.js's hash index/_takenNames are already loaded
// (importNewFile needs that same readiness ensureInPhotos already guards
// on), and again whenever the plugin's 'shareReceived' event fires while
// already running.
export async function checkPendingShare(onDone) {
  const result = await MediaExchange.getPendingShare().catch(() => null);
  const items = result?.items;
  if (!items?.length) return;
  const decoded = items.map(({ base64Data, filename }) => ({ buf: base64ToArrayBuffer(base64Data), filename }));
  await importSharedPhotos(decoded, onDone);
}

// Same "swallow, don't throw" contract as every other native-plugin call in
// backgroundsync.js — addListener rejects outright (an unhandled rejection,
// not just a resolved-with-error) if MediaExchange isn't implemented on this
// platform, which is never true on a real Android build but is true for the
// web dev server this app is also previewed in.
export function listenForShares(onDone) {
  MediaExchange.addListener('shareReceived', () => { checkPendingShare(onDone); })
    .catch(e => log('Import', `listenForShares unavailable: ${e.message}`));
}
