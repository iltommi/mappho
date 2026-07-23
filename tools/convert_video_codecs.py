#!/usr/bin/env python3
"""
convert_video_codecs.py — Find MP4/MOV files whose video stream isn't H.264
and re-encode just those, in place (same fileid, same path). Also finds
files that are ALREADY H.264 but whose container is non-standard in a way
that breaks Android's native video decoder even though ffprobe/ffmpeg parse
them fine, and fixes those with a fast, lossless stream-copy remux instead
of a full re-encode.

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
import json
import os
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


def download_full(remote, path, rel_path, dest: Path) -> bool:
    r = subprocess.run(
        ['rclone', 'copyto', f'{remote}:{path}/{rel_path}', str(dest)],
        capture_output=True,
    )
    return r.returncode == 0 and dest.exists()


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
    """Returns a dict with 'kind': 'convert' | 'remux' | 'skipped' | 'error'.
    'convert' and 'remux' results additionally carry old/new fileid+hash so
    the caller can fix up the JSON DBs afterward.

    on_start(rel, size_mb, action), if given, is called right before the
    ffmpeg run begins — a full re-encode can run for minutes with no other
    output, which otherwise looks indistinguishable from a hang.
    """
    rel  = f['Path']
    name = PurePosixPath(rel).name

    with tempfile.TemporaryDirectory(prefix='mappho-vidconv-') as tmpdir:
        local_src = Path(tmpdir) / name
        if not download_full(remote, path, rel, local_src):
            return {'kind': 'error', 'rel': rel, 'msg': 'download failed'}

        streams = probe_streams(local_src)
        if streams is None:
            return {'kind': 'error', 'rel': rel, 'msg': 'ffprobe failed — possibly corrupt'}
        video, audio = streams
        if video is None:
            return {'kind': 'skipped', 'rel': rel, 'msg': 'no video stream'}

        already_h264 = video.get('codec_name') == 'h264'
        # Only matters when already h264 — a genuinely non-h264 file is
        # going through the full re-encode path regardless, which produces
        # a clean container as a side effect of ffmpeg building it fresh.
        dirty_container = already_h264 and needs_remux(local_src)
        if already_h264 and not dirty_container:
            return {'kind': 'skipped', 'rel': rel}

        action = 'remux' if already_h264 else 'convert'

        if dry_run:
            msg = ('container needs a clean remux (non-standard ftyp brand/extra box — '
                   'decoder-hostile even though already H.264)') if action == 'remux' \
                else f"video codec: {video.get('codec_name')}"
            return {'kind': action, 'rel': rel, 'msg': msg}

        if on_start:
            on_start(rel, local_src.stat().st_size / 1e6, action)

        t0 = time.monotonic()
        if action == 'remux':
            local_out = Path(tmpdir) / f'{name}.remuxed.mp4'
            result = subprocess.run(
                ['ffmpeg', '-i', str(local_src), '-c', 'copy', '-movflags', '+faststart', '-y', str(local_out)],
                capture_output=True,
            )
        else:
            audio_codec = audio.get('codec_name') if audio else None
            audio_args = ['-c:a', 'copy'] if audio_codec == 'aac' else ['-c:a', 'aac', '-b:a', '128k']
            local_out = Path(tmpdir) / f'{name}.converted.mp4'
            result = subprocess.run(
                [
                    'ffmpeg', '-i', str(local_src),
                    '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
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
# Maps path -> 'converted' | 'remux' | 'skipped'. All three mean "nothing
# left to do for this file" and are skipped on resume — only 'converted'/
# 'remux' matter for resuming correctness, but recording 'skipped' too
# avoids re-downloading and re-probing the (typically large) majority of
# files that don't need anything every time the script is interrupted and
# re-run. Errors are deliberately not recorded, so they're retried on the
# next run. hash_migrations/fileid_migrations persist alongside this so an
# interrupted run's DB patches aren't lost even if every video file ends up
# already marked done on the next run.

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
    prior_done    = sum(1 for v in checked.values() if v in ('converted', 'remux'))
    prior_skipped = len(checked) - prior_done
    print(f'{len(checked)} already checked ({prior_done} converted/remuxed, {prior_skipped} already clean), '
          f'{len(pending)} left to check'
          f"{' (dry run)' if args.dry_run else f', {args.workers} workers'}.\n")

    converted = remuxed = skipped = errors = completed = 0
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
        touched_so_far = converted + remuxed
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

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(
                    process_one, f, args.remote, args.path, hostname, token, args.dry_run,
                    lambda rel, mb, action: log(f"  ⏳ {'remuxing' if action == 'remux' else 'encoding'} {rel} ({mb:.1f} MB)…"),
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
                elif kind in ('converted', 'convert', 'remux'):
                    if kind == 'remux':
                        remuxed += 1
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
                            if r.get('old_fileid') and r.get('new_fileid'):
                                fileid_migrations[r['old_fileid']] = r['new_fileid']
                            persist()
                elif kind == 'error':
                    errors += 1
                    log(f"[{completed}/{len(pending)}] {r['rel']}  FAILED: {r['msg']}  "
                        f'{fmt_eta(completed, len(pending))}')

    except KeyboardInterrupt:
        print('\nInterrupted — progress saved.')

    total_touched = prior_done + converted + remuxed
    print(f'\nDone this run — {converted} converted, {remuxed} remuxed, {skipped} already clean, {errors} errors.')
    print(f'Total converted/remuxed so far (including prior runs): {total_touched}.')
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

    if not args.dry_run and errors == 0 and not hash_migrations and not fileid_migrations and os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)

    if total_touched and not args.dry_run:
        print('\nOpen Mappho and run Settings → Rebuild from Photos as a final sanity check '
              '(hash-index.json and the local cache should already be correct from the patch above).')


if __name__ == '__main__':
    main()
