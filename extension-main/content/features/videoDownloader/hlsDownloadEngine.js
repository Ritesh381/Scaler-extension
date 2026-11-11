// ============================================================
// hlsDownloadEngine.js
// Concurrent HLS downloader shared by videoProcessor.html (one lecture) and
// the bulk download page (many lectures): manifest → media playlist →
// segments, fetched by a pool of workers and written strictly in order,
// optionally stripped to audio by TSAudioExtractor.
// ============================================================

const HLS_CONCURRENCY = 6; // parallel chunk fetches per download
const HLS_CHUNK_RETRIES = 3;
// A stalled request would otherwise pin a worker (and, through the reorder
// window, the whole download) forever. Each attempt gets this long.
const HLS_CHUNK_TIMEOUT_MS = 60000;
// Workers may run at most this many chunks ahead of the write pointer, so one
// slow chunk can't make the reorder buffer grow without bound.
const HLS_REORDER_WINDOW = HLS_CONCURRENCY * 2;
// downloadToMemory folds chunks into a Blob part every this many bytes: the
// bytes move to the browser's blob store and leave the JS heap.
const HLS_MEMORY_FLUSH_BYTES = 32 * 1024 * 1024;

/**
 * Bytes from a FETCH_PROXY reply. The proxy sends base64 (`encoding:
 * "base64"`) because extension messaging is JSON: a number array costs 4–8x
 * the payload. Older content scripts still send a number array.
 * @param {string|number[]} data
 * @param {string} [encoding]
 * @returns {ArrayBuffer}
 */
function hlsDecodeProxyBytes(data, encoding) {
  if (encoding === "base64" && typeof data === "string") {
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(data).buffer;
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  return new Uint8Array(data || []).buffer;
}

/**
 * Pick a variant from a master playlist's #EXT-X-STREAM-INF entries.
 * Video wants the highest bandwidth. Audio/transcript (no separate audio
 * rendition) only need the muxed audio track, which is normally identical
 * across variants, so they take the lowest bandwidth one that carries audio —
 * a fraction of the bytes for the same sound.
 * @param {string[]} lines trimmed playlist lines
 * @param {boolean} audioOnly
 * @returns {string|null} the variant's (unresolved) URI
 */
function hlsPickVariant(lines, audioOnly) {
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
    if (!bwMatch) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
    if (!uri) continue;
    const codecs = (lines[i].match(/CODECS="([^"]*)"/) || [])[1];
    variants.push({ bandwidth: parseInt(bwMatch[1], 10), uri, codecs });
  }
  if (!variants.length) return null;

  let pool = variants;
  if (audioOnly) {
    // A variant that declares its codecs without mp4a has no AAC to extract.
    const withAac = variants.filter((v) => v.codecs && v.codecs.includes("mp4a"));
    const undeclared = variants.filter((v) => !v.codecs);
    pool = withAac.length ? withAac : undeclared.length ? undeclared : variants;
  }
  // Ties keep the first listed, as the old strict ">" scan did.
  let best = pool[0];
  for (const v of pool) {
    if (audioOnly ? v.bandwidth < best.bandwidth : v.bandwidth > best.bandwidth) best = v;
  }
  return best.uri;
}

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
 * @param {number} [opts.chunkTimeoutMs] per-attempt fetch timeout
 */
function createHlsEngine({
  sourceTabId,
  directFirst = false,
  type = "video",
  onLog = () => {},
  onProgress = () => {},
  signal,
  chunkTimeoutMs = HLS_CHUNK_TIMEOUT_MS,
} = {}) {
  const hasProxy = Number.isInteger(sourceTabId);
  const audioOnly = type === "audio" || type === "transcript";
  // Flips to false the first time a direct fetch fails, so a CDN that only
  // answers the proxy costs one wasted request, not one per chunk.
  let tryDirect = directFirst;
  // Why the most recent chunk gave up; a dead source tab and a 403 otherwise
  // look identical in the logs.
  let lastChunkError = null;
  let chunkFailures = 0;
  // Whether the last resolved master playlist had a separate audio rendition
  // (then the video variant's segments may carry no audio at all).
  let separateAudio = false;

  const abortError = () => new DOMException("Download cancelled.", "AbortError");

  const throwIfAborted = (extra) => {
    if ((signal && signal.aborted) || (extra && extra.aborted)) throw abortError();
  };

  /**
   * fetch + read the body under one timeout, also cut short by `stop`.
   * @param {string} url
   * @param {"text"|"arrayBuffer"} read
   * @param {AbortSignal} [stop]
   */
  async function timedFetch(url, read, stop) {
    const ctrl = new AbortController();
    const onStop = () => ctrl.abort();
    const sources = [signal, stop].filter(Boolean);
    sources.forEach((s) => (s.aborted ? ctrl.abort() : s.addEventListener("abort", onStop, { once: true })));
    const timer = setTimeout(() => ctrl.abort(), chunkTimeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      return await res[read]();
    } finally {
      clearTimeout(timer);
      sources.forEach((s) => s.removeEventListener("abort", onStop));
    }
  }

  // Resolves the proxied payload. Rejects with `unreachable: true` when the
  // source tab is gone (closed, navigated off Scaler, extension reloaded).
  // A message can't be cancelled, so a timeout just stops waiting for it.
  function proxyFetch(url, kind) {
    let timer = null;
    const request = new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(sourceTabId, { action: "FETCH_PROXY", url, type: kind }, (response) => {
        if (chrome.runtime.lastError) {
          const err = new Error(chrome.runtime.lastError.message);
          err.unreachable = true;
          reject(err);
        } else if (response && response.success) {
          resolve(kind === "text" ? response.data : hlsDecodeProxyBytes(response.data, response.encoding));
        } else {
          reject(new Error(response?.error || "Proxy fetch failed"));
        }
      });
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Proxy fetch timed out")), chunkTimeoutMs);
    });
    return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * One attempt: direct (when preferred) → proxy → direct.
   * @param {string} url
   * @param {"text"|"binary"} kind
   * @param {AbortSignal} [stop]
   */
  async function fetchOnce(url, kind, stop) {
    const read = kind === "text" ? "text" : "arrayBuffer";
    if (hasProxy && tryDirect) {
      try {
        return await timedFetch(url, read, stop);
      } catch (_) {
        throwIfAborted(stop);
        tryDirect = false;
      }
    }
    if (hasProxy) {
      try {
        return await proxyFetch(url, kind);
      } catch (err) {
        if (!err.unreachable) throw err;
        if (kind === "text") console.error("Proxy error:", err.message);
      }
    }
    return timedFetch(url, read, stop);
  }

  async function fetchText(url) {
    return fetchOnce(url, "text");
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
      separateAudio = false;
      return baseUrl;
    }

    // ── Master playlist: find best stream ──
    const audioRendition = lines.find(
      (l) => l.startsWith("#EXT-X-MEDIA") && l.includes("TYPE=AUDIO") && /URI="[^"]+"/.test(l),
    );
    separateAudio = !!audioRendition;

    // For AUDIO or TRANSCRIPT: a dedicated audio-only rendition beats demuxing
    if (audioOnly) {
      if (audioRendition) {
        onLog("Found dedicated audio rendition in master playlist.");
        return resolveUrl(baseUrl, audioRendition.match(/URI="([^"]+)"/)[1]);
      }
      onLog("No separate audio rendition found — will demux from the lightest variant with audio.");
    }

    const variantUrl = hlsPickVariant(lines, audioOnly);
    if (!variantUrl) {
      const fallback = lines.find((l) => l && !l.startsWith("#"));
      if (fallback) return resolveUrl(baseUrl, fallback);
      throw new Error("No media streams found in master playlist.");
    }

    return resolveUrl(baseUrl, variantUrl);
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
   * Stream URL → its segment URLs (master → chosen media playlist → segments)
   * plus the media playlist text, for format checks.
   * @returns {Promise<{segments: string[], mediaText: string, separateAudio: boolean}>}
   */
  async function resolveStream(m3u8Url) {
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
    return { segments, mediaText, separateAudio };
  }

  /**
   * Stream URL → its segment URLs (master → best media playlist → segments).
   */
  async function resolveSegments(m3u8Url) {
    return (await resolveStream(m3u8Url)).segments;
  }

  // ── Fetch a single chunk with retries ──

  /**
   * @returns {Promise<ArrayBuffer|null>} null once every retry failed
   */
  async function fetchChunk(url, index, stop) {
    for (let retry = 0; retry < HLS_CHUNK_RETRIES; retry++) {
      throwIfAborted(stop);
      try {
        return await fetchOnce(url, "binary", stop);
      } catch (e) {
        throwIfAborted(stop);
        lastChunkError = e;
        if (retry < HLS_CHUNK_RETRIES - 1) {
          // Backoff that ends early on stop, so a failed write or a cancel
          // doesn't wait out the retry delay.
          await new Promise((resolve) => {
            const done = () => {
              clearTimeout(timer);
              if (stop) stop.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 1000 * (retry + 1));
            if (stop) stop.addEventListener("abort", done, { once: true });
          });
        }
      }
    }
    // Capped: a dead CDN would otherwise log one line per chunk, for hundreds.
    chunkFailures++;
    if (chunkFailures <= 5) {
      onLog(
        `⚠ Chunk ${index + 1} failed after ${HLS_CHUNK_RETRIES} retries ` +
          `(${lastChunkError?.message || "unknown error"}). Skipping.`,
      );
    } else if (chunkFailures === 6) {
      onLog("⚠ More chunks failed; not logging each one.");
    }
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
  // Worker pool: N workers each claim the next chunk, fetch it, transform it,
  // and park it in a reorder buffer; one writer drains that buffer strictly
  // in order. Workers stay within HLS_REORDER_WINDOW of the writer, and the
  // first error (a failed write, an abort) stops every worker and is thrown
  // once, after they have all settled.

  /**
   * @param {string[]} segments
   * @param {(raw: ArrayBuffer|null, index: number) => *} transform
   * @param {(data: *, index: number) => (void|Promise<void>)} sink
   * @param {string} [label] progress log prefix
   */
  async function downloadOrdered(segments, transform, sink, label = "Progress") {
    const total = segments.length;
    let nextToFetch = 0; // shared index for workers to claim chunks
    let nextToWrite = 0; // sequential write pointer
    const ready = new Map(); // finished chunks waiting for their turn
    let failure = null;
    let writing = false;
    let writeDone = Promise.resolve();
    let waiters = []; // workers parked on a full window
    // Aborts in-flight fetches once anything has failed.
    const stopCtrl = new AbortController();

    const wake = () => {
      const parked = waiters;
      waiters = [];
      parked.forEach((resolve) => resolve());
    };
    const fail = (err) => {
      if (!failure) failure = err;
      stopCtrl.abort();
      wake();
    };
    const onAbort = () => fail(abortError());
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    // Single writer: `writing` flips back synchronously when the loop ends, so
    // a chunk parked after that always starts a new drain.
    function drain() {
      if (writing) return writeDone;
      writing = true;
      writeDone = (async () => {
        try {
          while (!failure && ready.has(nextToWrite)) {
            const data = ready.get(nextToWrite);
            ready.delete(nextToWrite);
            await sink(data, nextToWrite);
            nextToWrite++;
            onProgress(nextToWrite, total);
            if (nextToWrite % 50 === 0) {
              onLog(`${label}: ${nextToWrite}/${total} chunks.`);
            }
            wake();
          }
        } catch (err) {
          fail(err);
        } finally {
          writing = false;
        }
      })();
      return writeDone;
    }

    async function worker() {
      while (!failure) {
        // Backpressure: don't run more than the window ahead of the writer.
        while (!failure && nextToFetch - nextToWrite >= HLS_REORDER_WINDOW) {
          await new Promise((resolve) => waiters.push(resolve));
        }
        if (failure) return;
        const idx = nextToFetch++;
        if (idx >= total) return;
        const raw = await fetchChunk(segments[idx], idx, stopCtrl.signal);
        if (failure) return;
        ready.set(idx, transform(raw, idx));
        drain(); // don't await — let the writer catch up on its own
      }
    }

    try {
      const workers = [];
      for (let i = 0; i < HLS_CONCURRENCY; i++) {
        workers.push(worker().catch(fail));
      }
      await Promise.all(workers);
      await drain();
      await writeDone;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      ready.clear();
    }
    if (failure) throw failure;
  }

  /**
   * Stream every chunk to `writable` in order. With `tee` the same raw chunks
   * also feed a second output (e.g. the audio of a video being saved), so a
   * lecture wanted as both is downloaded once.
   * @param {string[]} segments
   * @param {{write: (data: Uint8Array) => Promise<void>}} writable
   * @param {TSAudioExtractor|null} [audioExtractor]
   * @param {{writable: object, extractor: TSAudioExtractor|null}} [tee]
   */
  async function downloadConcurrently(segments, writable, audioExtractor, tee) {
    onLog(`Launching ${HLS_CONCURRENCY} parallel download workers...`);
    await downloadOrdered(
      segments,
      (raw) =>
        tee
          ? [processChunk(raw, audioExtractor), processChunk(raw, tee.extractor)]
          : processChunk(raw, audioExtractor),
      async (data) => {
        const [main, extra] = tee ? data : [data];
        if (main.byteLength > 0) await writable.write(main);
        if (tee && extra.byteLength > 0) await tee.writable.write(extra);
      },
      "Progress",
    );
    onLog(`All ${segments.length} chunks processed.`);
  }

  // ── Concurrent Download to Memory (browsers without the File System Access API) ──

  /**
   * Download every chunk into one Blob. Chunks are folded into Blob parts as
   * they arrive (never concatenated into one big buffer), so the JS heap
   * holds at most ~HLS_MEMORY_FLUSH_BYTES plus the reorder window.
   * @returns {Promise<Blob>}
   */
  async function downloadToMemory(segments, audioExtractor, mimeType = "") {
    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
    const parts = [];
    let pending = [];
    let pendingBytes = 0;
    let totalBytes = 0;
    const fold = () => {
      if (!pending.length) return;
      parts.push(new Blob(pending));
      pending = [];
      pendingBytes = 0;
    };

    onLog(`Downloading ${type} (${HLS_CONCURRENCY}x parallel)...`);
    await downloadOrdered(
      segments,
      (raw) => processChunk(raw, audioExtractor),
      (data) => {
        if (data.byteLength === 0) return;
        pending.push(data);
        pendingBytes += data.byteLength;
        totalBytes += data.byteLength;
        if (pendingBytes >= HLS_MEMORY_FLUSH_BYTES) fold();
      },
      `${typeLabel} download`,
    );
    fold();
    const blob = new Blob(parts, { type: mimeType });
    parts.length = 0;

    onLog(`${typeLabel} downloaded: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
    return blob;
  }

  return {
    fetchText,
    fetchChunk,
    getMediaPlaylistUrl,
    extractSegments,
    resolveStream,
    resolveSegments,
    downloadOrdered,
    downloadConcurrently,
    downloadToMemory,
    /** Why the most recent chunk fetch gave up (or null). */
    lastChunkError: () => lastChunkError,
  };
}
