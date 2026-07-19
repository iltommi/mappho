import { registerPlugin } from '@capacitor/core';

// Native (Android-only) foreground service that keeps the app process alive
// while backgrounded — see BackgroundSyncService.java. A courtesy, not a
// requirement: every call is swallowed on failure (web dev server, iOS, or
// just a plugin call that fails for some reason) so a bulk operation always
// proceeds in the foreground-only fallback instead of erroring out.
const BackgroundSync = registerPlugin('BackgroundSync');

// Returns the promise (unlike update/stop) so a caller can await it before
// starting work that might otherwise race a user backgrounding the app
// mid-permission-dialog.
export function startBackgroundSync(title, body) {
  return BackgroundSync.start({ title, body }).catch(() => {});
}

export function updateBackgroundSync(title, body) {
  BackgroundSync.update({ title, body }).catch(() => {});
}

export function stopBackgroundSync() {
  BackgroundSync.stop().catch(() => {});
}
