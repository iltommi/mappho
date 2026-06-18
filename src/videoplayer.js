import { fetchVideoSrc } from './pcloud.js';
import { openWithIntent } from './intentlauncher.js';

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

export async function openVideoPlayer(fileid, name = '') {
  if (/\.avi$/i.test(name)) {
    try {
      const url = await fetchVideoSrc(fileid);
      await openWithIntent(url, 'video/x-msvideo');
    } catch (e) {
      vpLoad.textContent = `Error: ${e.message}`;
      vpLoad.style.display = '';
      player.classList.add('open');
    }
    return;
  }

  vpVideo.src = '';
  vpLoad.textContent = 'Loading…';
  vpLoad.style.display = '';
  player.classList.add('open');
  try {
    vpVideo.src = await fetchVideoSrc(fileid);
    vpLoad.style.display = 'none';
    vpVideo.play().catch(() => {});
  } catch (e) {
    vpLoad.textContent = `Error: ${e.message}`;
  }
}
