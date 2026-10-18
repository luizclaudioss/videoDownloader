// content.js - Roda na página principal e dentro de todos os iframes (all_frames: true)

(function () {
  const sentUrls = new Set();
  const isIframe = window.self !== window.top;

  const VIDEO_IFRAME_REGEX = /vimeo\.com|pandavideo\.com|wistia\.(net|com)|youtube(-nocookie)?\.com\/embed|youtu\.be|mediadelivery\.net|converteai\.net|vturb\.com|hotmart\.com|cloudflarestream\.com|videodelivery\.net|loom\.com\/(embed|share)|vidyard\.com|dailymotion\.com\/embed|smartplayer\.io|scaleup\.com\.br|jwpcdn\.com|jwplayer\.com|brightcove\.net|sproutvideo\.com|vadoo\.tv|gumlet\.io|mux\.com/i;

  function getBestTitle(el) {
    if (el) {
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-title');
      if (aria && aria.trim().length > 2) return aria.trim();
    }
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) return ogTitle.content.trim();
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent && h1.textContent.trim().length > 2) {
      return h1.textContent.trim().slice(0, 120);
    }
    return (document.title || '').trim();
  }

  function resolveUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('blob:') || trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed === 'about:blank') {
      return null;
    }
    try {
      return new URL(trimmed, window.location.href).href;
    } catch {
      return null;
    }
  }

  let observer = null;

  function isExtensionContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function scanFrameForVideos(forceResend = false) {
    if (!isExtensionContextValid()) {
      if (observer) observer.disconnect();
      return;
    }
    if (forceResend) {
      sentUrls.clear();
    }

    const found = [];
    const currentUrl = window.location.href;
    const refererUrl = document.referrer || currentUrl;
    const defaultTitle = getBestTitle(null);

    function addCandidate(item) {
      if (!item || !item.url) return;
      const fullUrl = resolveUrl(item.url);
      if (!fullUrl) return;
      if (!forceResend && sentUrls.has(fullUrl)) return;
      sentUrls.add(fullUrl);

      found.push({
        url: fullUrl,
        title: item.title || defaultTitle,
        pageUrl: isIframe ? refererUrl : currentUrl,
        referer: item.referer || (isIframe ? refererUrl : currentUrl),
        frameUrl: currentUrl,
        sourceType: item.sourceType || 'dom-video',
        providerOverride: item.providerOverride || null,
        qualityHint: item.qualityHint || null
      });
    }

    // 1. Se este script estiver rodando DENTRO de um iframe de player conhecido
    if (isIframe && VIDEO_IFRAME_REGEX.test(currentUrl)) {
      addCandidate({
        url: currentUrl,
        title: document.title || defaultTitle,
        referer: refererUrl,
        sourceType: 'dom-iframe'
      });
    }

    // 2. Tags <video> e <source>
    const videoEls = document.querySelectorAll('video');
    videoEls.forEach((video) => {
      const vTitle = getBestTitle(video);
      const srcs = [video.currentSrc, video.src, video.getAttribute('data-src')];
      srcs.forEach((s) => {
        if (s && !s.startsWith('blob:')) {
          addCandidate({
            url: s,
            title: vTitle,
            sourceType: 'dom-video',
            qualityHint: video.videoHeight ? `${video.videoHeight}p` : null
          });
        }
      });

      video.querySelectorAll('source').forEach((source) => {
        const sUrl = source.src || source.getAttribute('src') || source.getAttribute('data-src');
        const label = source.getAttribute('label') || source.getAttribute('size') || source.getAttribute('res');
        if (sUrl && !sUrl.startsWith('blob:')) {
          addCandidate({
            url: sUrl,
            title: vTitle,
            sourceType: 'dom-video',
            qualityHint: label ? (String(label).endsWith('p') ? label : `${label}p`) : null
          });
        }
      });
    });

    // 3. Tags <iframe>
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((iframe) => {
      const rawSrc =
        iframe.src ||
        iframe.getAttribute('data-src') ||
        iframe.getAttribute('data-lazy-src') ||
        iframe.getAttribute('data-original');
      const fullSrc = resolveUrl(rawSrc);
      if (!fullSrc) return;

      const allowAttr = (iframe.getAttribute('allow') || '').toLowerCase();
      const hasFullscreen =
        iframe.hasAttribute('allowfullscreen') ||
        iframe.hasAttribute('webkitallowfullscreen') ||
        allowAttr.includes('fullscreen') ||
        allowAttr.includes('autoplay');

      if (VIDEO_IFRAME_REGEX.test(fullSrc) || (hasFullscreen && /(player|embed|video|watch|stream)/i.test(fullSrc))) {
        addCandidate({
          url: fullSrc,
          title: getBestTitle(iframe),
          referer: currentUrl,
          sourceType: 'dom-iframe'
        });
      }
    });

    // 4. Divs especiais de Wistia
    const wistiaDivs = document.querySelectorAll('[class*="wistia_async_"], [data-wistia-id], wistia-player[media-id]');
    wistiaDivs.forEach((el) => {
      let mediaId = el.getAttribute('data-wistia-id') || el.getAttribute('media-id');
      if (!mediaId && el.className && typeof el.className === 'string') {
        const m = el.className.match(/wistia_async_([a-z0-9]+)/i);
        if (m) mediaId = m[1];
      }
      if (mediaId) {
        addCandidate({
          url: `https://fast.wistia.net/embed/iframe/${mediaId}`,
          title: getBestTitle(el),
          referer: currentUrl,
          sourceType: 'dom-embed',
          providerOverride: 'Wistia'
        });
      }
    });

    // 5. Divs especiais do Vimeo
    const vimeoDivs = document.querySelectorAll('[data-vimeo-id], [data-vimeo-url]');
    vimeoDivs.forEach((el) => {
      const vimeoId = el.getAttribute('data-vimeo-id');
      const vimeoUrl = el.getAttribute('data-vimeo-url');
      if (vimeoId && /^\d+$/.test(vimeoId)) {
        addCandidate({
          url: `https://player.vimeo.com/video/${vimeoId}`,
          title: getBestTitle(el),
          referer: currentUrl,
          sourceType: 'dom-embed',
          providerOverride: 'Vimeo'
        });
      } else if (vimeoUrl) {
        addCandidate({
          url: vimeoUrl,
          title: getBestTitle(el),
          referer: currentUrl,
          sourceType: 'dom-embed',
          providerOverride: 'Vimeo'
        });
      }
    });

    // 6. VTurb / ConverteAI scripts
    const scripts = document.querySelectorAll('script[src]');
    scripts.forEach((s) => {
      const src = s.src || '';
      const vturbMatch = src.match(/scripts\.converteai\.net\/([^\/]+)\/players\/([a-f0-9]+)\/player\.js/i);
      if (vturbMatch) {
        const [, orgId, playerId] = vturbMatch;
        addCandidate({
          url: `https://cdn.converteai.net/${orgId}/${playerId}/main.m3u8`,
          title: defaultTitle,
          referer: currentUrl,
          sourceType: 'network',
          providerOverride: 'VTurb / ConverteAI'
        });
      }
    });

    // 7. Meta tags OpenGraph
    const ogVideo = document.querySelector('meta[property="og:video"], meta[property="og:video:secure_url"], meta[property="og:video:url"]');
    if (ogVideo && ogVideo.content) {
      addCandidate({
        url: ogVideo.content,
        title: defaultTitle,
        referer: currentUrl,
        sourceType: 'dom-embed'
      });
    }

    // 7.1. X / Twitter (x.com / twitter.com) — detecta vídeo do post aberto ou posts com vídeo na timeline
    if (/(?:^|\.)(?:x\.com|twitter\.com)$/i.test(window.location.hostname)) {
      if (/\/status\/\d+/i.test(currentUrl)) {
        addCandidate({
          url: currentUrl,
          title: defaultTitle,
          referer: currentUrl,
          sourceType: 'dom-embed',
          providerOverride: 'X / Twitter'
        });
      }
      const articles = document.querySelectorAll('article');
      articles.forEach((art) => {
        if (!art.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]')) return;
        const statusLink = art.querySelector('a[href*="/status/"]');
        if (statusLink && statusLink.href) {
          addCandidate({
            url: statusLink.href,
            title: defaultTitle,
            referer: currentUrl,
            sourceType: 'dom-embed',
            providerOverride: 'X / Twitter'
          });
        }
      });
    }

    // 8. Vasculha Performance API para streams já carregados
    try {
      const resources = performance.getEntriesByType('resource') || [];
      for (const res of resources) {
        const rUrl = res.name;
        if (!rUrl) continue;
        if (/\.(m3u8|mpd|mp4|webm|mov)(\?|$)/i.test(rUrl) && !/\/seg-\d+|\/segment[-_]\d+|\/init\.mp4|\.ts(\?|$)/i.test(rUrl)) {
          addCandidate({
            url: rUrl,
            title: defaultTitle,
            referer: isIframe ? refererUrl : currentUrl,
            sourceType: 'network'
          });
        }
      }
    } catch {
      // Ignore
    }

    // 9. Procura URLs diretas de .m3u8 e .mp4 dentro de scripts inline de players (Vimeo, Panda Video, Bunny, Wistia, VTurb)
    if (isIframe || document.querySelectorAll('video, iframe').length > 0) {
      const inlineScripts = document.querySelectorAll('script:not([src])');
      const m3u8Regex = /https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
      const mp4Regex = /https?:\/\/[^\s"'<>\\]+\.mp4(?:\?[^\s"'<>\\]*)?/gi;

      inlineScripts.forEach((scr) => {
        const text = scr.textContent || '';
        if (!text || text.length > 600000) return;

        if (text.includes('.m3u8') || text.includes('.mp4')) {
          const cleaned = text.replace(/\\\//g, '/').replace(/\\u0026/g, '&');

          const m3u8Matches = cleaned.match(m3u8Regex);
          if (m3u8Matches) {
            m3u8Matches.slice(0, 6).forEach((mUrl) => {
              addCandidate({
                url: mUrl,
                title: defaultTitle,
                referer: isIframe ? refererUrl : currentUrl,
                sourceType: 'network'
              });
            });
          }

          const mp4Matches = cleaned.match(mp4Regex);
          if (mp4Matches) {
            mp4Matches.slice(0, 6).forEach((mp4Url) => {
              if (!/\/init\.mp4|\/seg-|\/segment/i.test(mp4Url)) {
                addCandidate({
                  url: mp4Url,
                  title: defaultTitle,
                  referer: isIframe ? refererUrl : currentUrl,
                  sourceType: 'network'
                });
              }
            });
          }
        }
      });
    }

    if (found.length > 0 && isExtensionContextValid()) {
      try {
        chrome.runtime.sendMessage({
          action: 'ADD_DOM_VIDEOS',
          videos: found
        }).catch(() => {});
      } catch {
        if (observer) observer.disconnect();
      }
    }
  }

  function highlightVideoOnPage(targetUrl) {
    const candidates = [...document.querySelectorAll('iframe, video, [class*="wistia_async_"]')];
    let targetEl = null;

    for (const el of candidates) {
      const src = el.src || el.currentSrc || el.getAttribute('data-src') || '';
      if (src && (targetUrl.includes(src) || src.includes(targetUrl))) {
        targetEl = el;
        break;
      }
    }

    if (!targetEl && candidates.length > 0) {
      targetEl = candidates[0];
    }

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prevOutline = targetEl.style.outline;
      const prevTransition = targetEl.style.transition;
      targetEl.style.transition = 'outline 0.25s ease';
      targetEl.style.outline = '4px solid #6366f1';
      setTimeout(() => {
        targetEl.style.outline = prevOutline;
        targetEl.style.transition = prevTransition;
      }, 3000);
    }
  }

  if (isExtensionContextValid()) {
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg) return false;
        if (msg.action === 'RESCAN_DOM') {
          scanFrameForVideos(true);
          sendResponse({ ok: true });
          return false;
        }
        if (msg.action === 'HIGHLIGHT_VIDEO') {
          highlightVideoOnPage(msg.url || '');
          sendResponse({ ok: true });
          return false;
        }
        if (msg.action === 'AUTO_TRIGGER_PLAY') {
          const v = document.querySelector('video');
          if (v && v.paused) {
            v.muted = true;
            v.play().then(() => {
              setTimeout(() => v.pause(), 600);
            }).catch(() => {});
          }
          scanFrameForVideos(true);
          sendResponse({ ok: true });
          return false;
        }
        return false;
      });
    } catch {
      // Ignore invalidated context
    }
  }

  scanFrameForVideos(false);
  setTimeout(() => scanFrameForVideos(false), 1800);
  setTimeout(() => scanFrameForVideos(false), 4500);

  let debounceTimer = null;
  observer = new MutationObserver(() => {
    if (!isExtensionContextValid()) {
      observer.disconnect();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scanFrameForVideos(false);
    }, 1000);
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'data-src']
    });
  }
})();
