import Panzoom from '@panzoom/panzoom';
import { fetchThumbSrc } from './pcloud.js';

const el       = document.getElementById('lightbox');
const img      = document.getElementById('lightbox-img');
const closeBtn = document.getElementById('lightbox-close');

let pz = null;

function destroyPanzoom() {
  if (pz) { pz.destroy(); pz = null; }
}

function initPanzoom() {
  destroyPanzoom();
  pz = Panzoom(img, { maxScale: 8, contain: 'inside', cursor: 'grab' });
  el.addEventListener('wheel', pz.zoomWithWheel, { passive: false });
}

function close() {
  el.classList.remove('open', 'loading');
  img.onload = null;
  img.src = '';
  destroyPanzoom();
}

closeBtn.addEventListener('click', close);
el.addEventListener('pointerup', e => { if (e.target === el) close(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('open')) close(); });

export function openLightbox(fileid, name) {
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
