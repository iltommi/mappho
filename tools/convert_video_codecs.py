#!/usr/bin/env python3
"""
convert_video_codecs.py — Find MP4/MOV files whose video stream isn't H.264
and re-encode just those, in place (same fileid, same path).

Some old phone/camera recordings are already .mp4 containers but use an
older video codec (commonly MPEG-4 Part 2 / "mp4v", the DivX/Xvid-era
codec) that modern Android devices generally can't decode at all — the
audio track (usually AAC) plays fine since that codec is universally
supported, but no picture ever renders. convert_avi.py doesn't catch these
because it only looks at the .avi extension, not the codec inside an
already-.mp4 file.

Uploads are done via pCloud's uploadfile?fileid=<id>, which overwrites the
existing file's content in place and keeps its fileid — the same trick
convert_b64_jpegs.py uses. That matters: Mappho keys temporary-meta.json
(video GPS/date) and ignored.json by fileid, so preserving it means those
stay valid with no extra work. The file's pCloud content hash does change
though (different bytes), which makes Mappho's hash-index.json stale for
converted files — this script does not try to patch that shared JSON
itself (real risk of racing the app's own writes to it). Simplest fix:
after running this, open Mappho and do Settings → Rebuild from Photos —
it already re-derives hash-index.json and the local cache from a fresh
listing of Photos/, picking up the new hashes for free.

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


def upload_inplace(hostname, token, file_id, name, data: bytes):
    """Overwrite an existing pCloud file in-place (same fileid, no delete).

    Verifies the upload against pCloud's own reported size for the new file
    rather than trusting result==0 alone — a file was found, after a run
    that reported zero errors, to still be byte-for-byte the pre-conversion
    original despite being recorded as successfully converted. Cheap check
    (uses data already in the API response, no extra round-trip) but closes
    a real gap between "the API call didn't raise" and "the content is
    actually what we sent."
    """
    fid      = file_id.lstrip('f') if isinstance(file_id, str) else file_id
    # Long, run-specific boundary — a hardcoded one could in principle
    # collide with the same byte sequence appearing inside a video's binary
    # payload, corrupting the multipart parse silently.
    boundary = ('MapphoVidConv-' + os.urandom(16).hex()).encode()
    body = (
        b'--' + boundary + b'\r\n'
        b'Content-Disposition: form-data; name="file"; filename="'
        + name.encode() + b'"\r\nContent-Type: video/mp4\r\n\r\n'
        + data
        + b'\r\n--' + boundary + b'--\r\n'
    )
    url = f'https://{hostname}/uploadfile?fileid={fid}&access_token={token}&nopartial=1'
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


# ── per-file worker ───────────────────────────────────────────────────────────

def process_one(f, remote, path, hostname, token, dry_run, on_start=None):
    """Returns a dict with 'kind': 'converted' | 'skipped' | 'error'.

    on_start(rel, size_mb), if given, is called right before the ffmpeg
    encode begins — an encode can run for minutes with no other output,
    which otherwise looks indistinguishable from a hang.
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
        if video.get('codec_name') == 'h264':
            return {'kind': 'skipped', 'rel': rel}

        if dry_run:
            return {'kind': 'converted', 'rel': rel, 'msg': f"video codec: {video.get('codec_name')}"}

        audio_codec = audio.get('codec_name') if audio else None
        audio_args = ['-c:a', 'copy'] if audio_codec == 'aac' else ['-c:a', 'aac', '-b:a', '128k']

        if on_start:
            on_start(rel, local_src.stat().st_size / 1e6)

        local_out = Path(tmpdir) / f'{name}.converted.mp4'
        t0 = time.monotonic()
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
        convert_seconds = time.monotonic() - t0
        if result.returncode != 0:
            return {'kind': 'error', 'rel': rel, 'msg': f'ffmpeg failed: {result.stderr.decode()[-300:]}'}

        data = local_out.read_bytes()
        if len(data) < 1024:
            return {'kind': 'error', 'rel': rel, 'msg': f'ffmpeg produced a suspiciously small output ({len(data)} bytes)'}
        try:
            upload_inplace(hostname, token, f['ID'], name, data)
        except Exception as e:
            return {'kind': 'error', 'rel': rel, 'msg': f'upload failed: {e}'}

        orig_mb = local_src.stat().st_size / 1e6
        new_mb  = len(data) / 1e6
        return {'kind': 'converted', 'rel': rel, 'convert_seconds': convert_seconds,
                'msg': f"{video.get('codec_name')} → h264, {orig_mb:.1f} MB → {new_mb:.1f} MB"}


# ── state ─────────────────────────────────────────────────────────────────────
# Maps path -> 'converted' | 'skipped'. Both outcomes mean "nothing left to
# do for this file" and are skipped on resume — only 'converted' matters for
# resuming correctness, but recording 'skipped' too avoids re-downloading and
# re-probing the (typically large) majority of files that don't need
# conversion every time the script is interrupted and re-run. Errors are
# deliberately not recorded, so they're retried on the next run.

def load_state():
    if not os.path.exists(STATE_FILE):
        return {}
    with open(STATE_FILE) as f:
        data = json.load(f)
    if 'checked' in data:
        return data['checked']
    # Migrate the older format (a converted-only path list) so an
    # in-progress run's already-converted files aren't redundantly
    # re-downloaded and re-probed under the new format.
    return {path: 'converted' for path in data.get('done', [])}


def save_state(checked):
    with open(STATE_FILE, 'w') as f:
        json.dump({'checked': checked}, f, indent=2)


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

    checked = {} if args.dry_run else load_state()
    pending = [f for f in files if f['Path'] not in checked]
    prior_converted = sum(1 for v in checked.values() if v == 'converted')
    prior_skipped   = len(checked) - prior_converted
    print(f'{len(checked)} already checked ({prior_converted} converted, {prior_skipped} already H.264), '
          f'{len(pending)} left to check'
          f"{' (dry run)' if args.dry_run else f', {args.workers} workers'}.\n")

    converted = skipped = errors = completed = 0
    convert_seconds_total = 0.0  # wall-clock time actually spent inside ffmpeg, for the ETA below
    state_lock = threading.Lock()
    print_lock = threading.Lock()
    start_time = time.monotonic()

    def log(msg):
        with print_lock:
            print(msg, flush=True)

    # Skip-only checks (most files) take seconds; an actual conversion takes
    # minutes. A flat "elapsed / completed" rate blends the two and wildly
    # overestimates remaining time once mostly-skips are left — instead,
    # extrapolate how many of the REMAINING files will likely need
    # conversion (from the hit rate seen so far) and cost each class of
    # file its own observed average duration.
    def fmt_eta(completed_count, total_count):
        elapsed = time.monotonic() - start_time
        if completed_count == 0 or elapsed < 1:
            return 'ETA ?'
        remaining_count = total_count - completed_count
        hit_rate = converted / completed_count
        expected_remaining_conversions = remaining_count * hit_rate

        avg_convert = (convert_seconds_total / converted) if converted else 90.0  # guess until we have data
        check_only_elapsed = max(0.0, elapsed - convert_seconds_total)
        checks_so_far = completed_count - converted
        avg_check = (check_only_elapsed / checks_so_far) if checks_so_far else 3.0

        remaining = (
            (expected_remaining_conversions * avg_convert) / max(1, args.workers)
            + ((remaining_count - expected_remaining_conversions) * avg_check) / max(1, args.workers)
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
                    lambda rel, mb: log(f'  ⏳ encoding {rel} ({mb:.1f} MB)…'),
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
                            save_state(checked)
                elif kind == 'converted':
                    converted += 1
                    convert_seconds_total += r.get('convert_seconds', 0.0)
                    log(f"[{completed}/{len(pending)}] {r['rel']}  {r.get('msg', '')}  ✓  "
                        f'{fmt_eta(completed, len(pending))}')
                    if not args.dry_run:
                        with state_lock:
                            checked[r['rel']] = 'converted'
                            save_state(checked)
                elif kind == 'error':
                    errors += 1
                    log(f"[{completed}/{len(pending)}] {r['rel']}  FAILED: {r['msg']}  "
                        f'{fmt_eta(completed, len(pending))}')

    except KeyboardInterrupt:
        print('\nInterrupted — progress saved.')

    if not args.dry_run and errors == 0 and os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)

    total_converted = prior_converted + converted
    print(f'\nDone this run — {converted} converted, {skipped} already H.264, {errors} errors.')
    print(f'Total converted so far (including prior runs): {total_converted}.')
    if errors:
        print('Re-run to retry failed files.')
    if total_converted and not args.dry_run:
        print('\nOpen Mappho and run Settings → Rebuild from Photos to refresh hash-index.json '
              'and the local cache with the converted files\' new content hashes.')


if __name__ == '__main__':
    main()
