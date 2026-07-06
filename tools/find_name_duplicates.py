#!/usr/bin/env python3
"""
find_name_duplicates.py — Find and resolve Photos/ files that share a timestamp
base name but differ only in their suffix number (_1, _2, _3 …).

Example: 2024-03-15_12-30-00_1.jpg  +  2024-03-15_12-30-00_2.jpg

Identical groups (all files within perceptual-hash threshold of _1):
    Auto-merge EXIF from all into _1, delete _2 _3 …

Visually different groups (any file exceeds threshold):
    Interactive review: keep _1 + merge, keep biggest + merge, or keep all.

Progress is saved after every group so you can stop and resume at any time.

Usage:
    python3 tools/find_name_duplicates.py
    python3 tools/find_name_duplicates.py --threshold 10
    python3 tools/find_name_duplicates.py --auto-only   # only auto-process, defer the rest

Requirements:
    pip install Pillow imagehash piexif
"""

import argparse
import io
import json
import os
import queue
import re
import subprocess
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import PurePosixPath


# ── sentinel: EXIF read failed (distinct from None = confirmed no EXIF) ──────
GPS_UNKNOWN = object()


# ── filename pattern ──────────────────────────────────────────────────────────
DUPE_RE = re.compile(
    r'^(?P<base>\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_(?P<n>\d+)(?P<ext>\.[^.]+)$',
    re.IGNORECASE,
)
IMG_EXTS = {'.jpg', '.jpeg', '.heic', '.png'}
VID_EXTS = {'.mp4', '.mov', '.avi'}
EXTS     = IMG_EXTS | VID_EXTS

THUMB_W, THUMB_H = 300, 260
BG      = '#0f172a'
FG      = '#e2e8f0'
FG_DIM  = '#94a3b8'
BTN_DEL = '#dc2626'
BTN_OK  = '#16a34a'
BTN_NEU = '#334155'

STATE_FILE = 'dup_name_state.json'


# ── pCloud / rclone helpers ───────────────────────────────────────────────────

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


def fetch_pcloud_thumb(hostname, token, file_id, size='512x512'):
    fid = file_id.lstrip('f') if isinstance(file_id, str) else file_id
    url = (f'https://{hostname}/getthumb'
           f'?fileid={fid}&size={size}&crop=0&access_token={token}')
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = resp.read()
        if data[:1] == b'{':
            try:
                err = json.loads(data)
                print(f'    [thumb] {err.get("error", "unknown error")} (result={err.get("result")})',
                      file=sys.stderr)
            except Exception:
                pass
            return None
        return data
    except Exception as e:
        print(f'    [thumb] fetch failed: {e}', file=sys.stderr)
        return None


def fetch_raw_head(remote, path, rel_path, nbytes=65536):
    r = subprocess.run(
        ['rclone', 'cat', '--count', str(nbytes), f'{remote}:{path}/{rel_path}'],
        capture_output=True,
    )
    return r.stdout if r.returncode == 0 and r.stdout else None



def download_full_rclone(remote, path, rel_path):
    r = subprocess.run(['rclone', 'cat', f'{remote}:{path}/{rel_path}'], capture_output=True)
    return r.stdout if r.returncode == 0 and r.stdout else None


def delete_file(remote, path, rel_path):
    r = subprocess.run(
        ['rclone', 'deletefile', f'{remote}:{path}/{rel_path}'],
        capture_output=True,
    )
    return r.returncode == 0, r.stderr.decode().strip()


def rename_file(remote, path, old_rel, new_rel):
    r = subprocess.run(
        ['rclone', 'moveto',
         f'{remote}:{path}/{old_rel}',
         f'{remote}:{path}/{new_rel}'],
        capture_output=True,
    )
    return r.returncode == 0, r.stderr.decode().strip()


def load_image(data):
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


def fmt_size(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return f'{n:.0f} {unit}'
        n /= 1024
    return f'{n:.1f} TB'


# ── group discovery ───────────────────────────────────────────────────────────

def find_groups(files):
    """Return dict of group_tuple → [file, …] sorted by suffix number."""
    buckets = {}
    for f in files:
        name = PurePosixPath(f['Path']).name
        m = DUPE_RE.match(name)
        if not m:
            continue
        parent = f['Path'].rsplit('/', 1)[0] if '/' in f['Path'] else ''
        key = (parent, m.group('base'), m.group('ext').lower())
        buckets.setdefault(key, []).append(f)
    return {
        k: sorted(v, key=lambda x: int(DUPE_RE.match(PurePosixPath(x['Path']).name).group('n')))
        for k, v in buckets.items()
        if len(v) > 1
    }


def group_key(files):
    """Canonical, order-independent key for state tracking."""
    return tuple(sorted(f['Path'] for f in files))


# ── EXIF helpers ──────────────────────────────────────────────────────────────

def read_exif(raw):
    """Parse piexif dict from raw bytes. Returns GPS_UNKNOWN if read failed."""
    if raw is None:
        return GPS_UNKNOWN
    try:
        import piexif
        return piexif.load(raw)
    except Exception:
        return None  # not a JPEG or no EXIF


def has_gps(exif):
    if not exif or exif is GPS_UNKNOWN:
        return False
    try:
        import piexif
        return piexif.GPSIFD.GPSLatitude in exif.get('GPS', {})
    except Exception:
        return bool(exif.get('GPS'))


def has_datetime(exif):
    if not exif or exif is GPS_UNKNOWN:
        return False
    # DateTimeOriginal=36867, DateTimeDigitized=36868, DateTime=306
    for ifd in ('Exif', '0th'):
        if any(exif.get(ifd, {}).get(t) for t in (36867, 36868, 306)):
            return True
    return False


def merge_exif(primary, *others):
    """
    Merge piexif dicts: primary wins on all tag conflicts.
    Missing tags are filled from others in order.
    """
    result = {'0th': {}, 'Exif': {}, 'GPS': {}, '1st': {}}
    result['thumbnail'] = (primary or {}).get('thumbnail')
    # Fill from others first (lowest priority)
    for src in others:
        if not src or src is GPS_UNKNOWN:
            continue
        for ifd in ('0th', 'Exif', 'GPS', '1st'):
            for tag, val in src.get(ifd, {}).items():
                if tag not in result[ifd]:
                    result[ifd][tag] = val
    # Apply primary last so it always wins
    if primary and primary is not GPS_UNKNOWN:
        for ifd in ('0th', 'Exif', 'GPS', '1st'):
            result[ifd].update(primary.get(ifd, {}))
        result['thumbnail'] = primary.get('thumbnail')
    return result


def _upload_jpeg_inplace(hostname, token, file_id, name, jpeg_data):
    """Upload jpeg_data over an existing pCloud file (same fileid, no delete needed)."""
    fid      = file_id.lstrip('f') if isinstance(file_id, str) else file_id
    boundary = b'BoundaryNaMeDuP9Ma4Y'
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
        raise RuntimeError(f'pCloud upload error: {result.get("error", result)}')


def inject_exif_and_upload(remote, path, keeper, merged):
    """
    Download the keeper JPEG, inject the merged EXIF dict, and overwrite it
    in-place via rclone copyto (temp file → remote path).
    Returns True on success or if the file type is not supported.
    """
    import tempfile, os
    rel  = keeper['Path']
    name = PurePosixPath(rel).name
    if PurePosixPath(rel).suffix.lower() not in ('.jpg', '.jpeg'):
        print(f'  Skipping EXIF merge for non-JPEG {name}')
        return True

    try:
        import piexif
    except ImportError:
        print('  piexif not installed — EXIF merge skipped.')
        return True

    print(f'  Downloading {name} for EXIF merge …', end='', flush=True)
    file_data = download_full_rclone(remote, path, rel)
    if not file_data:
        print(' FAILED (download)')
        return False
    print(f' {len(file_data)//1024} KB', end='', flush=True)

    try:
        exif_bytes = piexif.dump(merged)
        buf = io.BytesIO()
        piexif.insert(exif_bytes, file_data, buf)
        modified = buf.getvalue()
    except Exception as e:
        print(f' EXIF inject failed ({e}) — keeping original')
        return True  # non-fatal; still proceed with deletion

    if modified == file_data:
        print(' (no EXIF change needed)')
        return True

    print(' uploading …', end='', flush=True)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            tmp.write(modified)
            tmp_path = tmp.name
        r = subprocess.run(
            ['rclone', 'copyto', tmp_path, f'{remote}:{path}/{rel}'],
            capture_output=True,
        )
        if r.returncode != 0:
            raise RuntimeError(r.stderr.decode().strip())
        print(' done.')
        return True
    except Exception as e:
        print(f' FAILED: {e}')
        return False
    finally:
        if tmp_path:
            os.unlink(tmp_path)



# ── state ─────────────────────────────────────────────────────────────────────

def load_state():
    if not os.path.exists(STATE_FILE):
        return set()
    with open(STATE_FILE) as f:
        data = json.load(f)
    return {tuple(k) for k in data.get('done', [])}


def save_state(done):
    with open(STATE_FILE, 'w') as f:
        json.dump({'done': [list(k) for k in done]}, f, indent=2)


# ── review window ─────────────────────────────────────────────────────────────

class ReviewWindow:
    """Persistent tkinter window reused across all review groups."""

    def __init__(self, threshold):
        import tkinter as tk
        self._tk = tk
        self.threshold = threshold

        root = tk.Tk()
        root.configure(bg=BG)
        root.resizable(True, False)
        root.title('Duplicate review')
        root.protocol('WM_DELETE_WINDOW', lambda: self._decide('quit'))
        root.bind('<Return>', lambda e: self._decide('keep_big'))
        root.bind('<Escape>', lambda e: self._decide('keep_all'))
        root.bind('0',        lambda e: self._decide('keep_none'))
        for _n in range(1, 10):
            root.bind(str(_n), lambda e, n=_n: self._decide(f'keep_{n - 1}'))
        self.root = root

        self._decision = tk.StringVar()
        self._counter  = tk.StringVar()
        self._dist_str = tk.StringVar()
        tk.Label(root, textvariable=self._counter, bg=BG, fg=FG_DIM,
                 font=('Helvetica', 10)).pack(pady=(10, 2))
        self._group_lbl = tk.Label(root, bg=BG, fg=FG_DIM, font=('Helvetica', 9))
        self._group_lbl.pack()
        self._dist_lbl = tk.Label(root, textvariable=self._dist_str, bg=BG,
                                  font=('Helvetica', 11, 'bold'))
        self._dist_lbl.pack(pady=(4, 0))

        scroll_outer = tk.Frame(root, bg=BG)
        scroll_outer.pack(padx=12, pady=8, fill='x')

        self._canvas = tk.Canvas(scroll_outer, bg=BG, highlightthickness=0,
                                 height=THUMB_H + 110)
        self._hbar = tk.Scrollbar(scroll_outer, orient='horizontal',
                                  command=self._canvas.xview)
        self._canvas.configure(xscrollcommand=self._hbar.set)
        self._hbar.pack(side='bottom', fill='x')
        self._canvas.pack(side='top', fill='both', expand=True)

        self._img_frame = tk.Frame(self._canvas, bg=BG)
        self._canvas.create_window((0, 0), window=self._img_frame, anchor='nw')
        self._img_frame.bind('<Configure>',
            lambda e: self._canvas.configure(scrollregion=self._canvas.bbox('all')))

        row1 = tk.Frame(root, bg=BG)
        row1.pack(pady=(8, 2))
        self._mkbtn(row1, 'Keep biggest + merge EXIF  ↵', '#d97706', 'keep_big',  0)
        self._mkbtn(row1, 'Keep all  ⎋',                  BTN_NEU,   'keep_all',  1)
        self._mkbtn(row1, 'Delete all  0',                 '#7f1d1d', 'keep_none', 2)
        self._mkbtn(row1, 'Skip',                          BTN_NEU,   'skip',      3)
        self._mkbtn(row1, 'Quit review',                   '#7f1d1d', 'quit',      4)

    def _mkbtn(self, parent, text, color, action, col):
        # Use Label instead of Button: macOS tkinter ignores bg/fg on native buttons,
        # rendering white text on the system gray. Labels respect custom colors.
        def _darken(c):
            r, g, b = (int(c.lstrip('#')[i:i+2], 16) for i in (0, 2, 4))
            return f'#{int(r*.8):02x}{int(g*.8):02x}{int(b*.8):02x}'
        lbl = self._tk.Label(
            parent, text=text, bg=color, fg='#fff',
            font=('Helvetica', 11, 'bold'), padx=14, pady=9, cursor='hand2',
        )
        lbl.grid(row=0, column=col, padx=5)
        lbl.bind('<Button-1>',    lambda e, a=action: self._decide(a))
        lbl.bind('<Enter>',       lambda e: lbl.configure(bg=_darken(color)))
        lbl.bind('<Leave>',       lambda e: lbl.configure(bg=color))

    def _decide(self, action):
        self._decision.set(action)

    def show(self, idx, total, files, thumbs, exifs, group_str, max_dist=None):
        from PIL import Image, ImageTk
        LANCZOS = getattr(Image, 'Resampling', Image).LANCZOS

        self._decision.set('')
        self._counter.set(f'Group {idx} of {total}')
        self._group_lbl.configure(text=group_str)

        if max_dist is None:
            self._dist_str.set('hash distance: N/A')
            self._dist_lbl.configure(fg='#64748b')
        else:
            same = max_dist <= self.threshold
            self._dist_str.set(f'hash distance: {max_dist}  —  {"looks identical" if same else "visually different"}')
            self._dist_lbl.configure(fg='#4ade80' if same else '#f97316')

        for w in self._img_frame.winfo_children():
            w.destroy()
        self._tk_imgs = []  # keep references alive

        for col_i, (f, img, exif) in enumerate(zip(files, thumbs, exifs)):
            col = self._tk.Frame(self._img_frame, bg='#16213e', bd=1, relief='solid')
            col.grid(row=0, column=col_i, padx=5)

            m = DUPE_RE.match(PurePosixPath(f['Path']).name)
            n = m.group('n') if m else '?'
            self._tk.Label(col, text=f'_{n}  •  {fmt_size(f["Size"])}',
                           bg='#16213e', fg='#93c5fd',
                           font=('Helvetica', 10, 'bold')).pack(pady=(6, 2))

            if img is not None:
                base = img.copy()
                base.thumbnail((THUMB_W, THUMB_H), LANCZOS)
                c = Image.new('RGB', (THUMB_W, THUMB_H), BG)
                c.paste(base, ((THUMB_W - base.width) // 2, (THUMB_H - base.height) // 2))
                tk_img = ImageTk.PhotoImage(c)
                self._tk_imgs.append(tk_img)
                thumb_lbl = self._tk.Label(col, image=tk_img, bg='#16213e', cursor='hand2')
                thumb_lbl.pack(padx=6)
                thumb_lbl.bind('<Button-1>', lambda e, idx=col_i: self._decide(f'keep_{idx}'))
            else:
                # Thumbnail unavailable (pCloud can't generate one for this file type/age)
                self._tk.Label(col, text='No preview\navailable',
                               bg='#1e293b', fg='#475569',
                               font=('Helvetica', 11), width=20, height=10,
                               anchor='center').pack(padx=6, pady=4)

            gps_txt = ('GPS ✓' if has_gps(exif)
                       else ('GPS ?' if exif is GPS_UNKNOWN else 'no GPS'))
            dt_txt  = 'Date ✓' if has_datetime(exif) else 'no date'
            self._tk.Label(col, text=f'{gps_txt}  {dt_txt}',
                           bg='#16213e', fg=FG_DIM,
                           font=('Helvetica', 9)).pack(pady=(3, 6))

        # Size the canvas to show ~4 columns by default; scrollbar reveals the rest.
        col_w    = THUMB_W + 22
        screen_w = self.root.winfo_screenwidth()
        canvas_w = min(len(files) * col_w, screen_w - 80)
        self._canvas.configure(width=canvas_w)
        self._canvas.xview_moveto(0)  # reset scroll position for each new group

        self.root.deiconify()
        self.root.lift()
        self.root.wait_variable(self._decision)

        for w in self._img_frame.winfo_children():
            w.destroy()
        self._counter.set('')
        self._group_lbl.configure(text='')
        self._dist_str.set('')
        self.root.update_idletasks()

        return self._decision.get()

    def close(self):
        self.root.destroy()


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--remote',    default='pcloud',
                    help='rclone remote name (default: pcloud)')
    ap.add_argument('--path',      default='Photos',
                    help='sub-path to scan (default: Photos)')
    ap.add_argument('--threshold', type=int, default=10,
                    help='Max perceptual-hash distance to consider files identical (default 10)')
    ap.add_argument('--auto-only', action='store_true',
                    help='Only auto-process identical groups; defer the rest for a later run')
    ap.add_argument('--workers', type=int, default=4,
                    help='Parallel scanner workers (default: 4)')
    ap.add_argument('--size-ratio', type=float, default=2.0,
                    help='Auto-keep biggest if it is this many times larger than the second-largest (default: 2.0)')
    args = ap.parse_args()

    try:
        import imagehash   # noqa: F401
        import piexif      # noqa: F401
        from PIL import Image  # noqa: F401
    except ImportError:
        sys.exit('Install dependencies first:  pip install Pillow imagehash piexif')

    hostname, token = get_pcloud_creds(args.remote)
    if not token:
        sys.exit(f"Could not read pCloud token from rclone config for remote '{args.remote}'.")

    files = list_files(args.remote, args.path)
    print(f'{len(files)} media files found.')

    img_files = [f for f in files if PurePosixPath(f['Path']).suffix.lower() in IMG_EXTS]
    vid_files = [f for f in files if PurePosixPath(f['Path']).suffix.lower() in VID_EXTS]

    vid_groups = find_groups(vid_files)
    if vid_groups:
        print(f'Skipping {len(vid_groups)} video duplicate group(s) — handle separately.')

    groups = find_groups(img_files)
    if not groups:
        print('No image duplicate groups found. 🎉')
        return

    total       = len(groups)
    groups_list = list(groups.items())  # [(key_tuple, [file, …]), …]
    print(f'Found {total} image duplicate group(s).\n')

    done = load_state()
    if done:
        print(f'Resuming — {len(done)} group(s) already processed.\n')

    result_q = queue.Queue()  # unbounded — workers never stall waiting for the main loop
    cancel   = threading.Event()

    # ── scanner ───────────────────────────────────────────────────────────────
    def scan_group(i, key_tuple, gfiles):
        """Scan one group and put a result item on result_q. Runs in a worker thread."""
        if cancel.is_set():
            return

        gkey = group_key(gfiles)
        with state_lock:
            already = gkey in done
        if already:
            return

        ref_name = PurePosixPath(gfiles[0]['Path']).name

        # ── thumbnails ────────────────────────────────────────────────────────
        thumbs = []
        for f in gfiles:
            if cancel.is_set():
                return
            raw_thumb = fetch_pcloud_thumb(hostname, token, f['ID'])
            thumbs.append(load_image(raw_thumb))

        if cancel.is_set():
            return

        # ── perceptual hash comparison ────────────────────────────────────────
        ref_h    = phash(thumbs[0]) if thumbs[0] else None
        max_dist = 0
        hash_ok  = ref_h is not None
        any_diff = False

        for t in thumbs[1:]:
            h = phash(t) if t else None
            if ref_h is None or h is None:
                continue
            d = ref_h - h
            max_dist = max(max_dist, d)
            if d > args.threshold:
                any_diff = True

        all_thumbs_ok = all(t is not None for t in thumbs)
        if not all_thumbs_ok and not hash_ok:
            sizes    = [f['Size'] for f in gfiles]
            all_same = len(set(sizes)) == 1
            dist_str = f'N/A (size-{"match" if all_same else "mismatch"})'
        elif not all_thumbs_ok:
            all_same = hash_ok and not any_diff
            dist_str = f'{max_dist}(partial)'
        else:
            all_same = hash_ok and not any_diff
            dist_str = str(max_dist)

        tprint(f'[scan {i}/{total}] {ref_name} + {len(gfiles)-1} more  '
               f'max_dist={dist_str}  → {"identical" if all_same else "DIFFERENT"}')

        # ── EXIF ──────────────────────────────────────────────────────────────
        exifs = []
        for f in gfiles:
            raw = fetch_raw_head(args.remote, args.path, f['Path'])
            exifs.append(read_exif(raw))

        # Size-ratio check: if one file is much larger, it's the original — auto-keep it.
        sizes_sorted = sorted(range(len(gfiles)), key=lambda j: gfiles[j]['Size'], reverse=True)
        biggest_size = gfiles[sizes_sorted[0]]['Size']
        second_size  = gfiles[sizes_sorted[1]]['Size']
        size_dominant = (second_size > 0 and biggest_size / second_size >= args.size_ratio)

        if all_same:
            ref_name2 = PurePosixPath(gfiles[0]['Path']).name
            auto_keep(gkey, gfiles, exifs, 0,
                      f'[{i}/{total}] Auto: keeping {ref_name2}, merging EXIF from {len(gfiles)-1} duplicate(s)')
        elif size_dominant:
            ratio = biggest_size / second_size
            keeper_name = PurePosixPath(gfiles[sizes_sorted[0]]['Path']).name
            auto_keep(gkey, gfiles, exifs, sizes_sorted[0],
                      f'[{i}/{total}] Auto-biggest: {keeper_name} ({fmt_size(biggest_size)}) '
                      f'is {ratio:.1f}× larger — keeping, deleting {len(gfiles)-1} smaller')
        elif args.auto_only:
            result_q.put(('defer', i, gkey))
        else:
            result_q.put(('review', i, gkey, key_tuple, gfiles, thumbs, exifs, max_dist))

    def scanner():
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [
                pool.submit(scan_group, i, key_tuple, gfiles)
                for i, (key_tuple, gfiles) in enumerate(groups_list, 1)
            ]
            for f in as_completed(futures):
                try:
                    f.result()
                except Exception as e:
                    tprint(f'Scanner error: {e}')
        result_q.put(None)  # sentinel — all workers done

    # ── shared state (accessed by both scanner workers and main loop) ─────────
    deleted   = 0
    processed = 0
    state_lock = threading.Lock()
    print_lock = threading.Lock()

    def tprint(*a, **kw):
        with print_lock:
            print(*a, **kw)

    def do_keep(keeper, others, all_exifs, keeper_idx):
        """Keep one file, merge EXIF into it, delete the rest. Thread-safe."""
        nonlocal deleted, processed
        keeper_exif  = all_exifs[keeper_idx]
        other_exifs  = [all_exifs[j] for j in range(len(all_exifs)) if j != keeper_idx]
        valid_others = [e for e in other_exifs if e and e is not GPS_UNKNOWN]
        # Skip EXIF merge if keeper's EXIF couldn't be read — would overwrite unknown-but-present data.
        if keeper_exif is not GPS_UNKNOWN and valid_others:
            merged = merge_exif(keeper_exif or {}, *valid_others)
            inject_exif_and_upload(args.remote, args.path, keeper, merged)

        for f in others:
            ok, err = delete_file(args.remote, args.path, f['Path'])
            tprint(f'  Deleting {f["Path"]} … {"done." if ok else f"FAILED: {err}"}')
            with state_lock:
                if ok:
                    deleted += 1

        # Rename keeper to _1 if it isn't already.
        keeper_name = PurePosixPath(keeper['Path']).name
        m = DUPE_RE.match(keeper_name)
        if m and m.group('n') != '1':
            new_name = f'{m.group("base")}_1{m.group("ext")}'
            new_rel  = str(PurePosixPath(keeper['Path']).parent / new_name)
            ok, err  = rename_file(args.remote, args.path, keeper['Path'], new_rel)
            tprint(f'  Renamed {keeper_name} → {new_name}' if ok else f'  Rename FAILED: {err}')

        with state_lock:
            processed += 1

    def auto_keep(gkey, gfiles, exifs, keeper_idx, label):
        keeper = gfiles[keeper_idx]
        others = [gfiles[j] for j in range(len(gfiles)) if j != keeper_idx]
        tprint(label)
        do_keep(keeper, others, exifs, keeper_idx)
        with state_lock:
            done.add(gkey)
            save_state(done)

    threading.Thread(target=scanner, daemon=True).start()

    # ── main loop — only review items reach here ──────────────────────────────
    window = None
    deferred = 0

    try:
        while True:
            item = result_q.get()
            if item is None:
                break

            kind = item[0]

            if kind == 'defer':
                _, i, gkey = item
                tprint(f'[{i}/{total}] Deferred (needs review).')
                deferred += 1
                continue

            # kind == 'review'
            _, i, gkey, key_tuple, gfiles, thumbs, exifs, max_dist = item
            parent, base, ext = key_tuple
            group_str = f'{base}{ext}  (in {parent or "."})'
            print(f'[{i}/{total}] Review: {group_str}  max_dist={max_dist}')

            if window is None:
                window = ReviewWindow(args.threshold)

            action = window.show(i, total, gfiles, thumbs, exifs, group_str, max_dist)

            if action == 'quit':
                print('Review stopped by user.')
                cancel.set()
                break

            if action == 'skip':
                print('  Skipped.')
                continue

            with state_lock:
                done.add(gkey)
                save_state(done)

            if action == 'keep_all':
                print('  Keeping all files.')
                continue

            if action == 'keep_none':
                print(f'  Deleting all {len(gfiles)} files.')
                for f in gfiles:
                    ok, err = delete_file(args.remote, args.path, f['Path'])
                    print(f'  Deleting {f["Path"]} … {"done." if ok else f"FAILED: {err}"}')
                    with state_lock:
                        if ok:
                            deleted += 1
                with state_lock:
                    processed += 1
                continue

            if action == 'keep_big':
                by_size    = sorted(range(len(gfiles)), key=lambda j: gfiles[j]['Size'], reverse=True)
                keeper_idx = by_size[0]
            elif action.startswith('keep_'):
                keeper_idx = int(action[5:])
            else:
                continue

            keeper = gfiles[keeper_idx]
            others = [gfiles[j] for j in range(len(gfiles)) if j != keeper_idx]

            print(f'  Keeping {PurePosixPath(keeper["Path"]).name}')
            do_keep(keeper, others, exifs, keeper_idx)

    except KeyboardInterrupt:
        print('\nInterrupted — progress saved.')
        cancel.set()

    finally:
        if window:
            try:
                window.close()
            except Exception:
                pass

    # Clean up state file if everything is done
    remaining = total - len(done)
    if remaining <= 0 and os.path.exists(STATE_FILE):
        os.remove(STATE_FILE)
        print('All groups processed — state file removed.')

    print(f'\nDone — {processed} group(s) resolved, {deleted} file(s) deleted, {deferred} deferred.')
    if deferred:
        print(f'Re-run without --auto-only to review {deferred} group(s) interactively.')


if __name__ == '__main__':
    main()
