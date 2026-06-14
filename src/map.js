import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import 'leaflet.heat';
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

let map;
let cluster;
let heatLayer = null;
let heatmapActive = false;
const addedIds = new Set();
const markerIndex = []; // { marker, ts }
const markerData = new Map(); // marker -> { fileid, name, ts }

let pinDropMarker = null;
let pinDropHandler = null;
let pinDropOnPlace = null;

const PIN_ICON = L.icon({
  iconUrl: 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36" viewBox="0 0 24 36">' +
    '<path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z" fill="#e74c3c"/>' +
    '<circle cx="12" cy="12" r="5" fill="white"/></svg>'
  ),
  iconSize: [24, 36], iconAnchor: [12, 36],
});

function placePinAt(lat, lng) {
  if (pinDropMarker) {
    pinDropMarker.setLatLng([lat, lng]);
  } else {
    pinDropMarker = L.marker([lat, lng], { draggable: true, icon: PIN_ICON }).addTo(map);
    pinDropMarker.on('drag', ev => pinDropOnPlace?.({ lat: ev.latlng.lat, lng: ev.latlng.lng }));
    pinDropMarker.on('dragend', ev => pinDropOnPlace?.({ lat: ev.target.getLatLng().lat, lng: ev.target.getLatLng().lng }));
  }
}

export function enterPinDropMode({ center, initialPin, onPlace }) {
  pinDropOnPlace = onPlace;
  map.getContainer().style.cursor = 'crosshair';

  if (initialPin) {
    map.setView([initialPin.lat, initialPin.lng], 14);
    placePinAt(initialPin.lat, initialPin.lng);
  } else if (center) {
    map.setView([center.lat, center.lng], 14);
  }

  pinDropHandler = e => {
    const { lat, lng } = e.latlng;
    placePinAt(lat, lng);
    pinDropOnPlace?.({ lat, lng });
  };
  map.on('click', pinDropHandler);
}

export function exitPinDropMode() {
  if (pinDropHandler) { map.off('click', pinDropHandler); pinDropHandler = null; }
  if (pinDropMarker)  { map.removeLayer(pinDropMarker); pinDropMarker = null; }
  map.getContainer().style.cursor = '';
  pinDropOnPlace = null;
}

export function initMap() {
  map = L.map('map').setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  cluster = L.markerClusterGroup({ chunkedLoading: true, zoomToBoundsOnClick: false });
  cluster.on('clusterclick', e => {
    const children = e.layer.getAllChildMarkers();
    log('clusterclick', `${children.length} child markers, markerData size=${markerData.size}`);
    const photos = children.map(m => markerData.get(m)).filter(Boolean);
    log('clusterclick', `${photos.length} photos resolved`);
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
        img.onerror = () => {
          log('thumb img error', `len=${src.length}`);
          img.remove();
          const errEl = document.createElement('p');
          errEl.className = 'popup-error';
          errEl.textContent = 'Preview unavailable';
          div.insertBefore(errEl, caption);
          marker.getPopup()?.update();
        };
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', () => openLightbox(fileid, name));
        div.insertBefore(img, caption);
      }
      marker.getPopup()?.update();
    }).catch(() => {
      loading.remove();
      const errEl = document.createElement('p');
      errEl.className = 'popup-error';
      errEl.textContent = 'Preview unavailable';
      div.insertBefore(errEl, caption);
      marker.getPopup()?.update();
    });
  });

  marker.bindPopup(div, { maxWidth: 280 });
  cluster.addLayer(marker);
  markerIndex.push({ marker, ts: ts ?? null });
  markerData.set(marker, { fileid, name, ts: ts ?? null });
  if (heatmapActive && heatLayer) heatLayer.addLatLng([lat, lng]);
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
  if (heatmapActive && heatLayer) {
    const pts = markerIndex
      .filter(({ marker }) => cluster.hasLayer(marker))
      .map(({ marker }) => { const ll = marker.getLatLng(); return [ll.lat, ll.lng]; });
    heatLayer.setLatLngs(pts);
  }
}

export function clearMarkers() {
  cluster.clearLayers();
  addedIds.clear();
  markerIndex.length = 0;
  markerData.clear();
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  heatmapActive = false;
}

export function toggleHeatmap() {
  heatmapActive = !heatmapActive;
  if (heatmapActive) {
    map.removeLayer(cluster);
    const pts = markerIndex.map(({ marker }) => {
      const ll = marker.getLatLng(); return [ll.lat, ll.lng];
    });
    heatLayer = L.heatLayer(pts, { radius: 28, blur: 18, maxZoom: 17 }).addTo(map);
  } else {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    map.addLayer(cluster);
  }
  return heatmapActive;
}

// Returns { min, max } timestamps across all dated markers, or null if none.
export function getDateRange() {
  const dated = markerIndex.map(m => m.ts).filter(t => t != null);
  if (dated.length === 0) return null;
  return { min: Math.min(...dated), max: Math.max(...dated) };
}
