#!/usr/bin/env python3
"""
Re-encode MP4/MOV files whose video stream isn't H.264 to H.264, in place.

Some old phone/camera recordings are already .mp4 containers but use an
older video codec (commonly MPEG-4 Part 2 / "mp4v", the DivX/Xvid-era
codec) that modern Android devices generally can't decode — the audio
track (usually AAC) plays fine since that codec is universally supported,
but no picture ever renders. convert_avi.py doesn't catch these because it
only looks at the .avi extension, not the codec inside an already-.mp4 file.

Probes each file with ffprobe and only re-encodes the video stream if it
isn't already h264; the audio stream is copied as-is if it's already AAC
(no re-encode, no quality loss) and only transcoded otherwise. Also adds
-movflags +faststart so the moov atom moves to the front of the file,
letting Mappho's own metadata scan (which only reads the first 128KB) find
embedded date/GPS on files where it currently can't.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def probe_streams(path: Path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    return video, audio


def convert(path: Path, dry_run: bool) -> str:
    """Returns 'converted', 'skipped', or 'error'."""
    streams = probe_streams(path)
    if streams is None:
        print(f"  ERROR probing {path}")
        return "error"
    video, _audio = streams
    if video is None:
        print(f"  skip — {path} has no video stream")
        return "skipped"
    if video.get("codec_name") == "h264":
        return "skipped"

    print(f"  converting {path} (video codec: {video.get('codec_name')})")
    if dry_run:
        return "converted"

    audio_codec = _audio.get("codec_name") if _audio else None
    audio_args = ["-c:a", "copy"] if audio_codec == "aac" else ["-c:a", "aac", "-b:a", "128k"]

    tmp = path.with_suffix(path.suffix + ".converting.mp4")
    result = subprocess.run(
        [
            "ffmpeg", "-i", str(path),
            "-c:v", "libx264", "-crf", "23", "-preset", "fast",
            *audio_args,
            "-movflags", "+faststart",
            "-y", str(tmp),
        ],
        capture_output=True,
    )
    if result.returncode != 0:
        print(f"  ERROR: ffmpeg failed:\n{result.stderr.decode()}")
        tmp.unlink(missing_ok=True)
        return "error"

    tmp.replace(path)  # atomic on the same filesystem
    print(f"  done — {path}")
    return "converted"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("root", help="Root folder to search (e.g. /Volumes/pCloud/Photos)")
    parser.add_argument("--dry-run", action="store_true", help="List affected files without converting")
    args = parser.parse_args()

    root = Path(args.root)
    if not root.is_dir():
        print(f"Error: {root} is not a directory", file=sys.stderr)
        sys.exit(1)

    videos = sorted(
        p for ext in ("*.mp4", "*.MP4", "*.mov", "*.MOV") for p in root.rglob(ext)
    )
    if not videos:
        print("No MP4/MOV files found.")
        return

    print(f"Checking {len(videos)} file(s){' (dry run)' if args.dry_run else ''}:\n")
    converted = skipped = errors = 0
    for v in videos:
        outcome = convert(v, args.dry_run)
        if outcome == "converted":
            converted += 1
        elif outcome == "skipped":
            skipped += 1
        else:
            errors += 1

    print(f"\nDone — {converted} converted, {skipped} already H.264, {errors} failed.")


if __name__ == "__main__":
    main()
