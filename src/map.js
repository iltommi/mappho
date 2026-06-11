import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import { fetchThumbSrc } from './pcloud.js';
import { log } from './log.js';
import { openLightbox } from './lightbox.js';
import { openSlideshow } from './slideshow.js';

// Fix Leaflet's default icon path broken by Vite's asset hashing.
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

let cluster;
const addedIds = new Set();
const markerIndex = []; // { marker, ts }
const markerData = new Map(); // marker -> { fileid, name }

export function initMap() {
  const map = L.map('map').setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  cluster = L.markerClusterGroup({ chunkedLoading: true, zoomToBoundsOnClick: false });
  cluster.on('clusterclick', e => {
    const photos = e.layer.getAllChildMarkers()
      .map(m => markerData.get(m))
      .filter(Boolean);
    openSlideshow(photos);
  });
  map.addLayer(cluster);
}

export function addMarker({ fileid, name, lat, lng, ts }) {
  if (addedIds.has(fileid)) return;
  addedIds.add(fileid);
  const marker = L.marker([lat, lng]);

  const div = document.createElement('div');
  div.className = 'photo-popup';
  const caption = document.createElement('p');
  caption.textContent = name;
  div.appendChild(caption);

  let fetched = false;
  marker.on('popupopen', () => {
    if (fetched) return;
    fetched = true;

    const loading = document.createElement('p');
    loading.className = 'popup-loading';
    loading.textContent = 'Loading…';
    div.insertBefore(loading, caption);

    fetchThumbSrc(fileid).then(src => {
      loading.remove();
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = name;
        img.onload = () => marker.getPopup()?.update();
        img.onerror = () => log('thumb img error', `len=${src.length}`);
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => openLightbox(fileid, name));
        div.insertBefore(img, caption);
      }
      marker.getPopup()?.update();
    }).catch(() => {
      loading.remove();
      marker.getPopup()?.update();
    });
  });

  marker.bindPopup(div, { maxWidth: 280 });
  cluster.addLayer(marker);
  markerIndex.push({ marker, ts: ts ?? null });
  markerData.set(marker, { fileid, name });
}

// Show only markers whose ts falls within [fromTs, toTs].
// Markers with no date are always shown.
export function filterMarkers(fromTs, toTs) {
  for (const { marker, ts } of markerIndex) {
    const visible = ts == null || (ts >= fromTs && ts <= toTs);
    if (visible) {
      if (!cluster.hasLayer(marker)) cluster.addLayer(marker);
    } else {
      cluster.removeLayer(marker);
    }
  }
}

export function clearMarkers() {
  cluster.clearLayers();
  addedIds.clear();
  markerIndex.length = 0;
  markerData.clear();
}

// Returns { min, max } timestamps across all dated markers, or null if none.
export function getDateRange() {
  const dated = markerIndex.map(m => m.ts).filter(t => t != null);
  if (dated.length === 0) return null;
  return { min: Math.min(...dated), max: Math.max(...dated) };
}
