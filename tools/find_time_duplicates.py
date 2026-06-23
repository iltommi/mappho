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
import urllib.request
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


# ── pCloud thumbnail API ──────────────────────────────────────────────────────

def get_pcloud_creds(remote):
    """Read hostname and access token from rclone config."""
    r = subprocess.run(["rclone", "config", "show", remote], capture_output=True, text=True)
    if r.returncode != 0:
        return None, None
    hostname = token = None
    for line in r.stdout.splitlines():
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip()
        if k == "hostname":
            hostname = v
        elif k == "token":
            try:
                token = json.loads(v).get("access_token")
            except Exception:
                pass
    return hostname or "api.pcloud.com", token


def fetch_pcloud_thumb(hostname, token, file_id, size="512x512"):
    """
    Download a thumbnail directly from the pCloud API.
    file_id is the numeric pCloud file id (rclone lsjson 'ID' field, strip leading 'f').
    Returns raw image bytes or None.
    """
    fid = file_id.lstrip("f") if isinstance(file_id, str) else file_id
    url = (f"https://{hostname}/getthumb"
           f"?fileid={fid}&size={size}&crop=0&access_token={token}")
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = resp.read()
        # pCloud returns a JSON error object if the file has no thumbnail
        if data[:1] == b'{':
            return None
        return data
    except Exception:
        return None


# ── Image loading ─────────────────────────────────────────────────────────────

def load_image(data):
    """Return a PIL Image from raw bytes, or None."""
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


def _make_thumb(img):
    """Return a PIL Image letterboxed to THUMB_W × THUMB_H."""
    from PIL import Image
    LANCZOS = getattr(Image, "Resampling", Image).LANCZOS
    if img is None:
        return Image.new("RGB", (THUMB_W, THUMB_H), "#1e293b")
    thumb = img.copy()
    thumb.thumbnail((THUMB_W, THUMB_H), LANCZOS)
    canvas = Image.new("RGB", (THUMB_W, THUMB_H), "#0f172a")
    canvas.paste(thumb, ((THUMB_W - thumb.width) // 2, (THUMB_H - thumb.height) // 2))
    return canvas


class ReviewWindow:
    """Persistent tkinter window reused across all pairs."""

    def __init__(self, max_dist):
        import tkinter as tk
        from PIL import ImageTk
        self._tk = tk
        self._ImageTk = ImageTk
        self.max_dist = max_dist
        self._decision = tk.StringVar()

        root = tk.Tk()
        root.configure(bg=BG)
        root.resizable(False, False)
        root.protocol("WM_DELETE_WINDOW", lambda: self._decide("quit"))
        root.bind("<Escape>", lambda e: self._decide("keep_both"))
        self.root = root

        # ── counter label ──
        self._counter = tk.StringVar()
        tk.Label(root, textvariable=self._counter, bg=BG, fg=FG_DIM,
                 font=("Helvetica", 10)).pack(pady=(10, 2))

        # ── thumbnails + info ──
        frame = tk.Frame(root, bg=BG)
        frame.pack(padx=12, pady=4)

        self._img_lbl_a = tk.Label(frame, bg=BG)
        self._img_lbl_a.grid(row=0, column=0, padx=6)
        self._img_lbl_b = tk.Label(frame, bg=BG)
        self._img_lbl_b.grid(row=0, column=1, padx=6)

        self._name_a, self._size_a, self._dir_a = self._info_col(frame, 0)
        self._name_b, self._size_b, self._dir_b = self._info_col(frame, 1)

        # ── badge + delta ──
        self._badge = tk.Label(root, fg="#fff", font=("Helvetica", 10), padx=8, pady=3)
        self._badge.pack(pady=(6, 2))
        self._delta = tk.Label(root, bg=BG, fg=FG_DIM, font=("Helvetica", 9))
        self._delta.pack()

        # ── action buttons ──
        row1 = tk.Frame(root, bg=BG)
        row1.pack(pady=(10, 2))
        self._mkbtn(row1, "Delete A ←",  BTN_DEL, "delete_a",  0)
        self._mkbtn(row1, "Keep both",   BTN_NEU, "keep_both", 1)
        self._mkbtn(row1, "→ Delete B",  BTN_DEL, "delete_b",  2)

        row2 = tk.Frame(root, bg=BG)
        row2.pack(pady=(2, 12))
        self._mkbtn(row2, "Skip",         BTN_NEU,   "keep_both", 0)
        self._mkbtn(row2, "Quit review",  "#7f1d1d", "quit",      1)

    def _info_col(self, parent, col):
        f = self._tk.Frame(parent, bg=BG)
        f.grid(row=1, column=col, padx=6, pady=4)
        name = self._tk.Label(f, bg=BG, fg=FG,     font=("Helvetica", 10, "bold"), wraplength=THUMB_W)
        size = self._tk.Label(f, bg=BG, fg=FG_DIM, font=("Helvetica",  9))
        d    = self._tk.Label(f, bg=BG, fg=FG_DIM, font=("Helvetica",  8), wraplength=THUMB_W)
        name.pack(); size.pack(); d.pack()
        return name, size, d

    def _mkbtn(self, parent, text, color, action, col):
        self._tk.Button(
            parent, text=text, bg=color, fg="#fff", activebackground=color,
            font=("Helvetica", 11, "bold"), padx=14, pady=8, relief="flat",
            cursor="hand2", command=lambda a=action: self._decide(a),
        ).grid(row=0, column=col, padx=6)

    def _decide(self, action):
        self._decision.set(action)

    def show(self, idx, total, a, b, diff_s, dist, img_a, img_b):
        from PIL import ImageTk
        self._decision.set("")
        self.root.title(f"Duplicate review  {idx} / {total}")
        self._counter.set(f"Pair {idx} of {total}")

        # Update thumbnails
        for lbl, img in ((self._img_lbl_a, img_a), (self._img_lbl_b, img_b)):
            ph = ImageTk.PhotoImage(_make_thumb(img))
            lbl.configure(image=ph)
            lbl.image = ph  # prevent GC

        # Update info
        self._name_a.configure(text=PurePosixPath(a["Path"]).name)
        self._size_a.configure(text=fmt_size(a["Size"]))
        self._dir_a.configure(text=a["Path"].rsplit("/", 1)[0])
        self._name_b.configure(text=PurePosixPath(b["Path"]).name)
        self._size_b.configure(text=fmt_size(b["Size"]))
        self._dir_b.configure(text=b["Path"].rsplit("/", 1)[0])

        # Update badge
        if dist is not None:
            ok = dist <= self.max_dist
            self._badge.configure(
                bg=BTN_OK if ok else "#b45309",
                text=f"Hash distance: {dist}  {'✓ same image' if ok else '⚠ images differ'}",
            )
        else:
            self._badge.configure(bg=BTN_NEU, text="Hash distance: unavailable")

        self._delta.configure(text=f"Δt = {diff_s / 3600:.2f} h")

        self.root.deiconify()
        self.root.lift()
        self.root.wait_variable(self._decision)
        return self._decision.get()

    def close(self):
        self.root.destroy()


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

    hostname, token = get_pcloud_creds(args.remote)
    if not token:
        sys.exit(f"Could not read pCloud token from rclone config for remote '{args.remote}'.")

    window = ReviewWindow(args.hash_distance)

    for i, (a, b, diff_s) in enumerate(candidates, 1):
        name_a = PurePosixPath(a["Path"]).name
        name_b = PurePosixPath(b["Path"]).name
        print(f"[{i}/{len(candidates)}] Fetching thumbnails for {name_a} & {name_b} …", end="", flush=True)

        data_a = fetch_pcloud_thumb(hostname, token, a["ID"])
        data_b = fetch_pcloud_thumb(hostname, token, b["ID"])
        img_a  = load_image(data_a)
        img_b  = load_image(data_b)

        h_a  = phash(img_a) if img_a else None
        h_b  = phash(img_b) if img_b else None
        dist = (h_a - h_b) if (h_a is not None and h_b is not None) else None
        print(f" dist={dist}" if dist is not None else " (hash unavailable)")

        action = window.show(i, len(candidates), a, b, diff_s, dist, img_a, img_b)

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

    window.close()
    print(f"\nDone — {deleted} deleted, {kept} kept.")


if __name__ == "__main__":
    main()
