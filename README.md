# SharPho — [live app](https://iltommi.github.io/sharpho)

A Progressive Web App that plots your pCloud photo library on an interactive map using GPS coordinates embedded in image EXIF data.

## Features

- **Direct pCloud login** — no OAuth app registration required
- **Efficient scanning** — fetches only the first 128 KB of each JPEG to read EXIF, no full downloads
- **Persistent cache** — GPS data is stored in IndexedDB so subsequent visits are instant; only new photos are re-fetched
- **Marker clustering** — photos are grouped on the map at low zoom levels for readability
- **Thumbnail popups** — clicking a marker shows a preview served directly by pCloud
- **Installable PWA** — add to home screen on Android and iOS for a native-app feel

## Stack

- [Vite](https://vitejs.dev/) — build tool
- [Leaflet](https://leafletjs.com/) + [leaflet.markercluster](https://github.com/Libs/Leaflet.markercluster) — map and clustering
- [exifr](https://github.com/MikeKovarik/exifr) — EXIF / GPS parsing
- [idb](https://github.com/jakearchibald/idb) — IndexedDB wrapper
- [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) — service worker and manifest

## Getting started

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, sign in with your pCloud credentials, and the app will start scanning your library.

> The app is configured for the **EU datacenter** (`eapi.pcloud.com`). If your account is on the US datacenter, change `DEFAULT_HOST` in `src/auth.js`.

## Deployment

The included GitHub Actions workflow ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) builds and deploys to GitHub Pages automatically on every push to `main`.

Enable it under **Settings → Pages → Source → GitHub Actions**.
