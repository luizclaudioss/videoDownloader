// yt-bridge.js — ponte isolada que repassa os streams reais do YouTube extraídos no MAIN world para o background
(function () {
  if (window.__videoRadarYtBridge) return;
  window.__videoRadarYtBridge = true;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'video-radar-yt' || !e.data.data) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime
        .sendMessage({
          action: 'ADD_YOUTUBE_MEDIA',
          data: e.data.data
        })
        .catch(() => {});
    } catch {
      // Ignore context invalidated
    }
  });
})();
