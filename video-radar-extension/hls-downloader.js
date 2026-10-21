// hls-downloader.js - Baixa streams .m3u8 (com suporte a Referer e AES-128) e converte para .MP4 compatível com QuickTime/macOS

const params = new URLSearchParams(window.location.search);
const initialUrl = params.get('url') || '';
const initialTitle = params.get('title') || 'video_capturado';
const refererUrl = params.get('referer') || '';
const autoStart = params.get('autostart') === '1';

const titleInput = document.getElementById('titleInput');
const urlInput = document.getElementById('urlInput');
const variantField = document.getElementById('variantField');
const variantSelect = document.getElementById('variantSelect');
const btnStart = document.getElementById('btnStartDownload');
const btnCopyYtdlp = document.getElementById('btnCopyYtdlp');
const btnCopyFfmpeg = document.getElementById('btnCopyFfmpeg');
const progressFill = document.getElementById('progressFill');
const statusText = document.getElementById('statusText');

titleInput.value = initialTitle.replace(/\.(mp4|ts|m3u8)$/i, '');
urlInput.value = initialUrl;

let selectedPlaylistUrl = initialUrl;

function resolveUrl(rel, base) {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

async function ensureRefererForUrl(targetUrl) {
  if (!targetUrl || !refererUrl) return;
  try {
    await chrome.runtime.sendMessage({
      action: 'ENSURE_REFERER_RULE',
      targetUrl,
      refererUrl
    });
  } catch {
    // Ignore
  }
}

function startDirectDownloadFromHlsPage(url, title) {
  const cleanName = (title || 'video_capturado')
    .replace(/\.(mp4|ts|m3u8)$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim() || 'video_capturado';
  const finalFilename = `${cleanName}.mp4`;

  chrome.runtime.sendMessage(
    {
      action: 'START_DIRECT_DOWNLOAD',
      url,
      filename: finalFilename,
      referer: refererUrl || ''
    },
    (res) => {
      if (!res || !res.ok) {
        const a = document.createElement('a');
        a.href = url;
        a.download = finalFilename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      statusText.textContent = `✅ Download direto iniciado! Salvo como "${finalFilename}".`;
      progressFill.style.width = '100%';
    }
  );
}

async function inspectM3u8(url) {
  if (!url) {
    statusText.textContent = 'URL inválida.';
    return;
  }
  // Se for arquivo MP4 direto progressivo
  if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(url)) {
    statusText.textContent = 'Arquivo MP4 direto detectado! Iniciando download...';
    startDirectDownloadFromHlsPage(url, titleInput.value);
    return;
  }
  try {
    await ensureRefererForUrl(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    // Se o arquivo não começar com #EXTM3U (ex: arquivo binário .mp4), baixa diretamente
    if (!/#EXTM3U/i.test(text.slice(0, 500))) {
      statusText.textContent = 'Arquivo de vídeo direto identificado! Baixando...';
      startDirectDownloadFromHlsPage(url, titleInput.value);
      return;
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        const info = lines[i];
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          const resMatch = info.match(/RESOLUTION=(\d+x\d+)/i);
          const bwMatch = info.match(/BANDWIDTH=(\d+)/i);
          const resolution = resMatch ? resMatch[1] : 'Stream';
          const bandwidth = bwMatch ? Math.round(parseInt(bwMatch[1], 10) / 1000) : 0;
          variants.push({
            label: `${resolution} (${bandwidth} kbps)`,
            bandwidth,
            url: resolveUrl(nextLine, url)
          });
        }
      }
    }

    if (variants.length > 0) {
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      variantSelect.innerHTML = '';
      variants.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.url;
        opt.textContent = v.label;
        variantSelect.appendChild(opt);
      });
      variantField.style.display = 'flex';
      selectedPlaylistUrl = variants[0].url;
      variantSelect.addEventListener('change', () => {
        selectedPlaylistUrl = variantSelect.value;
      });
      statusText.textContent = `Master Playlist pronta (${variants.length} qualidades detectadas). Selecionada: ${variants[0].label}.`;
    } else {
      const segCount = lines.filter((l) => !l.startsWith('#')).length;
      statusText.textContent = `Playlist pronta (${segCount} segmentos identificados).`;
    }

    if (autoStart) {
      downloadAndConvertToMp4();
    }
  } catch (err) {
    statusText.textContent = `Erro ao ler manifesto (${err.message}). Verifique se você está logado na página do vídeo.`;
  }
}

function parseHexIv(ivStr) {
  const clean = ivStr.replace(/^0x/i, '').padStart(32, '0');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
  }
  return bytes;
}

function buildSequenceIv(seqNum) {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setUint32(12, seqNum, false);
  return new Uint8Array(buf);
}

function readBoxType(buf, offset) {
  return String.fromCharCode(buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]);
}

// Corrige cabeçalho moov do mux.js para compatibilidade total de Vídeo + Áudio no QuickTime / macOS (AVFoundation)
function patchInitSegmentForQuickTime(initBytes) {
  const buf = new Uint8Array(initBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  function walk(start, end) {
    let off = start;
    while (off + 8 <= end) {
      const sz = view.getUint32(off);
      if (sz < 8 || off + sz > end) break;
      const tp = readBoxType(buf, off);
      if (tp === 'moov' || tp === 'trak' || tp === 'mdia' || tp === 'minf' || tp === 'stbl') {
        walk(off + 8, off + sz);
      } else if (tp === 'mvhd') {
        // Zera duration=0xffffffff para que o QuickTime calcule a duração real pelos fragmentos moof
        if (buf[off + 8] === 0) view.setUint32(off + 24, 0);
      } else if (tp === 'tkhd') {
        if (buf[off + 8] === 0) view.setUint32(off + 28, 0);
      } else if (tp === 'mdhd') {
        if (buf[off + 8] === 0) view.setUint32(off + 24, 0);
      } else if (tp === 'stsd') {
        // Corrige pre_defined (clutID) em avc1 de 0x1111 para 0xFFFF conforme exigido pelo QuickTime
        for (let i = off + 16; i + 12 < off + sz; i++) {
          if (
            buf[i] === 0x00 &&
            buf[i + 1] === 0x18 &&
            buf[i + 2] === 0x11 &&
            buf[i + 3] === 0x11 &&
            buf[i + 8] === 0x61 &&
            buf[i + 9] === 0x76 &&
            buf[i + 10] === 0x63 &&
            buf[i + 11] === 0x43
          ) {
            buf[i + 2] = 0xff;
            buf[i + 3] = 0xff;
          }
        }
      }
      off += sz;
    }
  }

  walk(0, buf.byteLength);
  return buf;
}

// Corrige boxes moof/mfhd/tfhd do mux.js (adiciona flag default-base-is-moof 0x020000 para o QuickTime decodificar a faixa de vídeo)
function patchMediaFragmentForQuickTime(fragBytes, seqCounterRef) {
  const buf = new Uint8Array(fragBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 0;
  const end = buf.byteLength;

  while (off + 8 <= end) {
    const sz = view.getUint32(off);
    if (sz < 8 || off + sz > end) break;
    const tp = readBoxType(buf, off);
    if (tp === 'moof') {
      let mOff = off + 8;
      const mEnd = off + sz;
      while (mOff + 8 <= mEnd) {
        const mSz = view.getUint32(mOff);
        if (mSz < 8 || mOff + mSz > mEnd) break;
        const mTp = readBoxType(buf, mOff);
        if (mTp === 'mfhd' && mSz >= 16) {
          view.setUint32(mOff + 12, seqCounterRef.seq++);
        } else if (mTp === 'traf') {
          let tOff = mOff + 8;
          const tEnd = mOff + mSz;
          while (tOff + 8 <= tEnd) {
            const tSz = view.getUint32(tOff);
            if (tSz < 8 || tOff + tSz > tEnd) break;
            const tTp = readBoxType(buf, tOff);
            if (tTp === 'tfhd' && tSz >= 16) {
              const verFlags = view.getUint32(tOff + 8);
              view.setUint32(tOff + 8, verFlags | 0x00020000); // default-base-is-moof
            }
            tOff += tSz;
          }
        }
        mOff += mSz;
      }
    }
    off += sz;
  }
  return buf;
}

// Converte segmentos MPEG-TS (.ts) em arquivo MP4 real (Vídeo H.264 + Áudio AAC) usando mux.js + correção QuickTime
function transmuxTsSegmentsToMp4(tsBuffers) {
  if (!window.muxjs || !window.muxjs.mp4 || !window.muxjs.mp4.Transmuxer) {
    return null;
  }

  const transmuxer = new window.muxjs.mp4.Transmuxer({
    keepOriginalTimestamps: false
  });

  const mp4Chunks = [];
  let hasInit = false;
  const seqRef = { seq: 1 };

  transmuxer.on('data', (segment) => {
    if (!hasInit && segment.initSegment && segment.initSegment.byteLength > 0) {
      mp4Chunks.push(patchInitSegmentForQuickTime(segment.initSegment));
      hasInit = true;
    }
    if (segment.data && segment.data.byteLength > 0) {
      mp4Chunks.push(patchMediaFragmentForQuickTime(segment.data, seqRef));
    }
  });

  // Faz push de todos os segmentos em sequência contínua e executa flush ao final para manter a sincronia de vídeo e áudio
  for (const buf of tsBuffers) {
    if (buf && buf.byteLength > 0) {
      transmuxer.push(new Uint8Array(buf));
    }
  }
  transmuxer.flush();

  if (mp4Chunks.length === 0) return null;
  return new Blob(mp4Chunks, { type: 'video/mp4' });
}

async function downloadAndConvertToMp4() {
  btnStart.disabled = true;
  progressFill.style.width = '0%';
  statusText.textContent = 'Buscando lista de segmentos de vídeo...';

  try {
    await ensureRefererForUrl(selectedPlaylistUrl);
    const res = await fetch(selectedPlaylistUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    if (!/#EXTM3U/i.test(text.slice(0, 500))) {
      statusText.textContent = 'Arquivo de vídeo direto identificado! Iniciando download nativo...';
      startDirectDownloadFromHlsPage(selectedPlaylistUrl, titleInput.value);
      return;
    }

    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    let mediaSequence = 0;
    const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
    if (seqMatch) mediaSequence = parseInt(seqMatch[1], 10);

    let currentKeyInfo = null;
    const segmentTasks = [];
    let segCounter = 0;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([^,]+)/i);
        const uriMatch = line.match(/URI="([^"]+)"/i);
        const ivMatch = line.match(/IV=([^,]+)/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : 'NONE';
        if (method === 'AES-128' && uriMatch) {
          currentKeyInfo = {
            method: 'AES-128',
            uri: resolveUrl(uriMatch[1], selectedPlaylistUrl),
            iv: ivMatch ? parseHexIv(ivMatch[1]) : null
          };
        } else if (method === 'NONE') {
          currentKeyInfo = null;
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const m = line.match(/URI="([^"]+)"/i);
        if (m) {
          segmentTasks.push({
            url: resolveUrl(m[1], selectedPlaylistUrl),
            keyInfo: null,
            seq: -1,
            isInitMap: true
          });
        }
      } else if (!line.startsWith('#')) {
        if (line.length > 2000) continue;
        segmentTasks.push({
          url: resolveUrl(line, selectedPlaylistUrl),
          keyInfo: currentKeyInfo ? { ...currentKeyInfo } : null,
          seq: mediaSequence + segCounter,
          isInitMap: false
        });
        segCounter++;
      }
    }

    if (segmentTasks.length === 0) {
      throw new Error('Nenhum segmento encontrado na playlist.');
    }

    await ensureRefererForUrl(segmentTasks[0].url);

    const cryptoKeyCache = new Map();
    async function getCryptoKey(keyUri) {
      if (cryptoKeyCache.has(keyUri)) return cryptoKeyCache.get(keyUri);
      await ensureRefererForUrl(keyUri);
      const kRes = await fetch(keyUri);
      if (!kRes.ok) throw new Error(`Falha ao obter chave AES (${kRes.status})`);
      const kBuf = await kRes.arrayBuffer();
      const cKey = await crypto.subtle.importKey('raw', kBuf, { name: 'AES-CBC' }, false, ['decrypt']);
      cryptoKeyCache.set(keyUri, cKey);
      return cKey;
    }

    const buffers = new Array(segmentTasks.length);
    let completed = 0;
    const concurrency = 6;
    let index = 0;

    async function worker() {
      while (index < segmentTasks.length) {
        const currentIdx = index++;
        const task = segmentTasks[currentIdx];

        const segRes = await fetch(task.url);
        if (!segRes.ok) throw new Error(`Falha no segmento ${currentIdx + 1} (HTTP ${segRes.status})`);
        let rawBuf = await segRes.arrayBuffer();

        if (task.keyInfo && task.keyInfo.method === 'AES-128') {
          const cKey = await getCryptoKey(task.keyInfo.uri);
          const iv = task.keyInfo.iv || buildSequenceIv(task.seq);
          rawBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cKey, rawBuf);
        }

        buffers[currentIdx] = rawBuf;
        completed++;
        const pct = Math.round((completed / segmentTasks.length) * 100);
        progressFill.style.width = `${pct}%`;
        statusText.textContent = `Baixando segmentos: ${completed} / ${segmentTasks.length} (${pct}%)`;
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(concurrency, segmentTasks.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    statusText.textContent = 'Empacotando Vídeo H.264 + Áudio AAC em container .MP4...';

    const firstBuf = new Uint8Array(buffers[0]);
    const isMpegTs = firstBuf.length > 0 && firstBuf[0] === 0x47 && (firstBuf.length < 189 || firstBuf[188] === 0x47);

    let finalMp4Blob = null;
    if (isMpegTs) {
      finalMp4Blob = transmuxTsSegmentsToMp4(buffers);
    }

    if (!finalMp4Blob) {
      finalMp4Blob = new Blob(buffers, { type: 'video/mp4' });
    }

    const blobUrl = URL.createObjectURL(finalMp4Blob);
    const cleanName = (titleInput.value || 'video_capturado')
      .replace(/\.(mp4|ts|m3u8)$/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim() || 'video_capturado';
    const finalFilename = `${cleanName}.mp4`;

    chrome.runtime.sendMessage(
      {
        action: 'START_DIRECT_DOWNLOAD',
        url: blobUrl,
        filename: finalFilename,
        referer: ''
      },
      (res) => {
        if (!res || !res.ok) {
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = finalFilename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
        statusText.textContent = `✅ Concluído! Vídeo completo (Vídeo + Áudio) salvo como "${finalFilename}".`;
      }
    );
  } catch (err) {
    statusText.textContent = `❌ Erro durante o download: ${err.message}`;
  } finally {
    btnStart.disabled = false;
  }
}

btnStart.addEventListener('click', downloadAndConvertToMp4);

btnCopyYtdlp.addEventListener('click', async () => {
  const cleanName = (titleInput.value || 'video').replace(/"/g, '');
  const refPart = refererUrl ? `--referer "${refererUrl}" ` : '';
  const cmd = `yt-dlp ${refPart}-N 8 --merge-output-format mp4 -P "$HOME/Downloads/VideoRadar" -o "${cleanName}.%(ext)s" "${initialUrl}"`;
  await navigator.clipboard.writeText(cmd);
  statusText.textContent = '✅ Comando yt-dlp copiado (salvará na pasta Downloads)!';
});

btnCopyFfmpeg.addEventListener('click', async () => {
  const cleanName = (titleInput.value || 'video').replace(/"/g, '');
  const refPart = refererUrl ? `-headers "Referer: ${refererUrl}\\r\\n" ` : '';
  const cmd = `ffmpeg ${refPart}-i "${initialUrl}" -c copy -bsf:a aac_adtstoasc "$HOME/Downloads/VideoRadar/${cleanName}.mp4"`;
  await navigator.clipboard.writeText(cmd);
  statusText.textContent = '✅ Comando ffmpeg copiado (salvará na pasta Downloads)!';
});

inspectM3u8(initialUrl);
