import { fetchVideoSrc } from './pcloud.js';
import { openWithIntent } from './intentlauncher.js';
import { log } from './log.js';

const player  = document.getElementById('video-player');
const vpClose = document.getElementById('vp-close');
const vpVideo = document.getElementById('vp-video');
const vpLoad  = document.getElementById('vp-loading');

// HTMLMediaElement.error.code values — MDN / WHATWG MediaError.
const MEDIA_ERROR_MESSAGES = {
  1: 'Playback was aborted.',
  2: 'Network error while loading the video.',
  3: 'This video is corrupted or uses an encoding this device can\'t decode.',
  4: 'This video format isn\'t supported on this device.',
};

function showError(msg) {
  vpLoad.textContent = msg;
  vpLoad.style.display = '';
}

// Fires for real decode/network failures — e.g. a corrupted file or a
// container format the device can't parse at all. Note this does NOT catch
// every failure mode: a video using an unsupported codec inside an
// otherwise-valid container (common with old phone/camera recordings using
// MPEG-4 Part 2 / "mp4v") can play its audio track fine while silently
// never rendering a frame, with no error event at all — there's no
// reliable client-side signal to detect that case specifically.
vpVideo.addEventListener('error', () => {
  const err = vpVideo.error;
  log('Video playback error', err ? `code ${err.code}: ${err.message || ''}` : 'unknown');
  showError(err ? (MEDIA_ERROR_MESSAGES[err.code] ?? `Playback error (code ${err.code}).`) : 'Playback error.');
});

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
      showError(`Error: ${e.message}`);
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
    vpVideo.play().then(() => {
      vpLoad.style.display = 'none';
    }).catch(e => {
      if (vpVideo.error) return; // the 'error' listener already showed a message
      // Autoplay can be blocked (e.g. the user gesture window lapsed during
      // the network fetch above) without the file itself being at fault —
      // don't show that as an error; native controls still let the user hit play.
      if (e.name === 'AbortError' || e.name === 'NotAllowedError') { vpLoad.style.display = 'none'; return; }
      log('Video play() rejected', e.message);
      showError(`Could not play: ${e.message}`);
    });
  } catch (e) {
    showError(`Error: ${e.message}`);
  }
}
