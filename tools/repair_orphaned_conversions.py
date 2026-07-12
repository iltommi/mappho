#!/usr/bin/env python3
"""
repair_orphaned_conversions.py — One-off cleanup for a bug in an earlier
version of convert_video_codecs.py.

That script's upload_inplace() called pCloud's uploadfile?fileid=<id>
expecting it to overwrite the target file's content in place. It doesn't:
pCloud ignored the fileid and uploaded each converted video as a brand-new
file in the account's ROOT folder, leaving every original in Photos/YYYY/MM
untouched and still broken. This script finds those orphaned root files,
matches each back to its intended Photos/YYYY/MM/name.ext location by
parsing the date out of Mappho's own filename convention
(YYYY-MM-DD_HH-MM-SS_N.ext), and swaps it into place: delete the stale
original, then move+rename the orphan (a metadata-only pCloud operation —
no re-upload, since the orphan already holds the correctly-converted
bytes). This salvages the completed ffmpeg work instead of re-encoding
from scratch.

Defaults to a dry run that only prints what it would do. Pass --execute to
actually delete originals and move files. Progress is saved so an
in-progress --execute run can be interrupted and resumed.

Usage:
    python3 tools/repair_orphaned_conversions.py                # dry run
    python3 tools/repair_orphaned_conversions.py --execute
    python3 tools/repair_orphaned_conversions.py --execute --workers 4
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

STATE_FILE = 'repair_orphans_state.json'
NAME_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})_\d{2}-\d{2}-\d{2}_\d+\.\w+$')
EXTS = {'.mp4', '.mov'}


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


def _pcloud_api(hostname, token, method, params, timeout=60):
    qs = '&'.join(f'{k}={urllib.parse.quote(str(v))}' for k, v in params.items())
    url = f'https://{hostname}/{method}?{qs}&access_token={token}'
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        result = json.loads(resp.read())
    if result.get('result') != 0:
        raise RuntimeError(f'pCloud {method} error {result.get("result")}: {result.get("error", result)}')
    return result


def list_root_orphans(hostname, token, root_path):
    meta = _pcloud_api(hostname, token, 'listfolder', {'path': root_path})['metadata']
    out = []
    for e in meta.get('contents', []):
        if e.get('isfolder'):
            continue
        name = e['name']
        ext = os.path.splitext(name)[1].lower()
        if ext not in EXTS:
            continue
        m = NAME_RE.match(name)
        if not m:
            continue
        out.append({'name': name, 'fileid': e['fileid'], 'size': e['size'],
                     'year': m.group(1), 'month': m.group(2)})
    return out


# folderid + contents-by-name for a Photos/YYYY/MM folder, cached across
# orphans that share the same month (root normally has many per month).
_folder_cache = {}
_folder_cache_lock = threading.Lock()


def get_dest_folder(hostname, token, photos_path, year, month):
    key = (year, month)
    with _folder_cache_lock:
        if key in _folder_cache:
            return _folder_cache[key]
    path = f'{photos_path}/{year}/{month}'
    meta = _pcloud_api(hostname, token, 'listfolder', {'path': path})['metadata']
    folderid = meta['folderid']
    by_name = {c['name']: c for c in meta.get('contents', []) if not c.get('isfolder')}
    with _folder_cache_lock:
        _folder_cache[key] = (folderid, by_name)
    return folderid, by_name


def repair_one(hostname, token, photos_path, orphan, execute):
    name, year, month = orphan['name'], orphan['year'], orphan['month']
    try:
        folderid, by_name = get_dest_folder(hostname, token, photos_path, year, month)
    except Exception as e:
        return {'kind': 'error', 'name': name, 'msg': f'destination folder lookup failed: {e}'}

    original = by_name.get(name)
    if not original:
        return {'kind': 'error', 'name': name,
                 'msg': f'no original found at Photos/{year}/{month}/{name} — not touching orphan'}

    plan = (f'{name}: delete stale original (fileid {original["fileid"]}, '
            f'{original["size"]/1e6:.1f} MB) in Photos/{year}/{month}, '
            f'then move converted orphan (fileid {orphan["fileid"]}, '
            f'{orphan["size"]/1e6:.1f} MB) into place')

    if not execute:
        return {'kind': 'planned', 'name': name, 'msg': plan}

    try:
        _pcloud_api(hostname, token, 'deletefile', {'fileid': original['fileid']})
        _pcloud_api(hostname, token, 'renamefile',
                    {'fileid': orphan['fileid'], 'tofolderid': folderid, 'toname': name})
    except Exception as e:
        return {'kind': 'error', 'name': name, 'msg': f'{plan} — FAILED mid-way: {e}'}

    # Verify: re-stat the (now relocated) file and confirm it landed with the
    # expected name/size in the expected folder before declaring success.
    try:
        check = _pcloud_api(hostname, token, 'stat', {'fileid': orphan['fileid']})['metadata']
        if check['name'] != name or check['parentfolderid'] != folderid or check['size'] != orphan['size']:
            return {'kind': 'error', 'name': name,
                     'msg': f'moved but post-check mismatch: {check}'}
    except Exception as e:
        return {'kind': 'error', 'name': name, 'msg': f'moved but post-check failed: {e}'}

    return {'kind': 'repaired', 'name': name, 'msg': plan}


def load_state():
    if not os.path.exists(STATE_FILE):
        return set()
    with open(STATE_FILE) as f:
        return set(json.load(f))


def save_state(done):
    with open(STATE_FILE, 'w') as f:
        json.dump(sorted(done), f, indent=2)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--remote', default='pcloud', help='rclone remote name (default: pcloud)')
    ap.add_argument('--photos-path', default='/Photos', help='pCloud path to the Photos root (default: /Photos)')
    ap.add_argument('--root-path', default='/', help='pCloud folder to scan for orphans (default: /)')
    ap.add_argument('--workers', type=int, default=4, help='parallel repairs (default: 4)')
    ap.add_argument('--execute', action='store_true',
                     help='actually delete stale originals and move orphans (default: dry run / plan only)')
    args = ap.parse_args()

    hostname, token = get_pcloud_creds(args.remote)
    if not token:
        sys.exit(f"Could not read pCloud token for remote '{args.remote}'.")

    orphans = list_root_orphans(hostname, token, args.root_path)
    print(f'{len(orphans)} orphaned, Mappho-named video files found in {args.root_path}.')
    if not orphans:
        return

    done = load_state() if args.execute else set()
    pending = [o for o in orphans if o['name'] not in done]
    if done:
        print(f'{len(done)} already repaired in a prior run, {len(pending)} left.')
    print(f"Mode: {'EXECUTE (destructive)' if args.execute else 'DRY RUN — nothing will be changed'}\n")

    repaired = errors = planned = 0
    state_lock = threading.Lock()
    print_lock = threading.Lock()

    def log(msg):
        with print_lock:
            print(msg, flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(repair_one, hostname, token, args.photos_path, o, args.execute): o
            for o in pending
        }
        for i, future in enumerate(as_completed(futures), 1):
            r = future.result()
            if r['kind'] == 'repaired':
                repaired += 1
                log(f'[{i}/{len(pending)}] ✓ {r["msg"]}')
                with state_lock:
                    done.add(r['name'])
                    save_state(done)
            elif r['kind'] == 'planned':
                planned += 1
                log(f'[{i}/{len(pending)}] PLAN: {r["msg"]}')
            else:
                errors += 1
                log(f'[{i}/{len(pending)}] ✗ {r["name"]}: {r["msg"]}')

    if args.execute:
        print(f'\nDone — {repaired} repaired, {errors} errors.')
        if errors:
            print('Re-run to retry failed files (already-repaired ones are skipped via state file).')
        if repaired and os.path.exists(STATE_FILE) and errors == 0:
            os.remove(STATE_FILE)
        if repaired:
            print('\nOpen Mappho and run Settings → Rebuild from Photos to pick up the new fileids/hashes.')
    else:
        print(f'\n{planned} files planned, {errors} anomalies (would be skipped, not touched).')
        print('Re-run with --execute to actually perform the repair.')


if __name__ == '__main__':
    main()
