import { fetchThumbSrc } from './pcloud.js';
import { openLightbox } from './lightbox.js';

const el        = document.getElementById('slideshow');
const imgEl     = document.getElementById('ss-img');
const loadingEl = document.getElementById('ss-loading');
const counterEl = document.getElementById('ss-counter');
const captionEl = document.getElementById('ss-caption');
const prevBtn   = document.getElementById('ss-prev');
const nextBtn   = document.getElementById('ss-next');
const closeBtn    = document.getElementById('ss-close');
const geotagBtn   = document.getElementById('ss-geotag-btn');

let geotagHandler = null;

export function setGeotagHandler(fn) { geotagHandler = fn; }

let photos  = [];
let current = 0;
let reqId   = 0;
const cache = new Map();

// Lazy-loading state (null when not in lazy mode)
let lazyFetch    = null; // async (offset, limit) => record[]
let lazyOffset   = 0;
let lazyTotal    = null; // known total or null
let lazyDone     = false;
let lazyPending  = false;

const PAGE_SIZE  = 30;
const LOAD_AHEAD = 8;

function resetLazy() {
  lazyFetch   = null;
  lazyOffset  = 0;
  lazyTotal   = null;
  lazyDone    = false;
  lazyPending = false;
}

function close() {
  el.classList.remove('open');
  geotagBtn.style.display = 'none';
  photos = [];
  cache.clear();
  resetLazy();
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

document.addEventListener('keydown', e => {
  if (!el.classList.contains('open')) return;
  if (e.key === 'ArrowLeft')  go(current - 1, -1);
  if (e.key === 'ArrowRight') go(current + 1,  1);
  if (e.key === 'Escape')     close();
});

prevBtn.addEventListener('click', () => go(current - 1, -1));
nextBtn.addEventListener('click', () => go(current + 1,  1));

imgEl.addEventListener('click', () => {
  if (photos[current]) openLightbox(photos[current].fileid, photos[current].name);
});

let touchStartX = 0;
let touchDelta  = 0;
let dragging    = false;
const wrap = document.getElementById('ss-img-wrap');

wrap.addEventListener('touchstart', e => {
  touchStartX = e.touches[0].clientX;
  touchDelta  = 0;
  dragging    = true;
  imgEl.style.transition = 'none';
}, { passive: true });

wrap.addEventListener('touchmove', e => {
  if (!dragging) return;
  touchDelta = e.touches[0].clientX - touchStartX;
  imgEl.style.transform = `translateX(${touchDelta}px)`;
}, { passive: true });

wrap.addEventListener('touchend', () => {
  if (!dragging) return;
  dragging = false;
  const dx = touchDelta;

  if (Math.abs(dx) > 50) {
    const forward = dx < 0;
    const exitX   = forward ? -wrap.clientWidth : wrap.clientWidth;
    imgEl.style.transition = 'transform 0.18s ease-in';
    imgEl.style.transform  = `translateX(${exitX}px)`;
    setTimeout(() => {
      imgEl.style.transition = '';
      imgEl.style.transform  = '';
      go(current + (forward ? 1 : -1), forward ? 1 : -1);
    }, 180);
  } else {
    imgEl.style.transition = 'transform 0.25s ease-out';
    imgEl.style.transform  = '';
    imgEl.addEventListener('transitionend', () => { imgEl.style.transition = ''; }, { once: true });
  }
});

async function fetchCached(fileid) {
  if (cache.has(fileid)) return cache.get(fileid);
  const src = await fetchThumbSrc(fileid, '512x512');
  cache.set(fileid, src);
  return src;
}

function updateCounter() {
  const total = lazyTotal != null
    ? lazyTotal
    : lazyDone ? photos.length : `${photos.length}+`;
  counterEl.textContent = `${current + 1} / ${total}`;
}

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

async function go(index, dir = 0) {
  if (!photos.length) return;
  current = ((index % photos.length) + photos.length) % photos.length;
  const id = ++reqId;

  const { fileid, name, ts } = photos[current];
  updateCounter();
  const dateStr = ts ? new Date(ts).toLocaleDateString() : '';
  captionEl.textContent = dateStr ? `${name} · ${dateStr}` : name;
  imgEl.style.display = 'none';
  loadingEl.style.display = '';

  maybeLoadMore();

  const src = await fetchCached(fileid);
  if (id !== reqId) return;
  loadingEl.style.display = 'none';
  if (src) {
    imgEl.src = src;
    imgEl.style.display = 'block';
    if (dir !== 0) {
      imgEl.classList.remove('ss-slide-left', 'ss-slide-right');
      void imgEl.offsetWidth; // force reflow so animation re-triggers
      imgEl.classList.add(dir > 0 ? 'ss-slide-right' : 'ss-slide-left');
    }
  }

  const prev = photos[(current - 1 + photos.length) % photos.length];
  const next = photos[(current + 1) % photos.length];
  fetchCached(prev.fileid);
  fetchCached(next.fileid);
}

export function openSlideshow(photoList, startIndex = 0) {
  if (!photoList.length) return;
  resetLazy();
  lazyDone = true; // all photos already in memory, no paging needed
  photos = photoList;
  cache.clear();
  geotagBtn.style.display = 'none';
  el.classList.add('open');
  go(startIndex);
}

export async function openLazySlideshow(fetchPage, total) {
  cache.clear();
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
