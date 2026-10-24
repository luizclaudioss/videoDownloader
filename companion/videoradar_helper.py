#!/usr/bin/env python3
"""Video Radar Helper — servidor local (127.0.0.1) que baixa vídeos com yt-dlp na qualidade escolhida.

A extensão envia {url, height, title, referer} e o arquivo final (.mp4 com áudio) é salvo em
~/Downloads/VideoRadar. Escuta apenas em localhost.
"""
import json
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 47654
OUT_DIR = os.path.expanduser("~/Downloads/VideoRadar")
EXTRA_PATHS = [os.path.expanduser("~/.local/bin"), "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
os.environ["PATH"] = os.pathsep.join(EXTRA_PATHS + [os.environ.get("PATH", "")])

jobs = {}  # id -> {"status": "running|done|error", "message": str}
jobs_lock = threading.Lock()
counter = [0]


def build_format(height):
    try:
        h = int(height)
    except (TypeError, ValueError):
        h = 0
    if h <= 0:
        return "bv*+ba/b"
    return f"bv*[height<={h}]+ba/b[height<={h}]/b"


def run_job(job_id, url, height, title, referer):
    os.makedirs(OUT_DIR, exist_ok=True)
    cmd = [
        "yt-dlp",
        "-f", build_format(height),
        "--merge-output-format", "mp4",
        "--no-playlist",
        "-N", "8",
        "-P", OUT_DIR,
        "-o", "%(title)s.%(ext)s",
    ]
    if referer and referer.startswith("http") and "youtube.com" not in url:
        cmd += ["--referer", referer]
    cmd.append(url)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        with jobs_lock:
            if proc.returncode == 0:
                jobs[job_id] = {"status": "done", "message": "Concluído"}
            else:
                tail = (proc.stderr or proc.stdout or "erro").strip().splitlines()[-1][:300]
                jobs[job_id] = {"status": "error", "message": tail}
    except FileNotFoundError:
        with jobs_lock:
            jobs[job_id] = {"status": "error", "message": "yt-dlp não encontrado"}
    if shutil.which("osascript"):
        msg = "Download concluído em Downloads/VideoRadar" if jobs[job_id]["status"] == "done" else "Falha no download"
        subprocess.run(
            ["osascript", "-e", f'display notification "{msg}" with title "Video Radar"'],
            capture_output=True,
        )


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path.startswith("/ping"):
            self._send(200, {"ok": True, "ytdlp": shutil.which("yt-dlp") is not None, "dir": OUT_DIR})
        elif self.path.startswith("/status/"):
            job_id = self.path.rsplit("/", 1)[-1]
            with jobs_lock:
                self._send(200, jobs.get(job_id, {"status": "unknown"}))
        else:
            self._send(404, {"ok": False})

    def do_POST(self):
        if self.path != "/download":
            self._send(404, {"ok": False})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._send(400, {"ok": False, "error": "JSON inválido"})
            return
        url = data.get("url", "")
        if not url.startswith("http"):
            self._send(400, {"ok": False, "error": "URL inválida"})
            return
        with jobs_lock:
            counter[0] += 1
            job_id = str(counter[0])
            jobs[job_id] = {"status": "running", "message": "Baixando..."}
        threading.Thread(
            target=run_job,
            args=(job_id, url, data.get("height"), data.get("title", ""), data.get("referer", "")),
            daemon=True,
        ).start()
        self._send(200, {"ok": True, "id": job_id})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
