import exifr from 'exifr';
import piexif from 'piexifjs';

// Returns { lat, lng, ts } — any field may be absent if not in EXIF.
export async function extractEXIF(buffer) {
  const result = {};

  try {
    const gps = await exifr.gps(buffer);
    if (gps?.latitude != null && gps?.longitude != null) {
      result.lat = gps.latitude;
      result.lng = gps.longitude;
    }
  } catch { /* no GPS */ }

  try {
    const tags = await exifr.parse(buffer, { exif: true, tiff: false, gps: false,
      pick: ['DateTimeOriginal', 'DateTime', 'DateTimeDigitized'] });
    const d = tags?.DateTimeOriginal ?? tags?.DateTime ?? tags?.DateTimeDigitized;
    if (d instanceof Date && !isNaN(d)) result.ts = d.getTime();
  } catch { /* no date */ }

  return result;
}

// Try to extract a Unix timestamp from a filename like 2024-01-15_14-30-22_anything.jpg
export function parseDateFromFilename(name) {
  const m = name.match(/(\d{4})-(\d{2})-(\d{2})[_T ](\d{2})[-:](\d{2})[-:](\d{2})/);
  if (!m) return null;
  const dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(dt.getTime()) ? null : dt.getTime();
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
