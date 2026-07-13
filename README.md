# Mappho

An Android app (Capacitor 8) that plots your pCloud photo and video library on an interactive map using GPS EXIF/metadata, with grid and slideshow browsing, in-place editing, and tools for filling in missing location/date data.

## Features

- **Direct pCloud login** — email/password with two-factor authentication (optional "trust this device" to skip future codes); no OAuth required
- **Folder selection** — scan your entire library or pick specific folders
- **Efficient scanning** — fetches only the first 128 KB of each JPEG to read EXIF; concurrent requests with automatic retry; interrupted scans resume from cache
- **Interactive map** — markers clustered at low zoom, heatmap toggle, filter by media type (photo/video); tap a cluster to browse its photos in a grid, long-press for the same
- **Thumbnail popups** — tap a marker to preview; tap the thumbnail to open a fullscreen pinch-to-zoom lightbox (up to 8×, correctly anchored and able to zoom past any letterboxing)
- **Date filter** — two-slider panel to narrow markers to a chosen time range
- **Grid view** — virtualized thumbnail grid with fast-scroll scrubber; multi-select for bulk geotag / fix date / share / delete, plus a "Same day" helper that selects everything from the same day(s) as the current selection
- **Slideshow** — swipeable fullscreen photo/video browsing, lazily paginated over the whole library or any filtered subset (map cluster, People search, missing-location list, ...)
- **Geotagging** — drop a draggable pin on the map, single-photo or bulk; suggests a starting pin at the location of the nearest-in-time already-geotagged photo; search by place name (Nominatim); after saving, the slideshow resumes at the next photo so a tagging pass can move straight through a batch
- **Fix date / fix time** — same pin-drop-style flow as geotagging, single or bulk, for photos with a missing or wrong timestamp
- **Photo editing** — rotate, flip horizontal, auto-enhance, saved back to pCloud with the original EXIF (make/model, exposure, lens, ...) preserved, not just GPS/date
- **HEIC support** — reads EXIF from HEIC files directly; converts to JPEG on edit or date/location fix (via the WebView's native HEIC decoder), carrying the original EXIF over
- **Video support** — playback, thumbnail generation with rotation correction (from the MP4 `tkhd` matrix), and GPS/date tagging (stored as sidecar metadata, since MP4 containers don't carry EXIF)
- **People** — mirrors a companion face-recognition project's `faces.json`; search and multi-select people (AND filter) to browse their photos together, with face boxes overlaid in the slideshow
- **Flagging** — flag a photo in the slideshow as "has people, not tagged" for the face-recognition project to pick up later
- **Ignored photos** — hide photos from normal browsing without deleting them, with a dedicated view to review and restore
- **pCloud backup / restore** — the local photo index is mirrored to `Photos/index.json`; a fresh install restores from it without a full rescan
- **Persistent cache** — dates, GPS, hashes, and ignore/flag state stored in IndexedDB; app opens instantly without rescanning
- **Debug log** — in-app log panel, saveable/shareable, for diagnosing issues without a dev console
- **Over-the-air updates** — APK is signed with a stable release key; Settings → Check for updates downloads and installs the latest release in place, no uninstall needed

## Stack

| | |
|---|---|
| [Vite](https://vitejs.dev/) | build tool |
| [Capacitor 8](https://capacitorjs.com/) | Android wrapper (all HTTP via OkHttp — no CORS) |
| [Leaflet](https://leafletjs.com/) + [leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) + [leaflet.heat](https://github.com/Leaflet-extras/leaflet.heat) | map, clustering, heatmap |
| [exifr](https://github.com/MikeKovarik/exifr) | EXIF / GPS / date parsing |
| [piexifjs](https://github.com/hMatoba/piexifjs) | GPS/date EXIF read+write for JPEG |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB wrapper |
| [@panzoom/panzoom](https://github.com/timmywil/panzoom) | lightbox pinch-to-zoom |
| [Nominatim](https://nominatim.org/) | place-name search for the pin-drop map |

`tools/` holds standalone Python maintenance scripts (rclone + pCloud API, ffmpeg) for library-wide cleanup jobs — see below.

## Getting started

```bash
npm install
npm run build
npx cap sync android
```

Requires Node 22+ and Java 21+.

> **EU datacenter only.** The app points to `eapi.pcloud.com`. If your account is on the US datacenter, change `DEFAULT_HOST` in `src/auth.js`.

## Maintenance scripts (`tools/`)

Standalone Python scripts for library-wide cleanup jobs too heavy for the app itself — they talk to pCloud directly via [rclone](https://rclone.org/) (`rclone config show pcloud` for credentials) and, where noted, ffmpeg. All are resumable: interrupt with Ctrl-C and re-run to continue. After any of them changes file content, run Settings → **Rebuild from Photos** in the app so its local cache picks up the new fileids/hashes.

| Script | What it does |
|---|---|
| `convert_video_codecs.py` | Finds MP4/MOV files whose video stream isn't H.264 (e.g. old MPEG-4 Part 2 recordings Android can't decode) and re-encodes just those in place. |
| `convert_avi.py` | Converts every `.avi` in a directory tree to H.264 MP4, deletes the originals. |
| `convert_b64_jpegs.py` | Finds JPEGs stored as base64 text instead of binary (an old upload bug) and fixes them in place. |
| `find_name_duplicates.py` | Finds `Photos/` files sharing a timestamp but differing only in suffix (`_1`, `_2`, ...), merges EXIF from near-identical groups automatically, prompts for visually different ones. |
| `find_time_duplicates.py` | Finds likely DST-duplicate photos (filenames a fixed offset apart, default 2h); optional side-by-side image comparison before deleting. |

Run any script with `--help` for its full option list.

## Android APK

The [GitHub Actions workflow](.github/workflows/release.yml) builds a **signed release APK** on every push to `main` and publishes it to the [latest release](../../releases/tag/latest).

To install: download `Mappho.apk`, open it on your device, and enable *Install from unknown sources* when prompted. Subsequent installs update the app in place (no uninstall needed).

To build locally:

```bash
npm run build
npx cap sync android
cd android && ./gradlew assembleRelease
```

Signing requires four env vars (or GitHub secrets for CI): `KEYSTORE_FILE`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

### Setting up signing secrets (one-time)

Run the helper script — it generates the keystore and uploads all four secrets in one step:

```bash
python3 tools/setup_signing.py "Your Name" CC yourpassword
# e.g.
python3 tools/setup_signing.py "Jane Smith" DE hunter2
```

Requires `keytool` (bundled with any JDK) and `gh` logged in (`gh auth login`).

Keep `mappho.keystore` safe — losing it means you can't publish updates to the same app identity.

<details>
<summary>Manual steps</summary>

**1. Generate the keystore**
```bash
keytool -genkeypair -v \
  -keystore mappho.keystore \
  -alias mappho \
  -keyalg RSA -keysize 2048 \
  -validity 10000
```

**2. Base64-encode the keystore**
```bash
base64 -i mappho.keystore | pbcopy   # macOS — copies to clipboard
```

**3. Add the four GitHub secrets** 

Go to **repo → Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | base64 string from step 2 |
| `KEYSTORE_PASSWORD` | password chosen during keytool prompt |
| `KEY_ALIAS` | `mappho` (or whatever alias you used) |
| `KEY_PASSWORD` | key password (often the same as keystore password) |

</details>

The CI workflow decodes `KEYSTORE_BASE64` back to a file and passes the other three to Gradle for signing.
