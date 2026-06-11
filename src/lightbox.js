import Panzoom from '@panzoom/panzoom';
import { fetchThumbSrc } from './pcloud.js';

const el      = document.getElementById('lightbox');
const img     = document.getElementById('lightbox-img');
const closeBtn = document.getElementById('lightbox-close');

const pz = Panzoom(img, {
  maxScale: 8,
  contain: 'outside',
  cursor: 'grab',
});

// Pinch-to-zoom on the lightbox container
el.addEventListener('wheel', pz.zoomWithWheel, { passive: false });

function close() {
  el.classList.remove('open', 'loading');
  img.src = '';
  pz.reset({ animate: false });
}

closeBtn.addEventListener('click', close);
// Only close on backdrop tap (not image drag/pan end)
el.addEventListener('pointerup', e => { if (e.target === el) close(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

export function openLightbox(fileid, name) {
  el.classList.add('open', 'loading');
  img.alt = name;
  pz.reset({ animate: false });

  fetchThumbSrc(fileid, '2048x2048').then(src => {
    el.classList.remove('loading');
    if (src) img.src = src;
  }).catch(() => {
    el.classList.remove('loading');
  });
}
