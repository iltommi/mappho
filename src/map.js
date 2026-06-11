import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import 'leaflet.markercluster';
import { fetchThumbSrc } from './pcloud.js';

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

export function initMap() {
  const map = L.map('map').setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);

  cluster = L.markerClusterGroup({ chunkedLoading: true });
  map.addLayer(cluster);
}

export function addMarker({ fileid, name, lat, lng }) {
  const marker = L.marker([lat, lng]);
  marker.bindPopup(() => {
    const div = document.createElement('div');
    div.className = 'photo-popup';
    div.innerHTML = '<p class="popup-loading">Loading…</p>';
    const showContent = (src) => {
      div.innerHTML = '';
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = name;
        img.onload = () => marker.getPopup()?.update();
        div.appendChild(img);
      }
      const caption = document.createElement('p');
      caption.textContent = name;
      div.appendChild(caption);
      marker.getPopup()?.update();
    };
    fetchThumbSrc(fileid).then(showContent).catch(() => showContent(null));
    return div;
  }, { maxWidth: 280 });
  cluster.addLayer(marker);
}
