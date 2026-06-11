# SharPho

A PWA and Android app that plots your pCloud photo library on an interactive map using GPS coordinates from image EXIF data.

## Features

- **Direct pCloud login** — email/password with two-factor authentication support; no OAuth app registration required
- **Folder selection** — scan your entire library or pick a specific folder
- **Efficient scanning** — fetches only the first 128 KB of each JPEG to read EXIF, no full downloads; up to 6 concurrent requests
- **Date filter** — two-slider panel to show only photos taken within a chosen time range
- **Persistent cache** — GPS coordinates and photo dates are stored in IndexedDB; subsequent opens are instant and interrupted scans resume automatically
- **Marker clustering** — photos are grouped at low zoom levels for readability
- **Thumbnail popups** — tap a marker to see a preview; tap the thumbnail to open a fullscreen lightbox (2048 px)
- **Scan status bar** — live counter of scanned/geotagged files during a scan
- **Overflow menu (⋮)** — Erase cache, Rescan, Local test, Date filter, Debug log, Disconnect
- **Android APK** — native app via Capacitor; latest debug build always available in [Releases](../../releases)
- **Installable PWA** — add to home screen on Android and iOS

## Stack

| | |
|---|---|
| [Vite](https://vitejs.dev/) | build tool |
| [Capacitor 8](https://capacitorjs.com/) | Android wrapper |
| [Leaflet](https://leafletjs.com/) + [leaflet.markercluster](https://github.com/Libs/Leaflet.markercluster) | map and clustering |
| [exifr](https://github.com/MikeKovarik/exifr) | EXIF / GPS / date parsing |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB wrapper |
| [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) | service worker and manifest |

## Getting started (web)

```bash
npm install
npm run dev
```

Open `http://localhost:5173`, sign in with your pCloud credentials, and the app will start scanning your library.

> **EU datacenter only.** The app points to `eapi.pcloud.com`. If your account is on the US datacenter, change `DEFAULT_HOST` in `src/auth.js`.

## Android APK

The [GitHub Actions workflow](.github/workflows/android.yml) builds a debug APK on every push to `main` and publishes it to the [latest release](../../releases/tag/latest).

To install: download `SharPho.apk`, open it on your device, and enable *Install from unknown sources* when prompted.

To build locally:

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

Requires Node 22+ and Java 21+.

## Web proxy (optional)

The web PWA cannot call `getfilelink` directly because browsers send an `Origin` header that pCloud blocks. A [Cloudflare Worker](worker/index.js) acts as a server-side proxy to strip that header.

Deploy your own worker and set `VITE_PROXY_URL` in your build environment. Without it the web version can still log in and list folders, but EXIF extraction is skipped (the Android app is not affected — it uses native HTTP with no `Origin` header).

