// ============================================================
// hlsDownloadEngine.js
// Concurrent HLS downloader shared by videoProcessor.html (one lecture) and
// the bulk download page (many lectures): manifest → media playlist →
// segments, fetched by a pool of workers and written strictly in order,
// optionally stripped to audio by TSAudioExtractor.
// ============================================================

const HLS_CONCURRENCY = 6; // parallel chunk fetches per download
const HLS_CHUNK_RETRIES = 3;

/**
 * Create an engine for one download.
 * @param {object} [opts]
 * @param {number} [opts.sourceTabId] Scaler tab that proxies fetches
 *   (FETCH_PROXY in videoDownloader.js): the CDN's CORS headers are cut for
 *   the scaler.com origin, so the proxy goes first and a direct fetch is the
 *   fallback when that tab can't be reached.
 * @param {boolean} [opts.directFirst] fetch directly first and use the proxy
 *   only as the fallback. The proxy relays every chunk as a message through
 *   one tab, which caps throughput; when the CDN answers the extension
 *   directly (Scaler serves recordings from www.scaler.com, which the
 *   extension's host permission covers) direct is much faster. After the
 *   first failed direct fetch the engine stays on the proxy.
 * @param {"video"|"audio"|"transcript"} [opts.type] picks the rendition
 * @param {(msg: string) => void} [opts.onLog]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal] stops the download (rejects AbortError)
 */
function createHlsEngine({
  sourceTabId,
  directFirst = false,
  type = "video",
  onLog = () => {},
  onProgress = () => {},
  signal,
} = {}) {
  const hasProxy = Number.isInteger(sourceTabId);
  // Flips to false the first time a direct fetch fails, so a CDN that only
  // answers the proxy costs one wasted request, not one per chunk.
  let tryDirect = directFirst;

  async function directFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res;
  }

  const throwIfAborted = () => {
    if (signal && signal.aborted) throw new DOMException("Download cancelled.", "AbortError");
  };

  // Resolves the proxied payload. Rejects with `unreachable: true` when the
  // source tab is gone (closed, navigated off Scaler, extension reloaded).
  function proxyFetch(url, kind) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(sourceTabId, { action: "FETCH_PROXY", url, type: kind }, (response) => {
        if (chrome.runtime.lastError) {
          const err = new Error(chrome.runtime.lastError.message);
          err.unreachable = true;
          reject(err);
        } else if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || "Proxy fetch failed"));
        }
      });
    });
  }

  async function fetchText(url) {
    if (hasProxy && tryDirect) {
      try {
        return await (await directFetch(url)).text();
      } catch (_) {
        tryDirect = false;
      }
    }
    if (hasProxy) {
      try {
        return await proxyFetch(url, "text");
      } catch (err) {
        if (!err.unreachable) throw err;
        console.error("Proxy error:", err.message);
      }
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  }

  function resolveUrl(base, relative) {
    try {
      return new URL(relative, base).href;
    } catch (e) {
      return relative;
    }
  }

  // ── M3U8 Parsing ──

  function getMediaPlaylistUrl(masterText, baseUrl) {
    const lines = masterText.split("\n").map((l) => l.trim());

    if (!lines[0].startsWith("#EXTM3U")) {
      throw new Error("Invalid M3U8 format");
    }

    // If it already has segments → it IS the media playlist
    if (lines.some((l) => l.startsWith("#EXTINF"))) {
      return baseUrl;
    }

    // ── Master playlist: find best stream ──

    // For AUDIO or TRANSCRIPT: try to find a dedicated audio-only rendition first
    if (type === "audio" || type === "transcript") {
      for (const line of lines) {
        if (line.startsWith("#EXT-X-MEDIA") && line.includes("TYPE=AUDIO")) {
          const match = line.match(/URI="([^"]+)"/);
          if (match && match[1]) {
            onLog("Found dedicated audio rendition in master playlist.");
            return resolveUrl(baseUrl, match[1]);
          }
        }
      }
      onLog("No separate audio rendition found — will demux from video chunks.");
    }

    // Find highest bandwidth video stream
    let bestBandwidth = 0;
    let bestUrl = null;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        if (bwMatch) {
          const bw = parseInt(bwMatch[1], 10);
          if (bw > bestBandwidth) {
            bestBandwidth = bw;
            for (let j = i + 1; j < lines.length; j++) {
              if (lines[j] && !lines[j].startsWith("#")) {
                bestUrl = lines[j];
                break;
              }
            }
          }
        }
      }
    }

    if (!bestUrl) {
      const fallback = lines.find((l) => l && !l.startsWith("#"));
      if (fallback) return resolveUrl(baseUrl, fallback);
      throw new Error("No media streams found in master playlist.");
    }

    return resolveUrl(baseUrl, bestUrl);
  }

  function extractSegments(mediaText, baseUrl) {
    const lines = mediaText.split("\n").map((l) => l.trim());
    const segments = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXTINF")) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] && !lines[j].startsWith("#")) {
            segments.push(resolveUrl(baseUrl, lines[j]));
            break;
          }
        }
      }
    }
    return segments;
  }

  /**
   * Stream URL → its segment URLs (master → best media playlist → segments).
   */
  async function resolveSegments(m3u8Url) {
    onLog("Fetching stream manifest...");
    const masterText = await fetchText(m3u8Url);
    const mediaPlaylistUrl = getMediaPlaylistUrl(masterText, m3u8Url);
    onLog("Media playlist: " + mediaPlaylistUrl.substring(0, 60) + "...");
    const mediaText = await fetchText(mediaPlaylistUrl);
    const segments = extractSegments(mediaText, mediaPlaylistUrl);
    if (segments.length === 0) {
      throw new Error("0 segments found. Streaming format not supported.");
    }
    onLog(`Found ${segments.length} chunks to download.`);
    return segments;
  }

  // ── Fetch a single chunk with retries ──

  async function fetchChunk(url, index) {
    for (let retry = 0; retry < HLS_CHUNK_RETRIES; retry++) {
      throwIfAborted();
      try {
        if (hasProxy && tryDirect) {
          try {
            return await (await directFetch(url)).arrayBuffer();
          } catch (_) {
            tryDirect = false;
          }
        }
        if (hasProxy) {
          try {
            // Reconstitute ArrayBuffer from number array
            return new Uint8Array(await proxyFetch(url, "binary")).buffer;
          } catch (err) {
            if (!err.unreachable) throw err;
          }
        }
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      } catch (e) {
        if (retry < HLS_CHUNK_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
        }
      }
    }
    onLog(`⚠ Chunk ${index + 1} failed after ${HLS_CHUNK_RETRIES} retries. Skipping.`);
    return null;
  }

  function processChunk(raw, audioExtractor) {
    if (raw === null) return new Uint8Array(0); // skip failed chunks
    // Extract only audio bytes from the .ts chunk
    if (audioExtractor) return audioExtractor.extract(raw);
    return new Uint8Array(raw);
  }

  // ── Concurrent Download Engine ──
  //
  // Uses a worker-pool pattern: N workers each grab the next available chunk,
  // fetch it, optionally extract audio, and submit it to the ordered write
  // queue. Chunks are written sequentially even though they download in parallel.

  async function downloadConcurrently(segments, writable, audioExtractor) {
    const total = segments.length;
    let nextToFetch = 0; // shared index for workers to claim chunks
    let nextToWrite = 0; // sequential write pointer
    const buffer = new Map(); // stores out-of-order completed chunks

    // Write queue ensures sequential, non-overlapping writes
    let writeChain = Promise.resolve();

    function flushToFile() {
      writeChain = writeChain.then(async () => {
        while (buffer.has(nextToWrite)) {
          const data = buffer.get(nextToWrite);
          buffer.delete(nextToWrite);
          if (data && data.byteLength > 0) {
            await writable.write(data);
          }
          nextToWrite++;
          onProgress(nextToWrite, total);

          // Log progress milestones
          if (nextToWrite % 50 === 0) {
            onLog(`Progress: ${nextToWrite}/${total} chunks written to disk.`);
          }
        }
      });
      return writeChain;
    }

    // Each worker grabs the next unclaimed chunk, downloads + processes it,
    // then triggers the sequential flush
    async function worker() {
      while (true) {
        throwIfAborted();
        const idx = nextToFetch++;
        if (idx >= total) break;
        const raw = await fetchChunk(segments[idx], idx);
        buffer.set(idx, processChunk(raw, audioExtractor));
        flushToFile(); // don't await — let it queue up
      }
    }

    // Launch N parallel workers
    onLog(`Launching ${HLS_CONCURRENCY} parallel download workers...`);
    const workers = [];
    for (let i = 0; i < HLS_CONCURRENCY; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Final flush for any remaining buffered chunks
    await flushToFile();
    await writeChain;

    onLog(`All ${total} chunks processed.`);
  }

  // ── Concurrent Download to Memory (browsers without the File System Access API) ──

  async function downloadToMemory(segments, audioExtractor) {
    const total = segments.length;
    let nextToFetch = 0;
    let nextToWrite = 0;
    const buffer = new Map();
    const audioChunks = [];
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

    function flush() {
      while (buffer.has(nextToWrite)) {
        const data = buffer.get(nextToWrite);
        buffer.delete(nextToWrite);
        if (data && data.byteLength > 0) {
          audioChunks.push(data);
        }
        nextToWrite++;
        onProgress(nextToWrite, total);
        if (nextToWrite % 50 === 0) {
          onLog(`${typeLabel} download: ${nextToWrite}/${total} chunks.`);
        }
      }
    }

    async function worker() {
      while (true) {
        throwIfAborted();
        const idx = nextToFetch++;
        if (idx >= total) break;
        const raw = await fetchChunk(segments[idx], idx);
        buffer.set(idx, processChunk(raw, audioExtractor));
        flush();
      }
    }

    onLog(`Downloading ${type} (${HLS_CONCURRENCY}x parallel)...`);
    const workers = [];
    for (let i = 0; i < HLS_CONCURRENCY; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    flush();

    // Concatenate all chunks into a single ArrayBuffer
    let totalBytes = 0;
    for (const chunk of audioChunks) totalBytes += chunk.byteLength;
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of audioChunks) {
      combined.set(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    onLog(`${typeLabel} downloaded: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
    return combined.buffer;
  }

  return {
    fetchText,
    getMediaPlaylistUrl,
    extractSegments,
    resolveSegments,
    downloadConcurrently,
    downloadToMemory,
  };
}
