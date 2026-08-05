// Map-anchored photo bar: browse next/prev through photos currently shown
// on the map without leaving it (the map itself never pans/zooms — see
// showSelectionMarker in map.js for the temporary marker that shows where
// the current photo actually is, useful when its real marker is merged
// into a cluster bubble at the current zoom level). Tapping the thumbnail
// hands off to the full-screen slideshow (already built, same navigation)
// for a closer look.
import { fetchThumbSrc } from './pcloud.js';
import { openSlideshow } from './slideshow.js';
import { showSelectionMarker, hideSelectionMarker } from './map.js';
import { viewOpened, viewClosed } from './nav.js';

const el        = document.getElementById('pin-bar');
const thumbImg  = document.getElementById('pin-bar-thumb');
const prevBtn   = document.getElementById('pin-bar-prev');
const nextBtn   = document.getElementById('pin-bar-next');
const counterEl = document.getElementById('pin-bar-counter');

// px — matches lightbox.js/slideshow.js's own swipe-to-navigate threshold
// so a swipe feels the same across every view in the app.
const SWIPE_THRESHOLD = 50;

let photos  = [];
let current = 0;
let reqId   = 0;

function updateCounter() {
  counterEl.textContent = `${current + 1} / ${photos.length}`;
  const single = photos.length === 1;
  prevBtn.style.display = single ? 'none' : '';
  nextBtn.style.display = single ? 'none' : '';
}

function loadCurrent() {
  const photo = photos[current];
  updateCounter();
  showSelectionMarker(photo.lat, photo.lng);
  const id = ++reqId;
  thumbImg.alt = photo.name;
  thumbImg.src = '';
  fetchThumbSrc(photo.fileid, '512x512', photo.rotation ?? 0).then(src => {
    if (id !== reqId) return;
    if (src) thumbImg.src = src;
  }).catch(() => {});
}

function close() {
  el.classList.remove('open');
  photos = [];
  current = 0;
  hideSelectionMarker();
  viewClosed('pinbar');
}

function navigate(dir) {
  if (!photos.length) return;
  current = ((current + dir) % photos.length + photos.length) % photos.length;
  loadCurrent();
}

prevBtn.addEventListener('click', () => navigate(-1));
nextBtn.addEventListener('click', () => navigate(1));

document.addEventListener('keydown', e => {
  if (!el.classList.contains('open')) return;
  if (e.key === 'ArrowLeft')  navigate(-1);
  if (e.key === 'ArrowRight') navigate(1);
  if (e.key === 'Escape')     close();
});

// Swipe-to-navigate on the thumbnail, plus tap-to-open-fullscreen — a
// smaller-scale version of lightbox.js's own tap/swipe handling (no zoom,
// no pinch, just left/right swipe and a plain tap).
let touchStartX = 0, touchStartY = 0, touching = false;

thumbImg.addEventListener('pointerdown', e => {
  touching = true;
  touchStartX = e.clientX;
  touchStartY = e.clientY;
  thumbImg.setPointerCapture(e.pointerId);
});

thumbImg.addEventListener('pointerup', e => {
  if (!touching) return;
  touching = false;
  const dx = e.clientX - touchStartX, dy = e.clientY - touchStartY;
  if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    navigate(dx < 0 ? 1 : -1);
  } else if (dx * dx + dy * dy < 100) {
    // Plain tap: hand off to the full-screen slideshow at the same photo —
    // capture the list/index before close() clears them.
    const list = photos, idx = current;
    close();
    openSlideshow(list, idx);
  }
});

thumbImg.addEventListener('pointercancel', () => { touching = false; });

export function openPinBar(photoList, startIndex = 0) {
  if (!photoList.length) return;
  photos  = photoList;
  current = Math.min(Math.max(0, startIndex), photos.length - 1);
  el.classList.add('open');
  viewOpened('pinbar', { close });
  loadCurrent();
}

export function closePinBar() { close(); }
