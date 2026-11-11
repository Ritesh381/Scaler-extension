// ============================================================
// customAudioTranscriber.js
// Handles transcription using user-provided API credentials.
// Supports multiple providers based on the URL.
// ============================================================

class CustomAudioTranscriber {
  constructor(baseUrl, apiKey, modelName, logFn) {
    this.baseUrl = baseUrl.trim();
    this.apiKey = apiKey.trim();
    this.modelName = modelName ? modelName.trim() : "";
    this.log = logFn || (() => {});
    // Peak amplitude below this (~ -40 dBFS) is treated as silence. Real
    // lecture speech peaks far above it; digital silence sits near 0. Whisper
    // models hallucinate filler ("Thank you.") on silence, so silent audio
    // must be detected rather than transcribed.
    this.silencePeakThreshold = 0.01;
    // Stretches of audio that couldn't be decoded in the current run.
    this._decodeFailures = 0;
  }

  /**
   * The model a run actually uses: the one typed in, or the provider's default
   * when the field is blank. Decided from the base URL, exactly like the
   * request dispatch, so the cache can record (and match on) what really ran.
   */
  static resolveModel(baseUrl, modelName) {
    const typed = (modelName || "").trim();
    if (typed) return typed;
    const url = (baseUrl || "").trim();
    if (url.includes("deepgram.com")) return "nova-3";
    if (url.includes("elevenlabs.io")) return "scribe_v2";
    return url.includes("groq.com") ? "whisper-large-v3-turbo" : "gpt-transcribe";
  }

  // ── Helper: Remove Repetitions ──
  _removeRepetitions(text) {
    if (!text || text.length < 20) return text;
    const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    if (sentences.length < 3) return text;

    const cleaned = [sentences[0]];
    let repeatCount = 0;
    const MAX_REPEATS = 2;

    for (let i = 1; i < sentences.length; i++) {
      const prev = cleaned[cleaned.length - 1].trim().toLowerCase();
      const curr = sentences[i].trim().toLowerCase();

      if (curr === prev) {
        repeatCount++;
        if (repeatCount < MAX_REPEATS) cleaned.push(sentences[i]);
      } else {
        repeatCount = 0;
        cleaned.push(sentences[i]);
      }
    }

    let result = cleaned.join(" ");
    result = result.replace(/\b(\w+(?:\s+\w+){0,3})(?:\s+\1){2,}/gi, "$1");
    result = result.replace(/(\b\w+(?:\s+\w+){0,4},)(?:\s*\1){2,}/gi, "$1");
    return result.trim();
  }

  // ── Main Entry (legacy: accepts one combined ArrayBuffer) ──
  // For large lectures use transcribeFromSegments() instead.
  async transcribe(audioBuffer, onProgress) {
    if (!this.baseUrl) throw new Error("Base URL is required.");
    if (!this.apiKey) throw new Error("API Key is required.");

    this.log("Starting parallel transcription process...");
    this._decodeFailures = 0;

    const wavBlobs = await this._prepareWavBlobs(audioBuffer);
    if (!wavBlobs || wavBlobs.length === 0) {
      throw new Error("Failed to decode audio into a supported format.");
    }
    return this._transcribeWavBlobs(wavBlobs, onProgress);
  }

  // ── Segment-based entry (used for large lectures) ──────────────────────
  // Accepts an array of per-segment Uint8Arrays (output of downloadPartAudio).
  // Combines them in batches of BATCH_SEGMENTS, decodes each batch
  // independently, and feeds the resulting WAV blobs straight to the upload
  // workers. Decoding stays at most a few blobs ahead of the uploads, so the
  // lecture's WAV audio is never all held at once. Chunk boundaries and the
  // order of the joined text are the same as decoding everything first.
  //
  // Consumed entries of `audioSegments` are set to null to free them early;
  // callers must not reuse the array.
  async transcribeFromSegments(audioSegments, onProgress) {
    if (!this.baseUrl) throw new Error("Base URL is required.");
    if (!this.apiKey) throw new Error("API Key is required.");

    this.log("Starting parallel transcription process...");
    this._decodeFailures = 0;

    // ~200 TS segments ≈ 200 × 4s = ~800s ≈ 13 min of audio per batch.
    // Each batch produces a combined buffer of ~10–30 MB — well within the
    // browser's Web Audio API limits. Adjust down if memory is still tight.
    const BATCH_SEGMENTS = 200;
    // WAV blobs decoded but not yet picked up by an upload worker.
    const MAX_QUEUED_BLOBS = 6;
    const totalSegments = audioSegments.length;
    const numBatches = Math.ceil(totalSegments / BATCH_SEGMENTS);

    this.log(`Processing ${totalSegments} segments in ${numBatches} batch(es) of up to ${BATCH_SEGMENTS}...`);

    const queue = []; // { index, blob, peak } waiting for a worker
    const peaks = [];
    const transcriptParts = [];
    let produced = 0; // WAV blobs decoded so far (= next blob index)
    let consumedSegments = 0;
    let producing = true;
    let completedCount = 0;
    let silentChunks = 0;
    let hasFailures = false;
    let waiters = [];
    const waitForChange = () => new Promise((resolve) => waiters.push(resolve));
    const notify = () => {
      const parked = waiters;
      waiters = [];
      parked.forEach((resolve) => resolve());
    };
    // Total blobs isn't known until the last batch decodes; extrapolate from
    // the segments consumed so progress doesn't hit 100% early.
    const estimatedTotal = () =>
      producing && consumedSegments > 0
        ? Math.max(produced, Math.round((produced * totalSegments) / consumedSegments))
        : produced;

    const produce = async () => {
      try {
        for (let b = 0; b < numBatches; b++) {
          const start = b * BATCH_SEGMENTS;
          const end = Math.min(start + BATCH_SEGMENTS, totalSegments);
          const batch = audioSegments.slice(start, end);
          // The batch slice is the only reference left; drop the caller's.
          audioSegments.fill(null, start, end);

          this.log(`Decoding batch ${b + 1}/${numBatches} (segments ${start + 1}–${end})...`);
          const batchBlobs = await this._decodeSegmentBatch(batch, b);
          batch.length = 0;
          consumedSegments = end;

          for (const item of batchBlobs) {
            while (queue.length >= MAX_QUEUED_BLOBS) await waitForChange();
            peaks.push(item.peak);
            queue.push({ index: produced++, blob: item.blob, peak: item.peak });
            notify();
          }
        }
      } finally {
        producing = false;
        notify();
      }
    };

    const worker = async () => {
      while (true) {
        if (!queue.length) {
          if (!producing) return;
          await waitForChange();
          continue;
        }
        const { index, blob, peak } = queue.shift();
        notify(); // room for the decoder
        const outcome = await this._transcribeChunk(blob, peak, index);
        transcriptParts[index] = outcome.text;
        if (outcome.silent) silentChunks++;
        if (outcome.failed) hasFailures = true;
        completedCount++;
        const total = estimatedTotal();
        const pct = Math.min(100, (completedCount / total) * 100).toFixed(1);
        if (onProgress) onProgress(parseFloat(pct), completedCount, total);
        this.log(`Chunk ${index + 1} ${outcome.label}. Progress: ${completedCount}/${total} completed (${pct}%)`);
      }
    };

    this.log("Spawning 5 parallel worker(s) for transcription...");
    const workers = [];
    for (let w = 0; w < 5; w++) workers.push(worker());
    // Workers only exit once production is over, so a decode error can't
    // leave them parked.
    const production = produce();
    await Promise.all([production, ...workers]);

    if (produced === 0) {
      throw new Error("Failed to decode audio into a supported format.");
    }
    // Silent chunks are never uploaded, so an all-silent lecture has cost
    // nothing by the time it is detected here.
    if (this._isAllSilent(peaks.map((peak) => ({ peak })))) {
      throw this._silentError();
    }
    if (silentChunks > 0) {
      this.log(`⚠ ${silentChunks}/${produced} chunk(s) were silent and skipped.`);
    }
    if (this._decodeFailures > 0) {
      this.log(`⚠ ${this._decodeFailures} stretch(es) of audio could not be decoded — the transcript has gaps.`);
    }

    const fullText = transcriptParts.filter((p) => p && p.length > 0).join(" ");
    return {
      text: this._removeRepetitions(fullText),
      // Undecodable audio is a gap too: don't cache the result as complete.
      hasFailures: hasFailures || this._decodeFailures > 0,
      silentChunks: silentChunks,
    };
  }

  /**
   * Decode one batch of per-segment AAC into WAV blobs; on failure, retry its
   * two halves independently. Every stretch that can't be decoded (including
   * an empty batch) is counted in this._decodeFailures.
   * @param {Uint8Array[]} batch
   * @param {number} b batch index, for logs
   */
  async _decodeSegmentBatch(batch, b) {
    let totalBytes = 0;
    for (const seg of batch) totalBytes += seg.byteLength;

    // An empty batch is an extraction failure, not a decode failure. Halving
    // it and retrying just produces the same error twice with a misleading
    // message, so bail out with the real reason.
    if (totalBytes === 0) {
      this.log(`⚠ Batch ${b + 1}: 0 bytes of audio extracted — segments were empty, not a decode problem.`);
      this._decodeFailures++;
      return [];
    }

    try {
      return (await this._prepareWavBlobs(this._concatUint8Arrays(batch))) || [];
    } catch (e) {
      this.log(`⚠ Batch ${b + 1} decode failed (${e.message}). Trying smaller sub-batches...`);
    }
    // Halve the batch and retry each half independently
    const blobs = [];
    const half = Math.ceil(batch.length / 2);
    for (const subBatch of [batch.slice(0, half), batch.slice(half)]) {
      if (subBatch.length === 0) continue;
      try {
        const subBlobs = await this._prepareWavBlobs(this._concatUint8Arrays(subBatch));
        if (subBlobs) blobs.push(...subBlobs);
      } catch (se) {
        this.log(`⚠ Sub-batch decode also failed: ${se.message}. Skipping.`);
        this._decodeFailures++;
      }
    }
    return blobs;
  }

  _silentError() {
    return new Error(
      "Decoded audio is silent — the audio track could not be extracted from the lecture stream. " +
        "If this lecture already has a transcript, download it from the versions page; otherwise try re-downloading.",
    );
  }

  /**
   * Transcribe one WAV chunk with retries. Silent chunks are skipped (Whisper
   * hallucinates filler on silence).
   * @returns {Promise<{text: string, silent: boolean, failed: boolean, label: string}>}
   */
  async _transcribeChunk(blob, peak, i) {
    if (peak < this.silencePeakThreshold) {
      return { text: "", silent: true, failed: false, label: "skipped (silent)" };
    }
    const isDeepgram = this.baseUrl.includes("deepgram.com");
    const isElevenLabs = this.baseUrl.includes("elevenlabs.io");

    let text = "";
    // Whether the model actually answered — separate from whether it had
    // anything to say. An audible chunk can still hold no speech (noise,
    // music, a slide nobody is talking over) and Whisper answers "" for
    // it. Inferring failure from empty text marked those runs as broken
    // and blocked the cache save for an otherwise complete transcript.
    let answered = false;
    const MAX_RETRIES = 3;

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      try {
        if (isDeepgram) {
          text = await this._transcribeDeepgram(blob);
        } else if (isElevenLabs) {
          text = await this._transcribeElevenLabs(blob);
        } else {
          const model = CustomAudioTranscriber.resolveModel(this.baseUrl, this.modelName);
          text = await this._transcribeOpenAICompatible(blob, model);
        }
        answered = true;
        break;
      } catch (err) {
        const is429 = /\b429\b/.test(err.message);
        this.log(`❌ Chunk ${i + 1} attempt ${retry + 1} failed: ${err.message}`);
        if (retry < MAX_RETRIES - 1) {
          const backoffTime = is429
            ? (retry === 0 ? 60_000 : 240_000)
            : 2000 * (retry + 1);
          const waitLabel = backoffTime >= 60_000
            ? `${(backoffTime / 60_000).toFixed(0)} min`
            : `${backoffTime / 1000}s`;
          this.log(
            is429
              ? `⏳ Rate limited (429) — waiting ${waitLabel} before retry...`
              : `Waiting ${waitLabel} before retry...`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffTime));
        }
      }
    }

    const result = answered ? (text || "").trim() : "";
    // The old line said "transcribed" for every outcome, so a run that
    // refused to save looked identical to one that succeeded.
    const label = !answered
      ? `failed after ${MAX_RETRIES} attempts`
      : result
        ? "transcribed"
        : "transcribed (no speech)";
    return { text: result, silent: false, failed: !answered, label };
  }

  // ── Transcription worker pool over already-prepared WAV blobs (legacy path) ──
  async _transcribeWavBlobs(wavBlobs, onProgress) {
    if (this._isAllSilent(wavBlobs)) throw this._silentError();

    const totalChunks = wavBlobs.length;
    const transcriptParts = new Array(totalChunks);

    let nextChunkIndex = 0;
    let completedCount = 0;
    let hasFailures = false;
    let silentChunks = 0;

    const worker = async () => {
      while (nextChunkIndex < totalChunks) {
        const i = nextChunkIndex++;
        const { blob, peak } = wavBlobs[i];
        const outcome = await this._transcribeChunk(blob, peak, i);
        transcriptParts[i] = outcome.text;
        if (outcome.silent) silentChunks++;
        if (outcome.failed) hasFailures = true;

        completedCount++;
        const pct = ((completedCount / totalChunks) * 100).toFixed(1);
        if (onProgress) onProgress(parseFloat(pct), completedCount, totalChunks);
        this.log(`Chunk ${i + 1} ${outcome.label}. Progress: ${completedCount}/${totalChunks} completed (${pct}%)`);
      }
    };

    const concurrency = Math.min(5, totalChunks);
    this.log(`Spawning ${concurrency} parallel worker(s) for transcription...`);
    const workers = [];
    for (let w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);

    if (silentChunks > 0) {
      this.log(`⚠ ${silentChunks}/${totalChunks} chunk(s) were silent and skipped.`);
    }

    let fullText = transcriptParts.filter((p) => p && p.length > 0).join(" ");
    return {
      text: this._removeRepetitions(fullText),
      hasFailures: hasFailures || this._decodeFailures > 0,
      silentChunks: silentChunks,
    };
  }

  /**
   * Decodes raw AAC/ADTS audio in bounded-size chunks (never the full lecture at once).
   * Each chunk is resampled to 16kHz mono and split into WAV blobs (<25MB each).
   */
  async _prepareWavBlobs(rawAudioBuffer) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const frames = this._extractAdtsFrames(new Uint8Array(rawAudioBuffer));
      if (frames.length > 0) {
        this.log(`Decoding audio in ADTS chunks (${frames.length} frames)...`);
        return await this._decodeAdtsInChunks(frames, audioCtx);
      }

      // Non-ADTS fallback (e.g. MP3): only safe for small buffers — never a full lecture.
      const SMALL_BUFFER_MAX_BYTES = 8 * 1024 * 1024;
      if (rawAudioBuffer.byteLength <= SMALL_BUFFER_MAX_BYTES) {
        this.log("No ADTS frames — decoding small non-ADTS buffer directly...");
        const decodedBuffer = await audioCtx.decodeAudioData(rawAudioBuffer.slice(0));
        return await this._resampleToWavBlobs(decodedBuffer);
      }

      this.log("⚠ No ADTS frames in large buffer — refusing full-buffer decode.");
      return [];
    } finally {
      if (audioCtx.close) await audioCtx.close();
    }
  }

  /**
   * Returns true when every WAV chunk's peak amplitude is below the silence
   * threshold (i.e. the decoded audio carries no usable speech).
   */
  _isAllSilent(wavBlobs) {
    if (!wavBlobs || wavBlobs.length === 0) return false;
    let maxPeak = 0;
    for (const w of wavBlobs) {
      if (w.peak > maxPeak) maxPeak = w.peak;
    }
    this.log(`Peak audio amplitude: ${maxPeak.toFixed(4)} (silence threshold: ${this.silencePeakThreshold})`);
    return maxPeak < this.silencePeakThreshold;
  }

  async _resampleToWavBlobs(decodedBuffer) {
    this.log(`Decoded duration: ${Math.round(decodedBuffer.duration)} seconds. Resampling to 16kHz Mono...`);

    const TARGET_SAMPLE_RATE = 16000;
    const totalSamples = Math.ceil(decodedBuffer.duration * TARGET_SAMPLE_RATE);

    const offlineCtx = new OfflineAudioContext(1, totalSamples, TARGET_SAMPLE_RATE);
    const bufferSource = offlineCtx.createBufferSource();
    bufferSource.buffer = decodedBuffer;
    bufferSource.connect(offlineCtx.destination);
    bufferSource.start();

    const resampledBuffer = await offlineCtx.startRendering();

    // 10 minutes per chunk (600 seconds) => ~19.2 MB WAV files at 16kHz mono
    const CHUNK_DURATION_SEC = 600;
    const samplesPerChunk = CHUNK_DURATION_SEC * TARGET_SAMPLE_RATE;
    const totalChunks = Math.ceil(totalSamples / samplesPerChunk);

    this.log(`Splitting resampled audio into ${totalChunks} chunk(s) of ~10 minutes each...`);
    const wavBlobs = [];
    const channelData = resampledBuffer.getChannelData(0);

    for (let i = 0; i < totalChunks; i++) {
      const startSample = i * samplesPerChunk;
      const endSample = Math.min(startSample + samplesPerChunk, totalSamples);
      const slice = channelData.subarray(startSample, endSample);

      // Track peak amplitude so silent chunks can be detected downstream.
      let peak = 0;
      for (let s = 0; s < slice.length; s++) {
        const abs = slice[s] < 0 ? -slice[s] : slice[s];
        if (abs > peak) peak = abs;
      }

      const wavArrayBuffer = this._rawPcmToWav(slice, TARGET_SAMPLE_RATE);
      wavBlobs.push({ blob: new Blob([wavArrayBuffer], { type: "audio/wav" }), peak });
    }

    return wavBlobs;
  }

  /**
   * @param {Uint8Array[]} frames ADTS frames (views into the raw buffer)
   * @param {AudioContext} audioCtx
   */
  async _decodeAdtsInChunks(frames, audioCtx) {
    if (frames.length === 0) {
      this.log("⚠ No ADTS frames detected in raw audio.");
      return [];
    }

    const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
    const chunkBuffers = this._buildAdtsChunks(frames, MAX_CHUNK_BYTES);
    const wavBlobs = [];

    this.log(`Processing ${chunkBuffers.length} ADTS chunk(s) (max ${MAX_CHUNK_BYTES / 1024 / 1024} MB each)...`);

    for (let i = 0; i < chunkBuffers.length; i++) {
      // decodeAudioData detaches its input; the chunk isn't needed after, so
      // hand it over instead of a copy and drop our reference.
      const chunk = chunkBuffers[i];
      chunkBuffers[i] = null;
      try {
        const decoded = await audioCtx.decodeAudioData(chunk);
        const chunkWavs = await this._resampleToWavBlobs(decoded);
        for (const item of chunkWavs) wavBlobs.push(item);
      } catch (e) {
        this.log(`⚠ Chunked decode failed for part ${i + 1}: ${e.message}`);
        this._decodeFailures = (this._decodeFailures || 0) + 1;
      }
    }

    return wavBlobs;
  }

  _extractAdtsFrames(data) {
    const frames = [];
    let i = 0;

    while (i < data.length - 7) {
      if (data[i] === 0xff && (data[i + 1] & 0xf0) === 0xf0) {
        const frameLen =
          ((data[i + 3] & 0x03) << 11) |
          (data[i + 4] << 3) |
          ((data[i + 5] >> 5) & 0x07);

        if (frameLen > 0 && i + frameLen <= data.length) {
          frames.push(data.subarray(i, i + frameLen));
          i += frameLen;
          continue;
        }
      }
      i++;
    }

    return frames;
  }

  _buildAdtsChunks(frames, maxBytes) {
    const chunks = [];
    let current = [];
    let currentSize = 0;

    for (const frame of frames) {
      if (currentSize + frame.length > maxBytes && current.length > 0) {
        chunks.push(this._concatUint8Arrays(current));
        current = [];
        currentSize = 0;
      }
      current.push(frame);
      currentSize += frame.length;
    }

    if (current.length > 0) chunks.push(this._concatUint8Arrays(current));
    return chunks;
  }

  _concatUint8Arrays(parts) {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out.buffer;
  }

  _rawPcmToWav(channelData, sampleRate) {
    const format = 1; // raw PCM
    const numOfChan = 1; // mono
    const bitDepth = 16;
    
    const resultLength = channelData.length * 2 + 44;
    const arrayBuffer = new ArrayBuffer(resultLength);
    const view = new DataView(arrayBuffer);
    
    // RIFF identifier
    view.setUint32(0, 0x52494646, false);
    // file length minus RIFF identifier length
    view.setUint32(4, resultLength - 8, true);
    // RIFF type
    view.setUint32(8, 0x57415645, false);
    // format chunk identifier
    view.setUint32(12, 0x666d7420, false);
    // format chunk length
    view.setUint32(16, 16, true);
    // sample format (raw PCM)
    view.setUint16(20, format, true);
    // channel count
    view.setUint16(22, numOfChan, true);
    // sample rate
    view.setUint32(24, sampleRate, true);
    // byte rate (sample rate * block align)
    view.setUint32(28, sampleRate * numOfChan * 2, true);
    // block align (channel count * bytes per sample)
    view.setUint16(32, numOfChan * 2, true);
    // bits per sample
    view.setUint16(34, bitDepth, true);
    // data chunk identifier
    view.setUint32(36, 0x64617461, false);
    // chunk length
    view.setUint32(40, resultLength - 44, true);
    
    let offset = 44;
    for (let pos = 0; pos < channelData.length; pos++) {
      let sample = channelData[pos];
      sample = Math.max(-1, Math.min(1, sample));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
    
    return arrayBuffer;
  }



  async _transcribeOpenAICompatible(blob, defaultModel) {
    const filename = blob.type === "audio/mpeg" ? "audio.m4a" : "audio.wav";
    const formData = new FormData();
    formData.append("model", defaultModel);
    formData.append("file", blob, filename);

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return data.text;
  }

  async _transcribeDeepgram(blob) {
    const model = CustomAudioTranscriber.resolveModel(this.baseUrl, this.modelName);
    const contentType = blob.type === "audio/mpeg" ? "audio/mpeg" : "audio/wav";
    const res = await fetch(`${this.baseUrl}?model=${encodeURIComponent(model)}&smart_format=true`, {
      method: "POST",
      headers: {
        Authorization: `Token ${this.apiKey}`,
        "Content-Type": contentType,
      },
      body: blob,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return data.results?.channels[0]?.alternatives[0]?.transcript || "";
  }

  async _transcribeElevenLabs(blob) {
    const filename = blob.type === "audio/mpeg" ? "audio.m4a" : "audio.wav";

    const formData = new FormData();
    formData.append("model_id", CustomAudioTranscriber.resolveModel(this.baseUrl, this.modelName));
    formData.append("file", blob, filename);

    const res = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "xi-api-key": this.apiKey,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();
    return data.text;
  }
}
