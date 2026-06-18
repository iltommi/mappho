import { log } from './log.js';

const INTERVAL_MS = 5 * 60 * 1000;
const _queue = new Map(); // key → upload fn

// Queues a pCloud upload for `key`. Replaces any previous pending upload for
// the same key so rapid changes collapse into a single upload.
export function scheduleUpload(key, fn) {
  _queue.set(key, fn);
}

// Runs all pending uploads. Keeps failed ones in the queue so they are retried
// on the next tick.
export async function flushAll() {
  if (!_queue.size) return;
  for (const [key, fn] of [..._queue.entries()]) {
    try {
      await fn();
      _queue.delete(key);
    } catch (e) {
      log('Sync', `${key} upload failed, will retry: ${e.message}`);
    }
  }
}

// Starts a background timer that flushes pending uploads every INTERVAL_MS.
export function startSyncTimer() {
  setInterval(() => flushAll().catch(e => log('Sync timer', e.message)), INTERVAL_MS);
}
