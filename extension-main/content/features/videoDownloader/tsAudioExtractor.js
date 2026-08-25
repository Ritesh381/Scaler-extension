// ============================================================
// tsAudioExtractor.js
// Pure-JS MPEG-TS demuxer — extracts AAC/MP3 audio from .ts chunks
// No WebAssembly or external dependencies required.
//
// MPEG-TS format:
//   - Each packet is exactly 188 bytes, starting with sync byte 0x47
//   - PID 0x0000 = PAT (Program Association Table) → tells us PMT PID
//   - PMT (Program Map Table) → tells us audio/video stream PIDs + codecs
//   - Audio PES packets contain ADTS-wrapped AAC frames (or raw MP3)
//
// Usage:
//   const extractor = new TSAudioExtractor();
//   const audioBytes = extractor.extract(tsChunkArrayBuffer);
// ============================================================

class TSAudioExtractor {
  constructor() {
    this.audioPid = null;
    this.pmtPid = null;
    this.audioStreamType = null;
  }

  /**
   * Extract raw audio data (ADTS AAC frames) from a single .ts chunk.
   * Each HLS .ts segment is self-contained with its own PAT/PMT,
   * so this works independently per chunk.
   * @param {ArrayBuffer} buffer - The raw .ts chunk data
   * @returns {Uint8Array} - Extracted audio bytes (ADTS AAC or MP3 frames)
   */
  extract(buffer) {
    const data = new Uint8Array(buffer);
    const audioBuffers = [];

    // Reset PIDs for each chunk (HLS segments are self-contained)
    this.audioPid = null;
    this.pmtPid = null;

    let offset = 0;

    while (offset + 188 <= data.length) {
      // Scan for sync byte
      if (data[offset] !== 0x47) {
        offset++;
        continue;
      }

      const packet = data.subarray(offset, offset + 188);
      offset += 188;

      // --- Parse TS header (4 bytes) ---
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      const payloadUnitStart = (packet[1] & 0x40) !== 0;
      const hasAdaptation = (packet[3] & 0x20) !== 0;
      const hasPayload = (packet[3] & 0x10) !== 0;

      if (!hasPayload) continue;

      // Determine where the payload begins
      let payloadOffset = 4;
      if (hasAdaptation) {
        const adaptLen = packet[4];
        payloadOffset += 1 + adaptLen;
      }
      if (payloadOffset >= 188) continue;

      const payload = packet.subarray(payloadOffset);

      // --- PAT (PID 0) → find PMT PID ---
      if (pid === 0) {
        this._parsePAT(payload, payloadUnitStart);
        continue;
      }

      // --- PMT → find audio stream PID ---
      if (this.pmtPid !== null && pid === this.pmtPid) {
        this._parsePMT(payload, payloadUnitStart);
        continue;
      }

      // --- Audio data packets ---
      if (
        this.audioPid !== null &&
        pid === this.audioPid &&
        payload.length > 0
      ) {
        if (payloadUnitStart) {
          // PES header present → skip it to get raw audio frames
          const audioData = this._skipPESHeader(payload);
          if (audioData && audioData.length > 0) {
            audioBuffers.push(audioData);
          }
        } else {
          // Continuation packet — raw audio data
          audioBuffers.push(payload);
        }
      }
    }

    // Concatenate all extracted audio buffers
    if (audioBuffers.length === 0) return new Uint8Array(0);

    const totalLength = audioBuffers.reduce((sum, b) => sum + b.length, 0);
    const raw = new Uint8Array(totalLength);
    let pos = 0;
    for (const buf of audioBuffers) {
      raw.set(buf, pos);
      pos += buf.length;
    }

    // ── Validate ADTS frames ──
    // Strip any non-ADTS bytes that slipped through the demuxer.
    // ADTS sync word: 12 bits = 0xFFF (bytes: 0xFF 0xF_)
    // Invalid bytes confuse players into miscalculating duration.
    return this._filterADTS(raw);
  }

  /**
   * Filter raw bytes to only include valid ADTS frames.
   * Walks through the data looking for ADTS sync words (0xFFF)
   * and copies only complete, valid frames.
   */
  _filterADTS(data) {
    const frames = [];
    let i = 0;

    while (i < data.length - 7) {
      // Look for ADTS sync word: 0xFF followed by 0xF0-0xFF
      if (data[i] === 0xff && (data[i + 1] & 0xf0) === 0xf0) {
        // Parse ADTS header to get frame length
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
      // Not a valid ADTS frame — skip byte
      i++;
    }

    if (frames.length === 0) return data; // Fallback: return raw if no ADTS found

    const totalLen = frames.reduce((s, f) => s + f.length, 0);
    const result = new Uint8Array(totalLen);
    let off = 0;
    for (const f of frames) {
      result.set(f, off);
      off += f.length;
    }
    return result;
  }

  /**
   * Parse Program Association Table to find PMT PID.
   */
  _parsePAT(payload, payloadUnitStart) {
    let off = 0;
    if (payloadUnitStart) {
      off = payload[0] + 1; // pointer_field + 1
    }

    // PAT table structure:
    //   table_id (1) + section_syntax_indicator/length (2) +
    //   transport_stream_id (2) + version/current_next (1) +
    //   section_number (1) + last_section_number (1) = 8 bytes header
    off += 8;

    // Each program entry: program_number (2) + reserved(3bits) + PID (13bits) = 4 bytes
    // Skip program_number 0x0000 (network PID), take first real program
    while (off + 4 <= payload.length) {
      const programNumber = (payload[off] << 8) | payload[off + 1];
      const pmtPid = ((payload[off + 2] & 0x1f) << 8) | payload[off + 3];
      off += 4;

      if (programNumber !== 0) {
        this.pmtPid = pmtPid;
        break;
      }
    }
  }

  /**
   * Parse Program Map Table to find audio elementary stream PID.
   */
  _parsePMT(payload, payloadUnitStart) {
    let off = 0;
    if (payloadUnitStart) {
      off = payload[0] + 1;
    }

    if (off + 12 > payload.length) return;

    // table_id (1)
    off += 1;
    // section_syntax_indicator + section_length (2)
    off += 2;
    // program_number (2)
    off += 2;
    // version_number, current_next_indicator (1)
    off += 1;
    // section_number (1)
    off += 1;
    // last_section_number (1)
    off += 1;
    // PCR_PID (2)
    off += 2;
    // program_info_length (2)
    if (off + 2 > payload.length) return;
    const programInfoLength = ((payload[off] & 0x0f) << 8) | payload[off + 1];
    off += 2 + programInfoLength;

    // Parse elementary stream entries
    while (off + 5 <= payload.length) {
      const streamType = payload[off];
      const elementaryPid = ((payload[off + 1] & 0x1f) << 8) | payload[off + 2];
      const esInfoLength = ((payload[off + 3] & 0x0f) << 8) | payload[off + 4];
      off += 5 + esInfoLength;

      // Audio stream types:
      //   0x03 = MPEG-1 Audio (MP3)
      //   0x04 = MPEG-2 Audio (MP3)
      //   0x0F = AAC (ADTS)
      //   0x11 = AAC-LATM
      //   0x81 = AC-3 (Dolby)
      if (
        streamType === 0x0f ||
        streamType === 0x11 ||
        streamType === 0x03 ||
        streamType === 0x04 ||
        streamType === 0x81
      ) {
        this.audioPid = elementaryPid;
        // Which stream type matched decides whether the payload is ADTS AAC
        // (0x0F) or something decodeAudioData cannot take (0x11 LATM, 0x81 AC-3).
        this.audioStreamType = streamType;
        return; // Found audio, stop parsing
      }
    }
  }

  /**
   * Skip PES (Packetized Elementary Stream) header to get raw audio frames.
   * PES header: 00 00 01 [stream_id] [length:2] [flags:2] [header_data_length:1] [header_data...]
   */
  _skipPESHeader(payload) {
    if (payload.length < 9) return payload;

    // Check PES start code: 0x000001
    if (payload[0] !== 0x00 || payload[1] !== 0x00 || payload[2] !== 0x01) {
      return payload; // Not a PES start, treat as continuation data
    }

    // payload[3] = stream_id
    // payload[4..5] = PES packet length
    // payload[6] = flags byte 1
    // payload[7] = flags byte 2
    // payload[8] = PES header data length
    const headerDataLength = payload[8];
    const audioStart = 9 + headerDataLength;

    if (audioStart >= payload.length) return new Uint8Array(0);
    return payload.subarray(audioStart);
  }
}
