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
const cache = new Map(); // fileid -> src

function close() {
  el.classList.remove('open');
  photos = [];
  cache.clear();
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

// Swipe support
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

async function go(index) {
  if (!photos.length) return;
  current = ((index % photos.length) + photos.length) % photos.length;
  const id = ++reqId;

  const { fileid, name } = photos[current];
  counterEl.textContent = `${current + 1} / ${photos.length}`;
  captionEl.textContent = name;
  imgEl.style.display = 'none';
  loadingEl.style.display = '';

  const src = await fetchCached(fileid);
  if (id !== reqId) return; // superseded by a newer navigation
  loadingEl.style.display = 'none';
  if (src) { imgEl.src = src; imgEl.style.display = ''; }

  // Prefetch neighbours
  const prev = photos[(current - 1 + photos.length) % photos.length];
  const next = photos[(current + 1) % photos.length];
  fetchCached(prev.fileid);
  fetchCached(next.fileid);
}

export function openSlideshow(photoList, startIndex = 0) {
  if (!photoList.length) return;
  photos = photoList;
  cache.clear();
  el.classList.add('open');
  go(startIndex);
}
