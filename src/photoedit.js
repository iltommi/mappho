import { downloadFullFile, overwriteFile, getFileStat } from './pcloud.js';
import { injectExif } from './exif.js';
import { syncMapphoOnEdit } from './organize.js';
import { isVideo } from './mp4.js';
import { log } from './log.js';

const overlay     = document.getElementById('photoedit-overlay');
const canvas      = document.getElementById('photoedit-canvas');
const rotLBtn     = document.getElementById('photoedit-rotl');
const rotRBtn     = document.getElementById('photoedit-rotr');
const flipBtn     = document.getElementById('photoedit-flip');
const enhanceBtn  = document.getElementById('photoedit-enhance');
const saveBtn     = document.getElementById('photoedit-save');
const cancelBtn   = document.getElementById('photoedit-cancel');

let _photo    = null;
let _onSaved  = null;
let _rotation = 0;      // 0 | 90 | 180 | 270
let _flipH    = false;
let _enhanced = false;
let _thumbImg = null;

// ── Enhance ───────────────────────────────────────────────────────────────────

function _buildLUT(hist, n) {
  const clip = Math.ceil(n * 0.02);
  let lo = 0, hi = 255, c = 0;
  for (let i = 0;   i < 256; i++) { c += hist[i]; if (c >= clip) { lo = i; break; } }
  c = 0;
  for (let i = 255; i >= 0;  i--) { c += hist[i]; if (c >= clip) { hi = i; break; } }
  const range = hi - lo || 1;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round((i - lo) * 255 / range)));
  return lut;
}

function _applyEnhance(ctx, w, h) {
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data, n = d.length / 4;
  const hR = new Uint32Array(256), hG = new Uint32Array(256), hB = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) { hR[d[i]]++; hG[d[i+1]]++; hB[d[i+2]]++; }
  const lR = _buildLUT(hR, n), lG = _buildLUT(hG, n), lB = _buildLUT(hB, n);
  for (let i = 0; i < d.length; i += 4) { d[i] = lR[d[i]]; d[i+1] = lG[d[i+1]]; d[i+2] = lB[d[i+2]]; }
  ctx.putImageData(id, 0, 0);
}

// ── Preview ───────────────────────────────────────────────────────────────────

function _redraw() {
  if (!_thumbImg?.complete || !_thumbImg.naturalWidth) return;
  const isOdd = _rotation === 90 || _rotation === 270;
  const sw = _thumbImg.naturalWidth, sh = _thumbImg.naturalHeight;
  const cw = isOdd ? sh : sw, ch = isOdd ? sw : sh;
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(_rotation * Math.PI / 180);
  if (_flipH) ctx.scale(-1, 1);
  ctx.drawImage(_thumbImg, -sw / 2, -sh / 2);
  ctx.restore();
  if (_enhanced) _applyEnhance(ctx, cw, ch);
}

// ── Controls ──────────────────────────────────────────────────────────────────

rotLBtn.addEventListener('click', () => { _rotation = (_rotation - 90 + 360) % 360; _redraw(); });
rotRBtn.addEventListener('click', () => { _rotation = (_rotation + 90) % 360; _redraw(); });
flipBtn.addEventListener('click', () => { _flipH = !_flipH; _redraw(); });
enhanceBtn.addEventListener('click', () => {
  _enhanced = !_enhanced;
  enhanceBtn.classList.toggle('active', _enhanced);
  _redraw();
});

cancelBtn.addEventListener('click', _close);

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener('click', async () => {
  if (!_photo) return;
  const photo = _photo;
  saveBtn.disabled = true;
  saveBtn.textContent = '⏳';
  cancelBtn.disabled = true;

  try {
    const buf = await downloadFullFile(photo.fileid);

    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
    const isOdd = _rotation === 90 || _rotation === 270;
    const sw = bmp.width, sh = bmp.height;
    const cw = isOdd ? sh : sw, ch = isOdd ? sw : sh;

    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(_rotation * Math.PI / 180);
    if (_flipH) ctx.scale(-1, 1);
    ctx.drawImage(bmp, -sw / 2, -sh / 2);
    ctx.restore();
    bmp.close();
    if (_enhanced) _applyEnhance(ctx, cw, ch);

    const outBlob = await new Promise((res, rej) =>
      c.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/jpeg', 0.92));
    let outBuf = await outBlob.arrayBuffer();

    outBuf = injectExif(outBuf, { ts: photo.ts, lat: photo.lat, lng: photo.lng });

    const { hash: oldHash } = await getFileStat(photo.fileid).catch(() => ({}));
    const newFileid = await overwriteFile(photo.fileid, outBuf);
    const { hash: newHash } = await getFileStat(newFileid).catch(() => ({}));
    const syncedName = await syncMapphoOnEdit({ oldHash, newFileid, newHash, ts: photo.ts });

    const thumbSrc = canvas.toDataURL('image/jpeg', 0.85);
    _onSaved?.({ newFileid, newName: syncedName ?? photo.name, thumbSrc });
    _close();
  } catch (e) {
    log('photoedit save error', e.message);
    saveBtn.textContent = '❌ Retry';
    saveBtn.disabled = false;
    cancelBtn.disabled = false;
  }
});

// ── Open / close ──────────────────────────────────────────────────────────────

function _close() {
  overlay.style.display = 'none';
  saveBtn.disabled = false;
  saveBtn.textContent = '💾 Save';
  cancelBtn.disabled = false;
  _photo = null; _onSaved = null; _thumbImg = null;
  _rotation = 0; _flipH = false; _enhanced = false;
  enhanceBtn.classList.remove('active');
}

export function openPhotoEdit(photo, thumbSrc, onSaved) {
  if (isVideo(photo.name) || /\.heic$/i.test(photo.name)) return;
  _photo = photo; _onSaved = onSaved;
  _rotation = 0; _flipH = false; _enhanced = false;
  enhanceBtn.classList.remove('active');
  _thumbImg = new Image();
  _thumbImg.onload = _redraw;
  _thumbImg.src = thumbSrc;
  overlay.style.display = 'flex';
}
