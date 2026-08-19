# Lecture Transcription

**Reached from:** the recording download menu → **Transcript** (setting key `video-downloader`)
**Code:**
`content/features/videoDownloader/transcriptProcessor.html` / `.js` (the page + orchestration) ·
[customAudioTranscriber.js](../extension-main/content/features/videoDownloader/customAudioTranscriber.js) (decode + provider calls) ·
[tsAudioExtractor.js](../extension-main/content/features/videoDownloader/tsAudioExtractor.js) (TS → AAC) ·
[background/messagesProxy.js](../extension-main/background/messagesProxy.js) (cache read/write)

Read [video-downloader.md](video-downloader.md) first — stream capture, the slug, and the handoff
to a processor tab are shared.

## What it does

Turns a lecture recording into a `.txt` transcript using **the user's own** speech-to-text API key
(Deepgram, Groq, OpenAI, ElevenLabs, or any OpenAI-compatible endpoint). Completed transcripts are
uploaded to a shared backend cache keyed by the lecture slug, so the next student to ask for the
same lecture gets it instantly and for free.

## Shared cache

Key = the lecture slug from `/api/v2/classroom/{classId}/meta`.

| Action | Route | Where |
|---|---|---|
| `checkTranscriptCache` | `GET {backend}/api/transcript?slug=` | `messagesProxy.js`, bearer token |
| `saveTranscriptToCache` | `POST {backend}/api/transcript/save` | `messagesProxy.js`, bearer token |

The save runs **in the service worker**, deliberately: the processor tab is often closed right
after the download triggers, and a fire-and-forget POST from a dying page context would be
aborted. The worker outlives the tab.

Two entry points hit the cache:

- **From the Scaler page** — `startDownload("transcript")` checks the cache *before* opening the
  processor tab. On a hit it asks `confirm("A cached transcript was found. OK to download it,
  Cancel to generate your own.")`, and on OK prepends the metadata header and downloads
  immediately — no API key involved.
- **On the processor page** — a "Download Cached Transcript" button is shown whenever a lookup key
  exists, so the cache can be used without configuring anything.

A generated transcript is only uploaded when **no chunk failed** (`hasFailures === false`), so a
partial transcript never poisons the cache.

## Provider configuration (processor page)

Provider dropdown + Base URL + Model + API key, persisted in `chrome.storage`
(`saveConfig` / `loadConfig`), with a "get an API key" link per provider and an eye toggle for the
key field. `PROVIDER_DEFAULT_MODELS` fills a sensible default model when the provider changes.

For a hand-entered **custom** provider, `validateCustomInputs()` runs before any work: it checks
the URL shape and warns (with a suggested fix, and a `confirm` to override) when the path doesn't
end in `/audio/transcriptions`, which is where OpenAI-compatible transcription lives.

## Three steps

### Step 1 — API key health check

`validateApiKey(baseUrl, apiKey, modelName)` probes a cheap endpoint per provider *before*
downloading hundreds of megabytes of audio:

| Provider | Probe |
|---|---|
| Deepgram | `GET /v1/projects` |
| Groq | `GET /openai/v1/models` |
| OpenAI | `GET /v1/models` |
| ElevenLabs | `GET /v1/user` |
| Custom/unknown | POST a tiny 44-byte silent WAV and look only for 401/403 |

Interpretation is deliberately conservative:

- `401`/`403` → bad key, abort and re-enable the inputs;
- `404` → the Base URL isn't a transcription endpoint;
- `400` mentioning the model → bad model name;
- anything else (including `5xx`, or `400 "audio too short"` from the silent probe) → assume the
  key is fine and let the real attempt surface the true error;
- a network/CORS error on the probe never blocks the user.

### Step 2 — Download the audio

Same HLS pipeline as the video downloader (master playlist → media playlist → segments,
6 concurrent workers with retries, `TSAudioExtractor` per chunk) — but `downloadSegments()`
returns the **per-segment `Uint8Array`s in order**, never one giant combined buffer. A 3.5-hour
lecture is 700+ segments; concatenating them first is what used to make the browser choke.

### Step 3 — Transcribe

`CustomAudioTranscriber.transcribeFromSegments(segments, onProgress)`:

1. **Batch** — combine `BATCH_SEGMENTS = 200` segments (~13 min of audio, ~10–30 MB) at a time.
   If a batch fails to decode, it is **halved and each half retried independently**.
2. **Decode** — `_prepareWavBlobs()` prefers the ADTS path (`_decodeAdtsInChunks`), decoding in
   bounded chunks through the Web Audio API. A non-ADTS buffer (e.g. MP3) is decoded directly only
   when it is under 8 MB — never a whole lecture.
3. **Resample** — to **16 kHz mono**, split into WAV blobs of ≤ 10 min / ≤ 4 MB
   (`_writeWavHeader` builds the RIFF header by hand). Peak amplitude is recorded per chunk.
4. **Silence detection** — chunks whose peak is below `silencePeakThreshold` (~−40 dBFS) are
   **skipped, not sent**. Whisper-family models hallucinate filler ("Thank you.") on silence.
   If *every* chunk is silent, the run throws a clear error suggesting the cached transcript
   instead — that state means audio extraction failed, not that the lecture was quiet.
5. **Transcribe** — 5 parallel workers over the WAV blobs. Provider is chosen from the base URL
   (`deepgram.com` → `_transcribeDeepgram`, `elevenlabs.io` → `_transcribeElevenLabs`, otherwise
   OpenAI-compatible with the model defaulting to `whisper-large-v3` on Groq, else `whisper-1`).
6. **Retries** — 3 attempts per chunk with provider-aware backoff: a `429` waits **60 s** then
   **4 min**; other errors use 2 s × attempt. Progress is reported after every chunk.
7. **Stitch** — parts are joined in index order and passed through `_removeRepetitions()`, which
   collapses a phrase repeated more than `MAX_REPEATS = 2` times (a classic Whisper loop
   artefact).

## Output

`fetchMetadataHeader(classId)` fetches `/api/v2/classroom/{id}/session` and `/meta` in parallel
(`Promise.allSettled`) and prepends:

```
Course Name: …
Lecture Title: …
Start Time: …
Duration: … minutes
Downloaded via: Scaler++ Chrome Extension
Developer: Ritesh prajapati

==================================================
```

The file is then downloaded as `<slugified title>.txt`, the cache save is dispatched, and
`trackCompletedDownload("transcript")` fires.

## Privacy

The API key lives in `chrome.storage` on the user's machine and is sent only to the endpoint they
configured. Audio is decoded locally and uploaded only to that provider. What reaches the Scaler++
backend is the **finished transcript text** plus slug/title/classId and the generating user's
email, which is what makes the shared cache work.

## Limits

- Long lectures cost real API credits and time; the shared cache exists precisely to avoid
  repeating that.
- No diarisation, no timestamps — plain concatenated text.
- Batch/chunk sizes are tuned constants (`BATCH_SEGMENTS = 200`, 10 min / 4 MB WAV chunks); very
  unusual stream layouts may need them adjusted.
- Cache save is skipped on any chunk failure, so a flaky run leaves nothing behind for others.
