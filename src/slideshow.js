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
const MAX_CACHE  = 50;

function resetLazy() {
  lazyFetch = null; lazyOffset = 0; lazyTotal = null; lazyDone = false; lazyPending = false;
}

// ── Image zoom / pan state ────────────────────────────────────────────────────

let imgScale = 1;
let imgTx    = 0;
let imgTy    = 0;

function applyImgTransform(animate) {
  curImg.style.transition = animate ? 'transform 0.22s ease-out' : 'none';
  curImg.style.transform  = (imgScale === 1 && imgTx === 0 && imgTy === 0)
    ? '' : `translate(${imgTx}px, ${imgTy}px) scale(${imgScale})`;
}

function resetImgZoom(animate) {
  imgScale = 1; imgTx = 0; imgTy = 0;
  applyImgTransform(animate);
}

// Keep image inside the viewport when zoomed — no blank gutters.
function clampPan() {
  if (imgScale <= 1) { imgTx = 0; imgTy = 0; applyImgTransform(true); return; }
  const r  = curImg.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  // r.width / r.height are the visual (scaled) dimensions.
  // max allowed pan in each axis so the image edge never goes past the wrap edge:
  const mxh = Math.max(0, (r.width  - wr.width)  / 2);
  const mxv = Math.max(0, (r.height - wr.height) / 2);
  imgTx = Math.max(-mxh, Math.min(mxh, imgTx));
  imgTy = Math.max(-mxv, Math.min(mxv, imgTy));
  applyImgTransform(true);
}

// ── Track helpers ─────────────────────────────────────────────────────────────

function centerTrack(animate) {
  trackEl.style.transition = animate
    ? 'transform 0.28s cubic-bezier(0.25,0.46,0.45,0.94)'
    : 'none';
  trackEl.style.transform = `translateX(${-wrap.clientWidth}px)`;
}

// ── Close ─────────────────────────────────────────────────────────────────────

function close() {
  el.classList.remove('open');
  geotagBtn.style.display = 'none';
  photos = [];
  imgCache.clear();
  resetLazy();
  resetImgZoom(false);
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

// ── Keyboard ──────────────────────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if (!el.classList.contains('open')) return;
  if (e.key === 'ArrowLeft')  navigate(-1);
  if (e.key === 'ArrowRight') navigate(1);
  if (e.key === 'Escape')     close();
});

prevBtn.addEventListener('click', () => navigate(-1));
nextBtn.addEventListener('click', () => navigate(1));

curImg.addEventListener('click', () => {
  if (photos[current] && imgScale === 1)
    openLightbox(photos[current].fileid, photos[current].name);
});

// ── Touch ─────────────────────────────────────────────────────────────────────

let touchStartX = 0, touchDelta = 0, dragging = false;
let panning = false, panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;
let pinching = false;
let pinchNatCx = 0, pinchNatCy = 0, pinchDx = 0, pinchDy = 0;
let pinchStartDist = 0, pinchStartScale = 0;
let lastTap = 0;
let busy    = false;

wrap.addEventListener('touchstart', e => {
  if (busy) return;

  if (e.touches.length === 2) {
    // Pinch start — cancel any in-progress swipe or pan
    dragging = false;
    panning  = false;
    pinching = true;
    trackEl.style.transition = 'none';
    curImg.style.transition  = 'none';

    const t0 = e.touches[0], t1 = e.touches[1];
    const mx = (t0.clientX + t1.clientX) / 2;
    const my = (t0.clientY + t1.clientY) / 2;
    pinchStartDist  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    pinchStartScale = imgScale;

    // Natural center: element center in screen space before the JS transform.
    // visual_center = natCenter + (imgTx, imgTy), so natCenter = visual_center - (imgTx, imgTy).
    const rect  = curImg.getBoundingClientRect();
    pinchNatCx  = rect.left + rect.width  / 2 - imgTx;
    pinchNatCy  = rect.top  + rect.height / 2 - imgTy;

    // Image-space offset of the pinch midpoint from the natural center.
    // This point must remain under the midpoint throughout the gesture.
    pinchDx = (mx - (pinchNatCx + imgTx)) / imgScale;
    pinchDy = (my - (pinchNatCy + imgTy)) / imgScale;

  } else if (e.touches.length === 1 && !pinching) {
    if (imgScale > 1) {
      // Pan the zoomed image
      panning    = true;
      panStartX  = e.touches[0].clientX;
      panStartY  = e.touches[0].clientY;
      panStartTx = imgTx;
      panStartTy = imgTy;
    } else {
      // Swipe to navigate
      touchStartX = e.touches[0].clientX;
      touchDelta  = 0;
      dragging    = true;
      trackEl.style.transition = 'none';
    }
  }
}, { passive: true });

wrap.addEventListener('touchmove', e => {
  if (pinching && e.touches.length >= 2) {
    e.preventDefault(); // stop browser from doing its own zoom

    const t0   = e.touches[0], t1 = e.touches[1];
    const mx   = (t0.clientX + t1.clientX) / 2;
    const my   = (t0.clientY + t1.clientY) / 2;
    const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
    const s    = Math.max(1, Math.min(5, pinchStartScale * dist / pinchStartDist));

    // Keep the pinch midpoint fixed: solve for (imgTx, imgTy) such that
    //   natCenter + (imgTx, imgTy) + imageOffset * s  =  (mx, my)
    imgScale = s;
    imgTx    = mx - pinchNatCx - pinchDx * s;
    imgTy    = my - pinchNatCy - pinchDy * s;
    applyImgTransform(false);

  } else if (panning && e.touches.length === 1) {
    imgTx = panStartTx + e.touches[0].clientX - panStartX;
    imgTy = panStartTy + e.touches[0].clientY - panStartY;
    applyImgTransform(false);

  } else if (dragging && e.touches.length === 1) {
    touchDelta = e.touches[0].clientX - touchStartX;
    trackEl.style.transform = `translateX(${-wrap.clientWidth + touchDelta}px)`;
  }
}, { passive: false });

wrap.addEventListener('touchend', e => {
  // Double-tap: zoom in 2.5× around tap point, or reset if already zoomed
  if (!pinching && e.changedTouches.length === 1 && e.touches.length === 0) {
    const now = Date.now();
    if (now - lastTap < 280) {
      if (imgScale > 1) {
        resetImgZoom(true);
      } else {
        const t    = e.changedTouches[0];
        const rect = curImg.getBoundingClientRect();
        const natCx = rect.left + rect.width  / 2 - imgTx;
        const natCy = rect.top  + rect.height / 2 - imgTy;
        const s     = 2.5;
        const dx    = (t.clientX - (natCx + imgTx)) / imgScale;
        const dy    = (t.clientY - (natCy + imgTy)) / imgScale;
        imgScale    = s;
        imgTx       = t.clientX - natCx - dx * s;
        imgTy       = t.clientY - natCy - dy * s;
        applyImgTransform(true);
        setTimeout(clampPan, 230);
      }
    }
    lastTap = now;
  }

  if (e.touches.length < 2 && pinching) {
    pinching = false;
    if (imgScale < 1.05) resetImgZoom(true);
    else                 setTimeout(clampPan, 0);
  }

  if (e.touches.length === 0 && panning) {
    panning = false;
    clampPan();
  }

  if (e.touches.length === 0 && dragging) {
    dragging = false;
    if (Math.abs(touchDelta) > 50 && imgScale <= 1) {
      navigate(touchDelta < 0 ? 1 : -1);
    } else if (imgScale <= 1) {
      centerTrack(true);
    }
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────

async function navigate(dir) {
  if (busy || !photos.length) return;
  busy = true;
  dragging = false;

  const w = wrap.clientWidth;
  trackEl.style.transition = 'transform 0.28s cubic-bezier(0.25,0.46,0.45,0.94)';
  trackEl.style.transform  = `translateX(${dir > 0 ? -2 * w : 0}px)`;

  await new Promise(r => setTimeout(r, 280));

  current = ((current + dir) % photos.length + photos.length) % photos.length;
  const id = ++reqId;

  updateCaption();
  resetImgZoom(false);

  const srcPane = dir > 0 ? nextImg : prevImg;
  if (srcPane.src && srcPane.src !== window.location.href) {
    curImg.src           = srcPane.src;
    curImg.style.display = 'block';
    loadingEl.style.display = 'none';
  } else {
    curImg.style.display    = 'none';
    loadingEl.style.display = '';
  }

  trackEl.style.transition = 'none';
  trackEl.style.transform  = `translateX(${-w}px)`;

  busy = false;

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
  if (imgCache.size > MAX_CACHE) imgCache.delete(imgCache.keys().next().value);
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

// ── Direct jump (open / initial load) ─────────────────────────────────────────

async function go(index) {
  current = ((index % photos.length) + photos.length) % photos.length;
  const id = ++reqId;

  updateCaption();
  resetImgZoom(false);
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
