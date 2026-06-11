import { fetchThumbSrc } from './pcloud.js';

const el = document.getElementById('lightbox');
const img = document.getElementById('lightbox-img');
const closeBtn = document.getElementById('lightbox-close');

function close() {
  el.classList.remove('open', 'loading');
  img.src = '';
}

closeBtn.addEventListener('click', close);
el.addEventListener('click', (e) => { if (e.target === el) close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

export function openLightbox(fileid, name) {
  el.classList.add('open', 'loading');
  img.alt = name;

  fetchThumbSrc(fileid, '2048x2048').then(src => {
    el.classList.remove('loading');
    if (src) img.src = src;
  }).catch(() => {
    el.classList.remove('loading');
  });
}
