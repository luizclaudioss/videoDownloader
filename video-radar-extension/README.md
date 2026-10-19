# 🎬 Video Radar — Extensão Identificadora de Vídeos & Players

Extensão de navegador (Manifest V3 — compatível com **Google Chrome, Brave, Microsoft Edge, Opera e Vivaldi**) que identifica automaticamente o endereço de vídeos em qualquer site **sem precisar abrir o F12 (DevTools)**.

---

## ✨ O que ela detecta automaticamente

1. **Miniatura (Thumb) e Duração (estilo Video DownloadHelper)**:
   - Apresenta miniatura (preview) do vídeo em 16:9, selo da plataforma (𝕏, YouTube, Vimeo, etc.) e etiqueta com a duração exata (`MM:SS`).
2. **Players Embutidos & Plataformas**:
   - **YouTube** (`youtube.com/watch`, `youtube.com/shorts`, `youtube.com/embed/...`, `youtu.be`)
   - **X / Twitter** (`x.com`, `twitter.com`) com extração de MP4 direto com áudio e vídeo combinados
   - **Panda Video** (`tv.pandavideo.com.br`, `b-cdn.net`)
   - **Vimeo** (`player.vimeo.com/video/...`, `[data-vimeo-id]`)
   - **Wistia** (`fast.wistia.net/embed/iframe/...`, `wistia_async_...`, `wistia-player`)
   - **VTurb / ConverteAI** (`scripts.converteai.net`, `cdn.converteai.net/.../main.m3u8`)
   - **Bunny Stream** (`iframe.mediadelivery.net/embed/...`)
   - **Hotmart Player** (`player.hotmart.com`, `cf-embed.play.hotmart.com`)
   - **Cloudflare Stream**, **Loom**, **Vidyard**, **Smartplayer / Scaleup**, **Dailymotion**
3. **Streams de Vídeo (Tráfego de Rede + Scripts Inline)**:
   - **HLS (`.m3u8`)** — identifica tanto a *Master Playlist* quanto as playlists de resolução (`1080p`, `720p`, etc.) e filtra automaticamente os pedaços `.ts` para não poluir a lista.
   - **DASH (`.mpd`)**
4. **Arquivos de Vídeo Diretos**:
   - **`.mp4`, `.webm`, `.mov`, `.m4v`, `.mkv`** e tags `<video>` / `<source>`, exibindo o tamanho em MB quando informado pelo servidor.

---

## 🚀 Recursos de Download e Cópia Rápida

Para cada vídeo ou player encontrado, o painel oferece:
- **⬇️ Baixar**:
  - Se for arquivo direto (`.mp4`, `.webm`), inicia o download imediatamente pelo navegador já com o título da aula/página.
  - Se for stream **`.m3u8`**, abre o **Baixador Integrado de HLS** da própria extensão (permite escolher a resolução da Master Playlist e baixar todos os segmentos no navegador).
- **💻 Botão `yt-dlp`**:
  - Gera e copia o comando completo já com o cabeçalho `--referer` da página/iframe original (essencial para Vimeo privado, Panda Video, Hotmart e Bunny Stream que bloqueiam downloads sem Referer) e `-N 8` (download acelerado em 8 conexões):
    ```bash
    yt-dlp --referer "https://site-da-aula.com/" -N 8 -o "Titulo da Aula.%(ext)s" "URL_DO_VIDEO"
    ```
- **🎬 Botão `ffmpeg`**:
  - Gera e copia o comando pronto com `-headers "Referer: ..."` e cópia direta sem recodificar (`-c copy`):
    ```bash
    ffmpeg -headers "Referer: https://site-da-aula.com/\r\n" -i "URL_DO_VIDEO" -c copy -bsf:a aac_adtstoasc "Titulo da Aula.mp4"
    ```
- **🎯 Localizar**: Rola a página até o player correspondente e destaca a borda dele em roxo.

---

## 🛠️ Como instalar no Chrome / Brave / Edge (leva 30 segundos)

1. Abra o navegador e digite na barra de endereços:
   - **Chrome**: `chrome://extensions`
   - **Brave**: `brave://extensions`
   - **Edge**: `edge://extensions`
2. No canto superior direito, ative a chave **Modo do desenvolvedor** (*Developer mode*).
3. Clique no botão **Carregar sem compactação** (*Load unpacked*) no canto superior esquerdo.
4. Selecione a pasta **`video-finder-extension`**.
5. Pronto! Fixe o ícone do **Video Radar** (ícone roxo de vídeo) na barra do navegador.
