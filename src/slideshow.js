import { fetchThumbSrc, getFileDimensions, getFileFolderName, deleteFile } from './pcloud.js';
import { deleteRecord, deleteOrphan } from './db.js';
import { removeMarker } from './map.js';
import { openLightbox } from './lightbox.js';
import { showExif } from './exif.js';
import { isVideo } from './mp4.js';
import { openVideoPlayer } from './videoplayer.js';
import { log } from './log.js';
import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';

const VIDEO_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3">' +
  '<rect width="4" height="3" fill="#1a1a2e"/>' +
  '<polygon points="1.4,0.6 2.8,1.5 1.4,2.4" fill="#94a3b8"/>' +
  '</svg>'
)}`;

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
const playBadge   = document.getElementById('ss-play-badge');
const geotagBtn   = document.getElementById('ss-geotag-btn');
const fixDateBtn  = document.getElementById('ss-fixdate-btn');
const ignoreBtn   = document.getElementById('ss-ignore-btn');
const exifBtn     = document.getElementById('ss-exif-btn');
const shareBtn    = document.getElementById('ss-share-btn');
const deleteBtn   = document.getElementById('ss-delete-btn');
const wrap        = document.getElementById('ss-img-wrap');

let geotagHandler    = null;
let fixDateHandler   = null;
let ignoreHandler    = null;
let afterDeleteCb    = null;
export function setGeotagHandler(fn)       { geotagHandler = fn; }
export function setFixDateHandler(fn)      { fixDateHandler = fn; }
export function setIgnoreHandler(fn)       { ignoreHandler = fn; }
export function setAfterDeleteCallback(fn) { afterDeleteCb = fn; }

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
  playBadge.style.display  = 'none';
  geotagBtn.style.display  = 'none';
  fixDateBtn.style.display = 'none';
  ignoreBtn.style.display  = 'none';
  photos = [];
  imgCache.clear();
  resetLazy();
  resetImgZoom(false);
  centerTrack(false);
  resetDeleteBtn();
}

export function closeSlideshow() { close(); }

geotagBtn.addEventListener('click', () => {
  const photo = photos[current];
  if (!photo || !geotagHandler) return;
  close();
  geotagHandler(photo);
});

fixDateBtn.addEventListener('click', () => {
  const photo = photos[current];
  if (!photo || !fixDateHandler) return;
  close();
  fixDateHandler(photo);
});

ignoreBtn.addEventListener('click', async () => {
  const photo = photos[current];
  if (!photo || !ignoreHandler) return;

  ignoreBtn.disabled = true;
  photos.splice(current, 1);
  if (lazyTotal != null) lazyTotal = Math.max(0, lazyTotal - 1);

  if (!photos.length) {
    ignoreBtn.disabled = false;
    close();
    ignoreHandler(photo).catch(e => console.error('ignore error:', e));
    return;
  }
  if (current >= photos.length) current = photos.length - 1;
  ignoreBtn.disabled = false;
  await go(current);

  ignoreHandler(photo).catch(e => console.error('ignore error:', e));
});

exifBtn.addEventListener('click', () => {
  const photo = photos[current];
  if (photo) showExif(photo.fileid, photo.name);
});
closeBtn.addEventListener('click', close);

// ── Share ─────────────────────────────────────────────────────────────────────

shareBtn.addEventListener('click', async () => {
  const photo = photos[current];
  if (!photo || isVideo(photo.name)) return;
  shareBtn.disabled = true;
  const shareName = photo.name.replace(/\.heic$/i, '.jpg');
  try {
    const src = await fetchThumbSrc(photo.fileid, '2048x2048');
    if (!src) { log('share', 'thumb fetch returned null'); return; }
    const b64 = src.slice(src.indexOf(',') + 1);
    const written = await Filesystem.writeFile({
      path: shareName, data: b64, directory: Directory.Cache,
    });
    log('share', `temp file: ${written.uri}`);
    try {
      await Share.share({ files: [written.uri], dialogTitle: 'Share photo' });
    } finally {
      Filesystem.deleteFile({ path: shareName, directory: Directory.Cache }).catch(() => {});
    }
  } catch (e) {
    if (e.name !== 'AbortError') log('share error', e.message ?? String(e));
  } finally {
    shareBtn.disabled = false;
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

let _deleteConfirmTimer = null;
let _deleteConfirmPending = false;

function resetDeleteBtn() {
  clearTimeout(_deleteConfirmTimer);
  _deleteConfirmPending = false;
  deleteBtn.textContent = '🗑';
  deleteBtn.title = 'Delete';
  deleteBtn.classList.remove('confirm');
  deleteBtn.disabled = false;
}

deleteBtn.addEventListener('click', async () => {
  if (!_deleteConfirmPending) {
    _deleteConfirmPending = true;
    deleteBtn.textContent = '⚠️';
    deleteBtn.title = 'Confirm delete?';
    deleteBtn.classList.add('confirm');
    _deleteConfirmTimer = setTimeout(resetDeleteBtn, 3000);
    return;
  }
  clearTimeout(_deleteConfirmTimer);

  const photo = photos[current];
  if (!photo) { resetDeleteBtn(); return; }

  deleteBtn.disabled = true;
  deleteBtn.textContent = '⏳';
  deleteBtn.title = 'Deleting…';
  try {
    await deleteFile(photo.fileid);
    await Promise.all([deleteRecord(photo.fileid), deleteOrphan(photo.fileid)]);
    removeMarker(photo.fileid);
    imgCache.delete(photo.fileid);

    photos.splice(current, 1);
    if (lazyTotal != null) lazyTotal = Math.max(0, lazyTotal - 1);

    afterDeleteCb?.();

    if (!photos.length) { close(); return; }
    if (current >= photos.length) current = photos.length - 1;
    resetDeleteBtn();
    await go(current);
  } catch (e) {
    resetDeleteBtn();
    console.error('Delete error:', e);
  }
});

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
  const photo = photos[current];
  if (!photo || imgScale !== 1) return;
  if (isVideo(photo.name)) openVideoPlayer(photo.fileid);
  else                      openLightbox(photo.fileid, photo.name);
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
    const src = await fetchCached(photos[current].fileid, photos[current].name);
    if (id !== reqId) return;
    loadingEl.style.display = 'none';
    if (src) { curImg.src = src; curImg.style.display = 'block'; }
  }

  loadSidePanes();
  maybeLoadMore();
}

// ── Cache / preload ───────────────────────────────────────────────────────────

async function fetchCached(fileid, name = '') {
  if (imgCache.has(fileid)) return imgCache.get(fileid);
  let src;
  if (isVideo(name)) {
    src = (await fetchThumbSrc(fileid, '512x512')) ?? VIDEO_PLACEHOLDER;
  } else {
    src = await fetchThumbSrc(fileid, '512x512');
  }
  imgCache.set(fileid, src);
  if (imgCache.size > MAX_CACHE) imgCache.delete(imgCache.keys().next().value);
  return src;
}

function loadSidePanes() {
  const pIdx = (current - 1 + photos.length) % photos.length;
  const nIdx = (current + 1) % photos.length;
  prevImg.src = '';
  nextImg.src = '';
  if (photos[pIdx]) fetchCached(photos[pIdx].fileid, photos[pIdx].name).then(s => { if (s) prevImg.src = s; });
  if (photos[nIdx]) fetchCached(photos[nIdx].fileid, photos[nIdx].name).then(s => { if (s) nextImg.src = s; });
}

// ── Counter / caption ─────────────────────────────────────────────────────────

let currentDimStr = '';

function updateCounter() {
  const total = lazyTotal != null
    ? lazyTotal
    : lazyDone ? photos.length : `${photos.length}+`;
  const { ts } = photos[current];
  const dateStr = ts ? new Date(ts).toLocaleDateString() : '';
  const parts = [`${current + 1} / ${total}`, currentDimStr, dateStr].filter(Boolean);
  counterEl.textContent = parts.join(' · ');
}

function updateCaption() {
  const { name, fileid } = photos[current];
  currentDimStr = '';
  updateCounter();

  const buildCaption = folder => folder ? `${folder} / ${name}` : name;

  captionEl.textContent = buildCaption('');
  if (geotagHandler) geotagBtn.style.display = '';
  fixDateBtn.style.display  = fixDateHandler ? '' : 'none';
  ignoreBtn.style.display   = ignoreHandler  ? '' : 'none';
  playBadge.style.display   = isVideo(name) ? '' : 'none';
  exifBtn.style.display  = isVideo(name) ? 'none' : '';
  shareBtn.style.display = isVideo(name) ? 'none' : '';

  if (!isVideo(name)) {
    let folderName = '';
    const refresh = () => {
      if (photos[current]?.fileid !== fileid) return;
      updateCounter();
      captionEl.textContent = buildCaption(folderName);
    };
    getFileDimensions(fileid).then(dim => {
      if (dim) { currentDimStr = `${dim.w}×${dim.h}`; refresh(); }
    }).catch(() => {});
    getFileFolderName(fileid).then(folder => {
      if (folder) { folderName = folder; refresh(); }
    }).catch(() => {});
  }
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

  const src = await fetchCached(photos[current].fileid, photos[current].name);
  if (id !== reqId) return;

  loadingEl.style.display = 'none';
  if (src) { curImg.src = src; curImg.style.display = 'block'; }

  loadSidePanes();
  maybeLoadMore();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function openSlideshow(photoList, startIndex = 0) {
  if (!photoList.length) return;
  geotagHandler  = null;
  fixDateHandler = null;
  ignoreHandler  = null;
  resetLazy();
  lazyDone = true;
  photos   = photoList;
  imgCache.clear();
  geotagBtn.style.display  = 'none';
  fixDateBtn.style.display = 'none';
  ignoreBtn.style.display  = 'none';
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
