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

let started = false;

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
// than silently doing nothing extra.
export function startBackgroundSync(title, body) {
  return withTimeout(BackgroundSync.start({ title, body }), 60000)
    .then(() => { started = true; log('BackgroundSync', 'started'); return true; })
    .catch(e => { started = false; log('BackgroundSync', `start failed: ${e.message}`); return false; });
}

export function updateBackgroundSync(title, body) {
  BackgroundSync.update({ title, body }).catch(e => log('BackgroundSync', `update failed: ${e.message}`));
}

export function stopBackgroundSync() {
  log('BackgroundSync', `stop (was ${started ? '' : 'not '}running)`);
  started = false;
  BackgroundSync.stop().catch(e => log('BackgroundSync', `stop failed: ${e.message}`));
}
