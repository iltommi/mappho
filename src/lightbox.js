import Panzoom from '@panzoom/panzoom';
import { fetchThumbSrc } from './pcloud.js';

const el  = document.getElementById('lightbox');
const img = document.getElementById('lightbox-img');

let pz = null;
let wheelHandler = null;
let currentFileid = null;

function destroyPanzoom() {
  if (pz) {
    if (wheelHandler) { el.removeEventListener('wheel', wheelHandler); wheelHandler = null; }
    pz.destroy();
    pz = null;
  }
}

function initPanzoom() {
  destroyPanzoom();
  pz = Panzoom(img, { maxScale: 8, minScale: 1, cursor: 'grab' });
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
}

// Tap-to-close: single finger, short duration, minimal movement, not zoomed in.
let _tapT = 0, _tapN = 0, _tapX = 0, _tapY = 0;

img.addEventListener('pointerdown', e => {
  _tapN++;
  if (_tapN === 1) { _tapT = Date.now(); _tapX = e.clientX; _tapY = e.clientY; }
  else _tapT = 0;
});

img.addEventListener('pointerup', e => {
  _tapN = Math.max(0, _tapN - 1);
  if (_tapN === 0 && _tapT) {
    const dx = e.clientX - _tapX, dy = e.clientY - _tapY;
    // Defer close so the browser's synthetic click fires on the lightbox (still
    // visible) rather than on #ss-img underneath, which would reopen it.
    if (Date.now() - _tapT < 250 && dx*dx + dy*dy < 100 && (pz?.getScale() ?? 1) <= 1.01) setTimeout(close, 0);
    _tapT = 0;
  }
});

img.addEventListener('pointercancel', () => { _tapN = 0; _tapT = 0; });

// Tapping the dark background also closes.
el.addEventListener('pointerup', e => { if (e.target === el) close(); });

document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('open')) close(); });

export function openLightbox(fileid, name) {
  currentFileid = fileid;
  el.classList.add('open', 'loading');
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
