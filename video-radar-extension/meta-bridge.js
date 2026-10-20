// meta-bridge.js — Content Script isolado para Instagram e Facebook
// Recebe os dados de vídeo do meta-hook.js (MAIN world) e envia ao background.js via chrome.runtime.sendMessage.

(function () {
  if (window.__videoRadarMetaBridge) return;
  window.__videoRadarMetaBridge = true;

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'video-radar-meta') return;
    const items = event.data.media;
    if (Array.isArray(items) && items.length > 0) {
      chrome.runtime
        .sendMessage({
          action: 'ADD_META_MEDIA',
          media: items,
          pageUrl: window.location.href,
          pageTitle: document.title
        })
        .catch(() => {});
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'TRIGGER_META_SCAN') {
      window.postMessage({ source: 'video-radar-meta-trigger' }, window.location.origin);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.action === 'GET_META_PAGE_INFO') {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content;
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      const videoEl = document.querySelector('video');
      const poster = (videoEl && (videoEl.poster || videoEl.getAttribute('poster'))) || ogImage || null;
      sendResponse({
        title: ogTitle || document.title || 'Vídeo Meta',
        thumbnailUrl: poster
      });
      return true;
    }
  });
})();
