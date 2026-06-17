import { fetchThumbSrc, deleteFile } from './pcloud.js';
import { isVideo } from './mp4.js';
import { openLazySlideshow, setCloseHandler } from './slideshow.js';
import { startBulkGeotagging } from './geotag.js';
import { deleteRecord, deleteOrphan } from './db.js';
import { removeMarker } from './map.js';
import { removeVideoMetaEntry } from './videometa.js';
import { removeOrganizedEntry } from './organize.js';
import { removeIgnoredEntry } from './ignoremeta.js';
import { log } from './log.js';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';

const el         = document.getElementById('grid-view');
const closeBtn   = document.getElementById('grid-close');
const countEl    = document.getElementById('grid-count');
const selectBtn  = document.getElementById('grid-select-btn');
const track      = document.getElementById('grid-track');
const sentinel   = document.getElementById('grid-sentinel');
const scrollEl   = document.getElementById('grid-scroll');
const bulkBar    = document.getElementById('grid-bulk-bar');
const bulkCountEl  = document.getElementById('grid-bulk-count');
const bulkGeotagBtn = document.getElementById('grid-bulk-geotag');
const bulkShareBtn  = document.getElementById('grid-bulk-share');
const bulkDeleteBtn = document.getElementById('grid-bulk-delete');
const bulkCancelBtn = document.getElementById('grid-bulk-cancel');

const PAGE_SIZE  = 60;
const THUMB_SIZE = '256x256';

let items       = [];
let fetchPageFn = null;
let total       = null;
let offset      = 0;
let done        = false;
let loadingPage = false;
let reopenFn    = null;

let pageObserver  = null;
let thumbObserver = null;

let selectMode = false;
const selected = new Set(); // indices into `items`

function close() {
  el.classList.remove('open');
  track.innerHTML = '';
  items       = [];
  fetchPageFn = null;
  reopenFn    = null;
  pageObserver?.disconnect();
  thumbObserver?.disconnect();
  exitSelectMode();
}
closeBtn.addEventListener('click', close);

function tileAt(index) {
  return track.children[index] ?? null;
}

function updateBulkBar() {
  bulkCountEl.textContent = `${selected.size} selected`;
  bulkGeotagBtn.disabled  = selected.size === 0;
  bulkShareBtn.disabled   = selected.size === 0;
  bulkDeleteBtn.disabled  = selected.size === 0;
}

function setSelectMode(on) {
  selectMode = on;
  selectBtn.classList.toggle('active', on);
  selectBtn.textContent = on ? '✕ Cancel select' : '☑ Select';
  bulkBar.style.display = on ? 'flex' : 'none';
  el.classList.toggle('select-mode', on);
  if (!on) {
    for (const idx of selected) tileAt(idx)?.classList.remove('selected');
    selected.clear();
    resetBulkDeleteBtn();
  }
  updateBulkBar();
}

function exitSelectMode() { setSelectMode(false); }

selectBtn.addEventListener('click', () => setSelectMode(!selectMode));
bulkCancelBtn.addEventListener('click', () => exitSelectMode());

bulkGeotagBtn.addEventListener('click', () => {
  if (!selected.size) return;
  const photos = [...selected].sort((a, b) => a - b).map(idx => items[idx]);
  const reopen = reopenFn;
  close();
  startBulkGeotagging(photos, ({ success, count, failed }) => {
    if (success) log('Bulk geotag', `tagged ${count}${failed ? `, ${failed} failed` : ''}`);
    reopen?.();
  });
});

bulkShareBtn.addEventListener('click', async () => {
  if (!selected.size) return;
  const all = [...selected].sort((a, b) => a - b).map(idx => items[idx]);
  const photos = all.filter(p => !isVideo(p.name));
  if (!photos.length) { log('Bulk share', 'no shareable (non-video) photos selected'); return; }

  bulkShareBtn.disabled = true;
  bulkShareBtn.textContent = '⏳';
  const writtenPaths = [];
  const uris = [];
  try {
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      bulkShareBtn.title = `Preparing ${i + 1}/${photos.length}…`;
      const src = await fetchThumbSrc(photo.fileid, '2048x2048');
      if (!src) { log('Bulk share', `${photo.name}: thumb fetch returned null`); continue; }
      const b64 = src.slice(src.indexOf(',') + 1);
      // Prefix with fileid — selected photos can share the same filename across folders.
      const path = `${photo.fileid}_${photo.name.replace(/\.heic$/i, '.jpg')}`;
      const written = await Filesystem.writeFile({ path, data: b64, directory: Directory.Cache });
      writtenPaths.push(path);
      uris.push(written.uri);
    }
    if (uris.length) {
      await Share.share({ files: uris, dialogTitle: `Share ${uris.length} photos` });
    }
  } catch (e) {
    if (e.name !== 'AbortError') log('Bulk share error', e.message ?? String(e));
  } finally {
    for (const path of writtenPaths) Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
    bulkShareBtn.disabled    = false;
    bulkShareBtn.textContent = '📤';
    bulkShareBtn.title       = 'Share';
  }
});

let bulkDeleteConfirmTimer   = null;
let bulkDeleteConfirmPending = false;

function resetBulkDeleteBtn() {
  clearTimeout(bulkDeleteConfirmTimer);
  bulkDeleteConfirmPending = false;
  bulkDeleteBtn.textContent = '🗑';
  bulkDeleteBtn.title = 'Delete';
  bulkDeleteBtn.classList.remove('confirm');
}

bulkDeleteBtn.addEventListener('click', async () => {
  if (!selected.size) return;

  if (!bulkDeleteConfirmPending) {
    bulkDeleteConfirmPending = true;
    bulkDeleteBtn.textContent = '⚠️';
    bulkDeleteBtn.title = `Confirm delete (${selected.size})?`;
    bulkDeleteBtn.classList.add('confirm');
    bulkDeleteConfirmTimer = setTimeout(resetBulkDeleteBtn, 3000);
    return;
  }
  clearTimeout(bulkDeleteConfirmTimer);

  const photos = [...selected].sort((a, b) => a - b).map(idx => items[idx]);
  const reopen = reopenFn;
  bulkDeleteBtn.disabled = true;
  bulkDeleteBtn.textContent = '⏳';

  let ok = 0, failed = 0;
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    bulkDeleteBtn.title = `Deleting ${i + 1}/${photos.length}…`;
    try {
      await deleteFile(photo.fileid);
      await Promise.all([deleteRecord(photo.fileid), deleteOrphan(photo.fileid), removeVideoMetaEntry(photo.fileid), removeOrganizedEntry(photo.fileid), removeIgnoredEntry(photo.fileid)]);
      removeMarker(photo.fileid);
      ok++;
    } catch (e) {
      failed++;
      log('Bulk delete error', `${photo.name}: ${e.message}`);
    }
  }

  resetBulkDeleteBtn();
  close();
  log('Bulk delete', `deleted ${ok}${failed ? `, ${failed} failed` : ''}`);
  reopen?.();
});

const THUMB_RETRY_DELAYS = [500, 1500, 4000]; // ms — fetchThumbSrc returns null (not a throw) on transient failures

async function loadThumb(tile, attempt = 0) {
  const { fileid } = tile._item;
  try {
    const src = await fetchThumbSrc(fileid, THUMB_SIZE);
    if (src) { tile._img.src = src; tile._img.classList.add('loaded'); return; }
  } catch { /* falls through to retry below */ }
  if (attempt < THUMB_RETRY_DELAYS.length) {
    setTimeout(() => loadThumb(tile, attempt + 1), THUMB_RETRY_DELAYS[attempt]);
  }
}

function toggleTileSelected(tile, index) {
  if (selected.has(index)) { selected.delete(index); tile.classList.remove('selected'); }
  else                     { selected.add(index);    tile.classList.add('selected'); }
  updateBulkBar();
}

function makeTile(item, index) {
  const tile = document.createElement('div');
  tile.className = 'grid-tile';
  const check = document.createElement('span');
  check.className = 'grid-tile-check';
  tile.appendChild(check);
  const img = document.createElement('img');
  tile.appendChild(img);
  if (isVideo(item.name)) {
    const badge = document.createElement('span');
    badge.className = 'grid-play-badge';
    badge.textContent = '▶';
    tile.appendChild(badge);
  }
  tile._item = item;
  tile._img  = img;
  tile.addEventListener('click', () => {
    if (selectMode) { toggleTileSelected(tile, index); return; }
    const fetcher = fetchPageFn, seed = items, idx = index, t = total;
    // Grid view (z-index 3500) stays open underneath the slideshow (4000).
    // On a plain dismissal the slideshow just hides, revealing the grid as-is.
    // On a handoff to geotag/fix-date the map needs to be fully visible, so
    // tear the grid down for real in that case.
    setCloseHandler(({ handoff }) => { if (handoff) close(); });
    openLazySlideshow(fetcher, t, { startIndex: idx, seedItems: seed });
  });
  thumbObserver.observe(tile);
  return tile;
}

async function loadNextPage() {
  if (done || loadingPage || !fetchPageFn) return;
  loadingPage = true;
  try {
    const page = await fetchPageFn(offset, PAGE_SIZE);
    offset += page.length;
    if (page.length < PAGE_SIZE) done = true;
    const startIdx = items.length;
    items.push(...page);
    const frag = document.createDocumentFragment();
    page.forEach((item, i) => frag.appendChild(makeTile(item, startIdx + i)));
    track.appendChild(frag);
    countEl.textContent = total != null ? `${items.length} / ${total}` : `${items.length}+`;
  } finally {
    loadingPage = false;
  }
}

// `reopen`, if given, is called after a bulk action completes (success or
// cancel) to refresh and reopen the grid with fresh data — the underlying
// list (e.g. "no location") shrinks once photos get geotagged.
export async function openGrid(fetchPage, totalCount, { reopen = null } = {}) {
  fetchPageFn = fetchPage;
  total       = totalCount ?? null;
  reopenFn    = reopen;
  items       = [];
  offset      = 0;
  done        = false;
  track.innerHTML = '';
  countEl.textContent = '';
  setSelectMode(false);

  thumbObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) { loadThumb(e.target); thumbObserver.unobserve(e.target); }
    }
  }, { root: scrollEl, rootMargin: '200px' });

  pageObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loadNextPage();
  }, { root: scrollEl, rootMargin: '400px' });
  pageObserver.observe(sentinel);

  el.classList.add('open');
  await loadNextPage();
}
