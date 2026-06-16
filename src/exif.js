import exifr from 'exifr';
import piexif from 'piexifjs';
import { fetchFileHead, fetchFileRange } from './pcloud.js';

// Returns { lat, lng, ts } — any field may be absent if not in EXIF.
// Pass fileid + name for HEIC files so multi-pass fetching can be used when needed.
export async function extractEXIF(buffer, fileid = null, name = '') {
  const result = {};

  // For HEIC, prefer fetching the raw TIFF bytes directly so exifr gets the full data
  // regardless of where the meta box sits in the file.
  let parseTarget = buffer;
  if (/\.heic$/i.test(name) && fileid) {
    try {
      const tiff = await fetchHeicExifTiff(fileid);
      if (tiff) parseTarget = tiff;
    } catch { /* fall back to original buffer */ }
  }

  if (parseTarget) {
    try {
      const gps = await exifr.gps(parseTarget);
      if (gps?.latitude != null && gps?.longitude != null &&
          !isNaN(gps.latitude) && !isNaN(gps.longitude)) {
        result.lat = gps.latitude;
        result.lng = gps.longitude;
      }
    } catch { /* no GPS */ }

    try {
      const tags = await exifr.parse(parseTarget, { exif: true, tiff: false, gps: false,
        pick: ['CreateDate', 'DateTimeOriginal', 'DateTime', 'DateTimeDigitized'] });
      const d = tags?.CreateDate ?? tags?.DateTimeOriginal ?? tags?.DateTime ?? tags?.DateTimeDigitized;
      if (d instanceof Date && !isNaN(d)) result.ts = d.getTime();
    } catch { /* no date */ }
  }

  // Fallback: parse date from filename (e.g. 20250710_202139.heic, 2024-01-15_14-30-22.jpg)
  if (!result.ts && name) {
    const ts = parseDateFromFilename(name);
    if (ts) result.ts = ts;
  }

  return result;
}

// Try to extract a Unix timestamp from filenames like:
//   2024-01-15_14-30-22_anything.jpg
//   20240613_121250.jpg
export function parseDateFromFilename(name) {
  // Full datetime: 2024-01-15_14-30-22 or 20240613_121250
  let m = name.match(/(\d{4})-(\d{2})-(\d{2})[_T ](\d{2})[-:](\d{2})[-:](\d{2})/);
  if (m) {
    const dt = new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
    if (!isNaN(dt)) return dt.getTime();
  }
  m = name.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const dt = new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]);
    if (!isNaN(dt)) return dt.getTime();
  }
  // Date only: 2024-06-13_001.jpg — midnight, no time info
  m = name.match(/(\d{4})-(\d{2})-(\d{2})_/);
  if (m) {
    const dt = new Date(+m[1], +m[2]-1, +m[3]);
    if (!isNaN(dt)) return dt.getTime();
  }
  // Date only compact: IMG-20240613-* — 8-digit block between non-digit separators
  m = name.match(/[^0-9](\d{4})(\d{2})(\d{2})[^0-9]/);
  if (m) {
    const dt = new Date(+m[1], +m[2]-1, +m[3]);
    if (!isNaN(dt)) return dt.getTime();
  }
  return null;
}

// Convert a HEIC ArrayBuffer to JPEG by rendering through a Canvas element.
// Canvas strips all metadata, so inject EXIF separately afterwards.
// Requires Android WebView with HEIC decode support (Android 10+).
export async function heicToJpeg(heicBuffer) {
  const blob = new Blob([heicBuffer], { type: 'image/heic' });
  const url  = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload  = resolve;
      img.onerror = () => reject(new Error('WebView could not decode HEIC image'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(b => {
        if (!b) { reject(new Error('Canvas toBlob failed')); return; }
        b.arrayBuffer().then(resolve, reject);
      }, 'image/jpeg', 0.92);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Fetch Make and Model from a HEIC file's EXIF for metadata preservation.
export async function extractHeicMeta(fileid) {
  try {
    const tiff = await fetchHeicExifTiff(fileid);
    if (!tiff) return {};
    const parsed = await exifr.parse(new Uint8Array(tiff), {
      ifd0: true, exif: false, gps: false, translateValues: false,
      pick: ['Make', 'Model'],
    });
    return parsed ?? {};
  } catch { return {}; }
}

function fmtExifDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth()+1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Inject GPS, date, make and model into a JPEG ArrayBuffer.
// Canvas-converted images have no EXIF and Orientation=1 (already oriented).
export function injectExif(jpegBuffer, { lat, lng, ts, make, model } = {}) {
  const bytes = new Uint8Array(jpegBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }

  let exifObj;
  try   { exifObj = piexif.load(binary); }
  catch { exifObj = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {} }; }

  if (lat != null && lng != null) {
    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef]  = lat >= 0 ? 'N' : 'S';
    exifObj.GPS[piexif.GPSIFD.GPSLatitude]     = toDMS(Math.abs(lat));
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
    exifObj.GPS[piexif.GPSIFD.GPSLongitude]    = toDMS(Math.abs(lng));
  }

  if (ts) {
    const dateStr = fmtExifDate(ts);
    if (dateStr) {
      exifObj['0th'][piexif.ImageIFD.DateTime]         = dateStr;
      exifObj['Exif'][piexif.ExifIFD.DateTimeOriginal]  = dateStr;
      exifObj['Exif'][piexif.ExifIFD.DateTimeDigitized] = dateStr;
    }
  }

  if (make)  exifObj['0th'][piexif.ImageIFD.Make]  = make;
  if (model) exifObj['0th'][piexif.ImageIFD.Model] = model;
  exifObj['0th'][piexif.ImageIFD.Orientation] = 1;

  const exifBytes = piexif.dump(exifObj);
  const modified  = piexif.insert(exifBytes, binary);
  const out = new Uint8Array(modified.length);
  for (let i = 0; i < modified.length; i++) out[i] = modified.charCodeAt(i);
  return out.buffer;
}

// Inject GPS coordinates into a JPEG ArrayBuffer, return new ArrayBuffer.
export function injectGPS(buffer, lat, lng) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }

  let exifObj;
  try {
    exifObj = piexif.load(binary);
  } catch {
    exifObj = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {} };
  }

  exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef]  = lat >= 0 ? 'N' : 'S';
  exifObj.GPS[piexif.GPSIFD.GPSLatitude]     = toDMS(Math.abs(lat));
  exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
  exifObj.GPS[piexif.GPSIFD.GPSLongitude]    = toDMS(Math.abs(lng));

  const exifBytes = piexif.dump(exifObj);
  const modified  = piexif.insert(exifBytes, binary);

  const out = new Uint8Array(modified.length);
  for (let i = 0; i < modified.length; i++) out[i] = modified.charCodeAt(i);
  return out.buffer;
}

function toDMS(decimal) {
  const deg = Math.floor(decimal);
  const minF = (decimal - deg) * 60;
  const min  = Math.floor(minF);
  const sec  = Math.round((minF - min) * 60 * 1000);
  return [[deg, 1], [min, 1], [sec, 1000]];
}

// ── HEIC EXIF location (2-pass range fetch) ───────────────────────────────────

// Parse enough of the ISOBMFF container in `buf` to find where the Exif item
// is stored in the file. Returns { offset, length } or null.
function heicExifLocation(buf) {
  const view = new DataView(buf);
  const end  = buf.byteLength;

  function u8(o)  { return view.getUint8(o); }
  function u16(o) { return view.getUint16(o, false); }
  function u32(o) { return view.getUint32(o, false); }
  function s4(o)  { return String.fromCharCode(u8(o), u8(o+1), u8(o+2), u8(o+3)); }
  function uN(o, n) {
    if (n === 0) return 0;
    if (n === 1) return u8(o);
    if (n === 2) return u16(o);
    if (n === 4) return u32(o);
    if (n === 8) return Number(view.getBigUint64(o, false));
    return 0;
  }

  // Iterate ISOBMFF boxes at [start, stop); yield {type, ps, end}
  // ps = payload start (after 8-byte box header)
  function* boxes(start, stop) {
    let p = start;
    while (p + 8 <= stop) {
      const sz = u32(p);
      if (sz < 8) break;
      yield { type: s4(p + 4), ps: p + 8, end: p + sz };
      p += sz;
    }
  }

  // Find the 'meta' box at top level.
  // If a large box (e.g. mdat) extends past the buffer we return { fetchAt } so the
  // caller can fetch another chunk starting right after that box.
  let meta = null;
  {
    let p = 0;
    while (p + 8 <= end) {
      const sz = u32(p);
      if (sz < 8) break;
      const type = s4(p + 4);
      if (type === 'meta') { meta = { ps: p + 8, end: Math.min(p + sz, end) }; break; }
      if (p + sz > end) return { fetchAt: p + sz }; // box content beyond buffer
      p += sz;
    }
  }
  if (!meta) return null;

  // meta is a FullBox: 4-byte version+flags before its children
  const mc = meta.ps + 4;

  let iinf = null, iloc = null;
  for (const b of boxes(mc, meta.end)) {
    if (b.type === 'iinf') iinf = b;
    if (b.type === 'iloc') iloc = b;
  }
  if (!iinf || !iloc) return null;

  // Parse iinf → find item ID with item_type 'Exif'
  const iinfVer = u8(iinf.ps);
  let p = iinf.ps + 4;
  const entryCount = iinfVer === 0 ? u16(p) : u32(p);
  p += iinfVer === 0 ? 2 : 4;

  let exifId = null;
  for (const infe of boxes(p, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = u8(infe.ps);
    if (v < 2) continue;
    const idOff  = infe.ps + 4;
    const itemId = v === 2 ? u16(idOff) : u32(idOff);
    const typeOff = idOff + (v === 2 ? 2 : 4) + 2; // +2 for item_protection_index
    if (s4(typeOff) === 'Exif') { exifId = itemId; break; }
  }
  if (exifId === null) return null;

  // Parse iloc → find offset+length for exifId
  const ilocVer = u8(iloc.ps);
  p = iloc.ps + 4;
  const b1 = u8(p++), b2 = u8(p++);
  const offSz  = (b1 >> 4) & 0xF;
  const lenSz  = b1 & 0xF;
  const baseSz = (b2 >> 4) & 0xF;
  const idxSz  = (ilocVer === 1 || ilocVer === 2) ? (b2 & 0xF) : 0;
  const itemIdSz = ilocVer === 2 ? 4 : 2;
  const cmSz    = (ilocVer === 1 || ilocVer === 2) ? 2 : 0;
  const extSz   = idxSz + offSz + lenSz;

  const itemCount = ilocVer === 2 ? u32(p) : u16(p);
  p += ilocVer === 2 ? 4 : 2;

  for (let i = 0; i < itemCount; i++) {
    const itemId = uN(p, itemIdSz); p += itemIdSz;
    p += cmSz + 2 + baseSz;
    const extCount = u16(p); p += 2;
    if (itemId === exifId) {
      const offset = uN(p + idxSz,         offSz);
      const length = uN(p + idxSz + offSz, lenSz);
      return { offset, length };
    }
    p += extCount * extSz;
  }
  return null;
}

// Given raw HEIC Exif item bytes, find the start of the TIFF header ("II" or "MM").
function tiffStart(buf) {
  const a = new Uint8Array(buf);
  for (let i = 0; i < Math.min(32, a.length - 1); i++) {
    if ((a[i] === 0x49 && a[i+1] === 0x49) || (a[i] === 0x4D && a[i+1] === 0x4D)) return i;
  }
  return 0;
}

// Shared helper: fetch the raw TIFF bytes from a HEIC file using 1-3 range requests.
// Returns an ArrayBuffer (the TIFF data) or null.
export async function fetchHeicExifTiff(fileid) {
  const head = await fetchFileHead(fileid, 65536);
  let loc = heicExifLocation(head);

  if (loc && 'fetchAt' in loc) {
    const metaBuf = await fetchFileRange(fileid, loc.fetchAt, loc.fetchAt + 32767);
    loc = heicExifLocation(metaBuf);
  }

  if (!loc || !('offset' in loc) || loc.length <= 0) return null;
  const item = await fetchFileRange(fileid, loc.offset, loc.offset + loc.length - 1);
  return item.slice(tiffStart(item));
}

// ── EXIF viewer panel ─────────────────────────────────────────────────────────

const exifPanel   = document.getElementById('exif-panel');
const exifTitleEl = document.getElementById('exif-title');
const exifCloseBtn= document.getElementById('exif-close');
const exifListEl  = document.getElementById('exif-list');

exifCloseBtn.addEventListener('click', () => exifPanel.classList.remove('open'));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && exifPanel.classList.contains('open')) exifPanel.classList.remove('open');
});

function fmtVal(v) {
  if (v == null) return '—';
  if (v instanceof ArrayBuffer) return `[binary ${v.byteLength}b]`;
  if (ArrayBuffer.isView(v)) return `[binary ${v.byteLength ?? v.length}b]`;
  if (v instanceof Date) return v.toLocaleString();
  if (Array.isArray(v)) {
    const parts = v.slice(0, 12).map(fmtVal);
    return parts.join(', ') + (v.length > 12 ? ` … +${v.length - 12}` : '');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export async function showExif(fileid, name) {
  exifTitleEl.textContent = name ?? 'EXIF';
  exifListEl.innerHTML = '';
  exifPanel.classList.add('open', 'loading');

  try {
    let data;
    const isHeic = /\.heic$/i.test(name ?? '');

    if (isHeic) {
      const tiff = await fetchHeicExifTiff(fileid);
      if (tiff) {
        data = await exifr.parse(new Uint8Array(tiff), {
          ifd0: true, ifd1: true, exif: true, gps: true, interop: true,
          translateKeys: true, translateValues: true, reviveValues: true,
          mergeOutput: true, unknown: true,
        });
      }
    } else {
      const buf = await fetchFileHead(fileid, 131072);
      data = await exifr.parse(new Uint8Array(buf), { all: true });
    }

    exifPanel.classList.remove('loading');

    const entries = data
      ? Object.entries(data).filter(([k]) => k !== 'errors')
      : [];

    if (!entries.length) {
      exifListEl.innerHTML = '<p class="exif-empty">No EXIF data found.</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const [key, val] of entries) {
      const row = document.createElement('div');
      row.className = 'exif-row';
      const k = document.createElement('span');
      k.className = 'exif-key';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = 'exif-val';
      v.textContent = fmtVal(val);
      row.appendChild(k);
      row.appendChild(v);
      frag.appendChild(row);
    }
    exifListEl.appendChild(frag);
  } catch (e) {
    exifPanel.classList.remove('loading');
    exifListEl.innerHTML = `<p class="exif-empty">Error: ${e.message}</p>`;
  }
}
