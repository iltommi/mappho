#!/usr/bin/env python3
"""Convert all AVI files in a directory tree to H.264 MP4, then delete the originals."""

import argparse
import subprocess
import sys
from pathlib import Path


def convert(avi: Path, dry_run: bool) -> bool:
    mp4 = avi.with_suffix('.mp4')
    if mp4.exists():
        print(f"  skip — {mp4} already exists")
        return False

    print(f"  converting {avi} → {mp4}")
    if dry_run:
        return True

    result = subprocess.run(
        [
            "ffmpeg", "-i", str(avi),
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            "-y", str(mp4),
        ],
        capture_output=True,
    )

    if result.returncode != 0:
        print(f"  ERROR: ffmpeg failed:\n{result.stderr.decode()}")
        mp4.unlink(missing_ok=True)
        return False

    avi.unlink()
    print(f"  done — deleted {avi}")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", help="Root folder to search (e.g. /Volumes/pCloud/Photos)")
    parser.add_argument("--dry-run", action="store_true", help="List files without converting")
    args = parser.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    avis = sorted(root.rglob("*.avi")) + sorted(root.rglob("*.AVI"))
    if not avis:
        print("No AVI files found.")
        return

    print(f"Found {len(avis)} AVI file(s){' (dry run)' if args.dry_run else ''}:\n")
    ok = fail = skip = 0
    for avi in avis:
        result = convert(avi, args.dry_run)
        if result is True:
            ok += 1
        elif result is False and avi.with_suffix('.mp4').exists():
            skip += 1
        else:
            fail += 1

    print(f"\nDone — {ok} converted, {skip} skipped, {fail} failed.")


if __name__ == "__main__":
    main()
