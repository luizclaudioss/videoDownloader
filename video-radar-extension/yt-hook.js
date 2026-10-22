// yt-hook.js — roda no MAIN world do youtube.com
// Extrai os streams de mídia reais (hlsManifestUrl com 1080p/720p ou formatos progressivos MP4)
// diretamente do player interno do YouTube, sem restrições de sandbox.

(function () {
  if (window.__videoRadarYtHook) return;
  window.__videoRadarYtHook = true;

  function extractYouTubeMedia() {
    try {
      const player = document.getElementById('movie_player');
      const pr =
        player && typeof player.getPlayerResponse === 'function'
          ? player.getPlayerResponse()
          : window.ytInitialPlayerResponse;

      if (!pr || !pr.videoDetails) return null;

      const vd = pr.videoDetails;
      const sd = pr.streamingData || {};

      const videoId =
        vd.videoId ||
        new URLSearchParams(window.location.search).get('v') ||
        (window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/) || [])[1] ||
        '';

      if (!videoId) return null;

      let title = (vd.title || document.title.replace(/ - YouTube$/, '') || '').trim();
      const h1 = document.querySelector('h1.ytd-watch-metadata, #title h1, h1 yt-formatted-string');
      if (h1 && h1.textContent.trim()) {
        title = h1.textContent.trim();
      }

      const durationSec = parseInt(vd.lengthSeconds, 10) || 0;
      let thumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      if (vd.thumbnail && Array.isArray(vd.thumbnail.thumbnails) && vd.thumbnail.thumbnails.length > 0) {
        thumb = vd.thumbnail.thumbnails[vd.thumbnail.thumbnails.length - 1].url;
      }

      // 1. HLS master manifest URL (oferece 1080p, 720p, 480p, 360p com áudio)
      const hlsUrl = sd.hlsManifestUrl || null;

      // 2. Formatos progressivos diretos (.mp4 com áudio + vídeo juntos)
      const directFormats = [];
      if (Array.isArray(sd.formats)) {
        for (const f of sd.formats) {
          if (f.url && (f.mimeType || '').includes('video/mp4')) {
            directFormats.push({
              url: f.url,
              qualityLabel: f.qualityLabel || `${f.height || 360}p`,
              itag: f.itag,
              bitrate: f.bitrate || 0,
              width: f.width || 0,
              height: f.height || 0
            });
          }
        }
      }

      if (!hlsUrl && directFormats.length === 0) {
        return null;
      }

      return {
        videoId,
        title,
        durationSec,
        thumb,
        hlsUrl,
        directFormats,
        pageUrl: window.location.href
      };
    } catch {
      return null;
    }
  }

  function sendUpdate() {
    const data = extractYouTubeMedia();
    if (data) {
      window.postMessage({ source: 'video-radar-yt', data }, window.location.origin);
    }
  }

  // Monitora inicialização e navegações no SPA do YouTube (yt-navigate-finish)
  setTimeout(sendUpdate, 1000);
  setTimeout(sendUpdate, 2500);

  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(sendUpdate, 800);
    setTimeout(sendUpdate, 2000);
  });

  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      setTimeout(sendUpdate, 500);
    }
  }, true);

  // ---------- Download dentro da página (origem youtube.com, com cookies/headers corretos) ----------
  let overlayEl = null;
  function showOverlay(text, done) {
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#111827;color:#fff;' +
        'padding:10px 14px;border-radius:8px;font:13px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);max-width:320px';
      document.documentElement.appendChild(overlayEl);
    }
    overlayEl.textContent = text;
    if (done) setTimeout(() => { if (overlayEl) { overlayEl.remove(); overlayEl = null; } }, 5000);
  }

  async function fetchRange(url, start, end) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}range=${start}-${end}`);
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async function pageDownload(url, filename) {
    try {
      showOverlay('⏳ Video Radar: iniciando download...');
      const CHUNK = 5 * 1024 * 1024;
      const parts = [];
      let start = 0;
      let total = 0;
      const clenMatch = url.match(/[?&]clen=(\d+)/);
      if (clenMatch) total = parseInt(clenMatch[1], 10);

      for (;;) {
        const end = start + CHUNK - 1;
        const buf = await fetchRange(url, start, end);
        if (buf.length === 0) break;
        parts.push(buf);
        start += buf.length;
        if (total) showOverlay(`⏳ Baixando ${Math.round((start / total) * 100)}% — ${filename}`);
        else showOverlay(`⏳ Baixando ${(start / 1048576).toFixed(1)} MB — ${filename}`);
        if (buf.length < CHUNK || (total && start >= total)) break;
      }

      if (start < 100 * 1024) throw new Error('arquivo inválido');
      const blob = new Blob(parts, { type: 'video/mp4' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      showOverlay(`✅ Download concluído: ${filename}`, true);
    } catch (err) {
      showOverlay(`❌ Falha no download (${err.message}). Tente outra resolução.`, true);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'video-radar-yt-download') return;
    pageDownload(e.data.url, e.data.filename || 'youtube.mp4');
  });
})();
