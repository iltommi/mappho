import { fetchThumbSrc } from './pcloud.js';
import { isVideo } from './mp4.js';
import { openLazySlideshow, setCloseHandler } from './slideshow.js';
import { startBulkGeotagging } from './geotag.js';
import { log } from './log.js';

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
}

function setSelectMode(on) {
  selectMode = on;
  selectBtn.classList.toggle('active', on);
  selectBtn.textContent = on ? '✕ Cancel select' : '☑ Select';
  bulkBar.style.display = on ? 'flex' : 'none';
  if (!on) {
    for (const idx of selected) tileAt(idx)?.classList.remove('selected');
    selected.clear();
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

async function loadThumb(tile) {
  const { fileid } = tile._item;
  try {
    const src = await fetchThumbSrc(fileid, THUMB_SIZE);
    if (src) { tile._img.src = src; tile._img.classList.add('loaded'); }
  } catch { /* tile just stays blank — acceptable for a thumbnail grid */ }
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
