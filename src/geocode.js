export async function searchLocation(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
  const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!resp.ok) throw new Error(`Search failed: ${resp.status}`);
  const data = await resp.json();
  return data.map(r => ({
    label: r.display_name.split(',').slice(0, 3).join(',').trim(),
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    // Nominatim's own [south, north, west, east], as strings — lets a
    // caller fit the map to a place's actual extent (a country needs a
    // much wider view than a street address) instead of one fixed zoom
    // for every result. null when Nominatim doesn't provide one.
    boundingBox: Array.isArray(r.boundingbox) ? r.boundingbox.map(Number) : null,
  }));
}
