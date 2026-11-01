#!/usr/bin/env python3
"""Video Radar Helper — servidor local (127.0.0.1) que baixa vídeos com yt-dlp na qualidade escolhida.

A extensão envia {url, height, title, referer} e o arquivo final (.mp4 compatível com QuickTime / macOS)
é salvo em ~/Downloads/VideoRadar com a resolução no nome (ex: "Titulo [720p].mp4", "Titulo [2160p].mp4").
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
active_keys = {}  # (url, height_str) -> job_id
jobs_lock = threading.Lock()
counter = [0]


def cleanup_stale_temp_files():
    """Remove eventuais resíduos de arquivos temporários de execuções anteriores."""
    if not os.path.isdir(OUT_DIR):
        return
    try:
        for fname in os.listdir(OUT_DIR):
            if fname.endswith(".qt_temp.mp4") or (fname.startswith(".") and (".qt." in fname or ".src." in fname)):
                try:
                    os.remove(os.path.join(OUT_DIR, fname))
                except OSError:
                    pass
    except Exception:
        pass


def build_format(height):
    try:
        h = int(height)
    except (TypeError, ValueError):
        h = 0
    if h <= 0:
        return "bv*+ba/b"
    return f"bv*[height<={h}]+ba/b[height<={h}]/b"


def make_quicktime_compatible(filepath, job_id=None):
    """Garante que o arquivo MP4 final abra perfeitamente no QuickTime Player do macOS.

    QuickTime exige vídeo H.264 (ou HEVC) e áudio AAC.
    No YouTube, resoluções até 1080p já vêm nativamente em H.264 + AAC.
    Em 1440p e 2160p (4K), o YouTube fornece apenas VP9 ou AV1. Nestes casos,
    converte rapidamente em hardware (Apple Silicon via h264_videotoolbox).
    Usa arquivos temporários ocultos (iniciados com ponto '.') para que NENHUM
    arquivo '.temp' apareça visível no Finder durante o processo.
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

        if job_id:
            with jobs_lock:
                if job_id in jobs:
                    jobs[job_id]["message"] = "Otimizando para QuickTime..."

        dir_name = os.path.dirname(filepath)
        base_name = os.path.basename(filepath)
        tag = str(job_id or os.getpid())
        # Arquivos ocultos (iniciados por ponto) para não poluir o Finder
        tmp_in = os.path.join(dir_name, f".{base_name}.{tag}.src.mp4")
        tmp_out = os.path.join(dir_name, f".{base_name}.{tag}.qt.mp4")

        # Move o arquivo baixado para o nome temporário oculto
        # Assim o Finder não exibe o arquivo até que ele esteja 100% pronto e compatível
        os.replace(filepath, tmp_in)

        ff_cmd = ["ffmpeg", "-y", "-i", tmp_in]
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
            ff_cmd_fallback = ["ffmpeg", "-y", "-i", tmp_in]
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
                # Se falhar a conversão, restaura o arquivo original
                if os.path.exists(tmp_in):
                    os.replace(tmp_in, filepath)
                if os.path.exists(tmp_out):
                    try:
                        os.remove(tmp_out)
                    except OSError:
                        pass
                return filepath

        if os.path.exists(tmp_out) and os.path.getsize(tmp_out) > 1000:
            # Sucesso: substitui atomicamente para o arquivo final visível no Finder
            os.replace(tmp_out, filepath)
            if os.path.exists(tmp_in):
                try:
                    os.remove(tmp_in)
                except OSError:
                    pass
            return filepath
        else:
            if os.path.exists(tmp_in):
                os.replace(tmp_in, filepath)
    except Exception:
        pass
    return filepath


def run_job(job_id, url, height, title, referer):
    dedup_key = (url, str(height or 0))
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
                final_filepath = make_quicktime_compatible(final_filepath, job_id=job_id)

            with jobs_lock:
                jobs[job_id] = {"status": "done", "message": "Concluído", "file": final_filepath}
        else:
            tail = (proc.stderr or proc.stdout or "erro").strip().splitlines()[-1][:300]
            with jobs_lock:
                jobs[job_id] = {"status": "error", "message": tail}
    except FileNotFoundError:
        with jobs_lock:
            jobs[job_id] = {"status": "error", "message": "yt-dlp não encontrado"}
    finally:
        with jobs_lock:
            if active_keys.get(dedup_key) == job_id:
                active_keys.pop(dedup_key, None)

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

        height = data.get("height")
        dedup_key = (url, str(height or 0))

        with jobs_lock:
            existing_id = active_keys.get(dedup_key)
            if existing_id and jobs.get(existing_id, {}).get("status") == "running":
                # Já existe download em andamento para este mesmo vídeo nesta resolução
                self._send(200, {"ok": True, "id": existing_id, "already_running": True})
                return

            counter[0] += 1
            job_id = str(counter[0])
            jobs[job_id] = {"status": "running", "message": "Baixando..."}
            active_keys[dedup_key] = job_id

        threading.Thread(
            target=run_job,
            args=(job_id, url, height, data.get("title", ""), data.get("referer", "")),
            daemon=True,
        ).start()
        self._send(200, {"ok": True, "id": job_id})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    cleanup_stale_temp_files()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
