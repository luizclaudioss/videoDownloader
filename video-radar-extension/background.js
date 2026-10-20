// background.js - Service Worker (Manifest V3)
// Intercepta tráfego de rede, valida URLs de vídeo, injeta Referer/Origin e garante extensão .mp4.

const tabVideosCache = new Map(); // tabId -> Map(normalizedKey -> videoItem)
const requestHeadersMap = new Map(); // requestId -> { referer, origin, initiator }
const downloadFilenameById = new Map(); // downloadId -> forcedFilename.mp4
const downloadFilenameByUrl = new Map(); // url -> forcedFilename.mp4
const extractedEmbeds = new Set();
const deadUrlsCache = new Set(); // URLs que retornaram 403/404/text/plain

let nextRuleId = 1000;
const domainRuleMap = new Map(); // hostname -> ruleId

setInterval(() => {
  if (requestHeadersMap.size > 2000) {
    requestHeadersMap.clear();
  }
}, 60000);

async function ensureRefererRule(targetUrl, refererUrl) {
  if (!targetUrl || !refererUrl) return;
  try {
    const targetHost = new URL(targetUrl).hostname;
    const refUrlObj = new URL(refererUrl);
    const refererOrigin = refUrlObj.origin;

    let ruleId = domainRuleMap.get(targetHost);
    if (!ruleId) {
      ruleId = nextRuleId++;
      if (nextRuleId > 9000) nextRuleId = 1000;
      domainRuleMap.set(targetHost, ruleId);
    }

    const rule = {
      id: ruleId,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: refererUrl },
          { header: 'Origin', operation: 'set', value: refererOrigin }
        ]
      },
      condition: {
        urlFilter: `||${targetHost}`,
        resourceTypes: ['xmlhttprequest', 'media', 'other', 'main_frame', 'sub_frame']
      }
    };

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [rule]
    });
  } catch {
    // Ignore invalid URLs
  }
}

// Garante que todo download iniciado pela extensão seja salvo com a extensão correta (.mp4)
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const byId = downloadFilenameById.get(downloadItem.id);
  const byUrl = downloadFilenameByUrl.get(downloadItem.url) || downloadFilenameByUrl.get(downloadItem.finalUrl);
  const forcedFilename = byId || byUrl;

  if (forcedFilename) {
    downloadFilenameById.delete(downloadItem.id);
    suggest({
      filename: forcedFilename,
      conflictAction: 'uniquify'
    });
    return;
  }

  if (downloadItem.byExtensionId === chrome.runtime.id || (downloadItem.url && downloadItem.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}`))) {
    let fname = downloadItem.filename || 'video_capturado.mp4';
    if (!/\.(mp4|webm|mkv|mov)$/i.test(fname)) {
      fname = fname.replace(/\.[^/.]+$/, '') + '.mp4';
    }
    suggest({
      filename: fname,
      conflictAction: 'uniquify'
    });
  }
});

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

const PROVIDER_PATTERNS = [
  {
    name: 'Instagram',
    badgeColor: '#e1306c',
    regex: /(?:instagram\.com|cdninstagram\.com)/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Facebook',
    badgeColor: '#1877f2',
    regex: /(?:facebook\.com|fbcdn\.net)/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Spalla Video',
    badgeColor: '#0ea5e9',
    regex: /spalla\.io/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Panda Video',
    badgeColor: '#7c3aed',
    regex: /pandavideo\.com(\.br)?|tv\.pandavideo\.com\.br|b-cdn\.net\/.*playlist\.m3u8/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Vimeo',
    badgeColor: '#00adef',
    regex: /player\.vimeo\.com\/video\/\d+|vimeo\.com\/video\/\d+|vod-progressive\.akamaized\.net|vimeocdn\.com|akamaized\.net\/exp=.*vimeo/i,
    extractEmbedUrl: (url) => {
      const m = url.match(/player\.vimeo\.com\/video\/(\d+)(\?[^\s"']*)?/i);
      return m ? `https://player.vimeo.com/video/${m[1]}${m[2] || ''}` : url;
    }
  },
  {
    name: 'Wistia',
    badgeColor: '#54bbff',
    regex: /fast\.wistia\.(net|com)\/embed\/(iframe|medias)\/([a-z0-9]+)|embed-ssl\.wistia\.com/i,
    extractEmbedUrl: (url) => {
      const m = url.match(/fast\.wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([a-z0-9]+)/i);
      return m ? `https://fast.wistia.net/embed/iframe/${m[1]}` : url;
    }
  },
  {
    name: 'YouTube',
    badgeColor: '#ef4444',
    regex: /(?:youtube(-nocookie)?\.com\/(?:embed\/|watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i,
    extractEmbedUrl: (url) => {
      const m = url.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
      return m ? `https://www.youtube.com/watch?v=${m[1]}` : url;
    }
  },
  {
    name: 'VTurb / ConverteAI',
    badgeColor: '#f59e0b',
    regex: /converteai\.net|vturb\.com/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Bunny Stream',
    badgeColor: '#f97316',
    regex: /iframe\.mediadelivery\.net\/(embed|play)\/|\bmediadelivery\.net\b/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Hotmart Player',
    badgeColor: '#f04e23',
    regex: /player\.hotmart\.com|cf-embed\.play\.hotmart\.com|vod-akm\.play\.hotmart\.com/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Cloudflare Stream',
    badgeColor: '#f38020',
    regex: /cloudflarestream\.com|videodelivery\.net/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Loom',
    badgeColor: '#625df5',
    regex: /loom\.com\/(embed|share)\/[a-f0-9]+/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Vidyard',
    badgeColor: '#22c55e',
    regex: /play\.vidyard\.com\/[a-zA-Z0-9_-]+/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Smartplayer / Scaleup',
    badgeColor: '#ec4899',
    regex: /smartplayer\.io|scaleup\.com\.br/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'Dailymotion',
    badgeColor: '#0066dc',
    regex: /dailymotion\.com\/embed\/video\/[a-zA-Z0-9]+/i,
    extractEmbedUrl: (url) => url
  },
  {
    name: 'X / Twitter',
    badgeColor: '#1d9bf0',
    regex: /(?:x\.com|twitter\.com)\/[^\/]+\/status\/\d+|video\.twimg\.com/i,
    extractEmbedUrl: (url) => url
  }
];

function isIgnoredNoiseUrl(url) {
  if (!url || typeof url !== 'string') return true;
  if (deadUrlsCache.has(url)) return true;
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('chrome-extension:')) {
    return true;
  }

  // Ignora URLs extraídas de código JS minificado onde o token JWT é apenas o nome de uma variável curta (ex: ?sjwt=oq)
  const jwtParamMatch = url.match(/[?&](sjwt|jwt|token)=([^&]+)/i);
  if (jwtParamMatch && jwtParamMatch[2].length < 15) {
    return true;
  }

  const lower = url.toLowerCase();
  const pathOnly = lower.split('?')[0];

  if (/\.(ts|m4s|m4a|aac|vtt|srt|jpg|jpeg|png|gif|webp|svg|css|js|woff|woff2|ico)$/.test(pathOnly)) {
    if (!/fast\.wistia\.(com|net)\/embed\/medias\/[a-z0-9]+\.json/i.test(lower)) {
      return true;
    }
  }

  if (/\/seg-\d+|\/segment[-_]\d+|\/chunk[-_]\d+|\/frag\(\d+\)|\/init\.mp4/i.test(lower)) {
    return true;
  }

  if (lower.includes('googlevideo.com/videoplayback') || lower.includes('googlevideo.com/api/manifest')) {
    return true;
  }
  if (/[?&](range|bytestart|byteend)=\d+/i.test(lower)) {
    const isMetaVideo = /cdninstagram\.com|fbcdn\.net/i.test(lower) && (/(\/v\/|\/o1\/v\/|\.mp4)/i.test(lower));
    if (!isMetaVideo && !/\.mp4(\?|$)/i.test(lower)) {
      return true;
    }
  }

  if (/\/(analytics|telemetry|log|metrics|ping|heartbeat|thumb|thumbnail|storyboard)\b/i.test(lower)) {
    return true;
  }

  return false;
}

function extractQualityHint(url) {
  const dim = url.match(/\/(\d{3,4}x\d{3,4})(?:\/|$|\?)/i);
  if (dim) return dim[1];
  const m = url.match(/(?:^|[\/_-])(2160p|1440p|1080p|720p|540p|480p|360p|240p|4k|hd)(?:[\/_.-]|$|\?)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

function classifyVideoUrl(url, contentType = '', sourceType = 'network') {
  if (isIgnoredNoiseUrl(url)) return null;

  const lower = url.toLowerCase();
  const pathOnly = lower.split('?')[0];
  const ct = (contentType || '').toLowerCase();

  // Se o servidor respondeu com texto puro ou HTML de erro para uma URL .mp4, ignora!
  if (ct && (ct.startsWith('text/plain') || ct.startsWith('text/html') || ct.includes('application/json')) && !/wistia/i.test(lower)) {
    if (pathOnly.endsWith('.mp4') || pathOnly.endsWith('.webm')) {
      deadUrlsCache.add(url);
      return null;
    }
  }

  const wistiaJsonMatch = url.match(/fast\.wistia\.(?:com|net)\/embed\/medias\/([a-z0-9]+)\.json/i);
  if (wistiaJsonMatch) {
    const mediaId = wistiaJsonMatch[1];
    return {
      url: `https://fast.wistia.net/embed/iframe/${mediaId}`,
      wistiaMediaId: mediaId,
      provider: 'Wistia',
      badgeColor: '#54bbff',
      category: 'embed',
      format: 'Wistia Player',
      isMasterPlaylist: true,
      qualityHint: null,
      thumbnailUrl: `https://fast.wistia.com/embed/medias/${mediaId}/swatch`,
      priority: 70
    };
  }

  const ytMatch = url.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) {
    const videoId = ytMatch[1];
    return {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      provider: 'YouTube',
      badgeColor: '#ef4444',
      category: 'embed',
      format: 'YouTube Vídeo',
      isMasterPlaylist: false,
      qualityHint: 'HD / 1080p',
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      priority: 95
    };
  }

  if (/embed-ssl\.wistia\.com\/deliveries\/[a-z0-9]+\.bin/i.test(url)) {
    return {
      url,
      provider: 'Wistia',
      badgeColor: '#54bbff',
      category: 'direct',
      format: 'Arquivo MP4',
      isMasterPlaylist: false,
      qualityHint: extractQualityHint(url) || 'MP4 Direto',
      priority: 100
    };
  }

  const isM3u8 =
    pathOnly.endsWith('.m3u8') ||
    /\.m3u8(\?|$)/i.test(lower) ||
    ct.includes('application/vnd.apple.mpegurl') ||
    ct.includes('application/x-mpegurl') ||
    ct.includes('audio/mpegurl');

  const isMpd =
    pathOnly.endsWith('.mpd') ||
    /\.mpd(\?|$)/i.test(lower) ||
    ct.includes('application/dash+xml');

  const directMatch = pathOnly.match(/\.(mp4|webm|mov|m4v|mkv|ogv)$/i);
  const isDirectVideoContentType =
    ct.startsWith('video/') &&
    !ct.includes('mp2t') &&
    !ct.includes('iso.segment') &&
    !ct.includes('webm; codecs=');

  let matchedProvider = null;
  for (const p of PROVIDER_PATTERNS) {
    if (p.regex.test(url)) {
      matchedProvider = p;
      break;
    }
  }

  if (isM3u8) {
    const isMaster = /master|playlist\.m3u8|main\.m3u8|manifest|index\.m3u8/i.test(pathOnly) && !/playlist-\d+p|video_\d+|audio_|sub_/i.test(pathOnly);
    return {
      url,
      provider: matchedProvider ? matchedProvider.name : 'Stream HLS',
      badgeColor: matchedProvider ? matchedProvider.badgeColor : '#10b981',
      category: 'stream',
      format: 'HLS (.m3u8 ➔ .mp4)',
      isMasterPlaylist: isMaster,
      qualityHint: extractQualityHint(url) || (isMaster ? 'Master / Auto' : null),
      priority: isMaster ? 96 : 92
    };
  }

  if (isMpd) {
    return {
      url,
      provider: matchedProvider ? matchedProvider.name : 'Stream DASH',
      badgeColor: matchedProvider ? matchedProvider.badgeColor : '#06b6d4',
      category: 'stream',
      format: 'DASH (.mpd)',
      isMasterPlaylist: true,
      qualityHint: extractQualityHint(url) || 'Manifesto',
      priority: 75
    };
  }

  if (/cdninstagram\.com|fbcdn\.net/i.test(lower) && (/(\/v\/|\/o1\/v\/|\.mp4)/i.test(lower) || ct.startsWith('video/'))) {
    const isIg = /cdninstagram\.com|instagram/i.test(lower);
    const clean = cleanMetaCdnVideoUrl(url);
    return {
      url: clean,
      provider: isIg ? 'Instagram' : 'Facebook',
      badgeColor: isIg ? '#e1306c' : '#1877f2',
      category: 'direct',
      format: 'Arquivo MP4',
      isMasterPlaylist: false,
      qualityHint: extractQualityHint(clean) || 'HD MP4',
      priority: 100
    };
  }

  if (directMatch || isDirectVideoContentType) {
    let cleanUrl = url;
    if (/[?&](bytestart|byteend|range)=/i.test(url)) {
      cleanUrl = cleanMetaCdnVideoUrl(url);
    }
    const ext = directMatch ? directMatch[1].toUpperCase() : 'MP4';
    return {
      url: cleanUrl,
      provider: matchedProvider ? matchedProvider.name : 'Vídeo Direto',
      badgeColor: matchedProvider ? matchedProvider.badgeColor : '#3b82f6',
      category: 'direct',
      format: `Arquivo ${ext}`,
      isMasterPlaylist: false,
      qualityHint: extractQualityHint(cleanUrl) || 'Download Direto',
      priority: 100
    };
  }

  if (matchedProvider && (sourceType === 'dom-iframe' || sourceType === 'dom-embed' || /\/embed\/|player\.vimeo\.com|tv\.pandavideo|spalla\.io\/player/i.test(url))) {
    const finalUrl = matchedProvider.extractEmbedUrl ? matchedProvider.extractEmbedUrl(url) : url;
    const wistiaMatch = finalUrl.match(/fast\.wistia\.(?:net|com)\/embed\/(?:iframe|medias)\/([a-z0-9]+)/i);
    return {
      url: finalUrl,
      wistiaMediaId: wistiaMatch ? wistiaMatch[1] : null,
      provider: matchedProvider.name,
      badgeColor: matchedProvider.badgeColor,
      category: 'embed',
      format: 'Player Embutido',
      isMasterPlaylist: true,
      qualityHint: null,
      priority: 68
    };
  }

  if (sourceType === 'dom-video') {
    return {
      url,
      provider: matchedProvider ? matchedProvider.name : 'Vídeo HTML5',
      badgeColor: matchedProvider ? matchedProvider.badgeColor : '#3b82f6',
      category: 'direct',
      format: 'Arquivo MP4',
      isMasterPlaylist: false,
      qualityHint: extractQualityHint(url) || 'MP4',
      priority: 98
    };
  }

  if (sourceType === 'dom-iframe') {
    return {
      url,
      provider: matchedProvider ? matchedProvider.name : 'Iframe de Vídeo',
      badgeColor: matchedProvider ? matchedProvider.badgeColor : '#8b5cf6',
      category: 'embed',
      format: 'Iframe Embutido',
      isMasterPlaylist: false,
      qualityHint: null,
      priority: 60
    };
  }

  return null;
}

// Verifica se um link .mp4 vindo do DOM realmente existe no servidor (evita exibir links 404/desativados como o fallback do Spalla)
async function verifyDirectUrlAlive(url, referer) {
  if (!url) return false;
  if (/twimg\.com|twitter\.com|x\.com|googlevideo\.com|youtube\.com|fbcdn\.net|cdninstagram\.com|instagram\.com|facebook\.com/i.test(url)) {
    return true;
  }
  if (deadUrlsCache.has(url)) return false;
  try {
    if (referer) await ensureRefererRule(url, referer);
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-127' }
    });
    if (!res.ok && res.status !== 206) {
      deadUrlsCache.add(url);
      return false;
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('text/plain') || ct.startsWith('text/html') || ct.includes('application/json') || ct.includes('application/xml')) {
      deadUrlsCache.add(url);
      return false;
    }
    return true;
  } catch {
    deadUrlsCache.add(url);
    return false;
  }
}

async function extractWistiaDirectMp4(tabId, mediaId, referer) {
  const cacheKey = `wistia_${tabId}_${mediaId}`;
  if (extractedEmbeds.has(cacheKey)) return;
  extractedEmbeds.add(cacheKey);

  try {
    const res = await fetch(`https://fast.wistia.com/embed/medias/${mediaId}.json`);
    if (!res.ok) return;
    const data = await res.json();
    const media = data && data.media;
    if (!media || !Array.isArray(media.assets)) return;

    const title = media.name || '';
    for (const asset of media.assets) {
      if (!asset.url) continue;
      const isMp4 = asset.ext === 'mp4' || asset.content_type === 'video/mp4' || /mp4/i.test(asset.type || '');
      if (isMp4 && asset.url.endsWith('.bin')) {
        const mp4Url = asset.url.replace(/\.bin(\?|$)/, '.mp4$1');
        const height = asset.height ? `${asset.height}P` : (asset.display_name || 'MP4');
        await registerDetectedVideo(tabId, {
          url: mp4Url,
          title,
          referer,
          sizeBytes: asset.size || null,
          qualityHint: height,
          providerOverride: 'Wistia MP4',
          contentType: 'video/mp4',
          sourceType: 'network-verified'
        });
      }
    }
  } catch {
    // Ignore
  }
}

const twitterTweetCache = new Map(); // tweetId -> resolved video items

function extractTweetIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/(?:x\.com|twitter\.com)\/(?:[^\/]+\/status|i\/status|status)\/(\d+)/i);
  return m ? m[1] : null;
}

async function resolveTwitterVideosByTweetId(tweetId) {
  if (!tweetId) return [];
  if (twitterTweetCache.has(tweetId)) {
    return twitterTweetCache.get(tweetId);
  }

  const results = [];
  const seenUrls = new Set();

  // 1. Tenta via API de Syndication oficial do X/Twitter (retorna todas as variantes MP4 com vídeo + áudio)
  try {
    const synRes = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=0`);
    if (synRes.ok) {
      const data = await synRes.json();
      const author = (data.user && (data.user.screen_name || data.user.name)) || 'x_video';
      const cleanText = (data.text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
      const baseTitle = cleanText ? `${author} - ${cleanText}` : `X_${author}_${tweetId}`;

      const mediaList = Array.isArray(data.mediaDetails) ? data.mediaDetails : [];
      mediaList.forEach((m, idx) => {
        if (m && m.video_info && Array.isArray(m.video_info.variants)) {
          const mp4Variants = m.video_info.variants
            .filter((v) => v && v.url && (v.content_type === 'video/mp4' || /\.mp4(\?|$)/i.test(v.url)))
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

          if (mp4Variants.length > 0) {
            const best = mp4Variants[0];
            const cleanUrl = best.url.split('?')[0];
            if (!seenUrls.has(cleanUrl)) {
              seenUrls.add(cleanUrl);
              const thumb = m.media_url_https || (m.video_info && m.video_info.poster_url) || null;
              let durFormatted = null;
              if (m.video_info && m.video_info.duration_millis) {
                const s = Math.round(m.video_info.duration_millis / 1000);
                const mins = Math.floor(s / 60);
                const secs = s % 60;
                durFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
              }
              results.push({
                url: best.url,
                title: mediaList.length > 1 ? `${baseTitle} (${idx + 1})` : baseTitle,
                qualityHint: extractQualityHint(best.url) || 'HD MP4',
                provider: 'X / Twitter MP4',
                thumbnailUrl: thumb,
                duration: durFormatted,
                mediaId: m.id_str || '',
                durationMs: (m.video_info && m.video_info.duration_millis) || 0,
                rawVariants: m.video_info.variants
              });
            }
          }
        }
      });

      if (results.length === 0 && data.video && Array.isArray(data.video.variants)) {
        const mp4Variants = data.video.variants
          .filter((v) => v && v.src && (v.type === 'video/mp4' || /\.mp4(\?|$)/i.test(v.src)))
          .reverse();
        if (mp4Variants.length > 0) {
          const best = mp4Variants[0];
          const cleanUrl = best.src.split('?')[0];
          if (!seenUrls.has(cleanUrl)) {
            seenUrls.add(cleanUrl);
            results.push({
              url: best.src,
              title: baseTitle,
              qualityHint: extractQualityHint(best.src) || 'HD MP4',
              provider: 'X / Twitter MP4',
              thumbnailUrl: data.video.poster || null
            });
          }
        }
      }
    }
  } catch {
    // Continua para o fallback
  }

  // 2. Fallback via api.vxtwitter.com (funciona inclusive para vídeos com restrição de idade/sensíveis)
  if (results.length === 0) {
    try {
      const vxRes = await fetch(`https://api.vxtwitter.com/i/status/${tweetId}`);
      if (vxRes.ok) {
        const data = await vxRes.json();
        const author = data.user_screen_name || data.user_name || 'x_video';
        const cleanText = (data.text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
        const baseTitle = cleanText ? `${author} - ${cleanText}` : `X_${author}_${tweetId}`;

        const extList = Array.isArray(data.media_extended) ? data.media_extended : [];
        extList.forEach((m, idx) => {
          if (m && m.url && (m.type === 'video' || m.type === 'gif' || /\.mp4(\?|$)/i.test(m.url))) {
            const cleanUrl = m.url.split('?')[0];
            if (!seenUrls.has(cleanUrl)) {
              seenUrls.add(cleanUrl);
              const qHint =
                m.size && m.size.width && m.size.height
                  ? `${m.size.width}x${m.size.height}`
                  : extractQualityHint(m.url) || 'HD MP4';
              const thumb = m.poster_url || m.thumbnail_url || null;
              let durFormatted = null;
              if (m.duration_millis) {
                const s = Math.round(m.duration_millis / 1000);
                const mins = Math.floor(s / 60);
                const secs = s % 60;
                durFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
              }
              results.push({
                url: m.url,
                title: extList.length > 1 ? `${baseTitle} (${idx + 1})` : baseTitle,
                qualityHint: qHint,
                provider: 'X / Twitter MP4',
                thumbnailUrl: thumb,
                duration: durFormatted
              });
            }
          }
        });
      }
    } catch {
      // Ignore
    }
  }

  if (results.length > 0) {
    twitterTweetCache.set(tweetId, results);
  }
  return results;
}

async function extractTwitterDirectMp4(tabId, tweetId, referer) {
  if (!tweetId) return [];
  const videos = await resolveTwitterVideosByTweetId(tweetId);
  if (tabId && tabId > 0 && videos.length > 0) {
    const media = videos.map((v) => {
      const author = (v.title || '').split(' - ')[0] || '';
      return {
        id: v.mediaId || xMediaIdFromUrl(v.url) || `t${tweetId}_${v.url.split('/').pop().split('?')[0]}`,
        tweetId,
        user: author.replace(/^X_/, ''),
        text: (v.title || '').split(' - ').slice(1).join(' - '),
        type: 'video',
        thumb: v.thumbnailUrl || '',
        durationMs: v.durationMs || 0,
        variants: Array.isArray(v.rawVariants) && v.rawVariants.length
          ? v.rawVariants.map((rv) => ({ url: rv.url || rv.src, content_type: rv.content_type || rv.type || '', bitrate: rv.bitrate || 0 }))
          : [{ url: v.url, content_type: 'video/mp4', bitrate: 0 }]
      };
    });
    await upsertXMedia(tabId, media, referer || `https://x.com/i/status/${tweetId}`, { onlyIfMissing: true });
  }
  return videos;
}

// ---------- Agrupamento de vídeos (uma entrada por vídeo, com todas as qualidades) ----------

function formatDurationSec(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

function xMediaIdFromUrl(url) {
  const m = String(url || '').match(/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\//i);
  return m ? m[1] : null;
}

function parseDimsFromUrl(url) {
  const m = String(url || '').match(/\/(\d{2,5})x(\d{2,5})\//);
  return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null;
}

function labelForDims(width, height, bitrate) {
  const shortSide = Math.min(width || 0, height || 0);
  if (shortSide) return `${shortSide}p`;
  if (bitrate) return `${Math.round(bitrate / 1000)} kbps`;
  return 'Auto';
}

function cleanTweetText(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}

async function upsertXMedia(tabId, mediaList, pageUrl, opts = {}) {
  if (!tabId || tabId < 0 || !Array.isArray(mediaList) || mediaList.length === 0) return;
  const map = await getTabMap(tabId);
  let changed = false;
  const now = Date.now();

  for (const m of mediaList) {
    if (!m || !m.id || !Array.isArray(m.variants)) continue;
    const key = `x_media_${m.id}`;
    const existing = map.get(key);
    if (existing && opts.onlyIfMissing) continue;

    const mp4s = m.variants.filter((v) => v && v.url && (/mp4/i.test(v.content_type || '') || /\.mp4(\?|$)/i.test(v.url)));
    const hls = m.variants.find((v) => v && v.url && (/mpegurl/i.test(v.content_type || '') || /\.m3u8(\?|$)/i.test(v.url)));

    const seenLabels = new Set();
    let variants = mp4s
      .map((v) => {
        const dims = parseDimsFromUrl(v.url) || (m.width && m.height && mp4s.length === 1 ? { width: m.width, height: m.height } : null);
        return {
          url: v.url,
          kind: 'mp4',
          width: dims ? dims.width : 0,
          height: dims ? dims.height : 0,
          bitrate: v.bitrate || 0,
          label: labelForDims(dims && dims.width, dims && dims.height, v.bitrate)
        };
      })
      .sort((a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate)
      .filter((v) => {
        if (seenLabels.has(v.label)) return false;
        seenLabels.add(v.label);
        return true;
      });

    if (variants.length === 0 && hls) {
      variants = [{ url: hls.url, kind: 'hls', width: 0, height: 0, bitrate: 0, label: 'Auto' }];
    }
    if (variants.length === 0) continue;

    const user = (m.user || '').replace(/^@/, '');
    const text = cleanTweetText(m.text);
    const autoTitle = user ? `@${user}${text ? ` - ${text}` : ''}` : text || `X_video_${m.id}`;
    const statusUrl = m.tweetId ? `https://x.com/${user || 'i'}/status/${m.tweetId}` : pageUrl || 'https://x.com/';
    const durationSec = m.durationMs ? m.durationMs / 1000 : (existing && existing.durationSec) || 0;

    map.set(key, {
      key,
      url: variants[0].url,
      provider: 'X / Twitter',
      badgeColor: '#1d9bf0',
      category: variants[0].kind === 'hls' ? 'stream' : 'direct',
      format: m.type === 'animated_gif' ? 'GIF ➔ MP4' : 'MP4',
      streamType: variants[0].kind === 'hls' ? 'HLS' : 'MP4',
      isMasterPlaylist: false,
      qualityHint: variants[0].label,
      priority: 100,
      title: (existing && existing.customTitle) || autoTitle,
      customTitle: (existing && existing.customTitle) || null,
      pageUrl: statusUrl,
      referer: 'https://x.com/',
      frameUrl: '',
      sizeBytes: null,
      sourceType: 'network-verified',
      detectedAt: existing ? existing.detectedAt : now,
      thumbnailUrl: m.thumb || (existing && existing.thumbnailUrl) || null,
      durationSec,
      duration: formatDurationSec(durationSec),
      variants,
      mediaId: m.id,
      tweetId: m.tweetId || (existing && existing.tweetId) || null
    });
    changed = true;

    // Remove entradas "cruas" de rede (master/variantes .m3u8 e .mp4) que pertencem a este mesmo vídeo
    for (const [k, v] of map) {
      if (k !== key && v && v.url && xMediaIdFromUrl(v.url) === String(m.id)) {
        map.delete(k);
      }
    }
  }

  if (changed) await saveTabMap(tabId, map);
}

async function upsertYouTubeMedia(tabId, ytData) {
  if (!tabId || tabId < 0 || !ytData || !ytData.videoId) return;
  const map = await getTabMap(tabId);
  const key = `yt_${ytData.videoId}`;
  const existing = map.get(key);

  const durationSec = ytData.durationSec || (existing && existing.durationSec) || 0;
  const duration = formatDurationSec(durationSec);
  const title = (existing && existing.customTitle) || ytData.title || (existing && existing.title) || 'Vídeo do YouTube';
  const thumbnailUrl = ytData.thumb || (existing && existing.thumbnailUrl) || `https://i.ytimg.com/vi/${ytData.videoId}/hqdefault.jpg`;
  const pageUrl = ytData.pageUrl || `https://www.youtube.com/watch?v=${ytData.videoId}`;

  if (ytData.hlsUrl) {
    const item = {
      key,
      url: ytData.hlsUrl,
      provider: 'YouTube',
      badgeColor: '#ef4444',
      category: 'stream',
      format: 'HLS',
      streamType: 'HLS',
      isMasterPlaylist: true,
      qualityHint: (existing && existing.qualityHint) || '1080p',
      priority: 100,
      title,
      customTitle: (existing && existing.customTitle) || null,
      pageUrl,
      referer: 'https://www.youtube.com/',
      frameUrl: '',
      sizeBytes: null,
      sourceType: 'network-verified',
      detectedAt: existing ? existing.detectedAt : Date.now(),
      thumbnailUrl,
      durationSec,
      duration,
      variants: (existing && existing.variants && existing.variants.length > 0) ? existing.variants : [
        { url: ytData.hlsUrl, kind: 'hls', label: '1080p', width: 1920, height: 1080 },
        { url: ytData.hlsUrl, kind: 'hls', label: '720p', width: 1280, height: 720 },
        { url: ytData.hlsUrl, kind: 'hls', label: '480p', width: 854, height: 480 },
        { url: ytData.hlsUrl, kind: 'hls', label: '360p', width: 640, height: 360 }
      ],
      videoId: ytData.videoId
    };

    map.set(key, item);

    // Remove entradas duplicadas "Vídeo detectado" da mesma aba
    for (const [k, v] of map) {
      if (k !== key && v && v.url && (v.url.includes('googlevideo.com/api/manifest') || v.url.includes('youtube.com/watch'))) {
        map.delete(k);
      }
    }

    await saveTabMap(tabId, map);
    enrichHlsItem(tabId, key).catch(() => {});
    return;
  }

  if (Array.isArray(ytData.directFormats) && ytData.directFormats.length > 0) {
    const variants = ytData.directFormats.map((f) => ({
      url: f.url,
      kind: 'mp4',
      label: f.qualityLabel,
      bitrate: f.bitrate
    }));

    const item = {
      key,
      url: variants[0].url,
      provider: 'YouTube',
      badgeColor: '#ef4444',
      category: 'direct',
      format: 'MP4',
      streamType: 'MP4',
      qualityHint: variants[0].label,
      priority: 100,
      title,
      customTitle: (existing && existing.customTitle) || null,
      pageUrl,
      referer: 'https://www.youtube.com/',
      sourceType: 'network-verified',
      detectedAt: existing ? existing.detectedAt : Date.now(),
      thumbnailUrl,
      durationSec,
      duration,
      variants,
      videoId: ytData.videoId
    };

    map.set(key, item);
    await saveTabMap(tabId, map);
  }
}

async function upsertMetaMedia(tabId, metaItem, pageUrl, pageTitle) {
  if (!tabId || tabId < 0 || !metaItem) return;

  const rawVariants = Array.isArray(metaItem.variants) ? metaItem.variants : [];
  const variants = rawVariants
    .filter((v) => v && v.url)
    .map((v) => ({
      url: cleanMetaCdnVideoUrl(v.url),
      kind: 'mp4',
      label: v.quality || (v.height ? `${v.height}p` : 'HD'),
      width: v.width || 0,
      height: v.height || 0
    }));

  if (variants.length === 0) return;

  const isFb = metaItem.platform === 'Facebook' || /facebook\.com|fbcdn\.net/i.test(pageUrl || '');
  const platform = isFb ? 'Facebook' : 'Instagram';
  const badgeColor = isFb ? '#1877f2' : '#e1306c';
  const mediaId = metaItem.id || metaItem.code || Math.random().toString(36).slice(2, 8);
  const key = `meta_${isFb ? 'fb' : 'ig'}_${mediaId}`;

  const map = await getTabMap(tabId);
  const existing = map.get(key);

  let title = metaItem.title;
  if (!title) {
    if (metaItem.user && metaItem.caption) {
      const cleanCap = metaItem.caption.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      title = `${platform} - @${metaItem.user}: ${cleanCap || 'Vídeo'}`;
    } else if (metaItem.user) {
      title = `${platform} - @${metaItem.user} (${metaItem.code || metaItem.id || 'Vídeo'})`;
    } else if (metaItem.caption) {
      title = `${platform} - ${metaItem.caption.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
    } else {
      title = (pageTitle && !pageTitle.toLowerCase().startsWith('instagram') && !pageTitle.toLowerCase().startsWith('facebook'))
        ? `${platform} - ${pageTitle.slice(0, 60)}`
        : `${platform} Vídeo (${metaItem.code || metaItem.id || 'Reel'})`;
    }
  }

  let durationFormatted = null;
  if (metaItem.duration && !isNaN(metaItem.duration) && metaItem.duration > 0) {
    const s = Math.round(metaItem.duration);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    durationFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  const bestVariant = variants[0];
  const item = {
    key,
    url: bestVariant.url,
    provider: `${platform} MP4`,
    badgeColor,
    category: 'direct',
    format: 'MP4',
    streamType: 'MP4',
    qualityHint: bestVariant.label || 'HD MP4',
    priority: 100,
    title,
    customTitle: (existing && existing.customTitle) || null,
    pageUrl: pageUrl || '',
    referer: pageUrl || (isFb ? 'https://www.facebook.com/' : 'https://www.instagram.com/'),
    sourceType: 'meta-hook',
    detectedAt: existing ? existing.detectedAt : Date.now(),
    thumbnailUrl: metaItem.thumbnailUrl || (existing && existing.thumbnailUrl) || null,
    duration: durationFormatted || (existing && existing.duration) || null,
    variants
  };

  map.set(key, item);

  // Remove entradas genéricas "Vídeo Direto" sem thumbnail que correspondam a esse mesmo vídeo no CDN
  for (const [k, v] of map) {
    if (k !== key && v && v.url && (/cdninstagram\.com|fbcdn\.net/i.test(v.url)) && (!v.thumbnailUrl || v.provider === 'Vídeo Direto')) {
      const cleanK = cleanMetaCdnVideoUrl(v.url);
      const cleanBest = cleanMetaCdnVideoUrl(bestVariant.url);
      if (cleanK.split('?')[0] === cleanBest.split('?')[0]) {
        map.delete(k);
      }
    }
  }

  await saveTabMap(tabId, map);
}

// ---------- Leitura de manifestos HLS (variantes + duração) ----------

const hlsInfoCache = new Map(); // url -> Promise<info|null>
const hlsChildKeysByTab = new Map(); // tabId -> Set(normalizedKey) de playlists filhas já agrupadas numa master

function resolveRelUrl(rel, base) {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

function sumExtinf(text) {
  let total = 0;
  const re = /#EXTINF:([\d.]+)/g;
  let m;
  while ((m = re.exec(text))) total += parseFloat(m[1]) || 0;
  return total;
}

function fetchHlsInfo(url, referer) {
  if (hlsInfoCache.has(url)) return hlsInfoCache.get(url);
  const p = (async () => {
    if (referer) await ensureRefererRule(url, referer);
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    if (!/#EXTM3U/.test(text)) return null;

    if (/#EXT-X-STREAM-INF/i.test(text)) {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const variants = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const next = lines[i + 1];
        if (!next || next.startsWith('#')) continue;
        const resM = lines[i].match(/RESOLUTION=(\d+)x(\d+)/i);
        const bwM = lines[i].match(/[^-]BANDWIDTH=(\d+)/i) || lines[i].match(/BANDWIDTH=(\d+)/i);
        const width = resM ? parseInt(resM[1], 10) : 0;
        const height = resM ? parseInt(resM[2], 10) : 0;
        const bitrate = bwM ? parseInt(bwM[1], 10) : 0;
        variants.push({
          url: resolveRelUrl(next, url),
          kind: 'hls',
          width,
          height,
          bitrate,
          label: labelForDims(width, height, bitrate),
          separateAudio: /AUDIO="/i.test(lines[i])
        });
      }
      variants.sort((a, b) => b.width * b.height - a.width * a.height || b.bitrate - a.bitrate);
      const seen = new Set();
      const unique = variants.filter((v) => (seen.has(v.label) ? false : (seen.add(v.label), true)));

      let durationSec = 0;
      if (unique.length > 0) {
        try {
          const vr = await fetch(unique[unique.length - 1].url);
          if (vr.ok) durationSec = sumExtinf(await vr.text());
        } catch {
          // Ignore
        }
      }
      return { master: true, variants: unique, allVariantUrls: variants.map((v) => v.url), durationSec };
    }

    const isLive = !/#EXT-X-ENDLIST/i.test(text);
    return { master: false, variants: [], durationSec: isLive ? 0 : sumExtinf(text), isLive };
  })().catch(() => null);
  hlsInfoCache.set(url, p);
  return p;
}

async function enrichHlsItem(tabId, key) {
  const map0 = await getTabMap(tabId);
  const item0 = map0.get(key);
  if (!item0 || item0.hlsEnriched) return;

  const info = await fetchHlsInfo(item0.url, item0.referer);
  const map = await getTabMap(tabId);
  const item = map.get(key);
  if (!item) return;
  item.hlsEnriched = true;

  if (info) {
    if (info.durationSec) {
      item.durationSec = info.durationSec;
      item.duration = formatDurationSec(info.durationSec);
    }
    if (info.isLive) item.isLive = true;
    if (info.master && info.variants.length > 0) {
      item.isMasterPlaylist = true;
      item.variants = info.variants;
      item.qualityHint = info.variants[0].label;

      let children = hlsChildKeysByTab.get(tabId);
      if (!children) {
        children = new Set();
        hlsChildKeysByTab.set(tabId, children);
      }
      for (const u of info.allVariantUrls) {
        const ck = getNormalizedKey(u);
        if (ck === key) continue;
        children.add(ck);
        const child = map.get(ck);
        if (child) {
          if (!item.thumbnailUrl && child.thumbnailUrl) item.thumbnailUrl = child.thumbnailUrl;
          if (!item.title && child.title) item.title = child.title;
          map.delete(ck);
        }
      }
    } else if (!info.master) {
      item.isMasterPlaylist = false;
      item.variants = [{ url: item.url, kind: 'hls', width: 0, height: 0, bitrate: 0, label: item.qualityHint && item.qualityHint !== 'Master / Auto' ? item.qualityHint : 'Auto' }];
    }
  }
  await saveTabMap(tabId, map);
}

function getNormalizedKey(url) {
  try {
    const u = new URL(url);
    const essentialParams = ['v', 'id', 'video', 'h', 'clip_id'];
    const kept = [];
    for (const k of essentialParams) {
      if (u.searchParams.has(k)) {
        kept.push(`${k}=${u.searchParams.get(k)}`);
      }
    }
    return `${u.origin}${u.pathname}${kept.length ? '?' + kept.join('&') : ''}`;
  } catch {
    return url;
  }
}

async function getTabMap(tabId) {
  if (tabVideosCache.has(tabId)) {
    return tabVideosCache.get(tabId);
  }
  const key = `tab_${tabId}`;
  try {
    const data = await chrome.storage.session.get(key);
    const map = new Map();
    if (data && Array.isArray(data[key])) {
      for (const item of data[key]) {
        map.set(item.key, item);
      }
    }
    tabVideosCache.set(tabId, map);
    return map;
  } catch {
    const map = new Map();
    tabVideosCache.set(tabId, map);
    return map;
  }
}

async function saveTabMap(tabId, map) {
  const key = `tab_${tabId}`;
  const arr = Array.from(map.values());
  try {
    await chrome.storage.session.set({ [key]: arr });
  } catch {
    // Ignore
  }
  updateBadge(tabId, arr.length);
}

function updateBadge(tabId, count) {
  if (tabId < 0) return;
  const text = count > 0 ? String(count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#6366f1' }).catch(() => {});
  }
}

async function removeDetectedVideo(tabId, url) {
  const map = await getTabMap(tabId);
  const key = getNormalizedKey(url);
  if (map.has(key)) {
    map.delete(key);
    await saveTabMap(tabId, map);
  }
}

async function registerDetectedVideo(tabId, rawItem) {
  if (!tabId || tabId < 0 || !rawItem || !rawItem.url) return;

  // Se o item for uma URL de post do X/Twitter, resolve o MP4 direto automaticamente
  const tweetIdFromUrl =
    extractTweetIdFromUrl(rawItem.url) ||
    extractTweetIdFromUrl(rawItem.pageUrl) ||
    extractTweetIdFromUrl(rawItem.referer);
  if (tweetIdFromUrl && /(?:x\.com|twitter\.com)\//i.test(rawItem.url)) {
    await extractTwitterDirectMp4(tabId, tweetIdFromUrl, rawItem.url);
    return;
  }

  const classification = classifyVideoUrl(
    rawItem.url,
    rawItem.contentType || '',
    rawItem.sourceType || 'network'
  );
  if (!classification) return;

  // X / Twitter: playlists de variante (avc1 / mp4a) nunca viram card; se o vídeo já foi agrupado, ignora a URL crua
  const xMid = xMediaIdFromUrl(classification.url);
  if (xMid) {
    if (/\/pl\/(?:avc1|mp4a|hvc1|hev1)\//i.test(classification.url)) return;
    const mapX = await getTabMap(tabId);
    if (mapX.has(`x_media_${xMid}`)) return;
  }

  // Playlists filhas de uma master já agrupada não viram card separado
  const childSet = hlsChildKeysByTab.get(tabId);
  if (childSet && childSet.has(getNormalizedKey(classification.url))) return;

  const referer = rawItem.referer || rawItem.pageUrl || '';

  // Se for um arquivo .mp4 vindo do DOM/script (não confirmado por resposta HTTP 200/206 de vídeo), verifica se o link não é 404
  const isTrustedCdn = /twimg\.com|twitter\.com|x\.com|googlevideo\.com|youtube\.com|fbcdn\.net|cdninstagram\.com|instagram\.com|facebook\.com/i.test(classification.url);
  if (classification.category === 'direct' && rawItem.sourceType !== 'network-verified' && !isTrustedCdn) {
    const alive = await verifyDirectUrlAlive(classification.url, referer);
    if (!alive) {
      await removeDetectedVideo(tabId, classification.url);
      return;
    }
  }

  const map = await getTabMap(tabId);
  const key = getNormalizedKey(classification.url);
  const existing = map.get(key);
  const now = Date.now();

  const merged = {
    key,
    url: classification.url,
    provider: rawItem.providerOverride || classification.provider,
    badgeColor: classification.badgeColor,
    category: classification.category,
    format: classification.format,
    isMasterPlaylist: classification.isMasterPlaylist,
    qualityHint: rawItem.qualityHint || classification.qualityHint || (existing && existing.qualityHint) || null,
    priority: classification.priority,
    title: (existing && existing.customTitle) || rawItem.title || (existing && existing.title) || '',
    customTitle: (existing && existing.customTitle) || null,
    pageUrl: rawItem.pageUrl || (existing && existing.pageUrl) || '',
    referer: referer || (existing && existing.referer) || '',
    frameUrl: rawItem.frameUrl || (existing && existing.frameUrl) || '',
    sizeBytes: rawItem.sizeBytes || (existing && existing.sizeBytes) || null,
    sourceType: existing ? existing.sourceType : (rawItem.sourceType || 'network'),
    detectedAt: existing ? existing.detectedAt : now,
    thumbnailUrl: rawItem.thumbnailUrl || classification.thumbnailUrl || (existing && existing.thumbnailUrl) || null,
    duration: rawItem.duration || (existing && existing.duration) || null
  };

  // Se não possui thumbnail definida, tenta derivar para YouTube ou Vimeo
  if (!merged.thumbnailUrl) {
    const ytM = merged.url.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (ytM) {
      merged.thumbnailUrl = `https://i.ytimg.com/vi/${ytM[1]}/hqdefault.jpg`;
    } else {
      const vimeoM = merged.url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
      if (vimeoM) {
        merged.thumbnailUrl = `https://vumbnail.com/${vimeoM[1]}.jpg`;
      }
    }
  }

  map.set(key, merged);
  await saveTabMap(tabId, map);

  if (classification.category === 'stream' || /\.m3u8(\?|$)/i.test(classification.url)) {
    enrichHlsItem(tabId, key).catch(() => {});
  }

  if (merged.referer && merged.category !== 'embed') {
    ensureRefererRule(merged.url, merged.referer);
  }

  if (classification.wistiaMediaId) {
    extractWistiaDirectMp4(tabId, classification.wistiaMediaId, merged.referer);
  }

  if (tweetIdFromUrl) {
    extractTwitterDirectMp4(tabId, tweetIdFromUrl, merged.referer);
  } else if (/video\.twimg\.com/i.test(classification.url)) {
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.url) {
        const tid = extractTweetIdFromUrl(tab.url);
        if (tid) extractTwitterDirectMp4(tabId, tid, tab.url);
      }
    });
  }
}

// 1. Intercepta cabeçalhos de envio
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;

    let referer = '';
    let origin = '';
    if (details.requestHeaders) {
      for (const h of details.requestHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'referer') referer = h.value;
        if (name === 'origin') origin = h.value;
      }
    }

    requestHeadersMap.set(details.requestId, {
      referer: referer || details.initiator || '',
      origin
    });

    const classification = classifyVideoUrl(details.url, '', 'network');
    // Para arquivos diretos (.mp4), aguardamos onHeadersReceived confirmar que o status HTTP é 200/206 e não 404!
    if (classification && classification.category !== 'direct') {
      registerDetectedVideo(details.tabId, {
        url: details.url,
        referer: referer || details.initiator || '',
        sourceType: 'network'
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// 2. Intercepta cabeçalhos de resposta
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;

    // Se o servidor respondeu com erro (403, 404, 500), marca como URL morta e remove se já estava na lista
    if (details.statusCode >= 400) {
      deadUrlsCache.add(details.url);
      removeDetectedVideo(details.tabId, details.url);
      return;
    }

    let contentType = '';
    let contentLength = null;

    if (details.responseHeaders) {
      for (const h of details.responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'content-type') contentType = h.value || '';
        if (name === 'content-length') {
          const parsed = parseInt(h.value, 10);
          if (!isNaN(parsed) && parsed > 0) contentLength = parsed;
        }
      }
    }

    const isMetaCdn = /cdninstagram\.com|fbcdn\.net/i.test(details.url);
    if (!isMetaCdn && !/[?&](bytestart|range)=\d+/i.test(details.url)) {
      if (contentLength !== null && contentLength < 250 * 1024 && contentType.startsWith('video/')) {
        return;
      }
    }

    const reqMeta = requestHeadersMap.get(details.requestId) || {};
    const classification = classifyVideoUrl(details.url, contentType, 'network');

    if (classification) {
      registerDetectedVideo(details.tabId, {
        url: details.url,
        contentType,
        sizeBytes: contentLength,
        referer: reqMeta.referer || details.initiator || '',
        sourceType: 'network-verified'
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    tabVideosCache.delete(tabId);
    chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
    updateBadge(tabId, 0);
  }
  const candidateUrl = changeInfo.url || (changeInfo.status === 'complete' && tab ? tab.url : '');
  const tweetId = extractTweetIdFromUrl(candidateUrl);
  if (tweetId) {
    extractTwitterDirectMp4(tabId, tweetId, candidateUrl);
  }
  const ytMatch = candidateUrl.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) {
    const videoId = ytMatch[1];
    registerDetectedVideo(tabId, {
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: tab && tab.title ? tab.title.replace(/ - YouTube$/, '') : 'Vídeo do YouTube',
      providerOverride: 'YouTube',
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      pageUrl: candidateUrl,
      sourceType: 'dom-video',
      qualityHint: 'HD / 1080p'
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVideosCache.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  if (message.action === 'ADD_X_MEDIA') {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    if (tabId && tabId > 0 && Array.isArray(message.media)) {
      (async () => {
        await upsertXMedia(tabId, message.media, message.pageUrl || (sender.tab && sender.tab.url) || '');
        sendResponse({ ok: true });
      })();
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (message.action === 'ADD_YOUTUBE_MEDIA') {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    if (tabId && tabId > 0 && message.data) {
      (async () => {
        await upsertYouTubeMedia(tabId, message.data);
        sendResponse({ ok: true });
      })();
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (message.action === 'REMOVE_TAB_VIDEO') {
    const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
    const key = message.key;
    if (tabId && key) {
      (async () => {
        const map = await getTabMap(tabId);
        if (map.has(key)) {
          map.delete(key);
          await saveTabMap(tabId, map);
        }
        sendResponse({ ok: true });
      })();
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (message.action === 'UPDATE_VIDEO_TITLE') {
    const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
    const { key, title } = message;
    if (tabId && key && typeof title === 'string') {
      (async () => {
        const map = await getTabMap(tabId);
        const item = map.get(key);
        if (item) {
          item.title = title.trim() || item.title;
          item.customTitle = title.trim();
          await saveTabMap(tabId, map);
        }
        sendResponse({ ok: true });
      })();
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (message.action === 'SELECT_VIDEO_VARIANT') {
    const tabId = message.tabId || (sender.tab ? sender.tab.id : null);
    const { key, variantUrl, qualityHint } = message;
    if (tabId && key && variantUrl) {
      (async () => {
        const map = await getTabMap(tabId);
        const item = map.get(key);
        if (item) {
          item.selectedVariantUrl = variantUrl;
          if (qualityHint) item.qualityHint = qualityHint;
          await saveTabMap(tabId, map);
        }
        sendResponse({ ok: true });
      })();
      return true;
    }
    sendResponse({ ok: false });
    return false;
  }

  if (message.action === 'ADD_DOM_VIDEOS') {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    if (!tabId || tabId < 0) {
      sendResponse({ ok: false });
      return false;
    }
    (async () => {
      const items = Array.isArray(message.videos) ? message.videos : [];
      for (const item of items) {
        await registerDetectedVideo(tabId, {
          ...item,
          frameUrl: sender.url || item.frameUrl || ''
        });
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'RESOLVE_TWITTER_VIDEO') {
    (async () => {
      const tweetId = message.tweetId || extractTweetIdFromUrl(message.url);
      if (!tweetId) {
        sendResponse({ ok: false, videos: [] });
        return;
      }
      const videos = await extractTwitterDirectMp4(message.tabId || null, tweetId, message.url || '');
      sendResponse({ ok: videos.length > 0, videos });
    })();
    return true;
  }

  if (message.action === 'GET_TAB_VIDEOS') {
    const tabId = message.tabId;
    (async () => {
      const map = await getTabMap(tabId);
      const list = Array.from(map.values()).sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.detectedAt - a.detectedAt;
      });
      sendResponse({ videos: list });
    })();
    return true;
  }

  if (message.action === 'CLEAR_TAB_VIDEOS') {
    const tabId = message.tabId;
    (async () => {
      tabVideosCache.delete(tabId);
      await chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
      updateBadge(tabId, 0);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'ENSURE_REFERER_RULE') {
    (async () => {
      await ensureRefererRule(message.targetUrl, message.refererUrl);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'ADD_META_MEDIA') {
    const tabId = sender.tab ? sender.tab.id : message.tabId;
    if (!tabId || tabId < 0) {
      sendResponse({ ok: false });
      return false;
    }
    (async () => {
      const items = Array.isArray(message.media) ? message.media : [];
      for (const item of items) {
        await upsertMetaMedia(tabId, item, message.pageUrl, message.pageTitle);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.action === 'START_DIRECT_DOWNLOAD') {
    (async () => {
      const { url, filename, referer, tabId } = message;
      const downloadTargetUrl = cleanMetaCdnVideoUrl(url);

      if (referer) {
        await ensureRefererRule(downloadTargetUrl, referer);
      }

      // Se não for blob: da própria extensão, verifica antes se o arquivo direto realmente existe no servidor.
      // Ignora probe sintético de Range em CDNs confiáveis (Twitter/X, YouTube, Meta/Instagram/Facebook) onde Range de SW pode falhar com CORS/403.
      const isTrustedCdn = /twimg\.com|twitter\.com|x\.com|googlevideo\.com|youtube\.com|fbcdn\.net|cdninstagram\.com|instagram\.com|facebook\.com/i.test(downloadTargetUrl);
      if (!downloadTargetUrl.startsWith('blob:') && !isTrustedCdn) {
        const alive = await verifyDirectUrlAlive(downloadTargetUrl, referer);
        if (!alive) {
          if (tabId) await removeDetectedVideo(tabId, url);
          sendResponse({
            ok: false,
            deadUrl: true,
            error: 'Arquivo direto indisponível no servidor (usando fallback HLS .m3u8)'
          });
          return;
        }
      }

      let finalName = (filename || 'video_capturado').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
      if (!/\.(mp4|webm|mov|mkv)$/i.test(finalName)) {
        finalName += '.mp4';
      }

      downloadFilenameByUrl.set(downloadTargetUrl, finalName);

      chrome.downloads.download(
        {
          url: downloadTargetUrl,
          filename: finalName,
          conflictAction: 'uniquify'
        },
        (downloadId) => {
          if (chrome.runtime.lastError || !downloadId) {
            sendResponse({
              ok: false,
              error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Falha ao iniciar download'
            });
          } else {
            downloadFilenameById.set(downloadId, finalName);
            sendResponse({ ok: true, downloadId, filename: finalName });
          }
        }
      );
    })();
    return true;
  }

  return false;
});
