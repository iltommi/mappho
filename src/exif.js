import exifr from 'exifr';

// Returns { lat, lng, ts } — any field may be absent if not in EXIF.
export async function extractEXIF(buffer) {
  const result = {};

  // Use exifr.gps() for coordinates — it's the explicit high-level API that
  // was already proven to work, avoiding any mergeOutput/translateValues ambiguity.
  try {
    const gps = await exifr.gps(buffer);
    if (gps?.latitude != null && gps?.longitude != null) {
      result.lat = gps.latitude;
      result.lng = gps.longitude;
    }
  } catch { /* no GPS */ }

  // Separate targeted parse for the date.
  try {
    const tags = await exifr.parse(buffer, { exif: true, tiff: false, gps: false,
      pick: ['DateTimeOriginal', 'DateTime', 'DateTimeDigitized'] });
    const d = tags?.DateTimeOriginal ?? tags?.DateTime ?? tags?.DateTimeDigitized;
    if (d instanceof Date && !isNaN(d)) result.ts = d.getTime();
  } catch { /* no date */ }

  return result;
}
