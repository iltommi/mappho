import exifr from 'exifr';
import piexif from 'piexifjs';
import { fetchFileHead, fetchFileRange, getFileFullPath } from './pcloud.js';
import { viewOpened, viewClosed } from './nav.js';

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
      if (d instanceof Date && !isNaN(d) && d.getFullYear() >= 1900 && d.getFullYear() <= 2100) result.ts = d.getTime();
    } catch { /* no date */ }
  }

  // Fallback: parse date from filename (e.g. 20250710_202139.heic, 2024-01-15_14-30-22.jpg)
  if (!result.ts && name) {
    const ts = parseDateFromFilename(name);
    if (ts) result.ts = ts;
  }

  return result;
}

// Range-checked date builder: new Date() would silently roll over invalid
// months/days (2025-99-01 → mid-2033, but also less obviously Feb 30 → Mar
// 1/2 — the day-of-month bound above is a fixed 31 since it can't know each
// month's actual length), turning random digit runs into dates. The
// round-trip check below catches that: an impossible calendar date never
// reads back as what was asked for.
export function tsFromParts(y, mo, d, h = 0, mi = 0, s = 0) {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, s);
  if (isNaN(dt)) return null;
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}

// Try to extract a Unix timestamp from filenames like:
//   2024-01-15_14-30-22_anything.jpg
//   20240613_121250.jpg
export function parseDateFromFilename(name) {
  // Full datetime: 2024-01-15_14-30-22 or 20240613_121250
  let m = name.match(/(\d{4})-(\d{2})-(\d{2})[_T ](\d{2})[-:](\d{2})[-:](\d{2})/);
  let ts = m && tsFromParts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  if (ts) return ts;
  m = name.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  ts = m && tsFromParts(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  if (ts) return ts;
  // Date only: 2024-06-13_001.jpg — midnight, no time info
  m = name.match(/(\d{4})-(\d{2})-(\d{2})_/);
  ts = m && tsFromParts(+m[1], +m[2], +m[3]);
  if (ts) return ts;
  // Date only compact: IMG-20240613-* — 8-digit block between non-digit separators
  m = name.match(/[^0-9](\d{4})(\d{2})(\d{2})[^0-9]/);
  ts = m && tsFromParts(+m[1], +m[2], +m[3]);
  if (ts) return ts;
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

// Wraps a HEIC's raw TIFF/EXIF bytes (from fetchHeicExifTiff) with the
// "Exif\0\0" header piexif.load() requires to recognise standalone TIFF data
// rather than a full JPEG. The result is directly usable as injectExif's
// preserveFrom, so a HEIC→JPEG conversion (geotag/fix-date) carries forward
// the original's full EXIF — make/model, exposure, lens, GPS altitude, etc.
// — the same way a JPEG-to-JPEG edit does, instead of losing everything but
// whatever fields the caller explicitly re-injects.
export async function fetchHeicExifForPreserve(fileid) {
  try {
    const tiff = await fetchHeicExifTiff(fileid);
    if (!tiff) return null;
    const tiffBytes = new Uint8Array(tiff);
    const out = new Uint8Array(tiffBytes.length + 6);
    out.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0); // "Exif\0\0"
    out.set(tiffBytes, 6);
    return out.buffer;
  } catch { return null; }
}

function fmtExifDate(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth()+1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function bufferToBinary(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return binary;
}

// Inject GPS, date, make and model into a JPEG ArrayBuffer.
// Pass resetOrientation:true only for canvas-produced JPEGs (pixels already
// upright); on original camera files it would clobber a real rotation tag.
// Pass preserveFrom (the pre-edit original file's ArrayBuffer) when
// `jpegBuffer` was itself produced by re-encoding through a canvas — canvas
// output carries no EXIF of its own, so without this every camera tag
// (make/model, exposure, lens, GPS altitude, ...) would be silently lost on
// every edit instead of just the handful of fields this function sets.
export function injectExif(jpegBuffer, { lat, lng, ts, make, model, resetOrientation = false, preserveFrom = null } = {}) {
  const binary = bufferToBinary(jpegBuffer);

  // Fails here with a clear, correctly-classified message instead of
  // reaching piexif.insert() below for its own generic "Given data isn't
  // JPEG." — this has been observed for a file that's a perfectly valid
  // JPEG on pCloud, caused by a transient CDN hiccup upstream (see
  // pcloud.js's assertOkCdnResponse) handing back an error body in place of
  // the actual bytes. Checking the SOI marker up front, before any of the
  // EXIF work, makes that distinction obvious in the log rather than
  // looking like file corruption.
  if (binary.slice(0, 2) !== '\xff\xd8') {
    const head = new Uint8Array(jpegBuffer.slice(0, 8));
    const hex = Array.from(head, b => b.toString(16).padStart(2, '0')).join(' ');
    throw new Error(`injectExif: input isn't a JPEG (no FFD8 marker, got bytes: ${hex || '(empty)'}) — likely a corrupted/incomplete download rather than a bad file`);
  }

  let exifObj = null;
  if (preserveFrom) {
    try { exifObj = piexif.load(bufferToBinary(preserveFrom)); } catch { /* fall through */ }
    if (exifObj) {
      // The embedded EXIF thumbnail (IFD1) is a separate mini preview JPEG —
      // carrying it through unchanged would show the pre-edit image in any
      // viewer that renders it instead of the main image.
      exifObj['1st'] = {};
      exifObj['thumbnail'] = null;
    }
  }
  if (!exifObj) {
    try   { exifObj = piexif.load(binary); }
    catch { exifObj = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {} }; }
  }

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
  if (resetOrientation) exifObj['0th'][piexif.ImageIFD.Orientation] = 1;

  let exifBytes;
  try {
    exifBytes = piexif.dump(exifObj);
  } catch (e) {
    // A preserved original's EXIF can in principle be malformed or too large
    // for piexifjs to re-dump (e.g. an oversized MakerNote) — fall back to
    // just the fields this call actually set rather than failing the save.
    if (!preserveFrom) throw e;
    const minimal = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {} };
    if (lat != null && lng != null) {
      minimal.GPS[piexif.GPSIFD.GPSLatitudeRef]  = lat >= 0 ? 'N' : 'S';
      minimal.GPS[piexif.GPSIFD.GPSLatitude]     = toDMS(Math.abs(lat));
      minimal.GPS[piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
      minimal.GPS[piexif.GPSIFD.GPSLongitude]    = toDMS(Math.abs(lng));
    }
    if (ts) {
      const dateStr = fmtExifDate(ts);
      if (dateStr) {
        minimal['0th'][piexif.ImageIFD.DateTime]         = dateStr;
        minimal['Exif'][piexif.ExifIFD.DateTimeOriginal]  = dateStr;
        minimal['Exif'][piexif.ExifIFD.DateTimeDigitized] = dateStr;
      }
    }
    if (resetOrientation) minimal['0th'][piexif.ImageIFD.Orientation] = 1;
    exifBytes = piexif.dump(minimal);
  }
  const modified  = piexif.insert(exifBytes, binary);
  const out = new Uint8Array(modified.length);
  for (let i = 0; i < modified.length; i++) out[i] = modified.charCodeAt(i);
  return out.buffer;
}

// Inject GPS coordinates into a JPEG ArrayBuffer, return new ArrayBuffer.
export function injectGPS(buffer, lat, lng) {
  return injectExif(buffer, { lat, lng });
}

export function toDMS(decimal) {
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

function closeExifPanel() {
  exifPanel.classList.remove('open');
  viewClosed('exif');
}

exifCloseBtn.addEventListener('click', closeExifPanel);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && exifPanel.classList.contains('open')) closeExifPanel();
});

// Fixed DD/MM/YYYY HH:MM:SS regardless of device locale (which could give
// M/D/YYYY, AM/PM on an en-US device) — matches the rest of the app.
function fmtDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtVal(v) {
  if (v == null) return '—';
  if (v instanceof ArrayBuffer) return `[binary ${v.byteLength}b]`;
  if (ArrayBuffer.isView(v)) return `[binary ${v.byteLength ?? v.length}b]`;
  if (v instanceof Date) return fmtDate(v);
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
  viewOpened('exif', { close: closeExifPanel });

  try {
    const [pathResult, exifData] = await Promise.allSettled([
      getFileFullPath(fileid),
      (async () => {
        const isHeic = /\.heic$/i.test(name ?? '');
        if (isHeic) {
          const tiff = await fetchHeicExifTiff(fileid);
          if (!tiff) return null;
          return exifr.parse(new Uint8Array(tiff), {
            ifd0: true, ifd1: true, exif: true, gps: true, interop: true,
            translateKeys: true, translateValues: true, reviveValues: true,
            mergeOutput: true, unknown: true,
          });
        }
        const buf = await fetchFileHead(fileid, 131072);
        return exifr.parse(new Uint8Array(buf), { all: true });
      })(),
    ]);

    exifPanel.classList.remove('loading');

    const frag = document.createDocumentFragment();

    // Path row — always shown at the top.
    const pathRow = document.createElement('div');
    pathRow.className = 'exif-row exif-path-row';
    const pathKey = document.createElement('span');
    pathKey.className = 'exif-key';
    pathKey.textContent = 'pCloud path';
    const pathVal = document.createElement('span');
    pathVal.className = 'exif-val';
    pathVal.textContent = pathResult.status === 'fulfilled' ? pathResult.value : '—';
    pathRow.appendChild(pathKey);
    pathRow.appendChild(pathVal);
    frag.appendChild(pathRow);

    const data = exifData.status === 'fulfilled' ? exifData.value : null;
    const { latitude, longitude } = data ?? {};
    if (typeof latitude === 'number' && typeof longitude === 'number' &&
        !isNaN(latitude) && !isNaN(longitude)) {
      const mapRow = document.createElement('div');
      mapRow.className = 'exif-row exif-map-row';
      const mapLink = document.createElement('a');
      mapLink.className = 'exif-map-link';
      mapLink.href = `https://www.google.com/maps?q=${latitude},${longitude}`;
      mapLink.target = '_blank';
      mapLink.rel = 'noopener noreferrer';
      mapLink.textContent = 'Open in Google Maps';
      mapRow.appendChild(mapLink);
      frag.appendChild(mapRow);
    }

    const entries = data ? Object.entries(data).filter(([k]) => k !== 'errors') : [];

    if (!entries.length) {
      const empty = document.createElement('p');
      empty.className = 'exif-empty';
      empty.textContent = 'No EXIF data found.';
      frag.appendChild(empty);
    } else {
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
    }

    exifListEl.appendChild(frag);
  } catch (e) {
    exifPanel.classList.remove('loading');
    exifListEl.innerHTML = `<p class="exif-empty">Error: ${e.message}</p>`;
  }
}
