import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import 'leaflet.heat';
import { fetchThumbSrc } from './pcloud.js';
import { deleteRecord, deleteOrphan } from './db.js';
import { isVideo } from './mp4.js';
import { log } from './log.js';
import { openSlideshow, setGeotagHandler, setFixDateHandler, setIgnoreHandler } from './slideshow.js';
import { openGrid } from './grid.js';

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

// Gradient shared by leaflet.heat and the legend bar — keys are 0–1 intensity.
const HEAT_GRADIENT = { 0.0: '#60a5fa', 0.3: '#34d399', 0.6: '#fbbf24', 0.85: '#f97316', 1.0: '#ef4444' };

let map;
let cluster;
let heatLayer     = null;
let heatmapActive = false;
let heatPoints    = []; // [lat, lng] pairs currently fed to the heat layer
const addedIds = new Set();
const markerIndex = []; // { marker, ts, name }
const markerData = new Map(); // marker -> { fileid, name, ts }

let _dateFilter  = { fromTs: -Infinity, toTs: Infinity };
let _mediaType   = 'all'; // 'all' | 'photos' | 'videos'

function _isVisible({ ts, name }) {
  const dateOk = ts == null || (ts >= _dateFilter.fromTs && ts <= _dateFilter.toTs);
  const typeOk = _mediaType === 'all'
    || (_mediaType === 'photos' && !isVideo(name))
    || (_mediaType === 'videos' &&  isVideo(name));
  return dateOk && typeOk;
}

function _applyVisibility() {
  for (const entry of markerIndex) {
    if (_isVisible(entry)) {
      if (!cluster.hasLayer(entry.marker)) cluster.addLayer(entry.marker);
    } else {
      cluster.removeLayer(entry.marker);
    }
  }
  if (heatmapActive && heatLayer) {
    heatPoints = markerIndex
      .filter(e => cluster.hasLayer(e.marker))
      .map(({ marker }) => { const ll = marker.getLatLng(); return [ll.lat, ll.lng]; });
    heatLayer.setLatLngs(heatPoints);
  }
}

let pinDropMarker = null;
let pinDropHandler = null;
let pinDropOnPlace = null;

let _pickDateListener = null;

export function enterPickDateMode(onPick) {
  _pickDateListener = e => {
    const iconEl = e.target.closest('.leaflet-marker-icon');
    if (!iconEl) return;
    for (const { marker, ts, name } of markerIndex) {
      if (marker._icon === iconEl && ts) {
        e.stopPropagation();
        exitPickDateMode();
        onPick({ ts, name });
        return;
      }
    }
  };
  map.getContainer().addEventListener('click', _pickDateListener, { capture: true });
  map.getContainer().style.cursor = 'crosshair';
}

export function exitPickDateMode() {
  if (!_pickDateListener) return;
  map.getContainer().removeEventListener('click', _pickDateListener, { capture: true });
  _pickDateListener = null;
  map.getContainer().style.cursor = '';
}

let markerGeotagHandler = null;
export function setMarkerGeotagHandler(fn) { markerGeotagHandler = fn; }

let markerFixDateHandler = null;
export function setMarkerFixDateHandler(fn) { markerFixDateHandler = fn; }

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

export function flyToAndPlacePin(lat, lng) {
  map.flyTo([lat, lng], 13);
  placePinAt(lat, lng);
  pinDropOnPlace?.({ lat, lng });
}

export function initMap() {
  map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  cluster = L.markerClusterGroup({
    chunkedLoading: true,
    zoomToBoundsOnClick: false,
    showCoverageOnHover: false,
    iconCreateFunction(c) {
      const n    = c.getChildCount();
      const xl   = n > 9999;
      const tier = n < 10 ? 'small' : n < 100 ? 'medium' : 'large';
      const size = xl ? 56 : 40;
      return L.divIcon({
        html: `<div><span>${n}</span></div>`,
        className: `marker-cluster marker-cluster-${tier}${xl ? ' marker-cluster-xl' : ''}`,
        iconSize: L.point(size, size),
      });
    },
  });

  let longPressTimer = null;
  let suppressNextClusterClick = false;
  let pressedClusterEl = null;
  let pressOrigin = null;

  map.getContainer().addEventListener('pointerdown', e => {
    const clusterEl = e.target.closest('.marker-cluster');
    if (!clusterEl) return;
    pressedClusterEl = clusterEl;
    pressOrigin = { x: e.clientX, y: e.clientY };
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      suppressNextClusterClick = true;
      cluster._featureGroup.eachLayer(layer => {
        if (layer._icon !== pressedClusterEl) return;
        const children = layer.getAllChildMarkers();
        const photos = children.map(m => markerData.get(m)).filter(Boolean)
          .sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));
        if (!photos.length) return;
        log('cluster long-press', `${photos.length} photos`);
        setIgnoreHandler(null);
        openGrid((offset, limit) => Promise.resolve(photos.slice(offset, offset + limit)), photos.length);
      });
    }, 500);
  }, { capture: true });

  map.getContainer().addEventListener('pointermove', e => {
    if (!longPressTimer || !pressOrigin) return;
    if (Math.hypot(e.clientX - pressOrigin.x, e.clientY - pressOrigin.y) > 10) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }, { capture: true });

  map.getContainer().addEventListener('pointerup', () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }, { capture: true });

  cluster.on('clusterclick', e => {
    if (suppressNextClusterClick) {
      suppressNextClusterClick = false;
      return;
    }
    if (map.getZoom() === map.getMaxZoom()) {
      e.layer.spiderfy();
    } else {
      e.layer.zoomToBounds({ padding: [20, 20] });
    }
  });
  map.addLayer(cluster);
}

function _buildMarker(fileid, name, lat, lng, ts) {
  const marker  = L.marker([lat, lng]);
  const div     = document.createElement('div');
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
        img.addEventListener('click', () => {
          setGeotagHandler(markerGeotagHandler);
          setFixDateHandler(markerFixDateHandler);
          openSlideshow([markerData.get(marker)], 0);
        });
        div.insertBefore(img, caption);
      }
      marker.getPopup()?.update();
    }).catch(e => {
      loading.remove();
      if (e.pcloudResult === 2009) {
        marker.closePopup();
        removeMarker(fileid);
        Promise.all([deleteRecord(fileid), deleteOrphan(fileid)]).catch(() => {});
        log('Purged stale marker', fileid);
        return;
      }
      const errEl = document.createElement('p');
      errEl.className = 'popup-error';
      errEl.textContent = 'Preview unavailable';
      div.insertBefore(errEl, caption);
      marker.getPopup()?.update();
    });
  });

  marker.bindPopup(div, { maxWidth: 280 });
  markerIndex.push({ marker, ts: ts ?? null, name });
  markerData.set(marker, { fileid, name, ts: ts ?? null });
  return marker;
}

export function addMarker({ fileid, name, lat, lng, ts }) {
  if (addedIds.has(fileid)) return;
  addedIds.add(fileid);
  const marker = _buildMarker(fileid, name, lat, lng, ts);
  cluster.addLayer(marker);
  if (heatmapActive && heatLayer) {
    heatLayer.addLatLng([lat, lng]);
    heatPoints.push([lat, lng]);
  }
}

// Bulk variant for startup — uses addLayers() so markercluster does a single
// cluster pass (with chunkedLoading) instead of 40k individual refreshes.
export function bulkAddMarkers(records) {
  const toAdd = [];
  for (const { fileid, name, lat, lng, ts } of records) {
    if (addedIds.has(fileid)) continue;
    addedIds.add(fileid);
    toAdd.push(_buildMarker(fileid, name, lat, lng, ts));
  }
  if (toAdd.length) cluster.addLayers(toAdd);
}

export function filterMarkers(fromTs, toTs) {
  _dateFilter = { fromTs, toTs };
  _applyVisibility();
}

const MEDIA_CYCLES = ['all', 'photos', 'videos'];

// Two emoji at 2rem side-by-side overflow the 48px button width slightly;
// overflow:hidden on the button clips them to the circle, giving each emoji its own half.
export const MEDIA_ALL_ICON = '<span class="mf-all">📷🎬</span>';

const MEDIA_LABELS = { all: MEDIA_ALL_ICON, photos: '📷', videos: '🎬' };

export function cycleMediaTypeFilter() {
  _mediaType = MEDIA_CYCLES[(MEDIA_CYCLES.indexOf(_mediaType) + 1) % MEDIA_CYCLES.length];
  _applyVisibility();
  return { type: _mediaType, label: MEDIA_LABELS[_mediaType], active: _mediaType !== 'all' };
}

export function removeMarker(fileid) {
  for (const [marker, data] of markerData) {
    if (data.fileid !== fileid) continue;
    cluster.removeLayer(marker);
    markerData.delete(marker);
    const idx = markerIndex.findIndex(m => m.marker === marker);
    if (idx !== -1) markerIndex.splice(idx, 1);
    addedIds.delete(fileid);
    if (heatmapActive && heatLayer) {
      const { lat, lng } = marker.getLatLng();
      const hi = heatPoints.findIndex(([a, b]) => a === lat && b === lng);
      if (hi !== -1) { heatPoints.splice(hi, 1); heatLayer.setLatLngs(heatPoints); }
    }
    return;
  }
}

export function updateMarkerName(fileid, newName) {
  for (const [marker, data] of markerData) {
    if (data.fileid !== fileid) continue;
    data.name = newName;
    const caption = marker.getPopup()?.getContent()?.querySelector?.('p:last-child');
    if (caption) caption.textContent = newName;
    return;
  }
}

export function clearMarkers() {
  cluster.clearLayers();
  addedIds.clear();
  markerIndex.length = 0;
  markerData.clear();
  heatPoints = [];
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
  heatmapActive = false;
  _dateFilter = { fromTs: -Infinity, toTs: Infinity };
  _mediaType  = 'all';
}

export function toggleHeatmap() {
  heatmapActive = !heatmapActive;
  if (heatmapActive) {
    map.removeLayer(cluster);
    heatPoints = markerIndex
      .filter(({ marker }) => cluster.hasLayer(marker))
      .map(({ marker }) => { const ll = marker.getLatLng(); return [ll.lat, ll.lng]; });
    heatLayer = L.heatLayer(heatPoints, {
      radius: 28, blur: 18, maxZoom: 17,
      minOpacity: 0.45,
      gradient: HEAT_GRADIENT,
    }).addTo(map);
  } else {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    heatPoints = [];
    map.addLayer(cluster);
  }
  return heatmapActive;
}

// Returns the geotagged marker closest in time to ts, with { lat, lng, name, ts, delta }.
// Uses the in-memory markerIndex so newly tagged photos are visible immediately.
export function findClosestMarker(ts) {
  if (ts == null) return null;
  let bestMarker = null, bestDiff = Infinity;
  for (const { marker, ts: mts } of markerIndex) {
    if (!mts) continue;
    const diff = Math.abs(mts - ts);
    if (diff < bestDiff) { bestDiff = diff; bestMarker = marker; }
  }
  if (!bestMarker) return null;
  const { lat, lng } = bestMarker.getLatLng();
  const data = markerData.get(bestMarker) ?? {};
  return { lat, lng, name: data.name, ts: data.ts, delta: bestDiff };
}

// Returns { min, max } timestamps across all dated markers, or null if none.
export function getDateRange() {
  const dated = markerIndex.map(m => m.ts).filter(t => t != null);
  if (dated.length === 0) return null;
  return { min: Math.min(...dated), max: Math.max(...dated) };
}
