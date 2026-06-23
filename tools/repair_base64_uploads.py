#!/usr/bin/env python3
"""
Repair JPEGs on pCloud that were corrupted by a Mappho bug where uploadFile
stored the base64 text of the image instead of the binary JPEG.

Corrupt files start with the ASCII string "/9j/" (the base64 encoding of the
JPEG magic bytes FF D8 FF). This script finds them, decodes them, and
overwrites the file on pCloud with the correct binary content.

Progress is saved to repair_state.json after every file so you can interrupt
with Ctrl+C and resume from where you left off by running the script again.

Usage:
    python3 tools/repair_base64_uploads.py [--remote pcloud] [--path Photos]
    python3 tools/repair_base64_uploads.py --dry-run
    python3 tools/repair_base64_uploads.py --reset   # clear saved progress
    python3 tools/repair_base64_uploads.py --workers 16
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

STATE_FILE = "repair_state.json"
state_lock = threading.Lock()
print_lock = threading.Lock()


def load_state(root):
    if not os.path.exists(STATE_FILE):
        return {"root": root, "checked": [], "fixed": [], "skipped": [], "errors": []}
    with open(STATE_FILE) as f:
        state = json.load(f)
    if state.get("root") != root:
        print(f"Note: state file was for '{state.get('root')}', ignoring it.")
        return {"root": root, "checked": [], "fixed": [], "skipped": [], "errors": []}
    return state


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def println(msg):
    with print_lock:
        sys.stdout.write(f"\r{msg}\n")
        sys.stdout.flush()


def check_file(path, root):
    """Return (path, first4_bytes). Reads only 4 bytes via rclone cat + kill."""
    proc = subprocess.Popen(
        ["rclone", "cat", f"{root}/{path}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    first4 = proc.stdout.read(4)
    proc.kill()
    proc.wait()
    return path, first4


def fix_file(path, root, dry_run):
    """Download, decode, re-upload. Returns 'fixed', 'skipped', or 'error'."""
    full = subprocess.run(
        ["rclone", "cat", f"{root}/{path}"],
        capture_output=True,
    )
    if full.returncode != 0:
        println(f"  download failed: {full.stderr.decode().strip()}")
        return "error"

    try:
        decoded = base64.b64decode(full.stdout.strip())
    except Exception as e:
        println(f"  base64 decode failed: {e}")
        return "error"

    if decoded[:2] != b"\xff\xd8":
        println(f"  decoded content is not a JPEG — skipping")
        return "skipped"

    if dry_run:
        println(f"  would fix ({len(decoded):,} bytes)  [dry-run]")
        return "fixed"

    upload = subprocess.run(
        ["rclone", "rcat", f"{root}/{path}"],
        input=decoded,
        capture_output=True,
    )
    if upload.returncode == 0:
        println(f"  FIXED    ({len(decoded):,} bytes)")
        return "fixed"
    else:
        println(f"  upload failed: {upload.stderr.decode().strip()}")
        return "error"


def main():
    parser = argparse.ArgumentParser(description="Repair base64-encoded JPEGs on pCloud")
    parser.add_argument("--remote", default="pcloud", help="rclone remote name (default: pcloud)")
    parser.add_argument("--path", default="Photos", help="sub-path to scan (default: Photos)")
    parser.add_argument("--dry-run", action="store_true", help="detect only, do not upload fixes")
    parser.add_argument("--reset", action="store_true", help="clear saved progress and start over")
    parser.add_argument("--workers", type=int, default=8, help="parallel check workers (default: 8)")
    args = parser.parse_args()

    root = f"{args.remote}:{args.path}"

    if args.reset:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
            print(f"Cleared {STATE_FILE}")
        else:
            print("No state file to clear.")

    state = load_state(root)
    checked = set(state["checked"])

    if checked:
        print(f"Resuming — {len(checked)} files already checked, "
              f"{len(state['fixed'])} fixed so far.")

    print(f"Listing JPEGs under {root} …")
    ls = subprocess.run(
        ["rclone", "ls", root, "--include", "*.jpg", "--include", "*.JPG", "--include", "*.jpeg"],
        capture_output=True, text=True,
    )
    if ls.returncode != 0:
        sys.exit(f"rclone ls failed:\n{ls.stderr.strip()}")

    all_files = []
    for line in ls.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            all_files.append(parts[1])

    files = [f for f in all_files if f not in checked]
    total = len(files)
    print(f"{len(all_files)} JPEGs found, {total} to check  ({args.workers} workers)\n")

    done_count = 0
    interrupted = False

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {executor.submit(check_file, path, root): path for path in files}
            for future in as_completed(futures):
                path, first4 = future.result()
                done_count += 1

                with print_lock:
                    sys.stdout.write(f"\r[{done_count}/{total}] {path[-72:]:<72}")
                    sys.stdout.flush()

                if first4 == b"/9j/":
                    println(f"\n  CORRUPT  {path}")
                    outcome = fix_file(path, root, args.dry_run)
                    with state_lock:
                        state[{"fixed": "fixed", "skipped": "skipped", "error": "errors"}[outcome]].append(path)
                        state["checked"].append(path)
                        save_state(state)
                else:
                    with state_lock:
                        state["checked"].append(path)
                        save_state(state)

    except KeyboardInterrupt:
        interrupted = True
        print("\n\nInterrupted — progress saved.")

    tag = " [dry-run]" if args.dry_run else ""
    fixed, skipped, errors = state["fixed"], state["skipped"], state["errors"]
    print(f"\n{'Partial results' if interrupted else 'Done'}{tag}: "
          f"{len(fixed)} fixed, {len(skipped)} skipped, {len(errors)} errors")

    if fixed:
        print("\nFixed:")
        for p in fixed:
            print(f"  ✓  {p}")
    if skipped:
        print("\nSkipped (decoded content not a JPEG):")
        for p in skipped:
            print(f"  ?  {p}")
    if errors:
        print("\nErrors:")
        for p in errors:
            print(f"  ✗  {p}")

    if interrupted:
        print(f"\nRun the script again to continue.")
    elif not args.dry_run:
        if os.path.exists(STATE_FILE):
            os.remove(STATE_FILE)
        print(f"\nState file removed — scan complete.")


if __name__ == "__main__":
    main()
