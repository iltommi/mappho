import Panzoom from '@panzoom/panzoom';
import { fetchThumbSrc } from './pcloud.js';

const el       = document.getElementById('lightbox');
const img      = document.getElementById('lightbox-img');
const closeBtn = document.getElementById('lightbox-close');

let pz = null;

function initPanzoom() {
  if (pz) { pz.destroy(); pz = null; }
  pz = Panzoom(img, { maxScale: 8, cursor: 'grab' });
  el.addEventListener('wheel', pz.zoomWithWheel, { passive: false });
}

function close() {
  el.classList.remove('open', 'loading');
  img.src = '';
  if (pz) { pz.destroy(); pz = null; }
}

closeBtn.addEventListener('click', close);
el.addEventListener('pointerup', e => { if (e.target === el) close(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('open')) close(); });

export function openLightbox(fileid, name) {
  el.classList.add('open', 'loading');
  img.alt = name;
  img.src = '';

  // Init panzoom after the element is visible so it can measure correctly
  requestAnimationFrame(() => initPanzoom());

  fetchThumbSrc(fileid, '2048x2048').then(src => {
    el.classList.remove('loading');
    if (src) img.src = src;
  }).catch(() => {
    el.classList.remove('loading');
  });
}
