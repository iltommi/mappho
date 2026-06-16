import { fetchThumbSrc } from './pcloud.js';
import { isVideo } from './mp4.js';
import { openLazySlideshow } from './slideshow.js';

const el       = document.getElementById('grid-view');
const closeBtn = document.getElementById('grid-close');
const countEl  = document.getElementById('grid-count');
const track    = document.getElementById('grid-track');
const sentinel = document.getElementById('grid-sentinel');
const scrollEl = document.getElementById('grid-scroll');

const PAGE_SIZE  = 60;
const THUMB_SIZE = '256x256';

let items       = [];
let fetchPageFn = null;
let total       = null;
let offset      = 0;
let done        = false;
let loadingPage = false;

let pageObserver  = null;
let thumbObserver = null;

function close() {
  el.classList.remove('open');
  track.innerHTML = '';
  items       = [];
  fetchPageFn = null;
  pageObserver?.disconnect();
  thumbObserver?.disconnect();
}
closeBtn.addEventListener('click', close);

async function loadThumb(tile) {
  const { fileid } = tile._item;
  try {
    const src = await fetchThumbSrc(fileid, THUMB_SIZE);
    if (src) { tile._img.src = src; tile._img.classList.add('loaded'); }
  } catch { /* tile just stays blank — acceptable for a thumbnail grid */ }
}

function makeTile(item, index) {
  const tile = document.createElement('div');
  tile.className = 'grid-tile';
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
    const fetcher = fetchPageFn, seed = items, idx = index, t = total;
    close();
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

export async function openGrid(fetchPage, totalCount) {
  fetchPageFn = fetchPage;
  total       = totalCount ?? null;
  items       = [];
  offset      = 0;
  done        = false;
  track.innerHTML = '';
  countEl.textContent = '';

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
