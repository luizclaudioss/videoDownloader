// hls-downloader.js - Baixa streams .m3u8 (com suporte a Referer e AES-128) e converte para .MP4 compatível com QuickTime/macOS

function cleanPandaVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (/pandavideo\.com(\.br)?/i.test(u.hostname)) {
      if (/\.m3u8/i.test(u.pathname)) {
        u.searchParams.delete('token');
        u.searchParams.delete('get_qualities');
        u.searchParams.delete('substitute');
        return u.toString();
      }
      const pzMatch = u.hostname.match(/(vz-[a-z0-9]{8}-[a-z0-9]{3})/i);
      const vId = u.searchParams.get('v');
      if (pzMatch && vId && /^[0-9a-f-]{36}$/i.test(vId)) {
        const pullzone = pzMatch[1].toLowerCase();
        const domainSuffix = u.hostname.endsWith('.br') ? '.tv.pandavideo.com.br' : '.tv.pandavideo.com';
        const watermark = u.searchParams.get('watermark');
        return `https://b-${pullzone}${domainSuffix}/${vId.toLowerCase()}/playlist.m3u8${watermark ? `?watermark=${encodeURIComponent(watermark)}` : ''}`;
      }
    }
  } catch {}
  return rawUrl;
}

const params = new URLSearchParams(window.location.search);
const initialUrl = cleanPandaVideoUrl(params.get('url') || '');
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

urlInput.addEventListener('change', () => {
  const cleaned = cleanPandaVideoUrl(urlInput.value.trim());
  urlInput.value = cleaned;
  selectedPlaylistUrl = cleaned;
  if (cleaned) {
    inspectM3u8(cleaned);
  }
});

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

function makeMp4Box(type, payloadBuffers) {
  let totalPayload = 0;
  for (const b of payloadBuffers) totalPayload += b.byteLength;
  const out = new Uint8Array(8 + totalPayload);
  const view = new DataView(out.buffer);
  view.setUint32(0, 8 + totalPayload);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const b of payloadBuffers) {
    out.set(b, offset);
    offset += b.byteLength;
  }
  return out;
}

function buildSttsBox(samples) {
  const runs = [];
  for (const s of samples) {
    const dur = s.duration >>> 0;
    if (runs.length > 0 && runs[runs.length - 1].dur === dur) {
      runs[runs.length - 1].count++;
    } else {
      runs.push({ count: 1, dur });
    }
  }
  const body = new Uint8Array(8 + runs.length * 8);
  const v = new DataView(body.buffer);
  v.setUint32(0, 0);
  v.setUint32(4, runs.length);
  for (let i = 0; i < runs.length; i++) {
    v.setUint32(8 + i * 8, runs[i].count);
    v.setUint32(12 + i * 8, runs[i].dur);
  }
  return makeMp4Box('stts', [body]);
}

function buildStssBox(samples) {
  const syncIndices = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].isSync) syncIndices.push(i + 1);
  }
  const body = new Uint8Array(8 + syncIndices.length * 4);
  const v = new DataView(body.buffer);
  v.setUint32(0, 0);
  v.setUint32(4, syncIndices.length);
  for (let i = 0; i < syncIndices.length; i++) {
    v.setUint32(8 + i * 4, syncIndices[i]);
  }
  return makeMp4Box('stss', [body]);
}

function buildCttsBox(samples) {
  let hasNonZero = false;
  let hasNegative = false;
  const runs = [];
  for (const s of samples) {
    const cts = s.cts | 0;
    if (cts !== 0) hasNonZero = true;
    if (cts < 0) hasNegative = true;
    if (runs.length > 0 && runs[runs.length - 1].cts === cts) {
      runs[runs.length - 1].count++;
    } else {
      runs.push({ count: 1, cts });
    }
  }
  if (!hasNonZero) return null;
  const body = new Uint8Array(8 + runs.length * 8);
  const v = new DataView(body.buffer);
  v.setUint32(0, hasNegative ? 0x01000000 : 0);
  v.setUint32(4, runs.length);
  for (let i = 0; i < runs.length; i++) {
    v.setUint32(8 + i * 8, runs[i].count);
    v.setInt32(12 + i * 8, runs[i].cts);
  }
  return makeMp4Box('ctts', [body]);
}

function buildStscBox(sampleCount) {
  const body = new Uint8Array(sampleCount > 0 ? 20 : 8);
  const v = new DataView(body.buffer);
  v.setUint32(0, 0);
  if (sampleCount > 0) {
    v.setUint32(4, 1);
    v.setUint32(8, 1);
    v.setUint32(12, 1);
    v.setUint32(16, 1);
  } else {
    v.setUint32(4, 0);
  }
  return makeMp4Box('stsc', [body]);
}

function buildStszBox(samples) {
  const body = new Uint8Array(12 + samples.length * 4);
  const v = new DataView(body.buffer);
  v.setUint32(0, 0);
  v.setUint32(4, 0);
  v.setUint32(8, samples.length);
  for (let i = 0; i < samples.length; i++) {
    v.setUint32(12 + i * 4, samples[i].size >>> 0);
  }
  return makeMp4Box('stsz', [body]);
}

function buildStcoBox(samples, mdatPayloadOffset) {
  const body = new Uint8Array(8 + samples.length * 4);
  const v = new DataView(body.buffer);
  v.setUint32(0, 0);
  v.setUint32(4, samples.length);
  for (let i = 0; i < samples.length; i++) {
    v.setUint32(8 + i * 4, (mdatPayloadOffset + samples[i].relOffset) >>> 0);
  }
  return makeMp4Box('stco', [body]);
}

function parseMp4Fragments(fragChunks) {
  const tracks = new Map();
  for (const chunk of fragChunks) {
    const buf = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0;
    let currentMoofOffset = 0;
    while (off + 8 <= buf.byteLength) {
      const sz = view.getUint32(off);
      if (sz < 8 || off + sz > buf.byteLength) break;
      const tp = readBoxType(buf, off);
      if (tp === 'moof') {
        currentMoofOffset = off;
        let mOff = off + 8;
        const mEnd = off + sz;
        while (mOff + 8 <= mEnd) {
          const mSz = view.getUint32(mOff);
          if (mSz < 8 || mOff + mSz > mEnd) break;
          const mTp = readBoxType(buf, mOff);
          if (mTp === 'traf') {
            let trackId = 0;
            let defDur = 0;
            let defSize = 0;
            let defFlags = 0;
            let tOff = mOff + 8;
            const tEnd = mOff + mSz;
            while (tOff + 8 <= tEnd) {
              const tSz = view.getUint32(tOff);
              if (tSz < 8 || tOff + tSz > tEnd) break;
              const tTp = readBoxType(buf, tOff);
              if (tTp === 'tfhd') {
                const vf = view.getUint32(tOff + 8);
                trackId = view.getUint32(tOff + 12);
                let p = tOff + 16;
                if (vf & 0x000001) p += 8;
                if (vf & 0x000002) p += 4;
                if (vf & 0x000008) { defDur = view.getUint32(p); p += 4; }
                if (vf & 0x000010) { defSize = view.getUint32(p); p += 4; }
                if (vf & 0x000020) { defFlags = view.getUint32(p); p += 4; }
              } else if (tTp === 'trun' && trackId) {
                const vf = view.getUint32(tOff + 8);
                const sampleCount = view.getUint32(tOff + 12);
                let p = tOff + 16;
                let dataOffset = 0;
                let firstSampleFlags = defFlags;
                if (vf & 0x000001) { dataOffset = view.getInt32(p); p += 4; }
                if (vf & 0x000004) { firstSampleFlags = view.getUint32(p); p += 4; }
                let sampleDataPtr = currentMoofOffset + dataOffset;
                if (!tracks.has(trackId)) tracks.set(trackId, []);
                const list = tracks.get(trackId);
                for (let i = 0; i < sampleCount; i++) {
                  const dur = (vf & 0x000100) ? (p += 4, view.getUint32(p - 4)) : defDur;
                  const sSz = (vf & 0x000200) ? (p += 4, view.getUint32(p - 4)) : defSize;
                  const sFl = (vf & 0x000400) ? (p += 4, view.getUint32(p - 4)) : (i === 0 ? firstSampleFlags : defFlags);
                  const cts = (vf & 0x000800) ? (p += 4, view.getInt32(p - 4)) : 0;
                  const isSync = (sFl & 0x00010000) === 0;
                  if (sSz > 0 && sampleDataPtr >= 0 && sampleDataPtr + sSz <= buf.byteLength) {
                    list.push({
                      duration: dur || (trackId === 256 ? 3000 : 1024),
                      size: sSz,
                      isSync,
                      cts,
                      bytes: buf.subarray(sampleDataPtr, sampleDataPtr + sSz)
                    });
                  }
                  sampleDataPtr += sSz;
                }
              }
              tOff += tSz;
            }
          }
          mOff += mSz;
        }
      }
      off += sz;
    }
  }
  return tracks;
}

function patchStsdBox(stsdBytes) {
  const buf = new Uint8Array(stsdBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 16; i + 12 < buf.byteLength; i++) {
    if (
      buf[i] === 0x00 &&
      buf[i + 1] === 0x18 &&
      (buf[i + 2] === 0x11 || buf[i + 2] === 0xff) &&
      buf[i + 8] === 0x61 &&
      buf[i + 9] === 0x76 &&
      buf[i + 10] === 0x63 &&
      buf[i + 11] === 0x43
    ) {
      buf[i + 2] = 0xff;
      buf[i + 3] = 0xff;
      const avcCOff = i + 4;
      const avcCSz = view.getUint32(avcCOff);
      if (avcCSz >= 14 && avcCOff + 14 <= buf.byteLength) {
        buf[avcCOff + 12] |= 0xfc;
        buf[avcCOff + 13] |= 0xe0;
      }
    }
  }
  return buf;
}

// Converte saída fragmentada do mux.js (moof/mdat separados por faixa) em MP4 padrão ISO (ftyp + moov + mdat intercalado)
// compatível com VLC, QuickTime Player, macOS Finder, Chrome e Windows Media Player.
function convertFragmentedToStandardMp4(initBytes, fragChunks) {
  const initBuf = new Uint8Array(initBytes.buffer, initBytes.byteOffset, initBytes.byteLength);
  const initView = new DataView(initBuf.buffer, initBuf.byteOffset, initBuf.byteLength);
  const tracksMap = parseMp4Fragments(fragChunks);

  let ftypBox = null;
  let moovSlice = null;
  let off = 0;
  while (off + 8 <= initBuf.byteLength) {
    const sz = initView.getUint32(off);
    if (sz < 8 || off + sz > initBuf.byteLength) break;
    const tp = readBoxType(initBuf, off);
    if (tp === 'ftyp') ftypBox = initBuf.slice(off, off + sz);
    else if (tp === 'moov') moovSlice = initBuf.subarray(off, off + sz);
    off += sz;
  }
  if (!ftypBox || !moovSlice) return null;

  const moovView = new DataView(moovSlice.buffer, moovSlice.byteOffset, moovSlice.byteLength);
  let mvhdTimescale = 90000;
  const trackMeta = new Map();

  let mOff = 8;
  while (mOff + 8 <= moovSlice.byteLength) {
    const sz = moovView.getUint32(mOff);
    if (sz < 8 || mOff + sz > moovSlice.byteLength) break;
    const tp = readBoxType(moovSlice, mOff);
    if (tp === 'mvhd') {
      const ver = moovSlice[mOff + 8];
      mvhdTimescale = moovView.getUint32(mOff + (ver === 1 ? 28 : 20)) || 90000;
    } else if (tp === 'trak') {
      let tid = 0;
      let mdhdTs = 90000;
      let isVideo = false;
      let tOff = mOff + 8;
      const tEnd = mOff + sz;
      while (tOff + 8 <= tEnd) {
        const tSz = moovView.getUint32(tOff);
        if (tSz < 8 || tOff + tSz > tEnd) break;
        const tTp = readBoxType(moovSlice, tOff);
        if (tTp === 'tkhd') {
          const ver = moovSlice[tOff + 8];
          tid = moovView.getUint32(tOff + (ver === 1 ? 28 : 20));
        } else if (tTp === 'mdia') {
          let dOff = tOff + 8;
          const dEnd = tOff + tSz;
          while (dOff + 8 <= dEnd) {
            const dSz = moovView.getUint32(dOff);
            if (dSz < 8 || dOff + dSz > dEnd) break;
            const dTp = readBoxType(moovSlice, dOff);
            if (dTp === 'mdhd') {
              const ver = moovSlice[dOff + 8];
              mdhdTs = moovView.getUint32(dOff + (ver === 1 ? 28 : 20)) || 90000;
            } else if (dTp === 'hdlr') {
              const handler = String.fromCharCode(
                moovSlice[dOff + 16],
                moovSlice[dOff + 17],
                moovSlice[dOff + 18],
                moovSlice[dOff + 19]
              );
              if (handler === 'vide') isVideo = true;
            }
            dOff += dSz;
          }
        }
        tOff += tSz;
      }
      if (tid) {
        const samples = tracksMap.get(tid) || [];
        let totalDur = 0;
        for (const s of samples) totalDur += s.duration;
        trackMeta.set(tid, { mdhdTs, totalDur, isVideo, samples });
      }
    }
    mOff += sz;
  }

  const cursors = [];
  let totalMdatPayloadBytes = 0;
  for (const [tid, meta] of trackMeta.entries()) {
    for (const s of meta.samples) totalMdatPayloadBytes += s.size;
    if (meta.samples.length > 0) {
      cursors.push({ tid, samples: meta.samples, idx: 0, timeTicks: 0, ts: meta.mdhdTs });
    }
  }
  if (cursors.length === 0) return null;

  let currentRelOffset = 0;
  const interleavedSlices = [];
  while (cursors.length > 0) {
    let bestIdx = 0;
    let bestTime = cursors[0].timeTicks / cursors[0].ts;
    for (let i = 1; i < cursors.length; i++) {
      const t = cursors[i].timeTicks / cursors[i].ts;
      if (t < bestTime) {
        bestTime = t;
        bestIdx = i;
      }
    }
    const c = cursors[bestIdx];
    const s = c.samples[c.idx++];
    s.relOffset = currentRelOffset;
    currentRelOffset += s.size;
    interleavedSlices.push(s.bytes);
    c.timeTicks += s.duration;
    if (c.idx >= c.samples.length) {
      cursors.splice(bestIdx, 1);
    }
  }

  function buildMoov(mdatPayloadOffset) {
    const moovChildren = [];
    let maxMoovDuration = 0;
    for (const [, meta] of trackMeta.entries()) {
      const durInMvhd = Math.round((meta.totalDur / meta.mdhdTs) * mvhdTimescale);
      if (durInMvhd > maxMoovDuration) maxMoovDuration = durInMvhd;
    }

    let off1 = 8;
    while (off1 + 8 <= moovSlice.byteLength) {
      const sz1 = moovView.getUint32(off1);
      if (sz1 < 8 || off1 + sz1 > moovSlice.byteLength) break;
      const tp1 = readBoxType(moovSlice, off1);
      if (tp1 === 'mvex') {
        // Remove mvex para arquivo MP4 padrão não-fragmentado
      } else if (tp1 === 'mvhd') {
        const mvhdCopy = moovSlice.slice(off1, off1 + sz1);
        const v = new DataView(mvhdCopy.buffer, mvhdCopy.byteOffset, mvhdCopy.byteLength);
        if (mvhdCopy[8] === 0) v.setUint32(24, maxMoovDuration);
        moovChildren.push(mvhdCopy);
      } else if (tp1 === 'trak') {
        let tid = 0;
        let tOff = off1 + 8;
        while (tOff + 8 <= off1 + sz1) {
          const tSz = moovView.getUint32(tOff);
          if (tSz < 8 || tOff + tSz > off1 + sz1) break;
          if (readBoxType(moovSlice, tOff) === 'tkhd') {
            tid = moovView.getUint32(tOff + (moovSlice[tOff + 8] === 1 ? 28 : 20));
            break;
          }
          tOff += tSz;
        }
        const meta = trackMeta.get(tid);
        if (meta && meta.samples.length > 0) {
          const trakChildren = [];
          tOff = off1 + 8;
          while (tOff + 8 <= off1 + sz1) {
            const tSz = moovView.getUint32(tOff);
            if (tSz < 8 || tOff + tSz > off1 + sz1) break;
            const tTp = readBoxType(moovSlice, tOff);
            if (tTp === 'tkhd') {
              const tkhdCopy = moovSlice.slice(tOff, tOff + tSz);
              const v = new DataView(tkhdCopy.buffer, tkhdCopy.byteOffset, tkhdCopy.byteLength);
              const durInMvhd = Math.round((meta.totalDur / meta.mdhdTs) * mvhdTimescale);
              if (tkhdCopy[8] === 0) v.setUint32(28, durInMvhd);
              trakChildren.push(tkhdCopy);
            } else if (tTp === 'mdia') {
              const mdiaChildren = [];
              let dOff = tOff + 8;
              while (dOff + 8 <= tOff + tSz) {
                const dSz = moovView.getUint32(dOff);
                if (dSz < 8 || dOff + dSz > tOff + tSz) break;
                const dTp = readBoxType(moovSlice, dOff);
                if (dTp === 'mdhd') {
                  const mdhdCopy = moovSlice.slice(dOff, dOff + dSz);
                  const v = new DataView(mdhdCopy.buffer, mdhdCopy.byteOffset, mdhdCopy.byteLength);
                  if (mdhdCopy[8] === 0) v.setUint32(24, meta.totalDur);
                  mdiaChildren.push(mdhdCopy);
                } else if (dTp === 'minf') {
                  const minfChildren = [];
                  let nOff = dOff + 8;
                  while (nOff + 8 <= dOff + dSz) {
                    const nSz = moovView.getUint32(nOff);
                    if (nSz < 8 || nOff + nSz > dOff + dSz) break;
                    const nTp = readBoxType(moovSlice, nOff);
                    if (nTp === 'stbl') {
                      let stsdBox = null;
                      let sOff = nOff + 8;
                      while (sOff + 8 <= nOff + nSz) {
                        const sSz = moovView.getUint32(sOff);
                        if (sSz < 8 || sOff + sSz > nOff + nSz) break;
                        if (readBoxType(moovSlice, sOff) === 'stsd') {
                          stsdBox = patchStsdBox(moovSlice.slice(sOff, sOff + sSz));
                          break;
                        }
                        sOff += sSz;
                      }
                      const stblChildren = [stsdBox, buildSttsBox(meta.samples)];
                      if (meta.isVideo) {
                        stblChildren.push(buildStssBox(meta.samples));
                        const cttsBox = buildCttsBox(meta.samples);
                        if (cttsBox) stblChildren.push(cttsBox);
                      }
                      stblChildren.push(
                        buildStscBox(meta.samples.length),
                        buildStszBox(meta.samples),
                        buildStcoBox(meta.samples, mdatPayloadOffset)
                      );
                      minfChildren.push(makeMp4Box('stbl', stblChildren));
                    } else {
                      minfChildren.push(moovSlice.slice(nOff, nOff + nSz));
                    }
                    nOff += nSz;
                  }
                  mdiaChildren.push(makeMp4Box('minf', minfChildren));
                } else {
                  mdiaChildren.push(moovSlice.slice(dOff, dOff + dSz));
                }
                dOff += dSz;
              }
              trakChildren.push(makeMp4Box('mdia', mdiaChildren));
            } else {
              trakChildren.push(moovSlice.slice(tOff, tOff + tSz));
            }
            tOff += tSz;
          }
          moovChildren.push(makeMp4Box('trak', trakChildren));
        }
      } else {
        moovChildren.push(moovSlice.slice(off1, off1 + sz1));
      }
      off1 += sz1;
    }
    return makeMp4Box('moov', moovChildren);
  }

  const dummyMoov = buildMoov(0);
  const mdatPayloadOffset = ftypBox.byteLength + dummyMoov.byteLength + 8;
  const finalMoov = buildMoov(mdatPayloadOffset);

  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, 8 + totalMdatPayloadBytes);
  mdatHeader[4] = 0x6d;
  mdatHeader[5] = 0x64;
  mdatHeader[6] = 0x61;
  mdatHeader[7] = 0x74;

  return new Blob([ftypBox, finalMoov, mdatHeader, ...interleavedSlices], { type: 'video/mp4' });
}

// Converte segmentos MPEG-TS (.ts) em arquivo MP4 padrão (Vídeo H.264 + Áudio AAC intercalados) usando mux.js
function transmuxTsSegmentsToMp4(tsBuffers) {
  if (!window.muxjs || !window.muxjs.mp4 || !window.muxjs.mp4.Transmuxer) {
    return null;
  }

  const transmuxer = new window.muxjs.mp4.Transmuxer({
    keepOriginalTimestamps: false
  });

  let initSegmentBytes = null;
  const mediaFragChunks = [];

  transmuxer.on('data', (segment) => {
    if (!initSegmentBytes && segment.initSegment && segment.initSegment.byteLength > 0) {
      initSegmentBytes = new Uint8Array(segment.initSegment);
    }
    if (segment.data && segment.data.byteLength > 0) {
      mediaFragChunks.push(new Uint8Array(segment.data));
    }
  });

  for (const buf of tsBuffers) {
    if (buf && buf.byteLength > 0) {
      transmuxer.push(new Uint8Array(buf));
    }
  }
  transmuxer.flush();

  if (!initSegmentBytes || mediaFragChunks.length === 0) return null;

  const standardBlob = convertFragmentedToStandardMp4(initSegmentBytes, mediaFragChunks);
  if (standardBlob) return standardBlob;

  return new Blob([initSegmentBytes, ...mediaFragChunks], { type: 'video/mp4' });
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

function shq(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

btnCopyYtdlp.addEventListener('click', async () => {
  const cleanName = titleInput.value || 'video';
  const targetUrl = cleanPandaVideoUrl(selectedPlaylistUrl || urlInput.value.trim() || initialUrl);
  const refPart = refererUrl ? `--referer ${shq(refererUrl)} ` : '';
  const cmd = `yt-dlp ${refPart}-N 8 --force-overwrites --merge-output-format mp4 -P "$HOME/Downloads/VideoRadar" -o ${shq(cleanName + '.%(ext)s')} ${shq(targetUrl)}`;
  await navigator.clipboard.writeText(cmd);
  statusText.textContent = '✅ Comando yt-dlp copiado (salvará em Downloads/VideoRadar)!';
});

btnCopyFfmpeg.addEventListener('click', async () => {
  const cleanName = titleInput.value || 'video';
  const targetUrl = cleanPandaVideoUrl(selectedPlaylistUrl || urlInput.value.trim() || initialUrl);
  const refPart = refererUrl ? `-headers ${shq('Referer: ' + refererUrl + '\r\n')} ` : '';
  const cmd = `ffmpeg ${refPart}-i ${shq(targetUrl)} -c copy -bsf:a aac_adtstoasc "$HOME/Downloads/VideoRadar/"${shq(cleanName + '.mp4')}`;
  await navigator.clipboard.writeText(cmd);
  statusText.textContent = '✅ Comando ffmpeg copiado (salvará em Downloads/VideoRadar)!';
});

inspectM3u8(initialUrl);
