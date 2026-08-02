#!/usr/bin/env python3
"""
convert_video_codecs.py — Find MP4/MOV files whose video stream isn't H.264
and re-encode just those, in place (same fileid, same path). Also finds two
kinds of files that are ALREADY H.264 but decoder-hostile on Android anyway:
a non-standard container (fixed with a fast, lossless stream-copy remux) or
full-range YUV (fixed with a real re-encode that remaps pixel values —
see below, a remux alone can't fix this one).

Some old phone/camera recordings are already .mp4 containers but use an
older video codec (commonly MPEG-4 Part 2 / "mp4v", the DivX/Xvid-era
codec) that modern Android devices generally can't decode at all — the
audio track (usually AAC) plays fine since that codec is universally
supported, but no picture ever renders. convert_avi.py doesn't catch these
because it only looks at the .avi extension, not the codec inside an
already-.mp4 file.

Separately (confirmed on a real file, 2026-07): some old Samsung camera app
recordings are already H.264 but carry a non-standard ftyp major_brand
(mp4v — normally the brand for the OLD codec, oddly reused here on an
actual H.264 file) and a proprietary "beam" box (Samsung's old S Beam/NFC
sharing feature) sandwiched between ftyp and moov. ffmpeg tolerates this
fine (probe_score=100) but Android's native decoder pipeline — what the
WebView's <video> element delegates to — refuses to play it, silently, with
no error event at all. A stream-copy remux (ffmpeg -c copy) rebuilds a
clean, standard container losslessly — same pixels, same audio, just a
container ffmpeg produces from scratch instead of whatever muxed the
original — and fixes this without needing a full, slow re-encode.

Separately again (confirmed on two real files, 2026-07): full-range
("PC"/JPEG-style, 0-255) YUV instead of the standard limited-range ("TV",
16-235) YUV Android's hardware video decoder expects — ffprobe reports this
as pix_fmt yuvj420p or color_range pc. Same silent-no-picture symptom as
the container issue (no error event; the network/demux layer is fine, only
the decoded frame never renders), but a different fix: since the actual
pixel VALUES are out of the expected range, not just a container tag, a
plain -c copy remux would carry the same broken samples straight through
unchanged. Needs a real re-encode with the pixel values remapped
(ffmpeg's scale filter, in_range=full:out_range=tv). Sampled across the
whole library dating back to 2009: not confined to old pre-H.264 footage
this script itself re-encoded (though confirmed present there too, carried
through from the source by an earlier run before this check existed) —
scattered across every year up to 2025, meaning some phones/camera apps
genuinely record full-range H.264 natively. This script can't tell you
whether a specific unconverted file has this without downloading and
probing it, same as everything else here.

One more variant of the same issue (confirmed 2026-07): a file this script
had ALREADY range-fixed in an earlier run — before a since-fixed bug here
added the required -pix_fmt flag (see the long comment on video_args below)
— had its pixel values correctly remapped by that old run's scale filter,
but its container tag was left stuck at yuvj420p/pc, and it was completely
unplayable on Android regardless of the underlying (correct) pixel values.
Because measurement no longer confirmed genuinely full-range content (this
particular clip is dim and never reaches the highlight-side threshold),
the normal full-range check could never flag it again — it would have
stayed silently broken forever. When BOTH pix_fmt and color_range
independently say full-range (not just one — the single-signal case is the
one with the 44% false-positive history against measurement), that tag
alone is trusted enough to fix, but only losslessly: a bitstream-filter
rewrite of the H.264 SPS's video_full_range_flag (no re-encode, no pixel
remapping — verified byte-identical output size on the confirmed case).

Uploads use the same upload-temp -> delete-original -> rename-into-place
sequence as Mappho's own overwriteFile() in src/pcloud.js: stat the file
for its name+parentfolderid, upload the converted bytes under a temp name
in that same folder, delete the original, then rename the temp upload into
place. This means the file gets a NEW fileid (pCloud's uploadfile?fileid=X
does NOT overwrite content in place the way an earlier version of this
script — and convert_b64_jpegs.py's upload_inplace() — assumed; verified
the hard way: it silently uploads a new file to account ROOT instead,
ignoring the fileid entirely). Both fileid and content hash change for
every touched file, whether it went through a full re-encode or just a
remux.

That hash/fileid change is now fixed up automatically at the end of a run:
faces.json/locations.json (hash-keyed, owned by the external face/scene
detection tool) and temporary-meta.json/ignored.json (fileid-keyed,
Mappho's own) all get their entries for touched files rekeyed to the new
hash/fileid and reuploaded, the same way Mappho's own renameFacesEntry/
renameLocationsEntry do after an in-app edit — this script just does it for
edits that happened outside the app. hash-index.json gets the same
treatment too, though Settings -> Rebuild from Photos in the app remains
the authoritative way to refresh it and the local cache regardless (worth
doing after a run anyway, as a sanity check). Each of those 5 files is
re-checked for a remote change (its own pCloud hash) immediately before
being overwritten — if it changed since this script downloaded it (the
app, or the detection tool, wrote to it in the meantime), that one file's
patch is skipped rather than risking clobbering the concurrent write, and
is retried on the next run. Safest to run this whole script with Mappho
closed regardless. Pending hash/fileid migrations are saved to the state
file, so an interrupted run's DB patches aren't lost — the next run
retries them even if every video file is already marked done.

Downloads the full file locally before probing/converting — some of these
recordings have their moov atom at the very end of the file, so a partial
fetch wouldn't let ffprobe/ffmpeg see the container structure at all.

Progress is saved so you can stop and resume at any time.

Usage:
    python3 tools/convert_video_codecs.py
    python3 tools/convert_video_codecs.py --workers 3
    python3 tools/convert_video_codecs.py --remote pcloud --path Photos
    python3 tools/convert_video_codecs.py --dry-run

Requirements: rclone (configured), ffmpeg/ffprobe on PATH.
"""

import argparse
import decimal
import json
import os
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path, PurePosixPath

STATE_FILE = 'video_codec_convert_state.json'
EXTS       = {'.mp4', '.mov'}


# ── rclone / pCloud helpers ───────────────────────────────────────────────────

def list_files(remote, path):
    print(f'Listing {remote}:{path} …')
    r = subprocess.run(
        ['rclone', 'lsjson', f'{remote}:{path}', '--recursive', '--files-only'],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f'rclone lsjson failed:\n{r.stderr.strip()}')
    entries = json.loads(r.stdout)
    return [e for e in entries if PurePosixPath(e['Path']).suffix.lower() in EXTS]


def get_pcloud_creds(remote):
    r = subprocess.run(['rclone', 'config', 'show', remote], capture_output=True, text=True)
    if r.returncode != 0:
        return None, None
    hostname = token = None
    for line in r.stdout.splitlines():
        k, _, v = line.partition('=')
        k, v = k.strip(), v.strip()
        if k == 'hostname':
            hostname = v
        elif k == 'token':
            try:
                token = json.loads(v).get('access_token')
            except Exception:
                pass
    return hostname or 'api.pcloud.com', token


def download_full(remote, path, rel_path, dest: Path):
    """Returns (True, None) on success or (False, stderr_tail) on failure.
    Previously returned a bare bool, discarding rclone's own error message
    entirely — a real run hit a sustained multi-hundred-file run of
    "download failed" with genuinely no way to tell whether that was a
    network blip, a rate limit, or something else, since nothing about the
    actual failure was ever surfaced or logged anywhere.
    """
    try:
        r = subprocess.run(
            ['rclone', 'copyto', f'{remote}:{path}/{rel_path}', str(dest)],
            capture_output=True, timeout=300,
        )
    except subprocess.TimeoutExpired:
        return False, 'rclone copyto timed out after 300s'
    if r.returncode == 0 and dest.exists():
        return True, None
    stderr_tail = r.stderr.decode(errors='replace')[-300:] if r.stderr else '(no stderr)'
    return False, stderr_tail


def _pcloud_api(hostname, token, method, params, timeout=60):
    qs = '&'.join(f'{k}={urllib.parse.quote(str(v))}' for k, v in params.items())
    url = f'https://{hostname}/{method}?{qs}&access_token={token}'
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        result = json.loads(resp.read())
    if result.get('result') != 0:
        raise RuntimeError(f'pCloud {method} error {result.get("result")}: {result.get("error", result)}')
    return result


def _normalize_fileid(file_id):
    """rclone's pcloud backend reports fileids as strings like 'f123456';
    pCloud's own API wants the bare number. Mirrors stat_file's existing
    handling so every call site normalizes the same way."""
    return file_id.lstrip('f') if isinstance(file_id, str) else file_id


def js_rounded_hash(h):
    """Replicates what the app's own JS gets from a pCloud hash: every hash
    faces.json/locations.json/hash-index.json store went through the app's
    JSON.parse at some point, whose Number type is an IEEE-754 double and
    silently rounds any integer above 2^53 — see hashutil.js's
    normPcloudHash, which exists in the app for exactly this reason.

    A real, confirmed bug this fixes: this script's own hash_migrations
    used the EXACT hash from pCloud's API (Python ints are arbitrary
    precision, so no rounding happens on this side), and compared it
    directly against what's stored in these JSON files — which is almost
    always the rounded value, not the exact one, for any hash above 2^53
    (~84% of real hashes sampled from faces.json/locations.json). The
    match silently failed for the vast majority of files this script ever
    converted, patch_all_dbs treated "0 matching entries" as fully
    resolved (not a conflict to retry), and the pending migration was
    dropped — meaning face/location tags for most converted videos were
    silently left keyed to a hash the file no longer has, invisible to
    getFacesForHash()'s hash-only lookup (no path/name fallback) even
    though the raw entry was never deleted.

    repr(float(h)) + Decimal(...) reproduces the exact digit sequence
    JS's Number(h).toString() would produce (both languages implement
    shortest-round-trip decimal formatting for the same IEEE-754 double) —
    verified digit-for-digit against real `node` output across 7 real
    hash values from this library, all matching exactly.
    """
    try:
        d = decimal.Decimal(repr(float(h)))
    except (ValueError, OverflowError):
        return str(h)
    return format(d, 'f')


def stat_file(hostname, token, file_id):
    """Returns (name, parentfolderid) for a fileid."""
    meta = _pcloud_api(hostname, token, 'stat', {'fileid': _normalize_fileid(file_id)})['metadata']
    return meta['name'], meta['parentfolderid']


def get_file_hash(hostname, token, file_id):
    """Returns the file's current pCloud content hash as a string, or None
    if the stat call fails (deleted, bad id, transient error, ...) — the
    same hash Mappho's own hash-index.json/faces.json/locations.json use."""
    try:
        meta = _pcloud_api(hostname, token, 'stat', {'fileid': _normalize_fileid(file_id)})['metadata']
        h = meta.get('hash')
        return str(h) if h is not None else None
    except Exception:
        return None


def upload_to_folder(hostname, token, folderid, filename, data: bytes, content_type='video/mp4'):
    """Uploads data as filename into folderid. Returns the new fileid.

    Verifies the upload against pCloud's own reported size for the new file
    rather than trusting result==0 alone — a file was found, after a run
    that reported zero errors, to still be byte-for-byte the pre-conversion
    original despite being recorded as successfully converted. Cheap check
    (uses data already in the API response, no extra round-trip) but closes
    a real gap between "the API call didn't raise" and "the content is
    actually what we sent."
    """
    # Long, run-specific boundary — a hardcoded one could in principle
    # collide with the same byte sequence appearing inside a video's binary
    # payload, corrupting the multipart parse silently.
    boundary = ('MapphoVidConv-' + os.urandom(16).hex()).encode()
    body = (
        b'--' + boundary + b'\r\n'
        b'Content-Disposition: form-data; name="file"; filename="'
        + filename.encode() + b'"\r\nContent-Type: ' + content_type.encode() + b'\r\n\r\n'
        + data
        + b'\r\n--' + boundary + b'--\r\n'
    )
    url = f'https://{hostname}/uploadfile?folderid={folderid}&access_token={token}&nopartial=1'
    req = urllib.request.Request(
        url, data=body, method='POST',
        headers={'Content-Type': f'multipart/form-data; boundary={boundary.decode()}'},
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        result = json.loads(resp.read())
    if result.get('result') != 0:
        raise RuntimeError(f'pCloud error {result.get("result")}: {result.get("error", result)}')
    meta = (result.get('metadata') or [{}])[0]
    uploaded_size = meta.get('size')
    if uploaded_size is not None and uploaded_size != len(data):
        raise RuntimeError(f'upload size mismatch: sent {len(data)} bytes, pCloud reports {uploaded_size}')
    new_fileid = meta.get('fileid')
    if new_fileid is None:
        raise RuntimeError(f'upload succeeded but response had no fileid: {meta}')
    return new_fileid


def replace_file_content(hostname, token, file_id, data: bytes):
    """Replaces file_id's content, mirroring pcloud.js's overwriteFile():
    upload the new bytes under a temp name in the file's own folder first
    (so the original survives if the upload fails), delete the original,
    then rename the temp upload into place. Returns the NEW fileid — pCloud
    always assigns a fresh one on upload; passing the old fileid to
    uploadfile does NOT overwrite it in place (confirmed: doing so silently
    creates an unrelated file in account root instead).
    """
    name, folderid = stat_file(hostname, token, file_id)
    tmp_name = f'{name}.mappho-tmp'
    new_fileid = upload_to_folder(hostname, token, folderid, tmp_name, data)
    _pcloud_api(hostname, token, 'deletefile', {'fileid': _normalize_fileid(file_id)})
    _pcloud_api(hostname, token, 'renamefile', {'fileid': new_fileid, 'toname': name})
    return new_fileid


# ── ffprobe / ffmpeg ──────────────────────────────────────────────────────────

def probe_streams(path: Path):
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-print_format', 'json', '-show_streams', str(path)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None
    video = next((s for s in data.get('streams', []) if s.get('codec_type') == 'video'), None)
    audio = next((s for s in data.get('streams', []) if s.get('codec_type') == 'audio'), None)
    return video, audio


# Ground truth beats metadata. An earlier version of the full-range check
# trusted pix_fmt=='yuvj420p' or color_range=='pc' — sampled against a
# partial real run and found ~44% of what it flagged were files carrying an
# explicit, correct-looking color_range=tv tag alongside pix_fmt=yuvj420p.
# Directly measuring one such file's actual decoded luma values (not just
# reading its tags) settled it: the real samples spanned the full 0-255
# range regardless of the tv tag — i.e. the file's OWN metadata was simply
# wrong, not this script's logic. That cuts both ways: neither pix_fmt nor
# color_range can be trusted alone, in either direction, so this measures
# real decoded pixel values directly instead of reading either tag at all.
#
# A second, separate iteration on top of that: taking the absolute min/max
# luma across just a handful of single-frame samples turned out to be WAY
# too sensitive — sampled against 12 random real files and found 9/12 (75%)
# flagged, which is implausible for a specific decoder-incompatibility bug.
# Root cause: ordinary real footage often has one bright highlight or deep
# shadow somewhere (a window, a light bulb) that legitimately touches a
# near-extreme luma value even in a properly limited-range video — a SINGLE
# such frame among many was enough to trip an absolute-min/max threshold.
# Fixed by decoding many frames continuously (fps=2, not discrete -ss
# seeks) and taking the MEDIAN ymin/ymax across all of them instead of the
# absolute extremes — median is specifically robust to a single outlier
# frame/moment, unlike min/max. Verified against a synthetic file built to
# be 90% normal limited-range content plus one deliberately inserted
# extreme frame: the median stayed at the clean file's values (30/203 vs.
# 30.5/203, basically unmoved), while the two genuinely-broken real files
# showed ymin=0 in NEARLY EVERY sampled frame (not just one) — a real,
# consistent signal across the whole file's duration, not a single moment.
# Thresholds (<=15, >=220) sit with real margin between the confirmed-clean
# synthetic cases (30/202-203) and the confirmed-broken real files (0/229,
# 0/244).
FULL_RANGE_SAMPLE_FPS = 2
FULL_RANGE_MEDIAN_YMIN_MAX = 15
FULL_RANGE_MEDIAN_YMAX_MIN = 220


def measure_luma_range(path: Path):
    """Returns (median_ymin, median_ymax) across many continuously-decoded
    frames (fps-based sampling naturally covers the whole file), or None if
    ffmpeg produced no usable signalstats output at all (treated as "can't
    determine" by the caller — same fail-safe posture as every other
    best-effort probe in this script: skip rather than guess).
    """
    try:
        r = subprocess.run(
            ['ffmpeg', '-v', 'info', '-i', str(path),
             '-vf', f'fps={FULL_RANGE_SAMPLE_FPS},signalstats,metadata=print',
             '-f', 'null', '-'],
            capture_output=True, text=True, timeout=180,
        )
    except subprocess.TimeoutExpired:
        return None
    ymins, ymaxs = [], []
    for line in r.stderr.splitlines():
        if 'signalstats.YMIN=' in line:
            ymins.append(int(line.rsplit('=', 1)[1]))
        elif 'signalstats.YMAX=' in line:
            ymaxs.append(int(line.rsplit('=', 1)[1]))
    if not ymins or not ymaxs:
        return None
    return statistics.median(ymins), statistics.median(ymaxs)


# Deliberately narrow. An earlier version of this check flagged *any*
# top-level box between ftyp and moov that wasn't on a short allowlist —
# sampled against 40 real files from this library and found a ~50% false
# positive rate, because mdat (the actual media data — completely standard,
# and extremely commonly written *before* moov, since many camera apps
# can't finalize the index until recording stops) doesn't fit a strict
# "expected box order" model at all. That's a fundamentally different,
# far more common pattern than an actual problem.
#
# What's real, confirmed on one actual broken file: major_brand "mp4v" is
# literally the brand code for the OLD MPEG-4 Part 2 codec — its presence
# on a file whose video stream is ALREADY h264 (this check only ever runs
# on those; a genuinely mp4v-coded file already goes through the full
# re-encode path instead) means something odd happened during muxing,
# specifically confirmed paired with a proprietary Samsung "beam" box
# (old S Beam/NFC-sharing metadata) that a real device's native decoder
# refused to play even though ffmpeg parsed it without complaint. Checked
# against the SAME 40-file sample that broke the old heuristic: 0 matches,
# vs. 22 "mp42" and 17 "isom" among files that play fine.
BAD_MAJOR_BRANDS = {'mp4v'}

ACTION_VERBS = {'convert': 'encoding', 'rangefix': 're-encoding (range fix)', 'remux': 'remuxing', 'tagfix': 'fixing tag (lossless)'}


def needs_remux(path: Path) -> bool:
    """True if the container's ftyp major_brand is a known-bad value even
    though the video codec itself is already fine — see BAD_MAJOR_BRANDS
    above for why this stays narrow rather than trying to flag "anything
    unusual" in the box structure. Best-effort: any parse trouble just says
    "no" and leaves the file alone.
    """
    try:
        with open(path, 'rb') as f:
            header = f.read(8)
            if len(header) < 8 or header[4:8] != b'ftyp':
                return False
            major_brand = f.read(4).decode('ascii', errors='replace')
    except Exception:
        return False
    return major_brand in BAD_MAJOR_BRANDS


# ── per-file worker ───────────────────────────────────────────────────────────

def process_one(f, remote, path, hostname, token, dry_run, on_start=None):
    """Returns a dict with 'kind': 'convert' | 'rangefix' | 'remux' | 'skipped'
    | 'error'. 'convert'/'rangefix'/'remux' results additionally carry
    old/new fileid+hash so the caller can fix up the JSON DBs afterward.

    on_start(rel, size_mb, action), if given, is called right before the
    ffmpeg run begins — a full re-encode can run for minutes with no other
    output, which otherwise looks indistinguishable from a hang.
    """
    rel  = f['Path']
    name = PurePosixPath(rel).name

    with tempfile.TemporaryDirectory(prefix='mappho-vidconv-') as tmpdir:
        local_src = Path(tmpdir) / name
        ok, dl_err = download_full(remote, path, rel, local_src)
        if not ok:
            return {'kind': 'error', 'rel': rel, 'msg': f'download failed: {dl_err}'}

        streams = probe_streams(local_src)
        if streams is None:
            return {'kind': 'error', 'rel': rel, 'msg': 'ffprobe failed — possibly corrupt'}
        video, audio = streams
        if video is None:
            return {'kind': 'skipped', 'rel': rel, 'msg': 'no video stream'}

        already_h264 = video.get('codec_name') == 'h264'
        # Confirmed on real files (2026-07): full-range ("PC"/JPEG-style,
        # 0-255) YUV in an H.264 stream decodes and demuxes fine (ffprobe/
        # ffmpeg don't care) but produces no visible frame on Android's
        # hardware decoder, which expects standard limited-range ("TV",
        # 16-235) YUV. Unlike the container-brand issue, this needs actual
        # pixel values remapped, not just a container rebuild — a plain
        # -c copy remux would carry the same broken full-range samples
        # through untouched.
        #
        # Deliberately requires BOTH signals to agree, after each one alone
        # proved unreliable on its own:
        #   - Tag alone (pix_fmt=='yuvj420p' or color_range=='pc'): ~44%
        #     false-positive rate against files honestly tagged
        #     color_range=tv (until direct pixel measurement showed one
        #     such file's real samples spanned 0-255 regardless of its own
        #     tv tag — the file's OWN metadata was simply wrong).
        #   - Median pixel measurement alone: ~67-75% "full range" hit rate
        #     on random real files, implausible for a specific
        #     incompatibility — ordinary real footage often has SOME
        #     legitimate near-black/near-white content (a window, a light)
        #     even when properly limited-range encoded, so "does the
        #     content reach extreme values" doesn't cleanly separate
        #     genuinely-mis-encoded files from naturally high-contrast
        #     ones on its own.
        # Requiring agreement is deliberately conservative — accepting a
        # real risk of missing some genuinely-broken files (like the one
        # tv-tagged case, which happens to still pass since its pix_fmt
        # was independently yuvj420p) in exchange for not risking
        # destructive re-encodes of files that are actually fine, which a
        # false positive here would cause.
        tag_looks_wrong = video.get('pix_fmt') == 'yuvj420p' or video.get('color_range') == 'pc'
        measured_range = measure_luma_range(local_src) if tag_looks_wrong else None
        full_range = (
            tag_looks_wrong and measured_range is not None
            and measured_range[0] <= FULL_RANGE_MEDIAN_YMIN_MAX and measured_range[1] >= FULL_RANGE_MEDIAN_YMAX_MIN
        )
        # Confirmed on a real file (2026-07): tag_looks_wrong can be true
        # and full_range still false NOT because the tag is a fluke, but
        # because the clip is dim/low-contrast and never reaches the
        # highlight-side threshold — this one measured (0.0, 201.0), well
        # past FULL_RANGE_MEDIAN_YMIN_MAX on the shadow side but short of
        # FULL_RANGE_MEDIAN_YMAX_MIN. Its container's own encoder tag
        # (Lavf/Lavc libx264 — ffmpeg's signature, never a camera's) proved
        # it had ALREADY been through this script's rangefix path in an
        # earlier, pre-fix run: the scale filter had correctly remapped the
        # actual pixel values (that part of the old code always worked —
        # see the -pix_fmt comment below), but the missing -pix_fmt flag
        # left the container tag stuck at yuvj420p/pc, and Android refused
        # to render it regardless of what the real samples measured as.
        # Under the old logic this file could never be caught again —
        # full_range requires BOTH thresholds, permanently false here, and
        # nothing else in this script ever revisits a file once skipped.
        #
        # Fix: whenever BOTH pix_fmt and color_range independently agree
        # (not the single-signal OR case in tag_looks_wrong above, which
        # covers the historical 44%-false-positive contradictory-tag
        # scenario — pix_fmt bad but color_range honestly tv), the tag
        # itself is a reliable enough signal to act on even without
        # measurement confirmation, PROVIDED the fix stays lossless: a
        # bitstream-filter rewrite of the H.264 SPS's video_full_range_flag
        # (h264_metadata bsf), no re-encode, no pixel remapping. Verified
        # byte-identical output size on the confirmed case. This is safe
        # specifically because full_range is false here — if measurement
        # HAD confirmed genuinely out-of-range pixel content, relabeling
        # without remapping would visibly wash out the image, which is
        # exactly why that case is routed to the real re-encode (rangefix)
        # instead, checked first below.
        strong_tag_wrong = video.get('pix_fmt') == 'yuvj420p' and video.get('color_range') == 'pc'
        needs_tag_fix = already_h264 and not full_range and strong_tag_wrong and measured_range is not None
        # Only matters when already h264 and not already getting a real
        # re-encode for the range fix — a genuinely non-h264 file, or one
        # needing the range fix, goes through the full re-encode path
        # regardless, which produces a clean standard container as a side
        # effect of ffmpeg building it fresh.
        dirty_container = already_h264 and not full_range and needs_remux(local_src)
        if already_h264 and not full_range and not dirty_container and not needs_tag_fix:
            return {'kind': 'skipped', 'rel': rel}

        if not already_h264:
            action = 'convert'
        elif full_range:
            action = 'rangefix'
        elif needs_tag_fix:
            action = 'tagfix'
        else:
            action = 'remux'

        if dry_run:
            if action == 'remux':
                msg = 'container needs a clean remux (non-standard ftyp brand/extra box — decoder-hostile even though already H.264)'
            elif action == 'tagfix':
                msg = (f"tag says full-range (pix_fmt={video.get('pix_fmt')}, color_range={video.get('color_range')}) "
                       f"but measured luma (min={measured_range[0]}, max={measured_range[1]}) doesn't confirm it — "
                       "lossless tag-only fix, no re-encode")
            elif action == 'rangefix':
                msg = (f"measured full-range luma (min={measured_range[0]}, max={measured_range[1]} — "
                       f"tags say pix_fmt={video.get('pix_fmt')}, color_range={video.get('color_range')}) "
                       "— Android-decoder-hostile even though already H.264")
            else:
                msg = f"video codec: {video.get('codec_name')}" + (' (also full-range YUV)' if full_range else '')
            return {'kind': action, 'rel': rel, 'msg': msg}

        if on_start:
            on_start(rel, local_src.stat().st_size / 1e6, action)

        t0 = time.monotonic()
        if action in ('remux', 'tagfix'):
            # Both are lossless '-c copy' rebuilds — ffmpeg's mp4 muxer
            # always assigns its own clean major_brand from scratch
            # (never copies the source's ftyp verbatim), which is what
            # actually fixes a dirty_container regardless of the bsf flag
            # below. tagfix adds the h264_metadata bitstream filter to
            # additionally rewrite the SPS's video_full_range_flag in
            # place — see the needs_tag_fix comment above for why this is
            # safe (and why it's gated on full_range being false).
            bsf_args = ['-bsf:v', 'h264_metadata=video_full_range_flag=0'] if action == 'tagfix' else []
            local_out = Path(tmpdir) / f'{name}.remuxed.mp4'
            result = subprocess.run(
                ['ffmpeg', '-i', str(local_src), '-c', 'copy', *bsf_args, '-movflags', '+faststart', '-y', str(local_out)],
                capture_output=True,
            )
        else:
            audio_codec = audio.get('codec_name') if audio else None
            audio_args = ['-c:a', 'copy'] if audio_codec == 'aac' else ['-c:a', 'aac', '-b:a', '128k']
            # scale's in_range=full requires knowing the actual source range
            # to convert correctly (rather than just re-tagging it), so this
            # only applies when full_range was actually detected — a plain
            # codec conversion whose source is already standard-range must
            # NOT run pixel values through this filter at all.
            #
            # -pix_fmt yuv420p is NOT optional here — a real, serious bug,
            # caught the hard way (a live run kept re-processing the same
            # already-fixed files forever): without it, ffmpeg/libx264
            # inherits the DECODED yuvj420p pixel format from the full-range
            # source and writes that same "j" (JPEG-range) tag straight into
            # the output, even though -color_range tv is also passed and the
            # scale filter DID correctly remap the actual pixel values. The
            # result decodes and looks fine, but its own pix_fmt tag still
            # reads yuvj420p — which is EXACTLY what this script's own
            # full-range detection checks for, so every "fixed" file kept
            # measuring as still-broken on the next run, forever, each pass
            # adding another full lossy re-encode for zero benefit. Verified
            # the fix directly: reproduced the bug with the old flags (still
            # yuvj420p/pc afterward), confirmed adding -pix_fmt yuv420p
            # produces a clean yuv420p tag AND leaves the actual measured
            # pixel values correctly in the limited range (not just the tag).
            video_args = (
                ['-vf', 'scale=in_range=full:out_range=tv', '-pix_fmt', 'yuv420p', '-color_range', 'tv']
                if full_range else []
            )
            local_out = Path(tmpdir) / f'{name}.converted.mp4'
            result = subprocess.run(
                [
                    'ffmpeg', '-i', str(local_src),
                    '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
                    *video_args,
                    *audio_args,
                    '-movflags', '+faststart',
                    '-y', str(local_out),
                ],
                capture_output=True,
            )
        op_seconds = time.monotonic() - t0
        if result.returncode != 0:
            return {'kind': 'error', 'rel': rel, 'msg': f'ffmpeg {action} failed: {result.stderr.decode()[-300:]}'}

        data = local_out.read_bytes()
        if len(data) < 1024:
            return {'kind': 'error', 'rel': rel, 'msg': f'ffmpeg produced a suspiciously small output ({len(data)} bytes)'}

        old_fileid = _normalize_fileid(f['ID'])
        old_hash = get_file_hash(hostname, token, old_fileid)
        try:
            new_fileid = replace_file_content(hostname, token, f['ID'], data)
        except Exception as e:
            return {'kind': 'error', 'rel': rel, 'msg': f'upload failed: {e}'}
        new_hash = get_file_hash(hostname, token, new_fileid)

        orig_mb = local_src.stat().st_size / 1e6
        new_mb  = len(data) / 1e6
        if action == 'remux':
            msg = f"clean remux, {orig_mb:.1f} MB → {new_mb:.1f} MB"
        elif action == 'tagfix':
            msg = f"lossless tag fix (full-range → limited-range flag only), {orig_mb:.1f} MB → {new_mb:.1f} MB"
        elif action == 'rangefix':
            msg = f"full-range → limited-range YUV, {orig_mb:.1f} MB → {new_mb:.1f} MB"
        else:
            msg = f"{video.get('codec_name')} → h264, {orig_mb:.1f} MB → {new_mb:.1f} MB"
        return {
            'kind': action, 'rel': rel, 'convert_seconds': op_seconds, 'msg': msg,
            'old_fileid': str(old_fileid), 'new_fileid': str(new_fileid),
            'old_hash': old_hash, 'new_hash': new_hash,
        }


# ── JSON DB patching ────────────────────────────────────────────────────────
#
# Converting/remuxing a file always gives it a new fileid and content hash
# (see replace_file_content's docstring). Mappho's own hash-index.json and
# local cache pick this up for free via Settings -> Rebuild from Photos, but
# faces.json/locations.json (hash-keyed, owned by the external detection
# tool) and temporary-meta.json/ignored.json (fileid-keyed, Mappho's own)
# have no automatic fix-up for a change that happened outside the app —
# these functions do that rekeying directly, the same job Mappho's own
# renameFacesEntry/renameLocationsEntry do after an in-app edit.
#
# Each checks whether the remote file's pCloud hash changed between when it
# was downloaded and when it's about to be overwritten — the same guard
# faces.js/locations.js use before uploading — and skips (not clobbers) that
# one file's patch if so, leaving it for a retry on the next run. Best run
# with Mappho closed regardless, to keep that race window as small as
# possible in the first place.

def _download_json_by_path(hostname, token, remote_path):
    """Returns (data, fileid, folderid, hash), or (None, None, None, None)
    if the file genuinely doesn't exist on pCloud (result 2005/2009). Any
    OTHER failure (bad path, auth, network, ...) is re-raised instead of
    swallowed — a prior version of this function treated every failure as
    "doesn't exist", which silently hid a real bug here (a missing leading
    slash on remote_path — pCloud's stat API rejects a relative path with
    result 1001, "no full path or name/folderid provided") as a false
    "not present on pCloud" for all 5 files, every run.
    """
    try:
        meta = _pcloud_api(hostname, token, 'stat', {'path': remote_path})['metadata']
    except RuntimeError as e:
        # _pcloud_api's message format is "pCloud stat error <code>: ...".
        # 2005 = folder not found, 2009 = file not found — genuine absence.
        # Anything else (e.g. 1001 "no full path or name/folderid provided",
        # which is what a missing leading slash on remote_path produces) is
        # a real problem and must propagate, not be read as "not present".
        if 'error 2005' in str(e) or 'error 2009' in str(e):
            return None, None, None, None
        raise
    fileid, folderid = meta['fileid'], meta['parentfolderid']
    link = _pcloud_api(hostname, token, 'getfilelink', {'fileid': fileid})
    host = link['hosts'][0]
    with urllib.request.urlopen(f"https://{host}{link['path']}", timeout=60) as resp:
        data = json.loads(resp.read())
    return data, fileid, folderid, meta.get('hash')


def _upload_json(hostname, token, folderid, filename, data, prev_fileid):
    body = json.dumps(data).encode('utf-8')
    tmp_name = f'{filename}.mappho-tmp'
    new_fileid = upload_to_folder(hostname, token, folderid, tmp_name, body, content_type='application/json')
    _pcloud_api(hostname, token, 'deletefile', {'fileid': prev_fileid})
    _pcloud_api(hostname, token, 'renamefile', {'fileid': new_fileid, 'toname': filename})
    return new_fileid


def _remote_unchanged(hostname, token, fileid, expected_hash):
    try:
        current = _pcloud_api(hostname, token, 'stat', {'fileid': fileid})['metadata'].get('hash')
    except Exception:
        return False  # can't confirm — safest to treat as changed and skip the patch
    return str(current) == str(expected_hash)


def patch_hash_keyed_json(hostname, token, remote_path, filename, hash_migrations,
                           rekey_fileid_too=False, fileid_migrations=None):
    """faces.json/locations.json/hash-index.json all have an `entries` array
    with a `hash` field to rekey. hash-index.json's entries also carry their
    own `fileid` (rekey_fileid_too). Returns the number of entries patched,
    None if the file doesn't exist, or -1 if patching was skipped because
    the remote changed since it was read (caller should treat that as "not
    yet resolved, retry later", same as if nothing had been attempted).
    """
    data, fileid, folderid, remote_hash = _download_json_by_path(hostname, token, remote_path)
    if data is None:
        return None
    if not isinstance(data.get('entries'), list):
        print(f'  ! {filename}: malformed (no entries array) — leaving it alone')
        return None
    patched = 0
    for entry in data['entries']:
        old_h = str(entry.get('hash', ''))
        if old_h in hash_migrations:
            entry['hash'] = hash_migrations[old_h]
            if rekey_fileid_too and fileid_migrations:
                old_fid = entry.get('fileid')
                if old_fid is not None and str(old_fid) in fileid_migrations:
                    entry['fileid'] = int(fileid_migrations[str(old_fid)])
            patched += 1
    if patched == 0:
        return 0
    if not _remote_unchanged(hostname, token, fileid, remote_hash):
        print(f'  ! {filename} changed remotely since it was read — skipping this file\'s patch for now')
        return -1
    _upload_json(hostname, token, folderid, filename, data, fileid)
    return patched


def patch_fileid_dict_json(hostname, token, remote_path, filename, fileid_migrations):
    """temporary-meta.json's shape: {..., entries: {fileidString: {...}}}."""
    data, fileid, folderid, remote_hash = _download_json_by_path(hostname, token, remote_path)
    if data is None:
        return None
    if not isinstance(data.get('entries'), dict):
        print(f'  ! {filename}: malformed (entries isn\'t an object) — leaving it alone')
        return None
    patched = 0
    for old_fid, new_fid in fileid_migrations.items():
        if old_fid in data['entries']:
            data['entries'][new_fid] = data['entries'].pop(old_fid)
            patched += 1
    if patched == 0:
        return 0
    if not _remote_unchanged(hostname, token, fileid, remote_hash):
        print(f'  ! {filename} changed remotely since it was read — skipping this file\'s patch for now')
        return -1
    _upload_json(hostname, token, folderid, filename, data, fileid)
    return patched


def patch_fileid_array_json(hostname, token, remote_path, filename, fileid_migrations):
    """ignored.json's shape: {fileids: [...]}."""
    data, fileid, folderid, remote_hash = _download_json_by_path(hostname, token, remote_path)
    if data is None:
        return None
    if not isinstance(data.get('fileids'), list):
        print(f'  ! {filename}: malformed (no fileids array) — leaving it alone')
        return None
    patched = 0
    new_list = []
    for fid in data['fileids']:
        new_fid = fileid_migrations.get(str(fid))
        if new_fid is not None:
            new_list.append(int(new_fid))
            patched += 1
        else:
            new_list.append(fid)
    if patched == 0:
        return 0
    if not _remote_unchanged(hostname, token, fileid, remote_hash):
        print(f'  ! {filename} changed remotely since it was read — skipping this file\'s patch for now')
        return -1
    data['fileids'] = new_list
    _upload_json(hostname, token, folderid, filename, data, fileid)
    return patched


def patch_all_dbs(hostname, token, root_path, hash_migrations, fileid_migrations):
    """Runs all 5 patches. Returns True only if every one of them either had
    nothing to do, succeeded, or the target file doesn't exist — i.e. no
    "remote changed" conflicts anywhere, so the caller can safely clear the
    pending migrations from the state file. Any single conflict (or
    exception) leaves the whole batch unresolved for a retry next run,
    since a migration that's only half-applied across the 5 files is worse
    than one that's still fully pending.
    """
    print(f'\nFixing up {len(hash_migrations)} hash-keyed and {len(fileid_migrations)} fileid-keyed '
          f'entries across faces.json / locations.json / hash-index.json / temporary-meta.json / ignored.json…')
    # pCloud's stat-by-path API requires an absolute path (a leading slash);
    # --path's default/CLI convention ('Photos', no slash — matching
    # rclone's remote:path syntax used everywhere else in this script) does
    # NOT satisfy that. Normalizing once here, rather than trusting every
    # call site below to remember it, is what the previous version of this
    # function got wrong — see _download_json_by_path's docstring.
    root_path = '/' + root_path.strip('/')
    all_resolved = True
    jobs = [
        ('faces.json',       lambda: patch_hash_keyed_json(hostname, token, f'{root_path}/faces.json', 'faces.json', hash_migrations)),
        ('locations.json',   lambda: patch_hash_keyed_json(hostname, token, f'{root_path}/locations.json', 'locations.json', hash_migrations)),
        ('hash-index.json',  lambda: patch_hash_keyed_json(hostname, token, f'{root_path}/hash-index.json', 'hash-index.json', hash_migrations, rekey_fileid_too=True, fileid_migrations=fileid_migrations)),
        ('temporary-meta.json', lambda: patch_fileid_dict_json(hostname, token, f'{root_path}/temporary-meta.json', 'temporary-meta.json', fileid_migrations)),
        ('ignored.json',     lambda: patch_fileid_array_json(hostname, token, f'{root_path}/ignored.json', 'ignored.json', fileid_migrations)),
    ]
    for label, job in jobs:
        try:
            result = job()
        except Exception as e:
            print(f'  ! {label}: patch failed ({e}) — will retry next run')
            all_resolved = False
            continue
        if result is None:
            print(f'  - {label}: not present on pCloud, nothing to do')
        elif result == -1:
            all_resolved = False
        elif result == 0:
            print(f'  - {label}: no matching entries')
        else:
            print(f'  ✓ {label}: {result} entries rekeyed')
    return all_resolved


# ── state ─────────────────────────────────────────────────────────────────────
# Maps path -> 'converted' | 'rangefix' | 'remux' | 'skipped'. All four mean
# "nothing left to do for this file" and are skipped on resume — only the
# three touched-kinds matter for resuming correctness, but recording
# 'skipped' too avoids re-downloading and re-probing the (typically large)
# majority of files that don't need anything every time the script is
# interrupted and re-run. Errors are deliberately not recorded, so they're
# retried on the next run. hash_migrations/fileid_migrations persist
# alongside this so an interrupted run's DB patches aren't lost even if
# every video file ends up already marked done on the next run.

def load_state():
    if not os.path.exists(STATE_FILE):
        return {}, {}, {}
    with open(STATE_FILE) as f:
        data = json.load(f)
    if 'checked' in data:
        return data['checked'], data.get('hash_migrations', {}), data.get('fileid_migrations', {})
    # Migrate the older format (a converted-only path list) so an
    # in-progress run's already-converted files aren't redundantly
    # re-downloaded and re-probed under the new format.
    return {path: 'converted' for path in data.get('done', [])}, {}, {}


def save_state(checked, hash_migrations, fileid_migrations):
    with open(STATE_FILE, 'w') as f:
        json.dump({'checked': checked, 'hash_migrations': hash_migrations,
                    'fileid_migrations': fileid_migrations}, f, indent=2)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--remote', default='pcloud', help='rclone remote name (default: pcloud)')
    ap.add_argument('--path', default='Photos', help='sub-path to scan (default: Photos)')
    ap.add_argument('--workers', type=int, default=2,
                     help='parallel ffmpeg conversions (default: 2 — each is already CPU-heavy)')
    ap.add_argument('--dry-run', action='store_true', help='list affected files without converting')
    args = ap.parse_args()

    hostname, token = get_pcloud_creds(args.remote)
    if not token:
        sys.exit(f"Could not read pCloud token for remote '{args.remote}'.")

    files = list_files(args.remote, args.path)
    total = len(files)
    print(f'{total} MP4/MOV files found.')

    if args.dry_run:
        checked, hash_migrations, fileid_migrations = {}, {}, {}
    else:
        checked, hash_migrations, fileid_migrations = load_state()
    pending = [f for f in files if f['Path'] not in checked]
    prior_done    = sum(1 for v in checked.values() if v in ('converted', 'rangefix', 'remux', 'tagfix'))
    prior_skipped = len(checked) - prior_done
    print(f'{len(checked)} already checked ({prior_done} converted/rangefixed/remuxed/tagfixed, {prior_skipped} already clean), '
          f'{len(pending)} left to check'
          f"{' (dry run)' if args.dry_run else f', {args.workers} workers'}.\n")

    converted = rangefixed = remuxed = tagfixed = skipped = errors = completed = 0
    convert_seconds_total = 0.0  # wall-clock time actually spent inside ffmpeg, for the ETA below
    state_lock = threading.Lock()
    print_lock = threading.Lock()
    start_time = time.monotonic()

    def log(msg):
        with print_lock:
            print(msg, flush=True)

    def persist():
        save_state(checked, hash_migrations, fileid_migrations)

    # Skip-only checks (most files) take seconds; an actual conversion/remux
    # takes much longer. A flat "elapsed / completed" rate blends the two
    # and wildly overestimates remaining time once mostly-skips are left —
    # instead, extrapolate how many of the REMAINING files will likely need
    # work (from the hit rate seen so far) and cost each class its own
    # observed average duration.
    def fmt_eta(completed_count, total_count):
        elapsed = time.monotonic() - start_time
        if completed_count == 0 or elapsed < 1:
            return 'ETA ?'
        remaining_count = total_count - completed_count
        touched_so_far = converted + rangefixed + remuxed + tagfixed
        hit_rate = touched_so_far / completed_count
        expected_remaining_touched = remaining_count * hit_rate

        avg_touch = (convert_seconds_total / touched_so_far) if touched_so_far else 90.0  # guess until we have data
        check_only_elapsed = max(0.0, elapsed - convert_seconds_total)
        checks_so_far = completed_count - touched_so_far
        avg_check = (check_only_elapsed / checks_so_far) if checks_so_far else 3.0

        remaining = (
            (expected_remaining_touched * avg_touch) / max(1, args.workers)
            + ((remaining_count - expected_remaining_touched) * avg_check) / max(1, args.workers)
        )
        if remaining >= 3600:
            return f'ETA {int(remaining // 3600)}h {int((remaining % 3600) // 60)}m'
        if remaining >= 60:
            return f'ETA {int(remaining // 60)}m {int(remaining % 60)}s'
        return f'ETA {int(remaining)}s'

    # Not a `with ThreadPoolExecutor(...)` block on purpose: that context
    # manager's __exit__ calls shutdown(wait=True) with no cancellation, so
    # on Ctrl+C it silently keeps draining the ENTIRE remaining queue (every
    # file was already submitted up front) before this function can even
    # reach the KeyboardInterrupt handler below — Ctrl+C looks unresponsive
    # for as long as the whole rest of the run would've taken, which is
    # exactly the kind of thing that pushes you toward a hard kill instead.
    # cancel_futures=True (both here and in the normal-completion path,
    # where it's a harmless no-op since the queue is already empty by then)
    # drops every not-yet-started file and only waits on the handful
    # actually in flight, so Ctrl+C is prompt either way.
    executor = ThreadPoolExecutor(max_workers=args.workers)
    try:
        futures = {
            executor.submit(
                process_one, f, args.remote, args.path, hostname, token, args.dry_run,
                lambda rel, mb, action: log(f"  ⏳ {ACTION_VERBS.get(action, 'processing')} {rel} ({mb:.1f} MB)…"),
            ): f
            for f in pending
        }
        for future in as_completed(futures):
            completed += 1
            try:
                r = future.result()
            except Exception as e:
                errors += 1
                log(f'[{completed}/{len(pending)}] unexpected error: {e}')
                continue

            kind = r['kind']
            if kind == 'skipped':
                skipped += 1
                if not args.dry_run:
                    with state_lock:
                        checked[r['rel']] = 'skipped'
                        persist()
            elif kind in ('converted', 'convert', 'rangefix', 'remux', 'tagfix'):
                if kind == 'remux':
                    remuxed += 1
                elif kind == 'tagfix':
                    tagfixed += 1
                elif kind == 'rangefix':
                    rangefixed += 1
                else:
                    converted += 1
                convert_seconds_total += r.get('convert_seconds', 0.0)
                log(f"[{completed}/{len(pending)}] {r['rel']}  {r.get('msg', '')}  ✓  "
                    f'{fmt_eta(completed, len(pending))}')
                if not args.dry_run:
                    with state_lock:
                        checked[r['rel']] = kind
                        if r.get('old_hash') and r.get('new_hash'):
                            hash_migrations[r['old_hash']] = r['new_hash']
                            # See js_rounded_hash's docstring — faces.json/
                            # locations.json/hash-index.json almost always
                            # store the JS-rounded form, not this exact
                            # pCloud value, so patch_hash_keyed_json's
                            # lookup needs both as possible keys.
                            js_old = js_rounded_hash(r['old_hash'])
                            if js_old != r['old_hash']:
                                hash_migrations[js_old] = r['new_hash']
                        if r.get('old_fileid') and r.get('new_fileid'):
                            fileid_migrations[r['old_fileid']] = r['new_fileid']
                        persist()
            elif kind == 'error':
                errors += 1
                log(f"[{completed}/{len(pending)}] {r['rel']}  FAILED: {r['msg']}  "
                    f'{fmt_eta(completed, len(pending))}')

    except KeyboardInterrupt:
        print('\nInterrupted — cancelling queued files (already-processed ones stay saved)…')
    finally:
        executor.shutdown(wait=True, cancel_futures=True)

    total_touched = prior_done + converted + rangefixed + remuxed + tagfixed
    print(f'\nDone this run — {converted} converted, {rangefixed} range-fixed, {remuxed} remuxed, '
          f'{tagfixed} tag-fixed, {skipped} already clean, {errors} errors.')
    print(f'Total converted/rangefixed/remuxed/tagfixed so far (including prior runs): {total_touched}.')
    if errors:
        print('Re-run to retry failed files.')

    if not args.dry_run and (hash_migrations or fileid_migrations):
        resolved = patch_all_dbs(hostname, token, args.path, hash_migrations, fileid_migrations)
        if resolved:
            hash_migrations = {}
            fileid_migrations = {}
            persist()
        else:
            persist()
            print('\nSome DB entries could not be patched (a concurrent write was detected) — '
                  're-run this script to retry just the DB fix-up.')

    # completed == len(pending) means the run genuinely drained the whole
    # pending list rather than being cut short — a real bug caught here:
    # this used to fire on ANY exit path with errors==0 and no pending
    # migrations, which is also true right after catching KeyboardInterrupt
    # (or after cancel_futures dropped the rest of the queue), silently
    # discarding the "checked" bookkeeping for every file this run — and
    # every prior run — had already verified, moments after printing that
    # progress was saved. That forced a full re-download-and-reprobe of the
    # entire library on the next run, which looks exactly like "it's
    # re-encoding files it already fixed" even though re-fixing them is not
    # what was actually happening — detection still correctly skips files
    # that are genuinely already clean.
    if (not args.dry_run and completed == len(pending) and errors == 0
            and not hash_migrations and not fileid_migrations and os.path.exists(STATE_FILE)):
        os.remove(STATE_FILE)

    if total_touched and not args.dry_run:
        print('\nOpen Mappho and run Settings → Rebuild from Photos as a final sanity check '
              '(hash-index.json and the local cache should already be correct from the patch above).')


if __name__ == '__main__':
    main()
