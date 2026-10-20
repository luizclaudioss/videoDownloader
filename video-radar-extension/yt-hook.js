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
})();
