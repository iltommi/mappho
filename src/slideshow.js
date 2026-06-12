import { fetchThumbSrc } from './pcloud.js';
import { openLightbox } from './lightbox.js';

const el        = document.getElementById('slideshow');
const trackEl   = document.getElementById('ss-track');
const curImg    = document.getElementById('ss-img');
const prevImg   = document.getElementById('ss-img-prev');
const nextImg   = document.getElementById('ss-img-next');
const loadingEl = document.getElementById('ss-loading');
const counterEl = document.getElementById('ss-counter');
const captionEl = document.getElementById('ss-caption');
const prevBtn   = document.getElementById('ss-prev');
const nextBtn   = document.getElementById('ss-next');
const closeBtn  = document.getElementById('ss-close');
const geotagBtn = document.getElementById('ss-geotag-btn');
const wrap      = document.getElementById('ss-img-wrap');

let geotagHandler = null;
export function setGeotagHandler(fn) { geotagHandler = fn; }

let photos  = [];
let current = 0;
let reqId   = 0;
const imgCache = new Map();

let lazyFetch   = null;
let lazyOffset  = 0;
let lazyTotal   = null;
let lazyDone    = false;
let lazyPending = false;

const PAGE_SIZE  = 30;
const LOAD_AHEAD = 8;

function resetLazy() {
  lazyFetch = null; lazyOffset = 0; lazyTotal = null; lazyDone = false; lazyPending = false;
}

// ── Track helpers ────────────────────────────────────────────────────────────

// One pane width equals the wrap's client width.
// Normal resting position: translateX(-paneW) → center pane visible.
// Next pane:  translateX(-2*paneW)
// Prev pane:  translateX(0)

function centerTrack(animate) {
  trackEl.style.transition = animate
    ? 'transform 0.28s cubic-bezier(0.25,0.46,0.45,0.94)'
    : 'none';
  trackEl.style.transform = `translateX(${-wrap.clientWidth}px)`;
}

// ── Close ────────────────────────────────────────────────────────────────────

function close() {
  el.classList.remove('open');
  geotagBtn.style.display = 'none';
  photos = [];
  imgCache.clear();
  resetLazy();
  centerTrack(false);
}

export function closeSlideshow() { close(); }

geotagBtn.addEventListener('click', () => {
  const photo = photos[current];
  if (!photo || !geotagHandler) return;
  close();
  geotagHandler(photo);
});

closeBtn.addEventListener('click', close);
el.addEventListener('click', e => { if (e.target === el) close(); });

// ── Keyboard ─────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (!el.classList.contains('open')) return;
  if (e.key === 'ArrowLeft')  navigate(-1);
  if (e.key === 'ArrowRight') navigate(1);
  if (e.key === 'Escape')     close();
});

// ── Buttons ───────────────────────────────────────────────────────────────────

prevBtn.addEventListener('click', () => navigate(-1));
nextBtn.addEventListener('click', () => navigate(1));

curImg.addEventListener('click', () => {
  if (photos[current]) openLightbox(photos[current].fileid, photos[current].name);
});

// ── Touch / swipe ─────────────────────────────────────────────────────────────

let touchStartX = 0;
let touchDelta  = 0;
let dragging    = false;
let busy        = false;

wrap.addEventListener('touchstart', e => {
  if (busy) return;
  touchStartX = e.touches[0].clientX;
  touchDelta  = 0;
  dragging    = true;
  trackEl.style.transition = 'none';
}, { passive: true });

wrap.addEventListener('touchmove', e => {
  if (!dragging) return;
  touchDelta = e.touches[0].clientX - touchStartX;
  trackEl.style.transform = `translateX(${-wrap.clientWidth + touchDelta}px)`;
}, { passive: true });

wrap.addEventListener('touchend', () => {
  if (!dragging) return;
  dragging = false;
  if (Math.abs(touchDelta) > 50) {
    navigate(touchDelta < 0 ? 1 : -1);
  } else {
    centerTrack(true); // bounce back
  }
});

// ── Navigate (swipe or button) ────────────────────────────────────────────────

async function navigate(dir) {
  if (busy || !photos.length) return;
  busy = true;
  dragging = false;

  const w = wrap.clientWidth;

  // Slide strip to reveal the adjacent pane
  trackEl.style.transition = 'transform 0.28s cubic-bezier(0.25,0.46,0.45,0.94)';
  trackEl.style.transform  = `translateX(${dir > 0 ? -2 * w : 0}px)`;

  await new Promise(r => setTimeout(r, 280));

  current = ((current + dir) % photos.length + photos.length) % photos.length;
  const id = ++reqId;

  updateCaption();

  // The pane that just slid into view already has the image (preloaded).
  // Copy its src to the center pane so the snap-back is invisible.
  const srcPane = dir > 0 ? nextImg : prevImg;
  if (srcPane.src && srcPane.src !== window.location.href) {
    curImg.src           = srcPane.src;
    curImg.style.display = 'block';
    loadingEl.style.display = 'none';
  } else {
    curImg.style.display    = 'none';
    loadingEl.style.display = '';
  }

  // Reset strip to center instantly — seamless because center now matches what was showing
  trackEl.style.transition = 'none';
  trackEl.style.transform  = `translateX(${-w}px)`;

  busy = false;

  // If the image wasn't preloaded yet, fetch it now
  if (!curImg.style.display || curImg.style.display === 'none') {
    const src = await fetchCached(photos[current].fileid);
    if (id !== reqId) return;
    loadingEl.style.display = 'none';
    if (src) { curImg.src = src; curImg.style.display = 'block'; }
  }

  loadSidePanes();
  maybeLoadMore();
}

// ── Cache / preload ───────────────────────────────────────────────────────────

async function fetchCached(fileid) {
  if (imgCache.has(fileid)) return imgCache.get(fileid);
  const src = await fetchThumbSrc(fileid, '512x512');
  imgCache.set(fileid, src);
  return src;
}

function loadSidePanes() {
  const pIdx = (current - 1 + photos.length) % photos.length;
  const nIdx = (current + 1) % photos.length;
  prevImg.src = '';
  nextImg.src = '';
  if (photos[pIdx]) fetchCached(photos[pIdx].fileid).then(s => { if (s) prevImg.src = s; });
  if (photos[nIdx]) fetchCached(photos[nIdx].fileid).then(s => { if (s) nextImg.src = s; });
}

// ── Counter / caption ─────────────────────────────────────────────────────────

function updateCounter() {
  const total = lazyTotal != null
    ? lazyTotal
    : lazyDone ? photos.length : `${photos.length}+`;
  counterEl.textContent = `${current + 1} / ${total}`;
}

function updateCaption() {
  const { name, ts } = photos[current];
  updateCounter();
  const dateStr = ts ? new Date(ts).toLocaleDateString() : '';
  captionEl.textContent = dateStr ? `${name} · ${dateStr}` : name;
}

// ── Lazy loading ──────────────────────────────────────────────────────────────

async function maybeLoadMore() {
  if (!lazyFetch || lazyDone || lazyPending) return;
  if (current < photos.length - LOAD_AHEAD) return;
  lazyPending = true;
  try {
    const page = await lazyFetch(lazyOffset, PAGE_SIZE);
    lazyOffset += page.length;
    if (page.length < PAGE_SIZE) lazyDone = true;
    photos.push(...page);
    updateCounter();
  } finally {
    lazyPending = false;
  }
}

// ── Direct jump (open / initial load) ────────────────────────────────────────

async function go(index) {
  current = ((index % photos.length) + photos.length) % photos.length;
  const id = ++reqId;

  updateCaption();
  curImg.style.display    = 'none';
  loadingEl.style.display = '';
  prevImg.src = '';
  nextImg.src = '';
  centerTrack(false);

  const src = await fetchCached(photos[current].fileid);
  if (id !== reqId) return;

  loadingEl.style.display = 'none';
  if (src) { curImg.src = src; curImg.style.display = 'block'; }

  loadSidePanes();
  maybeLoadMore();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function openSlideshow(photoList, startIndex = 0) {
  if (!photoList.length) return;
  resetLazy();
  lazyDone = true;
  photos   = photoList;
  imgCache.clear();
  geotagBtn.style.display = 'none';
  el.classList.add('open');
  go(startIndex);
}

export async function openLazySlideshow(fetchPage, total) {
  imgCache.clear();
  photos = [];
  resetLazy();
  lazyFetch = fetchPage;
  lazyTotal = total ?? null;

  const firstPage = await fetchPage(0, PAGE_SIZE);
  if (!firstPage.length) return;

  lazyOffset = firstPage.length;
  if (firstPage.length < PAGE_SIZE) lazyDone = true;
  photos = firstPage;
  geotagBtn.style.display = geotagHandler ? '' : 'none';
  el.classList.add('open');
  go(0);
}
