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

const PROVIDER_PATTERNS = [
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

  if (lower.includes('googlevideo.com/videoplayback')) {
    return true;
  }
  if (/[?&](range|bytestart|byteend)=\d+/i.test(lower) && !/\.mp4(\?|$)/i.test(lower)) {
    return true;
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

  if (directMatch || isDirectVideoContentType) {
    let cleanUrl = url.replace(/([?&])(bytestart|byteend|range)=[^&]+(&|$)/gi, '$1').replace(/[?&]$/, '');
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
                duration: durFormatted
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
  if (tabId && tabId > 0) {
    for (const v of videos) {
      await registerDetectedVideo(tabId, {
        url: v.url,
        title: v.title,
        referer: referer || `https://x.com/i/status/${tweetId}`,
        pageUrl: referer || `https://x.com/i/status/${tweetId}`,
        qualityHint: v.qualityHint,
        providerOverride: v.provider,
        contentType: 'video/mp4',
        thumbnailUrl: v.thumbnailUrl || null,
        duration: v.duration || null,
        sourceType: 'network-verified'
      });
    }
  }
  return videos;
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

  const referer = rawItem.referer || rawItem.pageUrl || '';

  // Se for um arquivo .mp4 vindo do DOM/script (não confirmado por resposta HTTP 200/206 de vídeo), verifica se o link não é 404
  if (classification.category === 'direct' && rawItem.sourceType !== 'network-verified') {
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
    title: rawItem.title || (existing && existing.title) || '',
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

    if (contentLength !== null && contentLength < 250 * 1024 && contentType.startsWith('video/')) {
      return;
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

  if (message.action === 'START_DIRECT_DOWNLOAD') {
    (async () => {
      const { url, filename, referer, tabId } = message;
      if (referer) {
        await ensureRefererRule(url, referer);
      }

      // Se não for blob: da própria extensão, verifica antes se o arquivo direto realmente existe no servidor
      if (!url.startsWith('blob:')) {
        const alive = await verifyDirectUrlAlive(url, referer);
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

      downloadFilenameByUrl.set(url, finalName);

      chrome.downloads.download(
        {
          url,
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
