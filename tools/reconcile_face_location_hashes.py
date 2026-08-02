#!/usr/bin/env python3
"""
reconcile_face_location_hashes.py — One-time repair for a real bug found in
convert_video_codecs.py (2026-07): every hash-based rekey that script ever
did to faces.json/locations.json/hash-index.json compared its own EXACT
pCloud hash (Python ints are arbitrary precision) against what those files
actually store, which is almost always the JS-rounded value instead (see
js_rounded_hash's docstring in convert_video_codecs.py — the app's own
JSON.parse silently rounds any hash above 2^53, and ~84% of real hashes in
this library exceed that). The match failed silently for the vast majority
of files that script ever converted/rangefixed/remuxed/tagfixed, and
patch_all_dbs treated "0 matching entries" as fully resolved rather than a
conflict to retry — so the pending migration was just dropped every time.

The forward-looking half of this bug is now fixed directly in
convert_video_codecs.py (hash_migrations registers both the exact and
JS-rounded key). This script is the other half: repairing entries that are
ALREADY stuck pointing at a hash the file no longer has, from every past
run before that fix existed.

Unlike convert_video_codecs.py's patch functions (which only know about
files THEY just touched, via old_hash/new_hash pairs recorded during that
same run), this script doesn't need any migration history at all — a video
conversion never changes a file's path/name, only its content hash, so it
cross-references every faces.json/locations.json entry against pCloud's
CURRENT hash for that same path (fetched once, in bulk, via listfolder
recursive=1 — not one stat() per entry) and fixes any mismatch directly.

Deliberately excludes entries whose stored hash isn't a plain pCloud
numeric hash (e.g. the ~750 faces.json entries that store a SHA-256 hex
digest instead — a separate, pre-existing bug in the external
face-detection tool, out of scope here: this script only fixes entries
that were RIGHT once and drifted stale, not entries in the wrong format
to begin with).

hash-index.json isn't included — Settings -> Rebuild from Photos in the
app already fully regenerates it from a fresh listing, which is strictly
more authoritative than a targeted patch here.

Usage:
    python3 tools/reconcile_face_location_hashes.py --dry-run
    python3 tools/reconcile_face_location_hashes.py

Requirements: rclone (configured for the target remote).
"""

import argparse
import json
import sys
import urllib.request
from pathlib import PurePosixPath

sys.path.insert(0, str(PurePosixPath(__file__).parent))
from convert_video_codecs import (
    get_pcloud_creds, _pcloud_api, js_rounded_hash, _remote_unchanged, _upload_json,
)

VIDEO_EXTS = {'.mp4', '.mov'}


def build_path_hash_map(hostname, token, root_path):
    root_path = '/' + root_path.strip('/')
    meta = _pcloud_api(hostname, token, 'stat', {'path': root_path})['metadata']
    print(f'Listing {root_path} recursively…')
    result = _pcloud_api(hostname, token, 'listfolder', {'folderid': meta['folderid'], 'recursive': 1}, timeout=180)

    path_hash = {}

    def walk(node, prefix):
        for item in node.get('contents', []):
            name = item['name']
            rel = f'{prefix}{name}' if not prefix else f'{prefix}/{name}'
            if item.get('isfolder'):
                walk(item, rel)
            else:
                ext = ('.' + name.rsplit('.', 1)[-1]).lower() if '.' in name else ''
                if ext in VIDEO_EXTS and item.get('hash') is not None:
                    path_hash[rel] = str(item['hash'])

    walk(result['metadata'], '')
    print(f'{len(path_hash)} video files found.')
    return path_hash


def reconcile_one(hostname, token, root_path, filename, path_hash, dry_run):
    remote_path = f"{'/' + root_path.strip('/')}/{filename}"
    meta = _pcloud_api(hostname, token, 'stat', {'path': remote_path})['metadata']
    fileid, folderid, remote_hash = meta['fileid'], meta['parentfolderid'], meta.get('hash')
    link = _pcloud_api(hostname, token, 'getfilelink', {'fileid': fileid})
    host = link['hosts'][0]
    with urllib.request.urlopen(f"https://{host}{link['path']}", timeout=60) as resp:
        data = json.loads(resp.read())

    fixed = 0
    skipped_wrong_format = 0
    for entry in data.get('entries', []):
        p = entry.get('path')
        cur_hash = path_hash.get(p)
        if cur_hash is None:
            continue  # not a currently-existing video (photo entry, deleted file, ...)
        stored = str(entry.get('hash', ''))
        if not stored.isdigit():
            skipped_wrong_format += 1
            continue  # e.g. the separate SHA-256-format bug — not this script's job
        if stored == cur_hash or js_rounded_hash(cur_hash) == stored:
            continue  # already correct
        if dry_run:
            print(f'  would fix {filename}: {p}  {stored} -> {cur_hash}')
        else:
            entry['hash'] = cur_hash
        fixed += 1

    print(f'{filename}: {fixed} entries to fix, {skipped_wrong_format} skipped (non-numeric hash format, separate issue)')
    if fixed == 0 or dry_run:
        return fixed

    if not _remote_unchanged(hostname, token, fileid, remote_hash):
        print(f'  ! {filename} changed remotely since it was read — skipping this file, re-run to retry')
        return 0

    _upload_json(hostname, token, folderid, filename, data, fileid)
    print(f'  ✓ {filename}: uploaded with {fixed} entries corrected')
    return fixed


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--remote', default='pcloud')
    ap.add_argument('--path', default='Photos')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    hostname, token = get_pcloud_creds(args.remote)
    if not token:
        sys.exit(f"Could not read pCloud token for remote '{args.remote}'.")

    path_hash = build_path_hash_map(hostname, token, args.path)

    total = 0
    for filename in ('faces.json', 'locations.json'):
        total += reconcile_one(hostname, token, args.path, filename, path_hash, args.dry_run)

    if args.dry_run:
        print(f'\n{total} entries would be fixed (dry run — nothing written).')
    else:
        print(f'\n{total} entries fixed.')


if __name__ == '__main__':
    main()
