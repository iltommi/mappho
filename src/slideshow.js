import { fetchThumbSrc } from './pcloud.js';
import { openLightbox } from './lightbox.js';

const el        = document.getElementById('slideshow');
const imgEl     = document.getElementById('ss-img');
const loadingEl = document.getElementById('ss-loading');
const counterEl = document.getElementById('ss-counter');
const captionEl = document.getElementById('ss-caption');
const prevBtn   = document.getElementById('ss-prev');
const nextBtn   = document.getElementById('ss-next');
const closeBtn  = document.getElementById('ss-close');

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
  photos = [];
  cache.clear();
  resetLazy();
}

closeBtn.addEventListener('click', close);
el.addEventListener('click', e => { if (e.target === el) close(); });

document.addEventListener('keydown', e => {
  if (!el.classList.contains('open')) return;
  if (e.key === 'ArrowLeft')  go(current - 1);
  if (e.key === 'ArrowRight') go(current + 1);
  if (e.key === 'Escape')     close();
});

prevBtn.addEventListener('click', () => go(current - 1));
nextBtn.addEventListener('click', () => go(current + 1));

imgEl.addEventListener('click', () => {
  if (photos[current]) openLightbox(photos[current].fileid, photos[current].name);
});

let touchStartX = 0;
const wrap = document.getElementById('ss-img-wrap');
wrap.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
wrap.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 40) go(current + (dx < 0 ? 1 : -1));
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

async function go(index) {
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
  if (src) { imgEl.src = src; imgEl.style.display = ''; }

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
  el.classList.add('open');
  go(0);
}
