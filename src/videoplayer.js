import { fetchVideoSrc } from './pcloud.js';

const player  = document.getElementById('video-player');
const vpClose = document.getElementById('vp-close');
const vpVideo = document.getElementById('vp-video');
const vpLoad  = document.getElementById('vp-loading');

function close() {
  vpVideo.pause();
  vpVideo.src = '';
  player.classList.remove('open');
}

vpClose.addEventListener('click', close);
player.addEventListener('pointerup', e => { if (e.target === player) close(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && player.classList.contains('open')) close();
});

export async function openVideoPlayer(fileid) {
  vpVideo.src = '';
  vpLoad.textContent = 'Loading…';
  vpLoad.style.display = '';
  player.classList.add('open');
  try {
    vpVideo.src = await fetchVideoSrc(fileid);
    vpLoad.style.display = 'none';
  } catch (e) {
    vpLoad.textContent = `Error: ${e.message}`;
  }
}
