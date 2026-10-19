// x-hook.js — roda no MAIN world do x.com / twitter.com (document_start)
// Lê as respostas da API GraphQL do próprio X (timeline, post, perfil, busca) e extrai, para cada vídeo:
// mediaId, tweetId, autor, texto, thumbnail, duração e TODAS as variantes MP4 (vídeo + áudio juntos).
// Os dados são repassados ao content script isolado (x-bridge.js) via window.postMessage.

(function () {
  if (window.__videoRadarXHook) return;
  window.__videoRadarXHook = true;

  const API_RE = /\/i\/api\/|\/graphql\/|api\.(?:x|twitter)\.com/i;

  function pickScreenName(tweet) {
    try {
      const u = tweet.core && tweet.core.user_results && tweet.core.user_results.result;
      if (!u) return '';
      return (u.core && u.core.screen_name) || (u.legacy && u.legacy.screen_name) || '';
    } catch {
      return '';
    }
  }

  function pickText(tweet) {
    try {
      const note = tweet.note_tweet && tweet.note_tweet.note_tweet_results && tweet.note_tweet.note_tweet_results.result;
      if (note && note.text) return note.text;
      return (tweet.legacy && tweet.legacy.full_text) || '';
    } catch {
      return '';
    }
  }

  function collect(node, ctx, out, seen, depth) {
    if (!node || typeof node !== 'object' || depth > 80) return;
    if (Array.isArray(node)) {
      for (const n of node) collect(n, ctx, out, seen, depth + 1);
      return;
    }

    let nextCtx = ctx;
    if (node.rest_id && node.legacy && typeof node.legacy === 'object' && (node.legacy.full_text !== undefined || node.legacy.extended_entities)) {
      nextCtx = {
        tweetId: String(node.rest_id),
        user: pickScreenName(node) || ctx.user || '',
        text: pickText(node) || ''
      };
    }

    if (
      node.video_info &&
      Array.isArray(node.video_info.variants) &&
      (node.type === 'video' || node.type === 'animated_gif') &&
      (node.id_str || node.media_key)
    ) {
      const id = String(node.id_str || node.media_key);
      if (!seen.has(id)) {
        seen.add(id);
        let tweetId = nextCtx.tweetId || '';
        let user = nextCtx.user || '';
        const exp = node.expanded_url || '';
        const em = exp.match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/i);
        if (em) {
          user = user || em[1];
          tweetId = em[2];
        }
        out.push({
          id,
          tweetId,
          user,
          text: nextCtx.text || '',
          type: node.type,
          thumb: node.media_url_https || '',
          width: (node.original_info && node.original_info.width) || 0,
          height: (node.original_info && node.original_info.height) || 0,
          durationMs: node.video_info.duration_millis || 0,
          expandedUrl: exp,
          variants: node.video_info.variants.map((v) => ({
            url: v.url,
            content_type: v.content_type,
            bitrate: v.bitrate || 0
          }))
        });
      }
    }

    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') collect(v, nextCtx, out, seen, depth + 1);
    }
  }

  function handlePayload(data) {
    try {
      const out = [];
      collect(data, { tweetId: '', user: '', text: '' }, out, new Set(), 0);
      if (out.length > 0) {
        window.postMessage({ source: 'video-radar-x', media: out }, window.location.origin);
      }
    } catch {
      // Ignore
    }
  }

  // XMLHttpRequest (o X web usa XHR para a maioria das chamadas GraphQL)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__vrUrl = String(url || '');
    } catch {
      // Ignore
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (API_RE.test(this.__vrUrl || '')) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            const t = this.responseText;
            if (t && t.indexOf('video_info') !== -1) handlePayload(JSON.parse(t));
          } else if (this.responseType === 'json' && this.response) {
            handlePayload(this.response);
          }
        } catch {
          // Ignore
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // fetch
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (API_RE.test(url)) {
          p.then((r) => r.clone().text())
            .then((t) => {
              if (t && t.indexOf('video_info') !== -1) handlePayload(JSON.parse(t));
            })
            .catch(() => {});
        }
      } catch {
        // Ignore
      }
      return p;
    };
  }
})();
