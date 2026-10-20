// meta-hook.js — Roda no MAIN world de instagram.com e facebook.com (document_start)
// Intercepta GraphQL, APIs internas, scripts SSR e requisições ao CDN de vídeo do Meta (*.cdninstagram.com e *.fbcdn.net).
// Extrai os arquivos MP4 diretos (com áudio e vídeo juntos), resoluções HD/SD, miniaturas e legendas.

(function () {
  if (window.__videoRadarMetaHook) return;
  window.__videoRadarMetaHook = true;

  const seenMediaIds = new Set();
  const seenVideoUrls = new Set();

  function cleanMetaCdnVideoUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    try {
      const u = new URL(rawUrl);
      if (/cdninstagram\.com|fbcdn\.net/i.test(u.hostname)) {
        u.searchParams.delete('bytestart');
        u.searchParams.delete('byteend');
        return u.toString();
      }
    } catch {}
    return rawUrl;
  }

  function formatDuration(sec) {
    if (!sec || isNaN(sec) || sec <= 0) return null;
    const s = Math.round(sec);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
  }

  function getActivePostContext() {
    const isIg = /instagram\.com/i.test(window.location.hostname);
    let author = '';
    let caption = '';
    let poster = null;

    if (isIg) {
      // Tenta achar autor e legenda na página atual do Instagram
      const authorEl = document.querySelector('header a[role="link"], article a[role="link"][tabindex="0"], a.x1i10hfl[href^="/"]');
      if (authorEl && authorEl.textContent) {
        author = authorEl.textContent.trim().replace(/^@/, '');
      }
      const capEl = document.querySelector('h1, article ul li span, article h1, div[data-pressable-container] span');
      if (capEl && capEl.textContent) {
        caption = capEl.textContent.trim().slice(0, 100);
      }
    } else {
      // Facebook
      const h1 = document.querySelector('h1, strong span, a[role="link"] > strong');
      if (h1 && h1.textContent) {
        author = h1.textContent.trim();
      }
    }

    const videoEl = document.querySelector('video');
    if (videoEl) {
      poster = videoEl.poster || videoEl.getAttribute('poster') || null;
    }

    return { author, caption, poster };
  }

  function collectMetaMedia(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (Array.isArray(node)) {
      for (const item of node) collectMetaMedia(item, out, depth + 1);
      return;
    }

    // 1. Instagram: array de video_versions (API REST / GraphQL)
    if (Array.isArray(node.video_versions) && node.video_versions.length > 0) {
      const id = String(node.id || node.pk || node.code || '');
      const cacheKey = id || (node.video_versions[0] && node.video_versions[0].url);
      if (cacheKey && !seenMediaIds.has(cacheKey)) {
        seenMediaIds.add(cacheKey);

        const variants = [];
        for (const v of node.video_versions) {
          if (!v || !v.url) continue;
          const cleanUrl = cleanMetaCdnVideoUrl(v.url);
          const height = v.height || 0;
          const width = v.width || 0;
          variants.push({
            url: cleanUrl,
            width,
            height,
            quality: height ? `${height}p` : 'HD'
          });
        }

        // Ordena: maior resolução primeiro
        variants.sort((a, b) => b.height - a.height);

        let thumb = null;
        if (node.image_versions2 && Array.isArray(node.image_versions2.candidates) && node.image_versions2.candidates.length > 0) {
          thumb = node.image_versions2.candidates[0].url;
        }

        let caption = '';
        if (node.caption && node.caption.text) {
          caption = node.caption.text;
        }

        let user = '';
        if (node.user && node.user.username) {
          user = node.user.username;
        }

        if (variants.length > 0) {
          out.push({
            platform: 'Instagram',
            id: id || node.code || 'ig_video',
            code: node.code || '',
            user,
            caption,
            duration: node.video_duration || 0,
            thumbnailUrl: thumb,
            variants
          });
        }
      }
    }

    // 2. Instagram: video_url direto (GraphQL shortcode_media)
    if (typeof node.video_url === 'string' && node.video_url.startsWith('http')) {
      const id = String(node.shortcode || node.id || node.code || node.video_url);
      if (!seenMediaIds.has(id)) {
        seenMediaIds.add(id);
        const cleanUrl = cleanMetaCdnVideoUrl(node.video_url);

        let caption = '';
        if (node.edge_media_to_caption && Array.isArray(node.edge_media_to_caption.edges) && node.edge_media_to_caption.edges[0]) {
          caption = (node.edge_media_to_caption.edges[0].node && node.edge_media_to_caption.edges[0].node.text) || '';
        }

        let user = (node.owner && node.owner.username) || '';
        out.push({
          platform: 'Instagram',
          id,
          code: node.shortcode || '',
          user,
          caption,
          thumbnailUrl: node.display_url || null,
          variants: [{ url: cleanUrl, quality: 'HD' }]
        });
      }
    }

    // 3. Facebook: playable_url_quality_hd / playable_url / browser_native_hd_url
    const fbHd = node.playable_url_quality_hd || node.browser_native_hd_url;
    const fbSd = node.playable_url || node.browser_native_sd_url;
    if (fbHd || fbSd) {
      const id = String(node.id || node.video_id || fbHd || fbSd);
      if (!seenMediaIds.has(id)) {
        seenMediaIds.add(id);
        const variants = [];
        if (fbHd) {
          variants.push({ url: cleanMetaCdnVideoUrl(fbHd), quality: 'HD 1080p' });
        }
        if (fbSd) {
          variants.push({ url: cleanMetaCdnVideoUrl(fbSd), quality: 'SD' });
        }

        let thumb =
          (node.preferred_thumbnail && node.preferred_thumbnail.image && node.preferred_thumbnail.image.uri) ||
          node.thumbnail_url ||
          null;

        let title = '';
        if (node.creation_story && node.creation_story.message && node.creation_story.message.text) {
          title = node.creation_story.message.text;
        }

        out.push({
          platform: 'Facebook',
          id,
          title,
          thumbnailUrl: thumb,
          variants
        });
      }
    }

    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') collectMetaMedia(v, out, depth + 1);
    }
  }

  function dispatchMedia(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    window.postMessage({ source: 'video-radar-meta', media: items }, window.location.origin);
  }

  function processPayload(data) {
    try {
      const out = [];
      collectMetaMedia(data, out, 0);
      if (out.length > 0) {
        dispatchMedia(out);
      }
    } catch {
      // Ignore
    }
  }

  function handleMetaCdnUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    const lower = rawUrl.toLowerCase();
    if (!lower.includes('cdninstagram.com') && !lower.includes('fbcdn.net')) return;
    if (!lower.includes('.mp4') && !lower.includes('/v/') && !lower.includes('/o1/v/')) return;
    if (lower.includes('/init.mp4') || lower.includes('/frag(')) return;

    const cleanUrl = cleanMetaCdnVideoUrl(rawUrl);
    if (seenVideoUrls.has(cleanUrl)) return;
    seenVideoUrls.add(cleanUrl);

    const isIg = /instagram\.com|cdninstagram\.com/i.test(window.location.hostname + rawUrl);
    const ctx = getActivePostContext();

    const item = {
      platform: isIg ? 'Instagram' : 'Facebook',
      id: `cdn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      user: ctx.author,
      caption: ctx.caption,
      thumbnailUrl: ctx.poster,
      variants: [{ url: cleanUrl, quality: 'HD MP4' }]
    };

    dispatchMedia([item]);
  }

  // Intercepta window.fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url) {
        if (/cdninstagram\.com|fbcdn\.net/i.test(url)) {
          handleMetaCdnUrl(url);
        } else if (/\/api\/v1\/|\/graphql|\/api\/graphql|instagram\.com\/graphql|facebook\.com\/api/i.test(url)) {
          const clone = res.clone();
          clone.json().then(processPayload).catch(() => {});
        }
      }
    } catch {}
    return res;
  };

  // Intercepta XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._vrUrl = typeof url === 'string' ? url : String(url || '');
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        const url = this._vrUrl || '';
        if (url) {
          if (/cdninstagram\.com|fbcdn\.net/i.test(url)) {
            handleMetaCdnUrl(url);
          } else if (/\/api\/v1\/|\/graphql|\/api\/graphql|instagram\.com\/graphql|facebook\.com\/api/i.test(url)) {
            const text = this.responseText;
            if (text && (text.startsWith('{') || text.startsWith('['))) {
              processPayload(JSON.parse(text));
            }
          }
        }
      } catch {}
    });
    return origSend.apply(this, args);
  };

  // Varredura de tags <script> na página (SSR inicial)
  function scanScripts() {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      if (!text || (!text.includes('video_versions') && !text.includes('playable_url') && !text.includes('browser_native_') && !text.includes('video_url'))) {
        continue;
      }
      try {
        if (s.type === 'application/json' || text.startsWith('{') || text.startsWith('[')) {
          processPayload(JSON.parse(text));
        } else {
          // Extrai URLs do script inline Facebook
          const unescaped = text.replace(/\\\//g, '/');
          const hdMatch = unescaped.match(/(?:playable_url_quality_hd|browser_native_hd_url)":\s*"([^"]+)/i);
          const sdMatch = unescaped.match(/(?:playable_url|browser_native_sd_url)":\s*"([^"]+)/i);
          const thumbMatch = unescaped.match(/(?:preferred_thumbnail|thumbnail)[^}]*?"(?:uri|url)":\s*"([^"]+)/i);

          if (hdMatch || sdMatch) {
            const variants = [];
            if (hdMatch) variants.push({ url: cleanMetaCdnVideoUrl(hdMatch[1]), quality: 'HD 1080p' });
            if (sdMatch) variants.push({ url: cleanMetaCdnVideoUrl(sdMatch[1]), quality: 'SD' });
            dispatchMedia([
              {
                platform: 'Facebook',
                id: `fb_script_${Date.now()}`,
                thumbnailUrl: thumbMatch ? thumbMatch[1] : null,
                variants
              }
            ]);
          }

          // Extrai video_versions do script inline Instagram
          const vvMatch = unescaped.match(/"video_versions":\s*(\[[^\]]+\])/i);
          if (vvMatch) {
            try {
              const vars = JSON.parse(vvMatch[1]);
              if (Array.isArray(vars) && vars.length > 0) {
                const variants = vars
                  .filter((v) => v && v.url)
                  .map((v) => ({
                    url: cleanMetaCdnVideoUrl(v.url),
                    quality: v.height ? `${v.height}p` : 'HD'
                  }));
                if (variants.length > 0) {
                  const thumbM = unescaped.match(/"image_versions2"[^}]*?"url":\s*"([^"]+)/i);
                  dispatchMedia([
                    {
                      platform: 'Instagram',
                      id: `ig_script_${Date.now()}`,
                      thumbnailUrl: thumbM ? thumbM[1] : null,
                      variants
                    }
                  ]);
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
  }

  // Varredura de tags <video> no DOM
  function scanDom() {
    const isIg = /instagram\.com/i.test(window.location.hostname);
    const isFb = /facebook\.com/i.test(window.location.hostname);
    if (!isIg && !isFb) return;

    const videos = document.querySelectorAll('video');
    videos.forEach((video) => {
      const poster = video.poster || video.getAttribute('poster') || null;
      const src = video.currentSrc || video.src || '';
      if (src && !src.startsWith('blob:') && /cdninstagram\.com|fbcdn\.net/i.test(src)) {
        handleMetaCdnUrl(src);
      }
    });
  }

  function scanAll() {
    scanScripts();
    scanDom();
  }

  // Executa varredura inicial em tempos incrementais
  setTimeout(scanAll, 500);
  setTimeout(scanAll, 1500);
  setTimeout(scanAll, 3000);

  // Monitora mutações no DOM (ex: rolagem no feed do Reels)
  if (document.body) {
    const observer = new MutationObserver(() => {
      scanDom();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      scanAll();
      const observer = new MutationObserver(() => {
        scanDom();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  // Escuta gatilho vindo do bridge (quando o popup abre ou usuário clica em Re-escanear)
  window.addEventListener('message', (e) => {
    if (e.data && e.data.source === 'video-radar-meta-trigger') {
      scanAll();
    }
  });

  // Escuta evento de play em vídeos
  document.addEventListener(
    'play',
    (e) => {
      if (e.target && e.target.tagName === 'VIDEO') {
        scanAll();
      }
    },
    true
  );
})();
