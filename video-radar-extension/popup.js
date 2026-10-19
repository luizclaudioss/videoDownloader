// popup.js - Lógica visual e funcional do Video Radar
// Design idêntico ao Video DownloadHelper com suporte a thumbnails, resoluções, HLS, MP4 e Google Sync.

let currentTab = null;
let allVideos = [];
let syncedVideos = [];
let activeFilter = 'all'; // 'all' ou 'synced'
let currentEditingItem = null;
let activeDropdownEl = null;

// Elementos DOM principais
const videoListEl = document.getElementById('videoList');
const pageHostEl = document.getElementById('pageHost');
const toastEl = document.getElementById('toast');

const btnToggleUrlInput = document.getElementById('btnToggleUrlInput');
const quickUrlDrawer = document.getElementById('quickUrlDrawer');
const customUrlInput = document.getElementById('customUrlInput');
const btnDownloadCustomUrl = document.getElementById('btnDownloadCustomUrl');
const btnRescan = document.getElementById('btnRescan');

// Barra inferior (Footer)
const btnFooterSettings = document.getElementById('btnFooterSettings');
const btnNoVideoHelp = document.getElementById('btnNoVideoHelp');
const btnFooterSync = document.getElementById('btnFooterSync');
const btnOpenDownloadsFolder = document.getElementById('btnOpenDownloadsFolder');
const btnClearAll = document.getElementById('btnClearAll');
const btnFooterHelp = document.getElementById('btnFooterHelp');
const btnOpenInTab = document.getElementById('btnOpenInTab');

// Modais
const renameModal = document.getElementById('renameModal');
const renameInput = document.getElementById('renameInput');
const btnRenameClose = document.getElementById('btnRenameClose');
const btnRenameCancel = document.getElementById('btnRenameCancel');
const btnRenameSave = document.getElementById('btnRenameSave');

const helpModal = document.getElementById('helpModal');
const btnHelpClose = document.getElementById('btnHelpClose');
const btnHelpActionRescan = document.getElementById('btnHelpActionRescan');

function showToast(msg, duration = 2600) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, duration);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeFilename(rawTitle) {
  const base = (rawTitle || 'video_capturado')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return base || 'video_capturado';
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

function getPlatformIcon(provider) {
  const p = (provider || '').toLowerCase();
  if (p.includes('twitter') || p.includes('x /') || p === 'x') return '𝕏';
  if (p.includes('youtube')) return '▶';
  if (p.includes('vimeo')) return 'Ⓥ';
  if (p.includes('wistia')) return 'W';
  if (p.includes('panda')) return '🐼';
  if (p.includes('spalla')) return '⚡';
  if (p.includes('hotmart')) return '🔥';
  if (p.includes('loom')) return 'L';
  if (p.includes('vidyard')) return 'V';
  return '🎬';
}

// Compacta os metadados do vídeo para caber na cota do chrome.storage.sync (8 KB por chave)
function compactVideoForSync(item) {
  return {
    key: item.key || `sync_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    url: String(item.url || '').slice(0, 900),
    title: String(item.title || 'Vídeo salvo').slice(0, 140),
    provider: item.provider || 'Vídeo',
    badgeColor: item.badgeColor || '#0284c7',
    category: item.category || 'stream',
    format: item.format || 'MP4',
    streamType: item.streamType || (item.url && item.url.includes('.m3u8') ? 'HLS' : 'MP4'),
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

async function persistSyncedVideos(list) {
  const trimmed = list.slice(0, 20);
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
    showToast('☁️ Salvo na Conta Google (sincronizado)!');
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
  } catch {
    // Ignore sync errors
  }
}

function buildYtDlpCommand(item) {
  const filename = sanitizeFilename(item.title);
  const ref = item.referer || item.pageUrl || '';
  const targetUrl = item.selectedVariantUrl || item.url;

  if (/youtube\.com|youtu\.be/i.test(targetUrl)) {
    return `yt-dlp -f "bv*+ba/b" --merge-output-format mp4 -o "${filename}.%(ext)s" "${targetUrl}"`;
  }

  const parts = ['yt-dlp'];
  if (ref && ref.startsWith('http')) {
    parts.push(`--referer "${ref.replace(/"/g, '\\"')}"`);
  }
  parts.push('-N 8');
  parts.push('--merge-output-format mp4');
  parts.push(`-o "${filename}.%(ext)s"`);
  parts.push(`"${targetUrl}"`);

  return parts.join(' ');
}

function buildFfmpegCommand(item) {
  const filename = sanitizeFilename(item.title);
  const ref = item.referer || item.pageUrl || '';
  const targetUrl = item.selectedVariantUrl || item.url;
  const parts = ['ffmpeg'];

  if (ref && ref.startsWith('http')) {
    parts.push(`-headers "Referer: ${ref.replace(/"/g, '\\"')}\\r\\n"`);
  }
  parts.push(`-i "${targetUrl}"`);
  parts.push('-c copy -bsf:a aac_adtstoasc');
  parts.push(`"${filename}.mp4"`);

  return parts.join(' ');
}

async function copyText(text, feedbackMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(feedbackMsg || 'Copiado para a área de transferência!');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast(feedbackMsg || 'Copiado para a área de transferência!');
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
  showToast(`Iniciando download: ${filename}...`);
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
        // Se o MP4 direto não estava disponível, tenta fallback HLS
        allVideos = allVideos.filter((v) => v.url !== url);
        renderList();
        const fallbackStream = allVideos.find((v) => v.category === 'stream' && v.url.includes('.m3u8'));
        if (fallbackStream) {
          showToast('MP4 direto indisponível. Baixando via Stream HLS (.m3u8 ➔ .mp4)...', 3500);
          openHlsDownloader(fallbackStream.url, title || fallbackStream.title, fallbackStream.referer || referer);
        } else {
          showToast('Esse link direto expirou no servidor. Use a opção de Stream (.m3u8).', 3500);
        }
      } else {
        showToast('Erro ao iniciar download direto.');
      }
    }
  );
}

// Tenta extrair .mp4 ou .m3u8 do código-fonte HTML de um player embutido
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

    const mp4Matches = html.match(/https?:\/\/[^\s"'<>\\]+\.mp4(?:\?[^\s"'<>\\]*)?/gi);
    if (mp4Matches) {
      const validMp4 = mp4Matches.find((u) => !/\/init\.mp4|\/seg-|\/segment/i.test(u));
      if (validMp4) return { type: 'direct', url: validMp4 };
    }

    const m3u8Matches = html.match(/https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?/gi);
    if (m3u8Matches && m3u8Matches.length > 0) {
      return { type: 'stream', url: m3u8Matches[0] };
    }
  } catch {
    // Ignore fetch errors
  }
  return null;
}

// Verifica se um vídeo/URL deve ser tratado como stream HLS (.m3u8) ou como arquivo direto (.mp4)
function isHlsStream(item, targetUrl) {
  const url = targetUrl || (item && (item.selectedVariantUrl || item.url)) || '';
  // Se for explicitamente um arquivo de vídeo progressivo (.mp4, .webm, .mov), NUNCA é HLS!
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) return false;
  // Se contiver .m3u8 na URL
  if (/\.m3u8(\?|$)/i.test(url)) return true;
  // Se tiver variantes mapeadas, confere a variante ativa
  if (item && Array.isArray(item.variants)) {
    const matched = item.variants.find((v) => v.url === url);
    if (matched && matched.kind === 'mp4') return false;
    if (matched && matched.kind === 'hls') return true;
  }
  if (item && item.category === 'direct') return false;
  if (item && (item.streamType === 'HLS' || item.category === 'stream')) return true;
  return false;
}

async function handleDirectDownload(item) {
  const targetUrl = item.selectedVariantUrl || item.url;
  const referer = item.referer || item.pageUrl || (currentTab ? currentTab.url : '');
  const title = item.title || 'video_capturado';

  // 1. YouTube
  if (/youtube\.com|youtu\.be/i.test(targetUrl) || (item.provider && item.provider.toLowerCase().includes('youtube'))) {
    const cmd = buildYtDlpCommand(item);
    copyText(cmd, 'Comando yt-dlp copiado! Use no terminal para baixar em 1080p/4K com áudio.');
    showToast('YouTube: comando yt-dlp (1080p/4K) copiado! Abrindo opções web...', 4000);
    chrome.tabs.create({ url: 'https://cobalt.tools/' });
    return;
  }

  // 2. Arquivo Direto (.mp4, .webm, .mov, etc.) - Baixa direto no navegador (prioridade máxima para MP4s)
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(targetUrl) || item.category === 'direct' || !isHlsStream(item, targetUrl)) {
    startBrowserMp4Download(targetUrl, title, referer);
    return;
  }

  // 3. Stream HLS (.m3u8) - Abre o conversor integrado HLS
  const isHls = isHlsStream(item, targetUrl);
  if (isHls) {
    openHlsDownloader(targetUrl, title, referer);
    return;
  }

  // 4. Se for player embutido (iframe), verifica se já temos stream capturado
  const bestDirect = allVideos.find((v) => v.category === 'direct' && v.url !== item.url);
  if (bestDirect) {
    startBrowserMp4Download(bestDirect.url, title || bestDirect.title, bestDirect.referer || referer);
    return;
  }

  const bestStream = allVideos.find((v) => v.category === 'stream' && v.url.includes('.m3u8'));
  if (bestStream) {
    openHlsDownloader(bestStream.url, title || bestStream.title, bestStream.referer || referer);
    return;
  }

  // Tenta extrair do HTML do player
  showToast('Extraindo stream de vídeo do player embutido...', 3500);
  const extracted = await tryExtractStreamFromEmbedHtml(item.url, referer);
  if (extracted) {
    if (extracted.type === 'direct') {
      startBrowserMp4Download(extracted.url, title, item.url);
    } else {
      openHlsDownloader(extracted.url, title, item.url);
    }
    return;
  }

  // Aciona rápido play no player para forçar a requisição
  if (currentTab && currentTab.id) {
    chrome.tabs.sendMessage(currentTab.id, { action: 'AUTO_TRIGGER_PLAY' }).catch(() => {});
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: currentTab.id }, (res) => {
        allVideos = res && Array.isArray(res.videos) ? res.videos : [];
        renderList();
        const newDirect = allVideos.find((v) => v.category === 'direct');
        const newStream = allVideos.find((v) => v.category === 'stream' && v.url.includes('.m3u8'));
        if (newDirect) {
          startBrowserMp4Download(newDirect.url, title || newDirect.title, newDirect.referer || referer);
        } else if (newStream) {
          openHlsDownloader(newStream.url, title || newStream.title, newStream.referer || referer);
        } else {
          showToast('Dê Play no vídeo da página por 2 segundos e clique em Baixar novamente!', 4000);
        }
      });
    }, 1200);
  }
}

function closeAllDropdowns() {
  document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach((menu) => {
    menu.classList.add('hidden');
  });
  activeDropdownEl = null;
}

// Renderização dos cartões idênticos ao Video DownloadHelper
function renderList() {
  closeAllDropdowns();
  videoListEl.innerHTML = '';

  const isSyncedTab = activeFilter === 'synced';
  const listToRender = isSyncedTab ? syncedVideos : allVideos;

  if (listToRender.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    if (isSyncedTab) {
      empty.innerHTML = `
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
        </svg>
        <h3>Nenhum vídeo salvo no Google Sync</h3>
        <p>Clique no menu <strong>▾</strong> de qualquer vídeo e escolha <strong>☁️ Salvar no Google Sync</strong> para acessá-lo em outros dispositivos.</p>
      `;
    } else {
      empty.innerHTML = `
        <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polygon points="10 8 16 12 10 16 10 8"></polygon>
        </svg>
        <h3>Nenhum vídeo detectado nesta aba</h3>
        <p>Dê <strong>Play no vídeo</strong> na página por 2 segundos para iniciar o fluxo de rede, ou use o botão <strong>🔗</strong> no topo para colar qualquer link.</p>
      `;
    }
    videoListEl.appendChild(empty);
    return;
  }

  listToRender.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.setAttribute('data-key', item.key || item.url);

    const activeUrl = item.selectedVariantUrl || item.url || '';
    const isHls = isHlsStream(item, activeUrl);
    const protocolLabel = isHls ? 'HLS' : 'MP4';
    const formatExt = 'MP4';

    // Determina a qualidade ativa a exibir no pill verde
    let currentQuality = item.qualityHint;
    if (!currentQuality && Array.isArray(item.variants) && item.variants.length > 0) {
      currentQuality = item.variants[0].label;
    }
    if (!currentQuality) {
      currentQuality = isHls ? 'Auto' : 'Original';
    }

    const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
    const hasThumb = Boolean(item.thumbnailUrl);
    const platformIcon = getPlatformIcon(item.provider);
    const isAlreadySynced = syncedVideos.some((s) => s.url === item.url);

    // Bloco da miniatura
    const thumbHtml = `
      <div class="card-left">
        <div class="thumb-wrapper">
          ${
            hasThumb
              ? `<img class="thumb-img" src="${escapeHtml(item.thumbnailUrl)}" alt="Thumb" loading="lazy" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
                 <div class="thumb-placeholder" style="display: none;">
                   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                     <polygon points="5 3 19 12 5 21 5 3"></polygon>
                   </svg>
                 </div>`
              : `<div class="thumb-placeholder">
                   <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                     <polygon points="5 3 19 12 5 21 5 3"></polygon>
                   </svg>
                 </div>`
          }
          <div class="thumb-badge-platform">
            <span>${platformIcon}</span>
            <span class="star-icon">★</span>
          </div>
          ${item.duration ? `<div class="thumb-badge-duration">${escapeHtml(item.duration)}</div>` : ''}
        </div>
      </div>
    `;

    card.innerHTML = `
      ${thumbHtml}

      <div class="card-right">
        <div class="card-header-row">
          <span class="protocol-badge">${protocolLabel}</span>
          <span class="card-title" title="${escapeHtml(item.title || 'Vídeo detectado')}">${escapeHtml(item.title || 'Vídeo detectado')}</span>
          <button class="btn-card-close" title="Remover este vídeo">✕</button>
        </div>

        <div class="card-actions-row">
          <button class="btn-edit-title" title="Editar nome do arquivo">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>

          <div class="quality-dropdown-wrapper">
            <button class="quality-selector-btn" title="Selecionar resolução / qualidade">
              <span class="quality-ext">${formatExt}</span>
              <span class="quality-tag">${escapeHtml(currentQuality)}</span>
              <span class="quality-arrow">${hasVariants ? '⇅' : '▾'}</span>
            </button>
            <div class="dropdown-menu hidden quality-menu"></div>
          </div>

          <div class="download-split-wrapper">
            <div class="download-split-btn">
              <div class="dl-main-action" title="Baixar vídeo agora">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>Baixar</span>
              </div>
              <div class="dl-menu-arrow" title="Mais opções de download">
                ▾
              </div>
            </div>
            <div class="dropdown-menu align-right hidden dl-options-menu">
              <div class="dropdown-item" data-action="download-action">
                <span>⬇️ Baixar ${isHls ? 'via HLS (.mp4)' : 'Direto (.mp4)'}</span>
              </div>
              <div class="dropdown-item" data-action="copy-ytdlp">
                <span>💻 Copiar comando yt-dlp</span>
              </div>
              <div class="dropdown-item" data-action="copy-ffmpeg">
                <span>🎬 Copiar comando ffmpeg</span>
              </div>
              <div class="dropdown-item" data-action="copy-url">
                <span>📋 Copiar link do vídeo</span>
              </div>
              <div class="dropdown-item" data-action="sync-toggle">
                <span>${isAlreadySynced ? '☁️ Remover do Google Sync' : '☁️ Salvar no Google Sync'}</span>
              </div>
              <div class="dropdown-item" data-action="open-tab">
                <span>↗ Abrir link em nova aba</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // 1. Botão Fechar / Dispensar cartão
    const closeBtn = card.querySelector('.btn-card-close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isSyncedTab) {
        removeVideoFromSync(item.url);
      } else {
        if (currentTab && currentTab.id) {
          chrome.runtime.sendMessage({
            action: 'REMOVE_TAB_VIDEO',
            tabId: currentTab.id,
            key: item.key || item.url
          });
        }
        allVideos = allVideos.filter((v) => (v.key || v.url) !== (item.key || item.url));
        renderList();
        showToast('Vídeo removido da lista.');
      }
    });

    // 2. Botão Editar Título (Lápis)
    const editBtn = card.querySelector('.btn-edit-title');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentEditingItem = item;
      renameInput.value = item.title || '';
      renameModal.classList.remove('hidden');
      setTimeout(() => {
        renameInput.focus();
        renameInput.select();
      }, 50);
    });

    // 3. Dropdown de Resolução / Qualidade
    const qualityBtn = card.querySelector('.quality-selector-btn');
    const qualityMenu = card.querySelector('.quality-menu');
    const qualityTagEl = card.querySelector('.quality-tag');

    qualityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = qualityMenu.classList.contains('hidden');
      closeAllDropdowns();
      if (isHidden) {
        // Preenche as opções de qualidade
        qualityMenu.innerHTML = '';
        if (hasVariants) {
          item.variants.forEach((v) => {
            const opt = document.createElement('div');
            const isSelected = (item.selectedVariantUrl || item.url) === v.url;
            opt.className = `dropdown-item ${isSelected ? 'active' : ''}`;
            const dimsLabel = v.width && v.height ? `${v.width}x${v.height}` : v.label;
            opt.innerHTML = `
              <span>${escapeHtml(dimsLabel)}</span>
              <span class="quality-tag">${escapeHtml(v.label)}</span>
            `;
            opt.addEventListener('click', (ev) => {
              ev.stopPropagation();
              item.selectedVariantUrl = v.url;
              item.qualityHint = v.label;
              qualityTagEl.textContent = v.label;
              if (currentTab && currentTab.id) {
                chrome.runtime.sendMessage({
                  action: 'SELECT_VIDEO_VARIANT',
                  tabId: currentTab.id,
                  key: item.key || item.url,
                  variantUrl: v.url,
                  qualityHint: v.label
                });
              }
              closeAllDropdowns();
              showToast(`Resolução alterada para ${v.label}!`);
            });
            qualityMenu.appendChild(opt);
          });
        } else {
          const opt = document.createElement('div');
          opt.className = 'dropdown-item active';
          opt.innerHTML = `<span>Qualidade única</span><span class="quality-tag">${escapeHtml(currentQuality)}</span>`;
          qualityMenu.appendChild(opt);
        }
        qualityMenu.classList.remove('hidden');
        activeDropdownEl = qualityMenu;
      }
    });

    // 4. Ação principal do Botão de Download (Pill azul)
    const dlMainAction = card.querySelector('.dl-main-action');
    dlMainAction.addEventListener('click', (e) => {
      e.stopPropagation();
      saveVideoToSync(item, true);
      handleDirectDownload(item);
    });

    // 5. Menu com seta do Botão de Download
    const dlMenuArrow = card.querySelector('.dl-menu-arrow');
    const dlOptionsMenu = card.querySelector('.dl-options-menu');

    dlMenuArrow.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = dlOptionsMenu.classList.contains('hidden');
      closeAllDropdowns();
      if (isHidden) {
        dlOptionsMenu.classList.remove('hidden');
        activeDropdownEl = dlOptionsMenu;
      }
    });

    // Ações dos itens do menu suspenso
    dlOptionsMenu.querySelectorAll('.dropdown-item').forEach((itemEl) => {
      itemEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = itemEl.getAttribute('data-action');
        closeAllDropdowns();

        const targetUrl = item.selectedVariantUrl || item.url;

        switch (action) {
          case 'download-action':
            saveVideoToSync(item, true);
            handleDirectDownload(item);
            break;
          case 'copy-ytdlp':
            saveVideoToSync(item, true);
            copyText(buildYtDlpCommand(item), 'Comando yt-dlp copiado!');
            break;
          case 'copy-ffmpeg':
            saveVideoToSync(item, true);
            copyText(buildFfmpegCommand(item), 'Comando ffmpeg copiado!');
            break;
          case 'copy-url':
            copyText(targetUrl, 'Link do vídeo copiado!');
            break;
          case 'sync-toggle':
            if (isAlreadySynced) {
              removeVideoFromSync(item.url);
            } else {
              saveVideoToSync(item, false);
            }
            break;
          case 'open-tab':
            chrome.tabs.create({ url: targetUrl });
            break;
        }
      });
    });

    videoListEl.appendChild(card);
  });
}

// Fechamento global de dropdowns ao clicar fora
document.addEventListener('click', () => {
  closeAllDropdowns();
});

// Ações do Modal Rename
function saveRename() {
  if (!currentEditingItem) return;
  const newTitle = renameInput.value.trim();
  if (newTitle) {
    currentEditingItem.title = newTitle;
    currentEditingItem.customTitle = newTitle;

    if (currentTab && currentTab.id) {
      chrome.runtime.sendMessage({
        action: 'UPDATE_VIDEO_TITLE',
        tabId: currentTab.id,
        key: currentEditingItem.key || currentEditingItem.url,
        title: newTitle
      });
    }

    // Se estiver na lista sincronizada, atualiza lá também
    const inSync = syncedVideos.find((s) => s.url === currentEditingItem.url);
    if (inSync) {
      inSync.title = newTitle;
      persistSyncedVideos(syncedVideos);
    }

    renderList();
    showToast('Nome do arquivo atualizado!');
  }
  renameModal.classList.add('hidden');
  currentEditingItem = null;
}

btnRenameSave.addEventListener('click', saveRename);
btnRenameCancel.addEventListener('click', () => {
  renameModal.classList.add('hidden');
  currentEditingItem = null;
});
btnRenameClose.addEventListener('click', () => {
  renameModal.classList.add('hidden');
  currentEditingItem = null;
});
renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveRename();
  } else if (e.key === 'Escape') {
    renameModal.classList.add('hidden');
    currentEditingItem = null;
  }
});
renameModal.addEventListener('click', (e) => {
  if (e.target === renameModal) {
    renameModal.classList.add('hidden');
    currentEditingItem = null;
  }
});

// Ações do Modal "Sem vídeo?"
function openHelpModal() {
  helpModal.classList.remove('hidden');
}
function closeHelpModal() {
  helpModal.classList.add('hidden');
}

btnNoVideoHelp.addEventListener('click', openHelpModal);
btnFooterHelp.addEventListener('click', openHelpModal);
btnHelpClose.addEventListener('click', closeHelpModal);
helpModal.addEventListener('click', (e) => {
  if (e.target === helpModal) closeHelpModal();
});

btnHelpActionRescan.addEventListener('click', () => {
  closeHelpModal();
  triggerRescan();
});

// Ações da Barra Inferior (Footer)
btnFooterSettings.addEventListener('click', () => {
  showToast('⚙️ Video Radar v1.4.0 — Otimizado para HLS, X e MP4');
});

btnFooterSync.addEventListener('click', () => {
  activeFilter = activeFilter === 'synced' ? 'all' : 'synced';
  btnFooterSync.classList.toggle('active', activeFilter === 'synced');
  renderList();
  if (activeFilter === 'synced') {
    showToast('☁️ Exibindo vídeos da Conta Google (Sync)');
  } else {
    showToast('🎬 Exibindo vídeos da aba atual');
  }
});

btnOpenDownloadsFolder.addEventListener('click', () => {
  if (chrome.downloads && typeof chrome.downloads.showDefaultFolder === 'function') {
    try {
      chrome.downloads.showDefaultFolder();
      showToast('Abrindo pasta de Downloads...');
      return;
    } catch {
      // Fallback
    }
  }
  chrome.tabs.create({ url: 'chrome://downloads' });
});

btnClearAll.addEventListener('click', async () => {
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
    showToast('Lista de vídeos limpa!');
  });
});

btnOpenInTab.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

// Barra rápida opcional de URL
btnToggleUrlInput.addEventListener('click', () => {
  quickUrlDrawer.classList.toggle('hidden');
  if (!quickUrlDrawer.classList.contains('hidden')) {
    customUrlInput.focus();
  }
});

async function handleCustomUrlDownload() {
  const rawUrl = (customUrlInput ? customUrlInput.value : '').trim();

  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    showToast('Cole um link válido começando com http:// ou https://');
    customUrlInput.focus();
    return;
  }

  const defaultReferer = currentTab && currentTab.url && /^https?:\/\//i.test(currentTab.url) ? currentTab.url : rawUrl;
  const fallbackTitle = (currentTab && currentTab.title) || 'video_capturado';

  btnDownloadCustomUrl.disabled = true;

  try {
    // 1. Link do X / Twitter
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
        const itemToSave = {
          url: chosen.url,
          title: chosen.title,
          provider: chosen.provider || 'X / Twitter',
          badgeColor: '#1d9bf0',
          category: 'direct',
          format: 'MP4',
          qualityHint: chosen.qualityHint || 'HD MP4',
          thumbnailUrl: chosen.thumbnailUrl,
          duration: chosen.duration,
          referer: rawUrl,
          pageUrl: rawUrl
        };
        await saveVideoToSync(itemToSave, true);
        if (currentTab && currentTab.id) {
          chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: currentTab.id }, (tabRes) => {
            allVideos = tabRes && Array.isArray(tabRes.videos) ? tabRes.videos : allVideos;
            renderList();
          });
        }
        customUrlInput.value = '';
        quickUrlDrawer.classList.add('hidden');
        startBrowserMp4Download(chosen.url, chosen.title, rawUrl);
      } else {
        showToast('Não foi possível extrair o vídeo deste link do X.', 3500);
      }
      return;
    }

    // 2. Link do YouTube (watch, shorts, youtu.be, embed)
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
        format: 'MP4',
        qualityHint: '1080p',
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
              allVideos = tabRes && Array.isArray(tabRes.videos) ? tabRes.videos : allVideos;
              renderList();
            });
          }
        );
      }
      customUrlInput.value = '';
      quickUrlDrawer.classList.add('hidden');
      handleDirectDownload(ytItem);
      return;
    }

    // 3. Link de Stream HLS (.m3u8)
    if (/\.m3u8(\?|$)/i.test(rawUrl)) {
      const hlsItem = {
        url: rawUrl,
        title: fallbackTitle,
        provider: 'Stream HLS',
        badgeColor: '#0284c7',
        category: 'stream',
        format: 'HLS',
        streamType: 'HLS',
        qualityHint: 'Auto',
        referer: defaultReferer,
        pageUrl: rawUrl
      };
      await saveVideoToSync(hlsItem, true);
      customUrlInput.value = '';
      quickUrlDrawer.classList.add('hidden');
      openHlsDownloader(rawUrl, fallbackTitle, defaultReferer);
      return;
    }

    // 4. Link direto de vídeo (.mp4, .webm, .mov, .m4v, .mkv)
    if (/\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(rawUrl)) {
      const directItem = {
        url: rawUrl,
        title: fallbackTitle,
        provider: 'Vídeo Direto',
        badgeColor: '#3b82f6',
        category: 'direct',
        format: 'MP4',
        qualityHint: 'HD',
        referer: defaultReferer,
        pageUrl: rawUrl
      };
      await saveVideoToSync(directItem, true);
      customUrlInput.value = '';
      quickUrlDrawer.classList.add('hidden');
      startBrowserMp4Download(rawUrl, fallbackTitle, defaultReferer);
      return;
    }

    // 5. Outros links (Vimeo, Panda, Wistia, etc.)
    showToast('Analisando link para extrair o vídeo...', 3000);
    const extracted = await tryExtractStreamFromEmbedHtml(rawUrl, defaultReferer);
    if (extracted) {
      customUrlInput.value = '';
      quickUrlDrawer.classList.add('hidden');
      if (extracted.type === 'direct') {
        startBrowserMp4Download(extracted.url, fallbackTitle, rawUrl);
      } else {
        openHlsDownloader(extracted.url, fallbackTitle, rawUrl);
      }
      return;
    }

    showToast('Não foi encontrado link de vídeo (.mp4/.m3u8) nesse endereço.', 3500);
  } finally {
    btnDownloadCustomUrl.disabled = false;
  }
}

btnDownloadCustomUrl.addEventListener('click', handleCustomUrlDownload);
customUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleCustomUrlDownload();
  }
});

// Re-escaneamento da aba
async function triggerRescan() {
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
}

btnRescan.addEventListener('click', triggerRescan);

// Carregamento inicial da aba
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

  // Se a aba for um post do X/Twitter, solicita resolução imediata
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
          allVideos = res && Array.isArray(res.videos) ? res.videos : [];
          renderList();
        });
      }
    );
  }

  setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'GET_TAB_VIDEOS', tabId: tab.id }, (res) => {
      allVideos = res && Array.isArray(res.videos) ? res.videos : [];
      renderList();
    });
  }, 150);
}

// Sincronização automática em tempo real se dados mudarem
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.syncedVideos) {
    syncedVideos = Array.isArray(changes.syncedVideos.newValue) ? changes.syncedVideos.newValue : [];
    if (activeFilter === 'synced') {
      renderList();
    }
  }
});

document.addEventListener('DOMContentLoaded', loadTabVideos);
