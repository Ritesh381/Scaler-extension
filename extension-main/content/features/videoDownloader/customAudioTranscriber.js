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

    const wavBlobs = await this._prepareWavBlobs(audioBuffer);
    if (!wavBlobs || wavBlobs.length === 0) {
      throw new Error("Failed to decode audio into a supported format.");
    }
    return this._transcribeWavBlobs(wavBlobs, onProgress);
  }

  // ── Segment-based entry (used for large lectures) ──────────────────────
  // Accepts an array of per-segment Uint8Arrays (output of downloadSegments).
  // Combines them in batches of BATCH_SEGMENTS (~30 min of audio each),
  // decodes each batch independently, then transcribes all WAV blobs.
  // This avoids ever creating one giant ArrayBuffer that the browser can't
  // handle for 700+ segment / 3.5-hour lectures.
  async transcribeFromSegments(audioSegments, onProgress) {
    if (!this.baseUrl) throw new Error("Base URL is required.");
    if (!this.apiKey) throw new Error("API Key is required.");

    this.log("Starting parallel transcription process...");

    // ~200 TS segments ≈ 200 × 4s = ~800s ≈ 13 min of audio per batch.
    // Each batch produces a combined buffer of ~10–30 MB — well within the
    // browser's Web Audio API limits. Adjust down if memory is still tight.
    const BATCH_SEGMENTS = 200;
    const totalSegments = audioSegments.length;
    const numBatches = Math.ceil(totalSegments / BATCH_SEGMENTS);

    this.log(`Processing ${totalSegments} segments in ${numBatches} batch(es) of up to ${BATCH_SEGMENTS}...`);

    const allWavBlobs = [];

    for (let b = 0; b < numBatches; b++) {
      const start = b * BATCH_SEGMENTS;
      const end = Math.min(start + BATCH_SEGMENTS, totalSegments);
      const batch = audioSegments.slice(start, end);

      this.log(`Decoding batch ${b + 1}/${numBatches} (segments ${start + 1}–${end})...`);

      // Combine this batch into one buffer
      let totalBytes = 0;
      for (const seg of batch) totalBytes += seg.byteLength;
      const combined = new Uint8Array(totalBytes);
      let off = 0;
      for (const seg of batch) {
        combined.set(seg, off);
        off += seg.byteLength;
      }

      let batchBlobs;
      try {
        batchBlobs = await this._prepareWavBlobs(combined.buffer);
      } catch (e) {
        this.log(`⚠ Batch ${b + 1} decode failed (${e.message}). Trying smaller sub-batches...`);
        // Halve the batch and retry each half independently
        batchBlobs = [];
        const half = Math.ceil(batch.length / 2);
        for (const subBatch of [batch.slice(0, half), batch.slice(half)]) {
          if (subBatch.length === 0) continue;
          let sb = 0;
          for (const seg of subBatch) sb += seg.byteLength;
          const sub = new Uint8Array(sb);
          let so = 0;
          for (const seg of subBatch) { sub.set(seg, so); so += seg.byteLength; }
          try {
            const subBlobs = await this._prepareWavBlobs(sub.buffer);
            if (subBlobs) batchBlobs.push(...subBlobs);
          } catch (se) {
            this.log(`⚠ Sub-batch decode also failed: ${se.message}. Skipping.`);
          }
        }
      }

      if (batchBlobs && batchBlobs.length > 0) {
        allWavBlobs.push(...batchBlobs);
      }
    }

    if (allWavBlobs.length === 0) {
      throw new Error("Failed to decode audio into a supported format.");
    }

    return this._transcribeWavBlobs(allWavBlobs, onProgress);
  }

  // ── Shared transcription worker (operates on prepared WAV blobs) ────────
  async _transcribeWavBlobs(wavBlobs, onProgress) {
    const isGroq = this.baseUrl.includes("groq.com");
    const isDeepgram = this.baseUrl.includes("deepgram.com");
    const isElevenLabs = this.baseUrl.includes("elevenlabs.io");

    if (this._isAllSilent(wavBlobs)) {
      throw new Error(
        "Decoded audio is silent — the audio track could not be extracted from the lecture stream. " +
          "If a cached transcript is available, use \"Download Cached Transcript\"; otherwise try re-downloading.",
      );
    }

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

        if (peak < this.silencePeakThreshold) {
          transcriptParts[i] = "";
          silentChunks++;
          completedCount++;
          const pctSilent = ((completedCount / totalChunks) * 100).toFixed(1);
          if (onProgress) onProgress(parseFloat(pctSilent), completedCount, totalChunks);
          this.log(`Chunk ${i + 1} skipped (silent). Progress: ${completedCount}/${totalChunks} completed (${pctSilent}%)`);
          continue;
        }

        let text = "";
        const MAX_RETRIES = 3;

        for (let retry = 0; retry < MAX_RETRIES; retry++) {
          try {
            if (isDeepgram) {
              text = await this._transcribeDeepgram(blob);
            } else if (isElevenLabs) {
              text = await this._transcribeElevenLabs(blob);
            } else {
              const model = this.modelName || (isGroq ? "whisper-large-v3" : "whisper-1");
              text = await this._transcribeOpenAICompatible(blob, model);
            }
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

        if (text) {
          transcriptParts[i] = text.trim();
        } else {
          transcriptParts[i] = "";
          hasFailures = true;
        }

        completedCount++;
        const pct = ((completedCount / totalChunks) * 100).toFixed(1);
        if (onProgress) onProgress(parseFloat(pct), completedCount, totalChunks);
        this.log(`Chunk ${i + 1} transcribed. Progress: ${completedCount}/${totalChunks} completed (${pct}%)`);
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
      hasFailures: hasFailures,
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
        return await this._decodeAdtsInChunks(rawAudioBuffer, audioCtx);
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
    let wavBlobs = await this._resampleToWavBlobs(decodedBuffer);

    // The monolithic decodeAudioData() call can silently mis-handle a large
    // concatenated ADTS stream and emit silence. If that happened, retry via
    // the per-frame chunked decode, which is more tolerant of irregularities.
    if (this._isAllSilent(wavBlobs)) {
      this.log("⚠ Whole-stream decode produced silent audio. Retrying with chunked ADTS decode...");
      const fallbackBlobs = await this._decodeAdtsInChunks(rawAudioBuffer, audioCtx);
      if (fallbackBlobs && fallbackBlobs.length > 0 && !this._isAllSilent(fallbackBlobs)) {
        this.log("✅ Chunked ADTS decode recovered audible audio.");
        wavBlobs = fallbackBlobs;
      }
    }

    if (audioCtx.close) await audioCtx.close();
    return wavBlobs;
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

  async _decodeAdtsInChunks(rawAudioBuffer, audioCtx) {
    const frames = this._extractAdtsFrames(new Uint8Array(rawAudioBuffer));
    if (frames.length === 0) {
      this.log("⚠ No ADTS frames detected in raw audio.");
      return [];
    }

    const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
    const chunkBuffers = this._buildAdtsChunks(frames, MAX_CHUNK_BYTES);
    const wavBlobs = [];

    this.log(`Processing ${chunkBuffers.length} ADTS chunk(s) (max ${MAX_CHUNK_BYTES / 1024 / 1024} MB each)...`);

    for (let i = 0; i < chunkBuffers.length; i++) {
      try {
        const decoded = await audioCtx.decodeAudioData(chunkBuffers[i].slice(0));
        const chunkWavs = await this._resampleToWavBlobs(decoded);
        for (const item of chunkWavs) wavBlobs.push(item);
      } catch (e) {
        this.log(`⚠ Chunked decode failed for part ${i + 1}: ${e.message}`);
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
    const model = this.modelName || "nova-3";
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
    formData.append("model_id", this.modelName || "scribe_v1");
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
