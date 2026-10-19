// popup.js - Lógica do painel do Video Radar (com download garantido em .mp4 e Google Sync)

let currentTab = null;
let allVideos = [];
let syncedVideos = [];
let activeFilter = 'all';

const videoListEl = document.getElementById('videoList');
const pageHostEl = document.getElementById('pageHost');
const toastEl = document.getElementById('toast');

const countAllEl = document.getElementById('countAll');
const countEmbedEl = document.getElementById('countEmbed');
const countStreamEl = document.getElementById('countStream');
const countDirectEl = document.getElementById('countDirect');
const countSyncedEl = document.getElementById('countSynced');

function showToast(msg, duration = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
}

// Compacta os metadados do vídeo para caber na cota do chrome.storage.sync (8 KB por chave)
function compactVideoForSync(item) {
  return {
    url: String(item.url || '').slice(0, 900),
    title: String(item.title || 'Vídeo salvo').slice(0, 140),
    provider: item.provider || 'Vídeo',
    badgeColor: item.badgeColor || '#6366f1',
    category: item.category || 'stream',
    format: item.format || 'MP4',
    qualityHint: item.qualityHint || '',
    sizeBytes: item.sizeBytes || null,
    thumbnailUrl: String(item.thumbnailUrl || '').slice(0, 300),
    duration: String(item.duration || '').slice(0, 20),
    referer: String(item.referer || item.pageUrl || '').slice(0, 400),
    pageUrl: String(item.pageUrl || '').slice(0, 400),
    sourceType: item.sourceType || 'sync',
    savedAt: Date.now()
  };
}

function getPlatformIcon(provider) {
  const p = (provider || '').toLowerCase();
  if (p.includes('twitter') || p.includes('x /')) return '𝕏';
  if (p.includes('youtube')) return '▶';
  if (p.includes('vimeo')) return 'Ⓥ';
  if (p.includes('wistia')) return 'W';
  if (p.includes('panda')) return '🐼';
  return '🎬';
}

async function persistSyncedVideos(list) {
  const trimmed = list.slice(0, 15);
  while (trimmed.length > 1 && new Blob([JSON.stringify(trimmed)]).size > 7200) {
    trimmed.pop();
  }
  syncedVideos = trimmed;
  try {
    await chrome.storage.sync.set({ syncedVideos: trimmed });
  } catch {
    // Fallback se a cota de sync estiver cheia
  }
}

async function saveVideoToSync(item, silent = false) {
  if (!item || !item.url) return;
  const compact = compactVideoForSync(item);
  const filtered = syncedVideos.filter((v) => v.url !== compact.url);
  await persistSyncedVideos([compact, ...filtered]);
  renderList();
  if (!silent) {
    showToast('☁️ Salvo na Conta Google (sincronizado entre PCs)!');
  }
}

async function removeVideoFromSync(url) {
  const next = syncedVideos.filter((v) => v.url !== url);
  await persistSyncedVideos(next);
  renderList();
  showToast('Removido da sincronização.');
}

async function loadSyncedData() {
  try {
    const data = await chrome.storage.sync.get(['syncedVideos', 'radarPrefs']);
    if (Array.isArray(data.syncedVideos)) {
      syncedVideos = data.syncedVideos;
    }
    if (data.radarPrefs && data.radarPrefs.activeFilter) {
      activeFilter = data.radarPrefs.activeFilter;
      document.querySelectorAll('.tab').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-filter') === activeFilter);
      });
    }
  } catch {
    // Ignore sync errors
  }
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function sanitizeFilename(rawTitle) {
  const base = (rawTitle || 'video_capturado')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return base || 'video_capturado';
}

function buildYtDlpCommand(item) {
  const filename = sanitizeFilename(item.title);
  const ref = item.referer || item.pageUrl || '';

  if (/youtube\.com|youtu\.be/i.test(item.url)) {
    return `yt-dlp -f "bv*+ba/b" --merge-output-format mp4 -o "${filename}.%(ext)s" "${item.url}"`;
  }

  const parts = ['yt-dlp'];
  if (ref && ref.startsWith('http')) {
    parts.push(`--referer "${ref.replace(/"/g, '\\"')}"`);
  }
  parts.push('-N 8');
  parts.push('--merge-output-format mp4');
  parts.push(`-o "${filename}.%(ext)s"`);
  parts.push(`"${item.url}"`);

  return parts.join(' ');
}

function buildFfmpegCommand(item) {
  const filename = sanitizeFilename(item.title);
  const ref = item.referer || item.pageUrl || '';
  const parts = ['ffmpeg'];

  if (ref && ref.startsWith('http')) {
    parts.push(`-headers "Referer: ${ref.replace(/"/g, '\\"')}\\r\\n"`);
  }
  parts.push(`-i "${item.url}"`);
  parts.push('-c copy -bsf:a aac_adtstoasc');
  parts.push(`"${filename}.mp4"`);

  return parts.join(' ');
}

async function copyText(text, feedbackMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(feedbackMsg || 'Copiado!');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(feedbackMsg || 'Copiado!');
  }
}

function openHlsDownloader(url, title, referer) {
  const filename = sanitizeFilename(title);
  const downloaderUrl = chrome.runtime.getURL(
    `hls-downloader.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(filename)}&referer=${encodeURIComponent(referer || '')}&autostart=1`
  );
  chrome.tabs.create({ url: downloaderUrl });
}

function startBrowserMp4Download(url, title, referer) {
  const filename = `${sanitizeFilename(title)}.mp4`;
  showToast(`Verificando e iniciando download: ${filename}...`);
  chrome.runtime.sendMessage(
    {
      action: 'START_DIRECT_DOWNLOAD',
      url,
      filename,
      referer: referer || '',
      tabId: currentTab ? currentTab.id : null
    },
    (res) => {
      if (res && res.ok) {
        showToast(`✅ Baixando "${res.filename}"!`);
      } else if (res && res.deadUrl) {
        // Se o MP4 direto estava desativado/404 no servidor, usa automaticamente o stream HLS (.m3u8) da aba!
        allVideos = allVideos.filter((v) => v.url !== url);
        renderList();
        const fallbackStream = allVideos.find((v) => v.category === 'stream' && v.url.includes('.m3u8'));
        if (fallbackStream) {
          showToast('MP4 direto desativado no servidor. Baixando via Stream HLS (.m3u8 ➔ .mp4)...', 3500);
          openHlsDownloader(fallbackStream.url, title || fallbackStream.title, fallbackStream.referer || referer);
        } else {
          showToast('Esse link direto não está disponível no servidor. Use a opção de Stream (.m3u8).', 3500);
        }
      } else {
        showToast('Erro ao iniciar download direto.');
      }
    }
  );
}

// Tenta extrair .mp4 ou .m3u8 do código-fonte HTML de um player embutido (Vimeo, Panda, Bunny, etc.)
async function tryExtractStreamFromEmbedHtml(embedUrl, referer) {
  try {
    await chrome.runtime.sendMessage({
      action: 'ENSURE_REFERER_RULE',
      targetUrl: embedUrl,
      refererUrl: referer
    });
    const res = await fetch(embedUrl);
    if (!res.ok) return null;
    const html = (await res.text()).replace(/\\\//g, '/').replace(/\\u0026/g, '&');

    // 1. Procura MP4 progressivo no HTML do player
    const mp4Matches = html.match(/https?:\/\/[^\s"'<>\\]+\.mp4(?:\?[^\s"'<>\\]*)?/gi);
    if (mp4Matches) {
      const validMp4 = mp4Matches.find((u) => !/\/init\.mp4|\/seg-|\/segment/i.test(u));
      if (validMp4) return { type: 'direct', url: validMp4 };
    }

    // 2. Procura playlist .m3u8 no HTML do player
    const m3u8Matches = html.match(/https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi);
    if (m3u8Matches && m3u8Matches.length > 0) {
      return { type: 'stream', url: m3u8Matches[0] };
    }
  } catch {
    // Ignore fetch errors
  }
  return null;
}

async function handleDirectDownload(item) {
  const referer = item.referer || item.pageUrl || (currentTab ? currentTab.url : '');

  // 0. Se for YouTube (usa yt-dlp com resolução total + abre downloader web)
  if (/youtube\.com|youtu\.be/i.test(item.url)) {
    const cmd = buildYtDlpCommand(item);
    copyText(cmd, 'Comando yt-dlp copiado! Use no terminal para baixar em 1080p/4K com áudio.');
    showToast('YouTube: comando yt-dlp copiado! Abrindo opções de download direto...', 4000);
    chrome.tabs.create({ url: `https://cobalt.tools/` });
    return;
  }

  // 0.1 Se for uma playlist .m3u8 do X/Twitter (onde vídeo e áudio são separados), resolve e baixa o .mp4 direto com áudio!
  if (/video\.twimg\.com/i.test(item.url) && item.url.includes('.m3u8')) {
    const existingMp4 = allVideos.find((v) => v.category === 'direct' && /video\.twimg\.com/i.test(v.url));
    if (existingMp4) {
      startBrowserMp4Download(existingMp4.url, existingMp4.title || item.title, referer);
      return;
    }
    const candidateTweetUrl = item.pageUrl || item.referer || (currentTab ? currentTab.url : '');
    const tweetMatch = candidateTweetUrl.match(/(?:x\.com|twitter\.com)\/(?:[^\/]+\/status|i\/status|status)\/(\d+)/i);
    if (tweetMatch) {
      showToast('Extraindo MP4 completo (vídeo + áudio) do X/Twitter...', 3000);
      const res = await chrome.runtime.sendMessage({
        action: 'RESOLVE_TWITTER_VIDEO',
        tweetId: tweetMatch[1],
        url: candidateTweetUrl,
        tabId: currentTab ? currentTab.id : null
      });
      if (res && res.ok && Array.isArray(res.videos) && res.videos.length > 0) {
        const chosen = res.videos[0];
        startBrowserMp4Download(chosen.url, chosen.title || item.title, candidateTweetUrl);
        return;
      }
    }
  }

  // 1. Se for arquivo direto (.mp4, .webm, .bin do Wistia, etc.), baixa forçando .mp4 via background.js
  if (item.category === 'direct') {
    startBrowserMp4Download(item.url, item.title, referer);
    return;
  }

  // 2. Se for Stream HLS (.m3u8), abre nosso conversor/baixador integrado que gera .mp4 real
  if (item.url.includes('.m3u8') || item.format.includes('.m3u8')) {
    openHlsDownloader(item.url, item.title, referer);
    return;
  }

  // 3. Se o usuário clicou em "Baixar MP4" num card de Player Embutido (Iframe de Vimeo, Panda, Wistia, etc.)
  // Primeiro verifica se já temos um arquivo .mp4 ou stream .m3u8 capturado nesta mesma aba!
  const bestDirect = allVideos.find((v) => v.category === 'direct');
  if (bestDirect) {
    startBrowserMp4Download(bestDirect.url, item.title || bestDirect.title, bestDirect.referer || referer);
    return;
  }

  const bestStream = allVideos.find((v) => v.category === 'stream' && v.url.includes('.m3u8'));
  if (bestStream) {
    openHlsDownloader(bestStream.url, item.title || bestStream.title, bestStream.referer || referer);
    return;
  }

  // Se ainda não havia stream capturado, tenta extrair do HTML do iframe ou acionar o player automaticamente
  showToast('Extraindo stream de vídeo do player embutido...', 3500);
  const extracted = await tryExtractStreamFromEmbedHtml(item.url, referer);
  if (extracted) {
    if (extracted.type === 'direct') {
      startBrowserMp4Download(extracted.url, item.title, item.url);
    } else {
      openHlsDownloader(extracted.url, item.title, item.url);
    }
    return;
  }

  // Pede para o content script dar um rápido Play no vídeo da página para forçar a requisição de rede
  if (currentTab && currentTab.id) {
    chrome.tabs.sendMessage(currentTab.id, { action: 'AUTO_TRIGGER_PLAY' }).catch(() => {});
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: currentTab.id }, (res) => {
        allVideos = (res && Array.isArray(res.videos)) ? res.videos : [];
        renderList();
        const newDirect = allVideos.find((v) => v.category === 'direct');
        const newStream = allVideos.find((v) => v.category === 'stream' && v.url.includes('.m3u8'));
        if (newDirect) {
          startBrowserMp4Download(newDirect.url, item.title || newDirect.title, newDirect.referer || referer);
        } else if (newStream) {
          openHlsDownloader(newStream.url, item.title || newStream.title, newStream.referer || referer);
        } else {
          showToast('Dê Play no vídeo da página por 2 segundos e clique em Baixar MP4 novamente!', 4000);
        }
      });
    }, 1200);
  }
}

function updateCounts() {
  const embedCount = allVideos.filter((v) => v.category === 'embed').length;
  const streamCount = allVideos.filter((v) => v.category === 'stream').length;
  const directCount = allVideos.filter((v) => v.category === 'direct').length;

  countAllEl.textContent = allVideos.length;
  countEmbedEl.textContent = embedCount;
  countStreamEl.textContent = streamCount;
  countDirectEl.textContent = directCount;
  if (countSyncedEl) {
    countSyncedEl.textContent = syncedVideos.length;
  }
}

function renderList() {
  updateCounts();
  videoListEl.innerHTML = '';

  const isSyncedTab = activeFilter === 'synced';
  const filtered = isSyncedTab
    ? syncedVideos
    : allVideos.filter((v) => {
        if (activeFilter === 'all') return true;
        return v.category === activeFilter;
      });

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    if (isSyncedTab) {
      empty.innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
        </svg>
        <h3>Nenhum vídeo salvo no Google Sync</h3>
        <p>Clique em <strong>☁️ Sync</strong> em qualquer vídeo (ou baixe/copie um vídeo) para sincronizá-lo automaticamente entre seus computadores.</p>
      `;
    } else {
      empty.innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polygon points="10 8 16 12 10 16 10 8"></polygon>
        </svg>
        <h3>Nenhum vídeo detectado neste filtro</h3>
        <p>Dê <strong>Play</strong> no vídeo da página para interceptar streams (<code>.m3u8</code> / <code>.mp4</code>) ou clique no botão de atualizar no topo para re-escanear iframes.</p>
      `;
    }
    videoListEl.appendChild(empty);
    return;
  }

  filtered.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'video-card';

    const sizeLabel = formatBytes(item.sizeBytes);
    const isAlreadySynced = syncedVideos.some((s) => s.url === item.url);
    let refererHost = '';
    try {
      if (item.referer) refererHost = new URL(item.referer).hostname;
    } catch {
      refererHost = '';
    }

    const syncBtnHtml = isSyncedTab
      ? `<button class="mini-btn btn-sync-toggle" title="Remover este vídeo da nuvem (Google Sync)">🗑️ Remover</button>`
      : `<button class="mini-btn btn-sync-toggle ${isAlreadySynced ? 'synced-active' : ''}" title="${
          isAlreadySynced
            ? 'Já sincronizado na Conta Google (clique para remover)'
            : 'Salvar na Conta Google para acessar em outro computador'
        }">${isAlreadySynced ? '☁️ Salvo' : '☁️ Sync'}</button>`;

    const hasThumb = Boolean(item.thumbnailUrl);
    const thumbHtml = `
      <div class="thumb-container">
        ${hasThumb
          ? `<img class="thumb-img" src="${escapeHtml(item.thumbnailUrl)}" alt="Thumbnail" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
             <div class="thumb-placeholder" style="display: none;">
               <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <polygon points="5 3 19 12 5 21 5 3"></polygon>
               </svg>
             </div>`
          : `<div class="thumb-placeholder">
               <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <polygon points="5 3 19 12 5 21 5 3"></polygon>
               </svg>
             </div>`
        }
        <span class="thumb-platform-tag">${getPlatformIcon(item.provider)}</span>
        ${item.duration ? `<span class="thumb-duration">${escapeHtml(item.duration)}</span>` : ''}
      </div>
    `;

    card.innerHTML = `
      <div class="card-main-content">
        ${thumbHtml}
        <div class="card-details">
          <div class="card-top">
            <div class="badges">
              <span class="badge" style="background: ${item.badgeColor || '#6366f1'}">${escapeHtml(item.provider)}</span>
              <span class="badge badge-format">${escapeHtml(item.format)}</span>
              ${item.qualityHint ? `<span class="badge badge-quality">${escapeHtml(item.qualityHint)}</span>` : ''}
              ${sizeLabel ? `<span class="badge badge-format">${escapeHtml(sizeLabel)}</span>` : ''}
            </div>
            <div class="card-quick-icons">
              ${syncBtnHtml}
              ${!isSyncedTab ? `<button class="mini-btn btn-highlight" title="Destacar este player na página">🎯 Localizar</button>` : ''}
              <button class="mini-btn btn-open" title="Abrir endereço em nova aba">↗</button>
            </div>
          </div>

          <div class="video-title" title="${escapeHtml(item.title || 'Vídeo sem título')}">
            ${escapeHtml(item.title || 'Vídeo detectado na página')}
          </div>

          <div class="url-box" title="Clique para selecionar a URL completa">${escapeHtml(item.url)}</div>

          <div class="meta-row">
            <span>Origem: <strong>${
              isSyncedTab
                ? '☁️ Conta Google (Sync)'
                : item.sourceType === 'network' || item.sourceType === 'network-verified'
                ? 'Tráfego de Rede'
                : 'Iframe / DOM'
            }</strong></span>
            ${refererHost ? `<span>Referer: <strong>${escapeHtml(refererHost)}</strong></span>` : ''}
          </div>
        </div>
      </div>

      <div class="actions-row">
        <button class="btn btn-primary btn-download" title="Baixar vídeo em formato .MP4">⬇️ Baixar .MP4</button>
        <button class="btn btn-ytdlp" title="Copiar comando completo do yt-dlp com Referer">💻 yt-dlp</button>
        <button class="btn btn-ffmpeg" title="Copiar comando completo do ffmpeg com Referer">🎬 ffmpeg</button>
        <button class="btn btn-copy-url" title="Copiar apenas o link do vídeo/player">📋 Link</button>
      </div>
    `;

    card.querySelector('.btn-download').addEventListener('click', () => {
      saveVideoToSync(item, true);
      handleDirectDownload(item);
    });
    card.querySelector('.btn-ytdlp').addEventListener('click', () => {
      saveVideoToSync(item, true);
      copyText(buildYtDlpCommand(item), 'Comando yt-dlp copiado e salvo no Sync!');
    });
    card.querySelector('.btn-ffmpeg').addEventListener('click', () => {
      saveVideoToSync(item, true);
      copyText(buildFfmpegCommand(item), 'Comando ffmpeg copiado e salvo no Sync!');
    });
    card.querySelector('.btn-copy-url').addEventListener('click', () => {
      copyText(item.url, 'URL do vídeo copiada!');
    });
    card.querySelector('.btn-open').addEventListener('click', () => {
      chrome.tabs.create({ url: item.url });
    });
    card.querySelector('.btn-sync-toggle').addEventListener('click', () => {
      if (isSyncedTab || isAlreadySynced) {
        removeVideoFromSync(item.url);
      } else {
        saveVideoToSync(item, false);
      }
    });

    const highlightBtn = card.querySelector('.btn-highlight');
    if (highlightBtn) {
      highlightBtn.addEventListener('click', () => {
        if (currentTab && currentTab.id) {
          chrome.tabs.sendMessage(currentTab.id, { action: 'HIGHLIGHT_VIDEO', url: item.url }).catch(() => {});
          showToast('Vídeo destacado na página!');
        }
      });
    }

    videoListEl.appendChild(card);
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadTabVideos() {
  await loadSyncedData();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTab = tab;

  try {
    const u = new URL(tab.url);
    pageHostEl.textContent = u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    pageHostEl.textContent = tab.title || 'Aba atual';
  }

  chrome.tabs.sendMessage(tab.id, { action: 'RESCAN_DOM' }).catch(() => {});

  // Se a aba atual já for um post de vídeo do X/Twitter, solicita extração imediata do MP4 direto
  const tabTweetMatch = (tab.url || '').match(/(?:x\.com|twitter\.com)\/(?:[^\/]+\/status|i\/status|status)\/(\d+)/i);
  if (tabTweetMatch) {
    chrome.runtime.sendMessage(
      {
        action: 'RESOLVE_TWITTER_VIDEO',
        tweetId: tabTweetMatch[1],
        url: tab.url,
        tabId: tab.id
      },
      () => {
        chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: tab.id }, (res) => {
          allVideos = (res && Array.isArray(res.videos)) ? res.videos : [];
          renderList();
        });
      }
    );
  }

  setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: tab.id }, (res) => {
      allVideos = (res && Array.isArray(res.videos)) ? res.videos : [];
      if (activeFilter === 'synced' && syncedVideos.length === 0 && allVideos.length > 0) {
        activeFilter = 'all';
        document.querySelectorAll('.tab').forEach((b) => {
          b.classList.toggle('active', b.getAttribute('data-filter') === 'all');
        });
      }
      renderList();
    });
  }, 150);
}

async function handleCustomUrlDownload() {
  const inputEl = document.getElementById('customUrlInput');
  const btnEl = document.getElementById('btnDownloadCustomUrl');
  const rawUrl = (inputEl ? inputEl.value : '').trim();

  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    showToast('Cole um link válido começando com http:// ou https://');
    if (inputEl) inputEl.focus();
    return;
  }

  const defaultReferer = currentTab && currentTab.url && /^https?:\/\//i.test(currentTab.url) ? currentTab.url : rawUrl;
  const fallbackTitle = (currentTab && currentTab.title) || 'video_baixado';

  if (btnEl) btnEl.disabled = true;

  try {
    // 1. Link de post/vídeo do X / Twitter (ex: https://x.com/user/status/123456789/video/1)
    const tweetMatch = rawUrl.match(/(?:x\.com|twitter\.com)\/(?:[^\/]+\/status|i\/status|status)\/(\d+)(?:\/video\/(\d+))?/i);
    if (tweetMatch) {
      const tweetId = tweetMatch[1];
      const videoIndex = tweetMatch[2] ? Math.max(0, parseInt(tweetMatch[2], 10) - 1) : 0;
      showToast('Extraindo vídeo MP4 do X / Twitter...', 3500);

      const res = await chrome.runtime.sendMessage({
        action: 'RESOLVE_TWITTER_VIDEO',
        tweetId,
        url: rawUrl,
        tabId: currentTab ? currentTab.id : null
      });

      if (res && res.ok && Array.isArray(res.videos) && res.videos.length > 0) {
        const chosen = res.videos[videoIndex] || res.videos[0];
        await saveVideoToSync(
          {
            url: chosen.url,
            title: chosen.title,
            provider: chosen.provider || 'X / Twitter MP4',
            badgeColor: '#1d9bf0',
            category: 'direct',
            format: 'Arquivo MP4',
            qualityHint: chosen.qualityHint || 'HD MP4',
            referer: rawUrl,
            pageUrl: rawUrl
          },
          true
        );
        if (currentTab && currentTab.id) {
          chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: currentTab.id }, (tabRes) => {
            allVideos = (tabRes && Array.isArray(tabRes.videos)) ? tabRes.videos : allVideos;
            renderList();
          });
        }
        inputEl.value = '';
        startBrowserMp4Download(chosen.url, chosen.title, rawUrl);
      } else {
        showToast('Não foi possível extrair o vídeo deste link do X.', 3500);
      }
      return;
    }

    // 1.5. Link do YouTube (watch, shorts, youtu.be, embed)
    const ytMatch = rawUrl.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?.*v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (ytMatch) {
      const videoId = ytMatch[1];
      showToast('Obtendo dados do vídeo do YouTube...', 2500);
      let ytTitle = fallbackTitle;
      try {
        const oeRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
        if (oeRes.ok) {
          const oeData = await oeRes.json();
          if (oeData && oeData.title) ytTitle = oeData.title;
        }
      } catch {
        // Ignore fetch error
      }

      const ytItem = {
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: ytTitle,
        provider: 'YouTube',
        badgeColor: '#ef4444',
        category: 'direct',
        format: 'YouTube MP4',
        qualityHint: 'HD / 1080p',
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        referer: rawUrl,
        pageUrl: rawUrl
      };

      await saveVideoToSync(ytItem, true);
      if (currentTab && currentTab.id) {
        chrome.runtime.sendMessage(
          {
            action: 'ADD_DOM_VIDEOS',
            tabId: currentTab.id,
            videos: [ytItem]
          },
          () => {
            chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: currentTab.id }, (tabRes) => {
              allVideos = (tabRes && Array.isArray(tabRes.videos)) ? tabRes.videos : allVideos;
              renderList();
            });
          }
        );
      }
      inputEl.value = '';
      handleDirectDownload(ytItem);
      return;
    }

    // 2. Link de Stream HLS (.m3u8)
    if (/\.m3u8(\?|$)/i.test(rawUrl)) {
      await saveVideoToSync(
        {
          url: rawUrl,
          title: fallbackTitle,
          provider: 'Stream HLS',
          badgeColor: '#10b981',
          category: 'stream',
          format: 'HLS (.m3u8 ➔ .mp4)',
          referer: defaultReferer,
          pageUrl: rawUrl
        },
        true
      );
      inputEl.value = '';
      openHlsDownloader(rawUrl, fallbackTitle, defaultReferer);
      return;
    }

    // 3. Link direto de vídeo (.mp4, .webm, .mov, .m4v, .mkv)
    if (/\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(rawUrl)) {
      await saveVideoToSync(
        {
          url: rawUrl,
          title: fallbackTitle,
          provider: 'Vídeo Direto',
          badgeColor: '#3b82f6',
          category: 'direct',
          format: 'Arquivo MP4',
          referer: defaultReferer,
          pageUrl: rawUrl
        },
        true
      );
      inputEl.value = '';
      startBrowserMp4Download(rawUrl, fallbackTitle, defaultReferer);
      return;
    }

    // 4. Outros links (Vimeo, Panda, Wistia, Bunny, páginas com vídeo embutido)
    showToast('Analisando link para extrair o vídeo...', 3000);
    const extracted = await tryExtractStreamFromEmbedHtml(rawUrl, defaultReferer);
    if (extracted) {
      inputEl.value = '';
      if (extracted.type === 'direct') {
        startBrowserMp4Download(extracted.url, fallbackTitle, rawUrl);
      } else {
        openHlsDownloader(extracted.url, fallbackTitle, rawUrl);
      }
      return;
    }

    showToast('Não foi encontrado link direto (.mp4/.m3u8) nesse endereço.', 3500);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

document.getElementById('btnDownloadCustomUrl').addEventListener('click', handleCustomUrlDownload);
document.getElementById('customUrlInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleCustomUrlDownload();
  }
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.getAttribute('data-filter') || 'all';
    chrome.storage.sync.set({ radarPrefs: { activeFilter } }).catch(() => {});
    renderList();
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.syncedVideos) {
    syncedVideos = Array.isArray(changes.syncedVideos.newValue) ? changes.syncedVideos.newValue : [];
    renderList();
  }
});

document.getElementById('btnRescan').addEventListener('click', async () => {
  if (!currentTab) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: currentTab.id, allFrames: true },
      files: ['content.js']
    });
  } catch {
    // Ignore
  }
  chrome.tabs.sendMessage(currentTab.id, { action: 'RESCAN_DOM' }).catch(() => {});
  setTimeout(loadTabVideos, 300);
  showToast('Página e iframes re-escaneados!');
});

document.getElementById('btnClear').addEventListener('click', async () => {
  if (activeFilter === 'synced') {
    await persistSyncedVideos([]);
    renderList();
    showToast('Lista sincronizada limpa!');
    return;
  }
  if (!currentTab) return;
  chrome.runtime.sendMessage({ action: 'CLEAR_TAB_VIDEOS', tabId: currentTab.id }, () => {
    allVideos = [];
    renderList();
    showToast('Lista limpa!');
  });
});

document.addEventListener('DOMContentLoaded', loadTabVideos);
