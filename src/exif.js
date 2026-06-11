import exifr from 'exifr';

// Returns {lat, lng} or null if the buffer contains no GPS data.
export async function extractGPS(buffer) {
  try {
    const gps = await exifr.gps(buffer);
    if (gps?.latitude == null || gps?.longitude == null) return null;
    return { lat: gps.latitude, lng: gps.longitude };
  } catch {
    return null;
  }
}
