// popup.js - Lógica do painel do Video Radar (com download garantido em .mp4)

let currentTab = null;
let allVideos = [];
let activeFilter = 'all';

const videoListEl = document.getElementById('videoList');
const pageHostEl = document.getElementById('pageHost');
const toastEl = document.getElementById('toast');

const countAllEl = document.getElementById('countAll');
const countEmbedEl = document.getElementById('countEmbed');
const countStreamEl = document.getElementById('countStream');
const countDirectEl = document.getElementById('countDirect');

function showToast(msg, duration = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
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
}

function renderList() {
  updateCounts();
  videoListEl.innerHTML = '';

  const filtered = allVideos.filter((v) => {
    if (activeFilter === 'all') return true;
    return v.category === activeFilter;
  });

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <polygon points="10 8 16 12 10 16 10 8"></polygon>
      </svg>
      <h3>Nenhum vídeo detectado neste filtro</h3>
      <p>Dê <strong>Play</strong> no vídeo da página para interceptar streams (<code>.m3u8</code> / <code>.mp4</code>) ou clique no botão de atualizar no topo para re-escanear iframes.</p>
    `;
    videoListEl.appendChild(empty);
    return;
  }

  filtered.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'video-card';

    const sizeLabel = formatBytes(item.sizeBytes);
    let refererHost = '';
    try {
      if (item.referer) refererHost = new URL(item.referer).hostname;
    } catch {
      refererHost = '';
    }

    card.innerHTML = `
      <div class="card-top">
        <div class="badges">
          <span class="badge" style="background: ${item.badgeColor || '#6366f1'}">${escapeHtml(item.provider)}</span>
          <span class="badge badge-format">${escapeHtml(item.format)}</span>
          ${item.qualityHint ? `<span class="badge badge-quality">${escapeHtml(item.qualityHint)}</span>` : ''}
          ${sizeLabel ? `<span class="badge badge-format">${escapeHtml(sizeLabel)}</span>` : ''}
        </div>
        <div class="card-quick-icons">
          <button class="mini-btn btn-highlight" title="Destacar este player na página">🎯 Localizar</button>
          <button class="mini-btn btn-open" title="Abrir endereço em nova aba">↗</button>
        </div>
      </div>

      <div class="video-title" title="${escapeHtml(item.title || 'Vídeo sem título')}">
        ${escapeHtml(item.title || 'Vídeo detectado na página')}
      </div>

      <div class="url-box" title="Clique para selecionar a URL completa">${escapeHtml(item.url)}</div>

      <div class="meta-row">
        <span>Origem: <strong>${item.sourceType === 'network' ? 'Tráfego de Rede' : 'Iframe / DOM'}</strong></span>
        ${refererHost ? `<span>Referer: <strong>${escapeHtml(refererHost)}</strong></span>` : ''}
      </div>

      <div class="actions-row">
        <button class="btn btn-primary btn-download" title="Baixar vídeo em formato .MP4">⬇️ Baixar .MP4</button>
        <button class="btn btn-ytdlp" title="Copiar comando completo do yt-dlp com Referer">💻 yt-dlp</button>
        <button class="btn btn-ffmpeg" title="Copiar comando completo do ffmpeg com Referer">🎬 ffmpeg</button>
        <button class="btn btn-copy-url" title="Copiar apenas o link do vídeo/player">📋 Link</button>
      </div>
    `;

    card.querySelector('.btn-download').addEventListener('click', () => handleDirectDownload(item));
    card.querySelector('.btn-ytdlp').addEventListener('click', () => {
      copyText(buildYtDlpCommand(item), 'Comando yt-dlp copiado!');
    });
    card.querySelector('.btn-ffmpeg').addEventListener('click', () => {
      copyText(buildFfmpegCommand(item), 'Comando ffmpeg copiado!');
    });
    card.querySelector('.btn-copy-url').addEventListener('click', () => {
      copyText(item.url, 'URL do vídeo copiada!');
    });
    card.querySelector('.btn-open').addEventListener('click', () => {
      chrome.tabs.create({ url: item.url });
    });
    card.querySelector('.btn-highlight').addEventListener('click', () => {
      if (currentTab && currentTab.id) {
        chrome.tabs.sendMessage(currentTab.id, { action: 'HIGHLIGHT_VIDEO', url: item.url }).catch(() => {});
        showToast('Vídeo destacado na página!');
      }
    });

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

  setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: tab.id }, (res) => {
      allVideos = (res && Array.isArray(res.videos)) ? res.videos : [];
      renderList();
    });
  }, 150);
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.getAttribute('data-filter') || 'all';
    renderList();
  });
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

document.getElementById('btnClear').addEventListener('click', () => {
  if (!currentTab) return;
  chrome.runtime.sendMessage({ action: 'CLEAR_TAB_VIDEOS', tabId: currentTab.id }, () => {
    allVideos = [];
    renderList();
    showToast('Lista limpa!');
  });
});

document.addEventListener('DOMContentLoaded', loadTabVideos);
