#!/usr/bin/env python3
"""
KlipDed Helper - lets the KlipDed website download YouTube (and other) links on this PC.

The website cannot download from YouTube by itself, so this small local server does it
with yt-dlp and hands the file to the website (only to the origins listed below).

Setup (Windows):
  1) Install Python 3.10+ from https://www.python.org/downloads/ (tick "Add python.exe to PATH")
  2) pip install -U "yt-dlp[default]"
  3) winget install DenoLand.Deno      (JavaScript runtime that yt-dlp needs for YouTube)
  4) winget install Gyan.FFmpeg        (merges video + audio)
  5) Double-click start-helper.bat and keep the window open while using the website.

Options:
  --port 7788                 port to listen on (the website expects 7788)
  --dir PATH                  where videos are saved (default: ~/Videos/KlipDed)
  --origin URL                extra website origin allowed to use the helper (repeatable)
  --max-height 1080           highest video resolution to download
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

VERSION = "1.0.0"
DEFAULT_ORIGINS = {
    "https://n0bss.github.io",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
}

ARGS = None
JOBS = {}
JOBS_LOCK = threading.Lock()


def ytdlp_base():
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        exe = shutil.which("yt-dlp")
        return [exe] if exe else None


def js_runtime_args():
    args = []
    # deno is enabled by default in yt-dlp; also enable node if it is installed
    if shutil.which("node"):
        args += ["--js-runtimes", "node"]
    args += ["--remote-components", "ejs:github"]
    return args


def child_env():
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def ytdlp_version():
    base = ytdlp_base()
    if not base:
        return None
    try:
        out = subprocess.run(base + ["--version"], capture_output=True, text=True, timeout=30, env=child_env())
        return out.stdout.strip() or None
    except Exception:
        return None


def valid_url(u):
    try:
        p = urlparse(u)
        return p.scheme in ("http", "https") and bool(p.netloc)
    except Exception:
        return False


class Job:
    def __init__(self, url, max_height):
        self.id = uuid.uuid4().hex[:16]
        self.url = url
        self.max_height = max_height
        self.status = "queued"  # queued | downloading | merging | done | error
        self.progress = 0.0
        self.title = ""
        self.duration = None
        self.path = None
        self.size = 0
        self.error = ""
        self.log = []
        self.parts = 1
        self.part = 0
        self.last_fmt = None
        self.created = time.time()

    def public(self):
        return {
            "id": self.id, "url": self.url, "status": self.status, "progress": round(self.progress, 4),
            "title": self.title, "duration": self.duration, "size": self.size,
            "filename": os.path.basename(self.path) if self.path else None, "error": self.error,
        }


def run_job(job):
    base = ytdlp_base()
    if not base:
        job.status, job.error = "error", "yt-dlp is not installed (pip install -U \"yt-dlp[default]\")"
        return
    h = job.max_height
    fmt = (f"bv*[height<={h}][vcodec^=avc1]+ba[acodec^=mp4a]/"
           f"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b")
    outtmpl = os.path.join(ARGS.dir, "%(title).70B [%(id)s].%(ext)s")
    cmd = base + js_runtime_args() + [
        "--encoding", "utf-8", "--no-playlist", "--newline", "--no-colors", "--progress", "--no-simulate",
        "--windows-filenames", "-f", fmt, "--merge-output-format", "mp4", "-o", outtmpl,
        "--progress-template", "download:KDP %(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(info.format_id)s",
        "--print", "before_dl:KDINFO %(format_id)s|%(duration)s|%(id)s|%(title)s",
        "--print", "after_move:KDFILE %(filepath)s",
        job.url,
    ]
    job.status = "downloading"
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                encoding="utf-8", errors="replace", bufsize=1, env=child_env())
    except Exception as e:
        job.status, job.error = "error", f"cannot start yt-dlp: {e}"
        return
    for raw in proc.stdout:
        line = raw.strip()
        if not line:
            continue
        job.log = (job.log + [line])[-30:]
        if line.startswith("KDINFO "):
            fmt_ids, dur, vid, title = (line[7:].split("|", 3) + ["", "", ""])[:4]
            job.parts = max(1, fmt_ids.count("+") + 1)
            job.title = title
            job.video_id = vid
            try:
                job.duration = float(dur)
            except ValueError:
                job.duration = None
        elif line.startswith("KDP "):
            done_b, total, est, fid = (line[4:].split("|") + ["", "", "", ""])[:4]
            if job.last_fmt is not None and fid != job.last_fmt:
                job.part = min(job.parts - 1, job.part + 1)
            job.last_fmt = fid
            try:
                d = float(done_b)
                t = float(total) if total not in ("NA", "None", "") else float(est) if est not in ("NA", "None", "") else 0
                frac = max(0.0, min(1.0, d / t)) if t else 0.0
            except ValueError:
                frac = 0.0
            # video stream is most of the bytes: weight it 85%
            if job.parts == 2:
                job.progress = 0.85 * frac if job.part == 0 else 0.85 + 0.13 * frac
            else:
                job.progress = 0.98 * frac
        elif line.startswith("[Merger]") or line.startswith("[VideoConvertor]"):
            job.status = "merging"
            job.progress = max(job.progress, 0.98)
        elif line.startswith("KDFILE "):
            job.path = line[7:].strip()
    code = proc.wait()
    if code == 0 and not (job.path and os.path.exists(job.path)):
        # fall back to finding the file by its video id, e.g. "Title [abc123].mp4"
        vid = getattr(job, "video_id", "")
        if vid:
            cands = [os.path.join(ARGS.dir, f) for f in os.listdir(ARGS.dir) if f"[{vid}]" in f and not f.endswith((".part", ".ytdl"))]
            if cands:
                job.path = max(cands, key=os.path.getmtime)
    if code == 0 and job.path and os.path.exists(job.path):
        job.size = os.path.getsize(job.path)
        job.status, job.progress = "done", 1.0
    else:
        tail = [l for l in job.log if "ERROR" in l or "error" in l.lower()][-3:] or job.log[-3:]
        job.status = "error"
        job.error = " / ".join(tail)[:600] or f"yt-dlp exited with code {code}"


def get_info(url):
    base = ytdlp_base()
    if not base:
        raise RuntimeError("yt-dlp is not installed")
    out = subprocess.run(base + js_runtime_args() + ["--encoding", "utf-8", "-J", "--no-playlist", "--skip-download", url],
                         capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, env=child_env())
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip().splitlines()[-1][:400] if (out.stderr or out.stdout) else "yt-dlp failed")
    info = json.loads(out.stdout)
    return {
        "id": info.get("id"), "title": info.get("title"), "duration": info.get("duration"),
        "uploader": info.get("uploader") or info.get("channel"), "thumbnail": info.get("thumbnail"),
        "webpage_url": info.get("webpage_url") or url, "is_live": info.get("is_live"),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "KlipDedHelper/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if ARGS.verbose:
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---- CORS -------------------------------------------------------------
    def origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or ARGS.any_origin or origin.lower() in ALLOWED

    def cors(self):
        origin = self.headers.get("Origin")
        if origin and (ARGS.any_origin or origin.lower() in ALLOWED):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges")

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- routes -----------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self.send_json(200, {
                "ok": True, "name": "klipded-helper", "version": VERSION, "ytdlp": ytdlp_version(),
                "ffmpeg": bool(shutil.which("ffmpeg")), "deno": bool(shutil.which("deno")),
                "node": bool(shutil.which("node")), "dir": ARGS.dir,
            })
        if not self.origin_ok():
            return self.send_json(403, {"error": "origin_not_allowed"})
        if u.path == "/info":
            url = (parse_qs(u.query).get("url") or [""])[0]
            if not valid_url(url):
                return self.send_json(400, {"error": "bad_url"})
            try:
                return self.send_json(200, get_info(url))
            except Exception as e:
                return self.send_json(502, {"error": "info_failed", "detail": str(e)[:400]})
        m = re.match(r"^/jobs/([0-9a-f]{16})$", u.path)
        if m:
            job = JOBS.get(m.group(1))
            return self.send_json(200, job.public()) if job else self.send_json(404, {"error": "no_job"})
        m = re.match(r"^/files/([0-9a-f]{16})$", u.path)
        if m:
            job = JOBS.get(m.group(1))
            if not job or job.status != "done":
                return self.send_json(404, {"error": "not_ready"})
            return self.send_file(job.path)
        return self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        u = urlparse(self.path)
        if self.headers.get("Origin") is None or not self.origin_ok():
            return self.send_json(403, {"error": "origin_not_allowed"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.send_json(400, {"error": "bad_json"})
        if u.path == "/download":
            url = str(body.get("url") or "").strip()
            if not valid_url(url):
                return self.send_json(400, {"error": "bad_url"})
            try:
                mh = int(body.get("maxHeight") or ARGS.max_height)
            except ValueError:
                mh = ARGS.max_height
            mh = max(360, min(2160, mh))
            with JOBS_LOCK:
                for j in JOBS.values():  # reuse a finished or running job for the same link
                    if j.url == url and j.max_height == mh and j.status != "error":
                        return self.send_json(200, j.public())
                job = Job(url, mh)
                JOBS[job.id] = job
            threading.Thread(target=run_job, args=(job,), daemon=True).start()
            return self.send_json(200, job.public())
        return self.send_json(404, {"error": "not_found"})

    def send_file(self, path):
        try:
            size = os.path.getsize(path)
        except OSError:
            return self.send_json(404, {"error": "file_missing"})
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        status = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(size - 1, int(m.group(2)))
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
                if start > end or start >= size:
                    self.send_response(416)
                    self.cors()
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
        length = end - start + 1
        self.send_response(status)
        self.cors()
        ctype = "video/mp4" if path.lower().endswith(".mp4") else "video/webm" if path.lower().endswith(".webm") else "application/octet-stream"
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(1024 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def main():
    global ARGS, ALLOWED
    ap = argparse.ArgumentParser(description="KlipDed Helper")
    ap.add_argument("--port", type=int, default=7788)
    ap.add_argument("--dir", default=os.path.join(os.path.expanduser("~"), "Videos", "KlipDed"))
    ap.add_argument("--origin", action="append", default=[])
    ap.add_argument("--any-origin", action="store_true", help="allow every website (not recommended)")
    ap.add_argument("--max-height", type=int, default=1080)
    ap.add_argument("--verbose", action="store_true")
    ARGS = ap.parse_args()
    ALLOWED = {o.lower().rstrip("/") for o in DEFAULT_ORIGINS | set(ARGS.origin)}
    os.makedirs(ARGS.dir, exist_ok=True)

    print("=" * 60)
    print(f" KlipDed Helper {VERSION}  ->  http://127.0.0.1:{ARGS.port}")
    print(f" Save folder : {ARGS.dir}")
    v = ytdlp_version()
    print(f" yt-dlp      : {v or 'NOT FOUND  (pip install -U \"yt-dlp[default]\")'}")
    print(f" ffmpeg      : {'ok' if shutil.which('ffmpeg') else 'NOT FOUND (winget install Gyan.FFmpeg)'}")
    js = [n for n in ("deno", "node") if shutil.which(n)]
    print(f" JS runtime  : {', '.join(js) if js else 'NOT FOUND (winget install DenoLand.Deno)'}")
    print(f" Allowed     : {', '.join(sorted(ALLOWED))}")
    print(" Keep this window open while you use the website. Ctrl+C to stop.")
    print("=" * 60)
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
