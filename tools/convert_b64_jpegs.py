#!/usr/bin/env python3
"""
convert_b64_jpegs.py — Find JPEG files stored as base64 text on pCloud and
re-upload them as proper binary JPEGs (in-place, same filename and fileid).

Some older uploads ended up with the file content being the base64 text of the
JPEG rather than the binary JPEG itself.  pCloud cannot thumbnail these files.
This script detects them (head starts with '/9j', the base64 encoding of the
JPEG SOI marker 0xFF 0xD8), decodes them, and re-uploads the binary in-place.
EXIF data is preserved unchanged — it is embedded in the JPEG and survives the
decode intact.

Run unattended; progress is saved so you can stop and resume at any time.

Usage:
    python3 tools/convert_b64_jpegs.py
    python3 tools/convert_b64_jpegs.py --workers 16
    python3 tools/convert_b64_jpegs.py --remote pcloud --path Photos

No extra Python dependencies — only rclone is required.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import PurePosixPath


STATE_FILE = 'b64_convert_state.json'
EXTS       = {'.jpg', '.jpeg'}


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


def fetch_head(remote, path, rel_path, nbytes=128):
    r = subprocess.run(
        ['rclone', 'cat', '--count', str(nbytes), f'{remote}:{path}/{rel_path}'],
        capture_output=True,
    )
    return r.stdout if r.returncode == 0 and r.stdout else None


def download_full(remote, path, rel_path):
    r = subprocess.run(['rclone', 'cat', f'{remote}:{path}/{rel_path}'], capture_output=True)
    return r.stdout if r.returncode == 0 and r.stdout else None


def upload_inplace(hostname, token, file_id, name, jpeg_data):
    """Overwrite an existing pCloud file in-place (same fileid, no delete)."""
    fid      = file_id.lstrip('f') if isinstance(file_id, str) else file_id
    boundary = b'BndB64Conv9Ma4YwXk'
    body = (
        b'--' + boundary + b'\r\n'
        b'Content-Disposition: form-data; name="file"; filename="'
        + name.encode() + b'"\r\nContent-Type: image/jpeg\r\n\r\n'
        + jpeg_data
        + b'\r\n--' + boundary + b'--\r\n'
    )
    url = f'https://{hostname}/uploadfile?fileid={fid}&access_token={token}&nopartial=1'
    req = urllib.request.Request(
        url, data=body, method='POST',
        headers={'Content-Type': f'multipart/form-data; boundary={boundary.decode()}'},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
    if result.get('result') != 0:
        raise RuntimeError(f'pCloud error {result.get("result")}: {result.get("error", result)}')


# ── base64 detection / decoding ───────────────────────────────────────────────

def decode_b64_jpeg(raw):
    """
    Return decoded binary JPEG if raw is a base64-encoded JPEG, else None.
    Binary JPEGs start with 0xFF 0xD8; their base64 representation starts with '/9j'.
    """
    if not raw or raw[:2] == b'\xff\xd8':
        return None  # already binary
    if raw.lstrip()[:3] != b'/9j':
        return None
    try:
        decoded = base64.b64decode(
            raw.replace(b'\r', b'').replace(b'\n', b'').replace(b' ', b'')
        )
        return decoded if decoded[:2] == b'\xff\xd8' else None
    except Exception:
        return None


# ── per-file worker ───────────────────────────────────────────────────────────

def probe_and_convert(f, remote, path, hostname, token):
    """
    Run the full pipeline for one file in a worker thread.
    Returns a dict with 'kind': 'binary' | 'converted' | 'error'.
    """
    rel  = f['Path']
    name = PurePosixPath(rel).name

    head = fetch_head(remote, path, rel)
    if not head:
        return {'kind': 'error', 'rel': rel, 'msg': 'head fetch failed'}
    if head.lstrip()[:3] != b'/9j':
        return {'kind': 'binary', 'rel': rel}

    # b64 detected — download and decode
    raw = download_full(remote, path, rel)
    if not raw:
        return {'kind': 'error', 'rel': rel, 'msg': 'full download failed'}

    jpeg = decode_b64_jpeg(raw)
    if not jpeg:
        return {'kind': 'error', 'rel': rel, 'msg': 'not valid base64 JPEG after decode'}

    try:
        upload_inplace(hostname, token, f['ID'], name, jpeg)
        return {'kind': 'converted', 'rel': rel,
                'b64_kb': len(raw) // 1024, 'jpeg_kb': len(jpeg) // 1024}
    except Exception as e:
        return {'kind': 'error', 'rel': rel, 'msg': f'upload failed: {e}'}


# ── state ─────────────────────────────────────────────────────────────────────

def load_state():
    if not os.path.exists(STATE_FILE):
        return set()
    with open(STATE_FILE) as f:
        return set(json.load(f).get('done', []))


def save_state(done):
    with open(STATE_FILE, 'w') as f:
        json.dump({'done': list(done)}, f, indent=2)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--remote',  default='pcloud', help='rclone remote name (default: pcloud)')
    ap.add_argument('--path',    default='Photos',  help='sub-path to scan (default: Photos)')
    ap.add_argument('--workers', type=int, default=8,
                    help='parallel workers for probing + converting (default: 8)')
    args = ap.parse_args()

    hostname, token = get_pcloud_creds(args.remote)
    if not token:
        sys.exit(f"Could not read pCloud token for remote '{args.remote}'.")

    files = list_files(args.remote, args.path)
    total = len(files)
    print(f'{total} JPEG files found.')

    done = load_state()
    pending = [f for f in files if f['Path'] not in done]
    print(f'{len(done)} already converted, {len(pending)} to check. '
          f'Running with {args.workers} workers.\n')

    converted  = 0
    skipped    = 0
    errors     = 0
    completed  = 0
    state_lock = threading.Lock()
    print_lock = threading.Lock()
    start_time = time.monotonic()
    PROGRESS_EVERY = max(1, min(100, len(pending) // 20))  # ~20 progress lines total

    def fmt_eta(done_count, total_count):
        elapsed = time.monotonic() - start_time
        if done_count == 0 or elapsed < 1:
            return 'ETA ?'
        rate = done_count / elapsed
        remaining = (total_count - done_count) / rate
        if remaining >= 3600:
            return f'ETA {int(remaining // 3600)}h {int((remaining % 3600) // 60)}m'
        if remaining >= 60:
            return f'ETA {int(remaining // 60)}m {int(remaining % 60)}s'
        return f'ETA {int(remaining)}s'

    def log(msg):
        with print_lock:
            print(msg, flush=True)

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(probe_and_convert, f,
                                args.remote, args.path, hostname, token): f
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
                if kind == 'binary':
                    skipped += 1
                    if completed % PROGRESS_EVERY == 0:
                        log(f'[{completed}/{len(pending)}] checking…  '
                            f'{converted} converted  {errors} errors  '
                            f'{fmt_eta(completed, len(pending))}')
                elif kind == 'converted':
                    converted += 1
                    log(f'[{completed}/{len(pending)}] {r["rel"]}  '
                        f'{r["b64_kb"]} KB b64 → {r["jpeg_kb"]} KB binary  ✓  '
                        f'{fmt_eta(completed, len(pending))}')
                    with state_lock:
                        done.add(r['rel'])
                        save_state(done)
                elif kind == 'error':
                    errors += 1
                    log(f'[{completed}/{len(pending)}] {r["rel"]}  FAILED: {r["msg"]}  '
                        f'{fmt_eta(completed, len(pending))}')

    except KeyboardInterrupt:
        print('\nInterrupted — progress saved.')

    if errors == 0 and os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)

    print(f'\nDone — {converted} converted, {skipped} already binary, {errors} errors.')
    if errors:
        print('Re-run to retry failed files.')


if __name__ == '__main__':
    main()
