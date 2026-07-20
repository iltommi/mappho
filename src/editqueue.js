import { removeMarker, addMarker } from './map.js';
import { askRetry, askResume } from './confirm.js';
import { startBackgroundSync, updateBackgroundSync, stopBackgroundSync } from './backgroundsync.js';
import { flushPhotoIndex } from './photoindex.js';
import { log } from './log.js';

// pCloud doesn't throttle concurrent requests from one account (confirmed
// against another app doing 8 in parallel), and organize.js's shared
// name-picking state serializes itself internally (see withOrganizeLock
// there), so 2 concurrent download/modify/upload cycles is safe for any
// kind of edit that flows through here.
export const BULK_CONCURRENCY = 2;

// Drives a 0-100 progress bar through 3 stages (download/process/upload) for
// a single item's edit. Download and EXIF-rewrite have no byte-level
// progress of their own, so those two just jump to a checkpoint; only the
// upload leg (the one FileTransfer reports real progress for) animates
// within its 66-100 share. `getProgressFn` is an accessor, not the function
// itself, since some callers (geotag.js) rebind their progress function
// after this module has already been imported. `setBulkMode(true)`
// suppresses both — once a queue is processing more than one item at a
// time, a single item's own progress no longer means anything on its own,
// and the queue drives the bar itself as a queue-wide completed/total.
export function createStepProgress(getProgressFn) {
  let bulkMode = false;
  function setBulkMode(v) { bulkMode = v; }
  function setStep(step) {
    const fn = getProgressFn();
    if (!fn || bulkMode) return;
    if (step === 'download') fn(0);
    else if (step === 'process') fn(33);
    else if (step === 'upload')  fn(66);
  }
  async function withUploadProgress(fn2) {
    const fn = getProgressFn();
    if (!fn || bulkMode) return fn2(undefined);
    try {
      return await fn2((bytes, total) => fn(66 + (total ? (bytes / total) * 34 : 0)));
    } finally {
      fn(0);
    }
  }
  return { setStep, withUploadProgress, setBulkMode };
}

// A queue of same-kind edit batches (bulk geotag, bulk date-fix, a photo
// edit save, ...). Same-kind batches queue behind each other instead of
// racing; a *different* kind gets its own separate queue instance (see
// geotag.js/main.js/photoedit.js) so unrelated kinds still run concurrently
// — two different edit types sharing this one native background-sync
// service (via its own reference count) rather than one single global FIFO,
// which would make a quick single-photo edit wait behind an unrelated
// 50-photo bulk job.
//
// config:
//   storageKey       — localStorage key for this queue's own resume state
//   resumeLabel       — e.g. 'bulk geotag', fed to askResume(count, label)
//   notificationTitle, icon
//   verb(params), pastVerb(params) — status text; some kinds need
//     params-dependent wording (e.g. fix-date's shift vs fixed)
//   apply(photo, params) — the actual per-photo pCloud + organize work;
//     returns { oldFileid, newFileid, newName, newHash, ts, lat, lng }
//   resumeReconstruct(fileid) — re-derives a photo object (or null) from the
//     cache for a persisted fileid on resume; kind-specific since each kind
//     needs different fields and a different "is this still relevant" check
//     (e.g. geotag drops photos that got a location some other way since)
//   skipNoteFn(skippedCount) — optional; wording for a caller-side pre-filter
//     count (e.g. "already located, skipped"), default: no note
//   statusFn(), progressFn() — accessors for the shared status bar / top
//     progress bar, since these live in main.js and can't be imported here
//     directly without a circular import
//   bulkModeCtl — optional { setBulkMode } from createStepProgress, so this
//     queue can suppress the per-item progress bar while it drives the
//     aggregate one itself
export function createEditQueue(config) {
  const {
    storageKey, resumeLabel, notificationTitle, icon,
    verb, pastVerb, apply, resumeReconstruct,
    skipNoteFn = () => '',
    statusFn, progressFn,
    bulkModeCtl = null,
    // Builds before this shared engine existed persisted each kind's own
    // bespoke batch shape (geotag: bare {lat, lng, fileids}; fix-date: {mode,
    // params, fileids}) instead of this engine's uniform {params, fileids}.
    // Given a raw stored batch object, return the migrated `params` value if
    // it looks like one of those old shapes, or null if it's already
    // {params, fileids} (nothing to migrate). Optional — a kind with no
    // legacy shape to worry about (nothing shipped before this engine
    // existed) just omits it.
    legacyToParams = () => null,
  } = config;

  function save(batches) {
    try {
      if (batches.length) localStorage.setItem(storageKey, JSON.stringify(batches));
      else localStorage.removeItem(storageKey);
    } catch {}
  }
  function clear() {
    try { localStorage.removeItem(storageKey); } catch {}
  }
  function getPending() {
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed) return null;
      // Back-compat: an even older, pre-queue build stored one bare batch
      // object rather than an array of them.
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr.map(b => {
        const migrated = legacyToParams(b);
        return migrated ? { params: migrated, fileids: b.fileids } : b;
      });
    } catch { return null; }
  }
  function discardPending() { clear(); }

  const queue = []; // batches not yet started: { list, params, cb, skipped }
  let running = false;
  let current = null; // batch actively being processed: { params, remaining: Set<fileid> }
  let queueTotal = 0;     // grand total across every batch this session has seen
  let queueCompleted = 0; // grand total processed (any outcome) so far this session

  function persist() {
    const batches = [];
    if (current) batches.push({ params: current.params, fileids: [...current.remaining] });
    for (const b of queue) batches.push({ params: b.params, fileids: b.list.map(p => p.fileid) });
    save(batches);
  }

  // Queues a batch, starting the runner if it isn't already going. Joining
  // an already-running session updates the live status/progress/
  // notification immediately to include the addition, rather than waiting
  // for the next processed item to catch up.
  function enqueue(list, params, cb, skipped = 0) {
    queue.push({ list, params, cb, skipped });
    queueTotal += list.length;
    if (running) {
      persist();
      const v = verb(params);
      statusFn()?.(`${icon} ${v}… ${queueCompleted}/${queueTotal} (+${list.length} just added)`, 0);
      updateBackgroundSync(notificationTitle, `${v}… ${queueCompleted}/${queueTotal}`);
    } else {
      run();
    }
  }

  async function run() {
    running = true;
    // No visibility-pause here — the background-sync service below is what
    // makes it safe to keep going while hidden; pausing until the app comes
    // back to the foreground would defeat it. Awaited so the foreground
    // service (and its permission prompt, the first time) is fully up
    // before any work starts, not still racing a background tap.
    const protectedRun = await startBackgroundSync(notificationTitle, `Working… 0/${queueTotal}`);
    const bgNote = protectedRun ? '' : ' — keep Mappho open, background sync unavailable';
    try {
      while (queue.length) {
        const { list, params, cb, skipped } = queue.shift();
        await runBatch(list, params, cb, skipped, bgNote);
      }
    } finally {
      current = null;
      queueTotal = 0;
      queueCompleted = 0;
      clear();
      stopBackgroundSync();
      running = false;
    }
  }

  // Processes one queued batch to completion, including any retry rounds
  // the user asks for — the queue runner above only moves on to the next
  // batch once this fully settles.
  async function runBatch(initialList, params, cb, skipped, bgNote) {
    const v = verb(params), pv = pastVerb(params);
    let list = initialList;
    let totalOk = 0, totalStale = 0;
    const results = []; // { photo, result } for every item that ever succeeded, across retry rounds

    for (;;) {
      let ok = 0, staleCount = 0;
      const failedItems = [];
      current = { params, remaining: new Set(list.map(p => p.fileid)) };
      persist();

      bulkModeCtl?.setBulkMode(true);
      let nextIndex = 0;
      async function worker() {
        while (nextIndex < list.length) {
          const item = list[nextIndex++];
          log('Edit queue', item.name);
          try {
            const r = await apply(item, params);
            if (r.lat != null && r.newFileid !== r.oldFileid) {
              removeMarker(r.oldFileid);
              addMarker({ fileid: r.newFileid, name: r.newName, lat: r.lat, lng: r.lng, ts: r.ts });
            }
            results.push({ photo: item, result: r });
            ok++;
          } catch (e) {
            // A stale photo's record is already purged by apply() — it's
            // permanently gone, not a transient failure, so don't offer to
            // retry it: retrying the same dead fileid can only ever fail again.
            if (e.staleFile) { staleCount++; log('Edit queue', `${item.name}: no longer exists on pCloud — removed`); }
            else { failedItems.push(item); log('Edit queue error', `${item.name}: ${e.message}`); }
          }
          // Recorded as done regardless of outcome — a genuine failure is
          // already captured in failedItems for the retry prompt below, and
          // re-resuming it here too would just fail the exact same way again.
          queueCompleted++;
          current.remaining.delete(item.fileid);
          statusFn()?.(`${icon} ${v}… ${queueCompleted}/${queueTotal}${bgNote}`, 0);
          updateBackgroundSync(notificationTitle, `${v}… ${queueCompleted}/${queueTotal}`);
          progressFn()?.((queueCompleted / queueTotal) * 100);
          persist();
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, list.length) }, worker));
      } finally {
        bulkModeCtl?.setBulkMode(false);
        progressFn()?.(0);
      }
      flushPhotoIndex();

      totalOk += ok;
      totalStale += staleCount;
      const staleNote = totalStale > 0 ? ` (${totalStale} no longer existed, removed)` : '';
      // skipNote only ever reflects the original pre-filtered count — dropped
      // on a retry round, since a retry only ever reprocesses failedItems.
      const skipNote = skipNoteFn(skipped);
      skipped = 0;

      if (failedItems.length > 0) {
        statusFn()?.(`${icon} ${pv} ${totalOk}/${initialList.length} — ${failedItems.length} failed${staleNote}${skipNote}`, 0);
        const retry = await askRetry(failedItems.length, 'photo');
        if (retry) { list = failedItems; continue; }
        cb?.({ success: totalOk > 0, count: totalOk, failed: failedItems.length, stale: totalStale, skipped: 0, results });
        return;
      }
      statusFn()?.(`${icon} ${pv} ${totalOk} photo${totalOk !== 1 ? 's' : ''}${staleNote}${skipNote}`, totalStale > 0 ? 6000 : 4000);
      cb?.({ success: totalOk > 0, count: totalOk, failed: 0, stale: totalStale, skipped: 0, results });
      return;
    }
  }

  // Offered on next launch when the background-sync service didn't manage
  // to keep the app alive through the whole queue after all (OS memory
  // pressure can still win). Re-derives full photo objects for every
  // pending batch via resumeReconstruct rather than trying to
  // serialize/restore them directly, then re-queues whatever's left.
  // Returns false (and clears the stale entry either way) if there's
  // nothing left worth resuming.
  async function resume(callback) {
    const batches = getPending();
    clear();
    if (!batches?.length) return false;

    let queued = false;
    for (const { params, fileids } of batches) {
      if (!fileids?.length) continue;
      const photos = [];
      for (const fileid of fileids) {
        const photo = await resumeReconstruct(fileid);
        if (photo) photos.push(photo);
      }
      if (photos.length) { enqueue(photos, params, callback); queued = true; }
    }
    return queued;
  }

  // Called at every startup entry point — prompts to resume or discard any
  // interrupted work from a previous session, then acts on the answer.
  async function checkPendingResume(reloadFn) {
    const pending = getPending();
    const total = pending?.reduce((n, b) => n + (b.fileids?.length ?? 0), 0) ?? 0;
    if (!total) return;
    const doResume = await askResume(total, resumeLabel);
    if (!doResume) { discardPending(); return; }
    await resume(reloadFn);
  }

  return { enqueue, getPending, discardPending, resume, checkPendingResume };
}
