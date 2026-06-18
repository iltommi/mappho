export async function searchLocation(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
  const resp = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  if (!resp.ok) throw new Error(`Search failed: ${resp.status}`);
  const data = await resp.json();
  return data.map(r => ({
    label: r.display_name.split(',').slice(0, 3).join(',').trim(),
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }));
}
