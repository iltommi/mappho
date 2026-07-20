import { registerPlugin } from '@capacitor/core';
import { log } from './log.js';

// Native (Android-only) foreground service that keeps the app process alive
// while backgrounded — see BackgroundSyncService.java. A courtesy, not a
// requirement: every call is swallowed on failure (web dev server, iOS, or
// just a plugin call that fails for some reason) so a bulk operation always
// proceeds in the foreground-only fallback instead of erroring out. Logged
// either way (visible in Settings → Debug log) since a silent failure here
// looks identical, from the loop's perspective, to it just not working.
const BackgroundSync = registerPlugin('BackgroundSync');

// Reference-counted: bulk geotag and bulk fix-date each have their own queue
// and can be running at once, both wanting this same one native service.
// Without a count, whichever finished first would call stop() and tear the
// service down out from under the other — the exact bug two concurrent
// geotag batches had before they got a shared queue, just one level up.
let refCount = 0;

// Generous — start() legitimately waits on a user-answered permission dialog
// the first time, which has no fixed upper bound. This is only a backstop
// against the native call hanging outright, so the bulk loop it's awaited
// from can't get stuck forever before it even begins.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

// Returns a boolean (unlike update/stop) so a caller can await it before
// starting work that might otherwise race a user backgrounding the app
// mid-permission-dialog, and — since this is the courtesy, not the actual
// bulk work — reflect in its own UI whether it's actually protected rather
// than silently doing nothing extra. Only the first caller (refCount 0 -> 1)
// actually starts the native service; anyone joining an already-running
// session just gets its notification text updated instead.
export function startBackgroundSync(title, body) {
  refCount++;
  if (refCount > 1) {
    updateBackgroundSync(title, body);
    return Promise.resolve(true);
  }
  return withTimeout(BackgroundSync.start({ title, body }), 60000)
    .then(() => { log('BackgroundSync', 'started'); return true; })
    .catch(e => { log('BackgroundSync', `start failed: ${e.message}`); return false; });
}

export function updateBackgroundSync(title, body) {
  BackgroundSync.update({ title, body }).catch(e => log('BackgroundSync', `update failed: ${e.message}`));
}

// Only actually stops the service once every caller that started it has
// also stopped — see refCount above.
export function stopBackgroundSync() {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) {
    log('BackgroundSync', `release (${refCount} other session${refCount === 1 ? '' : 's'} still running)`);
    return;
  }
  log('BackgroundSync', 'stop');
  BackgroundSync.stop().catch(e => log('BackgroundSync', `stop failed: ${e.message}`));
}
