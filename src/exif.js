import exifr from 'exifr';

// Returns { lat, lng, ts } — any field may be absent if not in EXIF.
export async function extractEXIF(buffer) {
  try {
    const data = await exifr.parse(buffer);
    if (!data) return {};
    const result = {};
    if (data.latitude != null && data.longitude != null) {
      result.lat = data.latitude;
      result.lng = data.longitude;
    }
    const d = data.DateTimeOriginal ?? data.DateTime;
    if (d instanceof Date && !isNaN(d)) result.ts = d.getTime();
    return result;
  } catch {
    return {};
  }
}
