// x-bridge.js — content script isolado (document_start) que recebe os vídeos extraídos pelo x-hook.js
// e repassa ao service worker. Precisa existir desde o início para não perder as primeiras respostas da timeline.

(function () {
  if (window.__videoRadarXBridge) return;
  window.__videoRadarXBridge = true;

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'video-radar-x' || !Array.isArray(e.data.media)) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime
        .sendMessage({ action: 'ADD_X_MEDIA', media: e.data.media, pageUrl: window.location.href })
        .catch(() => {});
    } catch {
      // Contexto da extensão invalidado (extensão recarregada)
    }
  });
})();
