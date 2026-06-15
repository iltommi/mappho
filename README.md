# SharPho

An Android app (Capacitor 8) that plots your pCloud photo library on an interactive map using GPS EXIF data, with a slideshow for untagged photos and a built-in geotagging tool.

## Features

- **Direct pCloud login** — email/password with two-factor authentication; no OAuth required
- **Folder selection** — scan your entire library or pick a specific folder
- **Efficient scanning** — fetches only the first 128 KB of each JPEG to read EXIF; up to 6 concurrent requests; interrupted scans resume from cache
- **Interactive map** — markers clustered at low zoom; tap a cluster to open a slideshow of all photos in the group
- **Thumbnail popups** — tap a marker to preview; tap the thumbnail to open a fullscreen zoomable lightbox (pinch-to-zoom, up to 8×)
- **Date filter** — two-slider panel to narrow markers to a chosen time range
- **No Location slideshow** — lazy-paginated slideshow of all photos without GPS, sorted by date
- **Geotagging** — from the No Location slideshow, tap *📍 Set location* to drop a draggable pin on the map; the app shows the nearest geotagged photo by time as a placement hint, downloads the full JPEG, injects GPS EXIF via piexifjs, and overwrites the file on pCloud
- **pCloud backup / restore** — export the full IndexedDB cache to `sharpho.json` in your pCloud root; restore it on another device without rescanning
- **Scan status bar** — live counter of scanned / geotagged files; tracks photos tagged manually in the current session
- **Persistent cache** — GPS coordinates and dates stored in IndexedDB; app opens instantly without rescanning
- **Over-the-air updates** — APK is signed with a stable release key; install new versions directly over the previous one without uninstalling

## Stack

| | |
|---|---|
| [Vite](https://vitejs.dev/) | build tool |
| [Capacitor 8](https://capacitorjs.com/) | Android wrapper (all HTTP via OkHttp — no CORS) |
| [Leaflet](https://leafletjs.com/) + [leaflet.markercluster](https://github.com/Libs/Leaflet.markercluster) | map and clustering |
| [exifr](https://github.com/MikeKovarik/exifr) | EXIF / GPS / date parsing |
| [piexifjs](https://github.com/hMatoba/piexifjs) | GPS EXIF injection |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB wrapper |
| [@panzoom/panzoom](https://github.com/timmywil/panzoom) | lightbox pinch-to-zoom |
| [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) | service worker and manifest |

## Getting started

```bash
npm install
npm run build
npx cap sync android
```

Requires Node 22+ and Java 21+.

> **EU datacenter only.** The app points to `eapi.pcloud.com`. If your account is on the US datacenter, change `DEFAULT_HOST` in `src/auth.js`.

## Android APK

The [GitHub Actions workflow](.github/workflows/android.yml) builds a **signed release APK** on every push to `main` and publishes it to the [latest release](../../releases/tag/latest).

To install: download `SharPho.apk`, open it on your device, and enable *Install from unknown sources* when prompted. Subsequent installs update the app in place (no uninstall needed).

To build locally:

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
```

Signing requires four env vars (or GitHub secrets for CI): `KEYSTORE_FILE`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

### Setting up signing secrets (one-time)

**1. Generate the keystore**
```bash
keytool -genkeypair -v \
  -keystore sharpho.keystore \
  -alias sharpho \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```
Keep `sharpho.keystore` safe — losing it means you can't publish updates to the same app identity.

**2. Base64-encode the keystore**
```bash
base64 -i sharpho.keystore | pbcopy   # macOS — copies to clipboard
```

**3. Add the four GitHub secrets**

Go to **repo → Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | base64 string from step 2 |
| `KEYSTORE_PASSWORD` | password chosen during keytool prompt |
| `KEY_ALIAS` | `sharpho` (or whatever alias you used) |
| `KEY_PASSWORD` | key password (often the same as keystore password) |

The CI workflow decodes `KEYSTORE_BASE64` back to a file and passes the other three to Gradle for signing.
