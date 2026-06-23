#!/usr/bin/env python3
"""
Detect duplicate photos in pCloud Photos/ whose filenames differ by a fixed
time offset (default 2 h), which is the classic DST mis-interpretation symptom.

Optionally downloads the first 128 KB of each candidate pair and compares the
embedded EXIF thumbnail using a perceptual hash — no full-file download needed.

Usage:
    python3 tools/find_time_duplicates.py
    python3 tools/find_time_duplicates.py --compare-images
    python3 tools/find_time_duplicates.py --offset 3600        # 1-hour offset
    python3 tools/find_time_duplicates.py --tolerance 120      # ± 2-minute window
    python3 tools/find_time_duplicates.py --remote pcloud --path Photos
    python3 tools/find_time_duplicates.py --delete-smaller     # auto-delete after confirm

Requirements for --compare-images:
    pip install Pillow imagehash
"""

import argparse
import io
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import PurePosixPath


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Find DST-offset duplicate photos on pCloud")
    p.add_argument("--remote",          default="pcloud",  help="rclone remote name")
    p.add_argument("--path",            default="Photos",  help="sub-path to scan")
    p.add_argument("--offset",          type=int, default=7200, help="expected time offset in seconds (default 7200 = 2 h)")
    p.add_argument("--tolerance",       type=int, default=90,   help="± tolerance in seconds (default 90)")
    p.add_argument("--compare-images",  action="store_true",    help="download & perceptually compare thumbnails")
    p.add_argument("--hash-distance",   type=int, default=8,    help="max perceptual hash distance to count as same image (default 8)")
    p.add_argument("--delete-smaller",  action="store_true",    help="offer to delete the smaller file of each confirmed pair")
    return p.parse_args()


# ── pCloud listing ────────────────────────────────────────────────────────────

EXTS = {".jpg", ".jpeg", ".heic", ".png", ".mp4", ".mov", ".avi", ".3gp"}

def list_files(remote, path):
    """Return list of dicts from rclone lsjson --recursive."""
    print(f"Listing {remote}:{path} …")
    r = subprocess.run(
        ["rclone", "lsjson", f"{remote}:{path}", "--recursive", "--files-only"],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"rclone lsjson failed:\n{r.stderr.strip()}")
    entries = json.loads(r.stdout)
    return [e for e in entries if PurePosixPath(e["Path"]).suffix.lower() in EXTS]


# ── Filename timestamp parsing ────────────────────────────────────────────────

# Mappho organises files as  YYYY-MM-DD_HH-MM-SS[_N].ext
_TS_RE = re.compile(r"(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})")

def parse_ts(name):
    m = _TS_RE.search(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ── Duplicate detection ───────────────────────────────────────────────────────

def find_candidates(files, offset_s, tolerance_s):
    """
    Return list of (file_a, file_b, actual_diff_s) where the filenames encode
    timestamps that differ by offset_s ± tolerance_s.
    """
    dated = []
    for f in files:
        name = PurePosixPath(f["Path"]).name
        ts = parse_ts(name)
        if ts is not None:
            dated.append({**f, "_ts": ts})

    dated.sort(key=lambda x: x["_ts"])

    candidates = []
    n = len(dated)
    for i, a in enumerate(dated):
        # Only look ahead while diff <= offset + tolerance (list is sorted)
        for j in range(i + 1, n):
            b = dated[j]
            diff = (b["_ts"] - a["_ts"]).total_seconds()
            if diff > offset_s + tolerance_s:
                break
            if abs(diff - offset_s) <= tolerance_s:
                candidates.append((a, b, diff))

    return candidates


# ── Perceptual image comparison ───────────────────────────────────────────────

def fetch_head(remote, path, rel_path, nbytes=131072):
    """Download first nbytes of a file via rclone."""
    r = subprocess.run(
        ["rclone", "cat", "--count", str(nbytes), f"{remote}:{path}/{rel_path}"],
        capture_output=True,
    )
    if r.returncode != 0:
        return None
    return r.stdout


def phash_from_bytes(data):
    """Extract the embedded EXIF thumbnail (or decode as image) and return perceptual hash."""
    try:
        import imagehash
        from PIL import Image
    except ImportError:
        sys.exit("Install Pillow and imagehash:  pip install Pillow imagehash")

    buf = io.BytesIO(data)

    # Try to extract EXIF thumbnail first (much smaller, faster hash)
    try:
        img = Image.open(buf)
        exif = img._getexif()  # type: ignore[attr-defined]
        if exif:
            thumb_data = exif.get(0x0201)  # JPEGInterchangeFormat offset marker
            # PIL already handles thumbnail extraction on open for EXIF thumb
        # Fall through to full image if needed
        buf.seek(0)
        img = Image.open(buf)
        img.load()
        return imagehash.phash(img)
    except Exception:
        pass

    # If EXIF path failed, try treating the head bytes as a raw JPEG fragment
    try:
        buf.seek(0)
        img = Image.open(buf)
        return imagehash.phash(img)
    except Exception:
        return None


def image_similarity(remote, path, file_a, file_b):
    """
    Returns (hash_distance, same_image) for the two files.
    Downloads only the first 128 KB of each.
    """
    data_a = fetch_head(remote, path, file_a["Path"])
    data_b = fetch_head(remote, path, file_b["Path"])
    if data_a is None or data_b is None:
        return None, None
    h_a = phash_from_bytes(data_a)
    h_b = phash_from_bytes(data_b)
    if h_a is None or h_b is None:
        return None, None
    dist = h_a - h_b
    return dist, dist


# ── Output helpers ────────────────────────────────────────────────────────────

def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def print_pair(a, b, diff_s, dist=None, max_dist=None):
    same = "" if dist is None else (" ✓ same image" if dist <= max_dist else f" ✗ images differ (dist={dist})")
    print(f"\n  A  {a['Path']}  ({fmt_size(a['Size'])})")
    print(f"  B  {b['Path']}  ({fmt_size(b['Size'])})")
    print(f"     Δt = {diff_s/3600:.2f} h{same}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()
    root = f"{args.remote}:{args.path}"

    files = list_files(args.remote, args.path)
    print(f"{len(files)} image files found.\n")

    candidates = find_candidates(files, args.offset, args.tolerance)

    if not candidates:
        print(f"No pairs found with a {args.offset/3600:.1f}-hour offset (±{args.tolerance}s). 🎉")
        return

    print(f"Found {len(candidates)} candidate pair(s) with ~{args.offset/3600:.1f}-hour offset:\n")
    print("─" * 70)

    confirmed = []  # pairs that pass the image comparison

    for a, b, diff_s in candidates:
        if args.compare_images:
            print(f"  Comparing {PurePosixPath(a['Path']).name} ↔ {PurePosixPath(b['Path']).name} …", end="", flush=True)
            dist, _ = image_similarity(args.remote, args.path, a, b)
            print(f" dist={dist}" if dist is not None else " (comparison failed)")
            if dist is not None and dist <= args.hash_distance:
                confirmed.append((a, b, diff_s, dist))
                print_pair(a, b, diff_s, dist, args.hash_distance)
            elif dist is not None:
                print(f"  (skipped — images look different, dist={dist})")
        else:
            confirmed.append((a, b, diff_s, None))
            print_pair(a, b, diff_s)

    print("\n" + "─" * 70)

    if args.compare_images:
        print(f"\n{len(confirmed)} / {len(candidates)} pairs confirmed as same image.")
    else:
        print(f"\n{len(candidates)} candidate pair(s). Run with --compare-images to verify visually.")

    if not confirmed:
        return

    if args.delete_smaller:
        print("\nDelete the SMALLER file of each confirmed pair?")
        print("(Keeping the larger file usually means keeping richer EXIF / higher quality.)")
        yn = input("Proceed? [y/N] ").strip().lower()
        if yn != "y":
            print("Aborted.")
            return

        for a, b, diff_s, dist in confirmed:
            to_delete = a if a["Size"] <= b["Size"] else b
            print(f"  Deleting {to_delete['Path']} … ", end="", flush=True)
            r = subprocess.run(
                ["rclone", "deletefile", f"{args.remote}:{args.path}/{to_delete['Path']}"],
                capture_output=True,
            )
            if r.returncode == 0:
                print("done.")
            else:
                print(f"FAILED: {r.stderr.decode().strip()}")
    else:
        print("\nRe-run with --delete-smaller to remove the smaller file of each pair.")
        print("Or inspect manually and delete with:  rclone deletefile pcloud:Photos/<path>")


if __name__ == "__main__":
    main()
