import Panzoom from '@panzoom/panzoom';
import { fetchThumbSrc } from './pcloud.js';
import { viewOpened, viewClosed } from './nav.js';

const el   = document.getElementById('lightbox');
const wrap = document.getElementById('lightbox-img-wrap');
const img  = document.getElementById('lightbox-img');

let pz = null;
let wheelHandler = null;
let currentFileid = null;

// px — matches the slideshow's own swipe-to-navigate threshold (touchend
// handler, dragging branch) so a swipe feels the same in both places.
const SWIPE_THRESHOLD = 50;

let swipeHandler = null;
export function setSwipeHandler(fn) { swipeHandler = fn; }

function destroyPanzoom() {
  if (pz) {
    if (wheelHandler) { el.removeEventListener('wheel', wheelHandler); wheelHandler = null; }
    pz.destroy();
    pz = null;
  }
}

function initPanzoom() {
  destroyPanzoom();
  // panOnlyWhenZoomed defaults to false in this library — without it,
  // Panzoom treats *every* drag as a pan attempt, even at scale 1, competing
  // with the swipe-to-navigate gesture below for the same pointer events
  // (harmless-looking in a mouse-driven test, but real touch input drives
  // both at once). Also just correct on its own terms: panning an image
  // that isn't zoomed in doesn't mean anything.
  pz = Panzoom(img, { maxScale: 8, minScale: 1, cursor: 'grab', panOnlyWhenZoomed: true });
  // Panzoom sets overflow:hidden on the panned element's parent — here
  // that's our snug wrapper (see openLightbox's markup comment), sized to
  // the image's *unscaled* box. Left as-is, that clips a zoomed-in image
  // to its own pre-zoom footprint, so it can never grow to cover the
  // letterboxed bars around it. #lightbox already provides the real clip
  // boundary (the screen edges), so keep the wrapper unclipped.
  wrap.style.overflow = 'visible';
  wheelHandler = pz.zoomWithWheel;
  el.addEventListener('wheel', wheelHandler, { passive: false });
}

function close() {
  el.classList.remove('open', 'loading');
  img.onload = null;
  img.src = '';
  currentFileid = null;
  _tapN = 0; _tapT = 0;
  destroyPanzoom();
  viewClosed('lightbox');
}

// Tap-to-close: single finger, short duration, minimal movement, not zoomed in.
let _tapT = 0, _tapN = 0, _tapX = 0, _tapY = 0;

img.addEventListener('pointerdown', e => {
  _tapN++;
  if (_tapN === 1) {
    _tapT = Date.now(); _tapX = e.clientX; _tapY = e.clientY;
    // Without this, a swipe-distance drag moves the pointer off img
    // entirely partway through, so pointerup fires on whatever's underneath
    // instead (the backdrop, triggering its own tap-to-close) rather than
    // here — capture keeps every event routed to img regardless of where
    // the pointer physically ends up.
    img.setPointerCapture(e.pointerId);
  }
  else _tapT = 0;
});

img.addEventListener('pointerup', e => {
  _tapN = Math.max(0, _tapN - 1);
  if (_tapN === 0 && _tapT) {
    const dx = e.clientX - _tapX, dy = e.clientY - _tapY;
    const notZoomed = (pz?.getScale() ?? 1) <= 1.01;
    if (Date.now() - _tapT < 250 && dx*dx + dy*dy < 100 && notZoomed) {
      close();
    } else if (notZoomed && Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
      // Deliberately don't close here — the callback (slideshow.js) knows
      // whether the adjacent item is another photo (swapLightboxImage, this
      // overlay stays open and just swaps content — no flash of the
      // slideshow underneath) or a video (closeLightbox + openVideoPlayer).
      // Closing unconditionally first, then reopening, was the original
      // design and is exactly what made every swipe visibly bounce through
      // the slideshow view first.
      swipeHandler?.(dx < 0 ? 1 : -1);
    }
    _tapT = 0;
  }
});

img.addEventListener('pointercancel', () => { _tapN = 0; _tapT = 0; });

// Tapping the dark background also closes.
el.addEventListener('pointerup', e => { if (e.target === el) close(); });

document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('open')) close(); });

function loadImage(fileid, name) {
  currentFileid = fileid;
  el.classList.add('loading');
  img.alt = name;
  img.onload = null;
  img.src = '';
  destroyPanzoom();

  fetchThumbSrc(fileid, '2048x2048').then(src => {
    el.classList.remove('loading');
    if (src) {
      img.onload = () => initPanzoom();
      img.src = src;
    }
  }).catch(() => {
    el.classList.remove('loading');
  });
}

export function openLightbox(fileid, name) {
  el.classList.add('open');
  viewOpened('lightbox', { close });
  loadImage(fileid, name);
}

// Swipe-to-adjacent-photo: the overlay is already open and already on the
// nav stack, so unlike openLightbox this never touches either — just swaps
// the displayed image in place, with the same brief loading state a fresh
// open shows.
export function swapLightboxImage(fileid, name) {
  loadImage(fileid, name);
}

export function closeLightbox() { close(); }
