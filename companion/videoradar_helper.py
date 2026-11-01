#!/usr/bin/env python3
"""Video Radar Helper — servidor local (127.0.0.1) que baixa vídeos com yt-dlp na qualidade escolhida.

A extensão envia {url, height, title, referer} e o arquivo final (.mp4 compatível com QuickTime / macOS)
é salvo em ~/Downloads/VideoRadar com a resolução no nome (ex: "Titulo [720p].mp4", "Titulo [1080p].mp4").
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


def make_quicktime_compatible(filepath):
    """Garante que o arquivo MP4 final abra perfeitamente no QuickTime Player do macOS.

    QuickTime exige vídeo H.264 (ou HEVC) e áudio AAC. Se o vídeo vier em VP9/AV1 ou áudio em Opus,
    converte rapidamente usando aceleração de hardware Apple Silicon (h264_videotoolbox).
    """
    if not filepath or not os.path.exists(filepath):
        return filepath
    try:
        cmd = ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", filepath]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            return filepath
        data = json.loads(res.stdout)
        vcodec, acodec = None, None
        for s in data.get("streams", []):
            if s.get("codec_type") == "video" and not vcodec:
                vcodec = s.get("codec_name")
            elif s.get("codec_type") == "audio" and not acodec:
                acodec = s.get("codec_name")

        needs_v = vcodec not in ("h264",)
        needs_a = acodec not in ("aac",)

        if not needs_v and not needs_a:
            # Já é nativamente H.264 + AAC, nenhuma conversão necessária!
            return filepath

        tmp_out = filepath + ".qt_temp.mp4"
        ff_cmd = ["ffmpeg", "-y", "-i", filepath]
        if needs_v:
            ff_cmd += ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-b:v", "10M"]
        else:
            ff_cmd += ["-c:v", "copy"]

        if needs_a:
            ff_cmd += ["-c:a", "aac", "-b:a", "192k"]
        else:
            ff_cmd += ["-c:a", "copy"]

        ff_cmd += ["-movflags", "+faststart", tmp_out]

        conv = subprocess.run(ff_cmd, capture_output=True, text=True)
        if conv.returncode != 0:
            # Fallback seguro para libx264 se o VideoToolbox rejeitar o formato
            ff_cmd_fallback = ["ffmpeg", "-y", "-i", filepath]
            if needs_v:
                ff_cmd_fallback += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
            else:
                ff_cmd_fallback += ["-c:v", "copy"]
            if needs_a:
                ff_cmd_fallback += ["-c:a", "aac", "-b:a", "192k"]
            else:
                ff_cmd_fallback += ["-c:a", "copy"]
            ff_cmd_fallback += ["-movflags", "+faststart", tmp_out]
            conv2 = subprocess.run(ff_cmd_fallback, capture_output=True, text=True)
            if conv2.returncode != 0:
                if os.path.exists(tmp_out):
                    try:
                        os.remove(tmp_out)
                    except OSError:
                        pass
                return filepath

        if os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 1000:
            os.replace(tmp_out, filepath)
            return filepath
    except Exception:
        pass
    return filepath


def run_job(job_id, url, height, title, referer):
    os.makedirs(OUT_DIR, exist_ok=True)
    cmd = [
        "yt-dlp",
        "-f", build_format(height),
        # Prioriza streams nativos H.264 e AAC para download direto sem re-encode
        "-S", "res,vcodec:avc,acodec:m4a",
        "--merge-output-format", "mp4",
        "--force-overwrites",
        "--no-playlist",
        "-N", "8",
        "-P", OUT_DIR,
        # Adiciona a resolução ao nome do arquivo para permitir resoluções diferentes do mesmo vídeo
        "-o", "%(title)s%(height& [{}p]|)s.%(ext)s",
        "--print", "after_move:filepath",
    ]
    if referer and referer.startswith("http") and "youtube.com" not in url:
        cmd += ["--referer", referer]
    cmd.append(url)

    final_filepath = None
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode == 0:
            # Localiza o arquivo baixado
            lines = [l.strip() for l in proc.stdout.splitlines() if l.strip()]
            for l in reversed(lines):
                if os.path.exists(l):
                    final_filepath = l
                    break

            # Garante compatibilidade total com QuickTime Player (H.264 + AAC)
            if final_filepath:
                final_filepath = make_quicktime_compatible(final_filepath)

            with jobs_lock:
                jobs[job_id] = {"status": "done", "message": "Concluído", "file": final_filepath}
        else:
            tail = (proc.stderr or proc.stdout or "erro").strip().splitlines()[-1][:300]
            with jobs_lock:
                jobs[job_id] = {"status": "error", "message": tail}
    except FileNotFoundError:
        with jobs_lock:
            jobs[job_id] = {"status": "error", "message": "yt-dlp não encontrado"}

    if shutil.which("osascript"):
        status = jobs[job_id]["status"]
        if status == "done":
            display_name = os.path.basename(final_filepath) if final_filepath else "Vídeo"
            escaped_name = display_name.replace('"', '\\"')
            msg = f"Salvo em Downloads/VideoRadar:\\n{escaped_name}"
            subprocess.run(
                ["osascript", "-e", f'display notification "{msg}" with title "Video Radar" subtitle "Download Concluído"'],
                capture_output=True,
            )
        else:
            err_msg = jobs[job_id].get("message", "Falha no download").replace('"', '\\"')
            subprocess.run(
                ["osascript", "-e", f'display notification "{err_msg}" with title "Video Radar" subtitle "Erro no Download"'],
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
