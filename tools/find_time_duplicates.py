#!/usr/bin/env python3
"""
Detect duplicate photos in pCloud Photos/ whose filenames differ by a fixed
time offset (default 2 h), which is the classic DST mis-interpretation symptom.

Without --compare-images: filename-only scan, prints candidates, no downloads.
With    --compare-images: downloads first 128 KB of each pair, shows both
    thumbnails side by side in an interactive window, lets you delete on the spot.

Usage:
    python3 tools/find_time_duplicates.py
    python3 tools/find_time_duplicates.py --compare-images
    python3 tools/find_time_duplicates.py --offset 3600     # 1-hour offset
    python3 tools/find_time_duplicates.py --tolerance 120   # ± 2-minute window
    python3 tools/find_time_duplicates.py --remote pcloud --path Photos

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
    p.add_argument("--remote",         default="pcloud", help="rclone remote name")
    p.add_argument("--path",           default="Photos", help="sub-path to scan")
    p.add_argument("--offset",         type=int, default=7200, help="expected time offset in seconds (default 7200 = 2 h)")
    p.add_argument("--tolerance",      type=int, default=90,   help="± tolerance in seconds (default 90)")
    p.add_argument("--compare-images", action="store_true",    help="show side-by-side thumbnail window for each pair")
    p.add_argument("--hash-distance",  type=int, default=8,    help="max perceptual hash distance to flag as same image (default 8)")
    return p.parse_args()


# ── pCloud listing ────────────────────────────────────────────────────────────

EXTS = {".jpg", ".jpeg", ".heic", ".png", ".mp4", ".mov", ".avi", ".3gp"}

def list_files(remote, path):
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

_TS_RE = re.compile(r"(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})")

def parse_ts(name):
    m = _TS_RE.search(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# ── Candidate detection ───────────────────────────────────────────────────────

def find_candidates(files, offset_s, tolerance_s):
    dated = []
    for f in files:
        ts = parse_ts(PurePosixPath(f["Path"]).name)
        if ts is not None:
            dated.append({**f, "_ts": ts})
    dated.sort(key=lambda x: x["_ts"])

    candidates = []
    n = len(dated)
    for i, a in enumerate(dated):
        for j in range(i + 1, n):
            b = dated[j]
            diff = (b["_ts"] - a["_ts"]).total_seconds()
            if diff > offset_s + tolerance_s:
                break
            if abs(diff - offset_s) <= tolerance_s:
                candidates.append((a, b, diff))
    return candidates


# ── Image loading ─────────────────────────────────────────────────────────────

def fetch_head(remote, path, rel_path, nbytes=131072):
    r = subprocess.run(
        ["rclone", "cat", "--count", str(nbytes), f"{remote}:{path}/{rel_path}"],
        capture_output=True,
    )
    return r.stdout if r.returncode == 0 else None


def load_image(data):
    """Return a PIL Image from raw (possibly truncated) bytes, or None."""
    if not data:
        return None
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
        return img
    except Exception:
        return None


def phash(img):
    import imagehash
    try:
        return imagehash.phash(img)
    except Exception:
        return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def delete_file(remote, path, rel_path):
    r = subprocess.run(
        ["rclone", "deletefile", f"{remote}:{path}/{rel_path}"],
        capture_output=True,
    )
    return r.returncode == 0, r.stderr.decode().strip()


# ── Interactive comparison window ─────────────────────────────────────────────

THUMB_W, THUMB_H = 380, 320
BG      = "#0f172a"
FG      = "#e2e8f0"
FG_DIM  = "#94a3b8"
BTN_DEL = "#dc2626"
BTN_OK  = "#16a34a"
BTN_NEU = "#334155"


def _make_thumb(img, tk_module):
    """Return a tkinter PhotoImage of size THUMB_W × THUMB_H (letterboxed)."""
    from PIL import Image, ImageTk
    if img is None:
        placeholder = Image.new("RGB", (THUMB_W, THUMB_H), "#1e293b")
        return ImageTk.PhotoImage(placeholder)
    thumb = img.copy()
    thumb.thumbnail((THUMB_W, THUMB_H), Image.LANCZOS)
    canvas = Image.new("RGB", (THUMB_W, THUMB_H), "#0f172a")
    canvas.paste(thumb, ((THUMB_W - thumb.width) // 2, (THUMB_H - thumb.height) // 2))
    return ImageTk.PhotoImage(canvas)


def show_pair_window(idx, total, a, b, diff_s, dist, img_a, img_b, max_dist):
    """
    Show a side-by-side comparison window.
    Returns one of: 'delete_a', 'delete_b', 'keep_both', 'quit'
    """
    import tkinter as tk

    result = ["keep_both"]
    root = tk.Tk()
    root.title(f"Duplicate review  {idx}/{total}")
    root.configure(bg=BG)
    root.resizable(False, False)

    # ── thumbnails ──
    photo_a = _make_thumb(img_a, tk)
    photo_b = _make_thumb(img_b, tk)

    frame_imgs = tk.Frame(root, bg=BG)
    frame_imgs.pack(padx=12, pady=(12, 4))

    for photo, col in ((photo_a, 0), (photo_b, 1)):
        lbl = tk.Label(frame_imgs, image=photo, bg=BG, relief="flat")
        lbl.grid(row=0, column=col, padx=6)
        lbl.image = photo  # keep reference

    # ── file info ──
    def info_label(parent, file, col):
        name  = PurePosixPath(file["Path"]).name
        size  = fmt_size(file["Size"])
        frame = tk.Frame(parent, bg=BG)
        frame.grid(row=1, column=col, padx=6, pady=4)
        tk.Label(frame, text=name,  bg=BG, fg=FG,     font=("Helvetica", 10, "bold"), wraplength=THUMB_W).pack()
        tk.Label(frame, text=size,  bg=BG, fg=FG_DIM, font=("Helvetica",  9)).pack()
        tk.Label(frame, text=file["Path"].rsplit("/", 1)[0],
                 bg=BG, fg=FG_DIM, font=("Helvetica", 8), wraplength=THUMB_W).pack()

    info_label(frame_imgs, a, 0)
    info_label(frame_imgs, b, 1)

    # ── hash distance badge ──
    if dist is not None:
        badge_color = BTN_OK if dist <= max_dist else "#b45309"
        badge_text  = f"Hash distance: {dist}  {'✓ same image' if dist <= max_dist else '⚠ images differ'}"
        tk.Label(root, text=badge_text, bg=badge_color, fg="#fff",
                 font=("Helvetica", 10), padx=8, pady=3).pack(pady=(0, 6))

    tk.Label(root, text=f"Δt = {diff_s / 3600:.2f} h",
             bg=BG, fg=FG_DIM, font=("Helvetica", 9)).pack()

    # ── buttons ──
    frame_btns = tk.Frame(root, bg=BG)
    frame_btns.pack(pady=10)

    def btn(parent, text, color, action, col):
        def cmd():
            result[0] = action
            root.destroy()
        b = tk.Button(parent, text=text, bg=color, fg="#fff", activebackground=color,
                      font=("Helvetica", 11, "bold"), padx=14, pady=8, relief="flat",
                      cursor="hand2", command=cmd)
        b.grid(row=0, column=col, padx=6)

    btn(frame_btns, "Delete A ←",  BTN_DEL, "delete_a",   0)
    btn(frame_btns, "Keep both",   BTN_NEU, "keep_both",  1)
    btn(frame_btns, "→ Delete B",  BTN_DEL, "delete_b",   2)

    frame_nav = tk.Frame(root, bg=BG)
    frame_nav.pack(pady=(2, 12))
    btn(frame_nav,  "Skip",        BTN_NEU, "keep_both",  0)
    btn(frame_nav,  "Quit review", "#7f1d1d", "quit",     1)

    root.bind("<Escape>", lambda e: (result.__setitem__(0, "keep_both"), root.destroy()))
    root.mainloop()
    return result[0]


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = parse_args()

    files = list_files(args.remote, args.path)
    print(f"{len(files)} image files found.\n")

    candidates = find_candidates(files, args.offset, args.tolerance)

    if not candidates:
        print(f"No pairs found with a {args.offset/3600:.1f}-hour offset (±{args.tolerance}s). 🎉")
        return

    print(f"Found {len(candidates)} candidate pair(s) with ~{args.offset/3600:.1f}-hour offset:\n")

    if not args.compare_images:
        for a, b, diff_s in candidates:
            print(f"  A  {a['Path']}  ({fmt_size(a['Size'])})")
            print(f"  B  {b['Path']}  ({fmt_size(b['Size'])})")
            print(f"     Δt = {diff_s/3600:.2f} h\n")
        print("Run with --compare-images to review thumbnails interactively.")
        return

    # Interactive review
    try:
        import imagehash  # noqa: F401
        from PIL import Image  # noqa: F401
    except ImportError:
        sys.exit("Install dependencies first:  pip install Pillow imagehash")

    deleted = 0
    kept    = 0

    for i, (a, b, diff_s) in enumerate(candidates, 1):
        name_a = PurePosixPath(a["Path"]).name
        name_b = PurePosixPath(b["Path"]).name
        print(f"[{i}/{len(candidates)}] Downloading {name_a} & {name_b} …", end="", flush=True)

        data_a = fetch_head(args.remote, args.path, a["Path"])
        data_b = fetch_head(args.remote, args.path, b["Path"])
        img_a  = load_image(data_a)
        img_b  = load_image(data_b)

        h_a  = phash(img_a) if img_a else None
        h_b  = phash(img_b) if img_b else None
        dist = (h_a - h_b) if (h_a is not None and h_b is not None) else None
        print(f" dist={dist}" if dist is not None else " (hash unavailable)")

        action = show_pair_window(i, len(candidates), a, b, diff_s, dist, img_a, img_b, args.hash_distance)

        if action == "quit":
            print("Review stopped by user.")
            break
        elif action in ("delete_a", "delete_b"):
            target = a if action == "delete_a" else b
            print(f"  Deleting {target['Path']} … ", end="", flush=True)
            ok, err = delete_file(args.remote, args.path, target["Path"])
            print("done." if ok else f"FAILED: {err}")
            deleted += 1
        else:
            print(f"  Kept both.")
            kept += 1

    print(f"\nDone — {deleted} deleted, {kept} kept.")


if __name__ == "__main__":
    main()
