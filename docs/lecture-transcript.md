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

- **From the Scaler page** — the downloader menu offers two separate transcript items instead of
  one, so the choice is made *before* anything runs and no dialog ever interrupts:
  - **Transcript Cache ⚡** — `startDownload("transcript", { useCache: true })` checks the cache
    first. On a hit it prepends the metadata header and downloads immediately — no API key
    involved. On a miss it falls through to opening the processor tab.
  - **Transcript New** — `startDownload("transcript", { useCache: false })` skips the cache lookup
    entirely and goes straight to the processor tab.
- **On the processor page** — a "Download Cached Transcript" button is shown whenever a lookup key
  exists, so the cache can be used without configuring anything.

## Versions

A lecture keeps **every** transcript ever generated for it. The old cache stored one
transcript and overwrote it only when the incoming text had **more bytes**, which
systematically preferred the worst output: hallucination loops emit more text, and UTF-8
makes non-Latin scripts ~3x heavier than ASCII, so a wrong-language transcript almost
always beat a correct English one. A good transcript could not displace a bad one.

Within one lecture, identical text collapses onto the same version instead of creating
duplicates.

### Ranking

`getCachedTranscript` returns the best-ranked version, so extension builds that predate
versioning keep working and simply receive whatever currently ranks highest:

1. **net votes** (`upvotes - downvotes`) — the only signal that directly says "this is garbage"
2. **download count** — weak but real evidence
3. **recency**

A downvote therefore demotes a version for everyone without anyone deleting it.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /api/transcript?slug=` | Best version. Unchanged response shape + `versionId`, `versionCount`. |
| `GET /api/transcript/versions?slug=&email=` | Metadata for all versions, newest first, **no text**. `email` marks the viewer's own votes. |
| `GET /api/transcript/version/:versionId` | One version including its text. |
| `POST /api/transcript/version/:versionId/download` | Counts a deliberate download. |
| `POST /api/transcript/version/:versionId/vote` | `{ email, vote }` — `"up"`, `"down"`, or `null` to withdraw. |
| `DELETE /api/transcript/version/:versionId` | Admin only (cookie JWT, not the extension token). |

Transcripts routinely exceed 50 KB, so the list endpoint never carries text — the versions
page fetches a body only when a row is expanded or downloaded, and memoises it.

### Counting downloads

`download_count` is bumped in exactly three places, each meaning a file actually reached
someone, and each guarded so the same download is never counted twice:

| Path | Counted by | Guard |
|---|---|---|
| **Download** on a version | `POST /version/:id/download` | — |
| **Generating** a version | `POST /save` with `countDownload: true` | the processor writes the `.txt` first, so a brand-new version starts at 1, not 0 |
| **Older builds** taking whatever `GET /api/transcript` served | `POST /api/users/download` | only when the report carries **no** `versionId` and `source !== "generated"` |

Counting the plain `GET` itself is **not** an option: `lectureSummary.js` hits the same endpoint
just to ask "does a transcript exist?", and that probe fires every time the summary panel opens.
The download *report* is the only trustworthy signal that a file reached a person, so old builds
are counted from there — `recordDownloadForLecture` re-resolves the same best-ranked version the
`GET` would have served and bumps that one.

Opening the versions page and expanding a preview deliberately do **not** count, or the number
stops meaning "people chose this one".

Votes live in `transcript_version_votes` as one row per `(version, email)` and are tallied
on read rather than kept in counter columns, so concurrent votes cannot lose a race.

### Extension entry points

The downloader menu has a single **Transcript** item, which always opens the versions
page — with no versions yet it shows an empty state whose "Create the first version"
button leads to the same place the header button does. The content script no longer checks
the cache or downloads anything itself; the versions page owns all of it.

`transcriptVersions.html` is the versions page; its "Create a version" button hands off to
`transcriptProcessor.html`, carrying the stream URL forward since that page needs it to
pull audio.

`versionId` is `sha256(lectureId + NUL + trimmed text)`. Scoping the hash to the lecture
matters: the legacy data stores the same lecture under several slug formats (a UUID slug,
a kebab slug, the raw title), and hashing text alone collapsed those into one document
owned by whichever lecture was written first, leaving the others with no version at all.

## Attribution storage

| Where | Columns | Notes |
|---|---|---|
| `transcript_versions` (Supabase) + Mongo `transcript_versions` | `generated_by`, `provider`, `model`, `char_count`, `download_count` | One row per version. Text lives only in Mongo. |
| `transcripts` (Supabase index) + Mongo doc | `generated_by`, `provider`, `model` | Now a lecture-level index row. Its Mongo `text` is legacy — read by the backfill and by `getCachedTranscript` as a fallback, never written again. |
| `download_history` | `provider`, `model`, `source`, `version_id` | `source` is `cache` or `generated`. A CHECK constraint forces all four to be NULL unless `type = 'transcript'`, so video/audio rows are unaffected. |

`source = 'generated'` is the count of downloads that actually invoked a provider;
`source = 'cache'` rows copy the cached transcript's provider/model, so the log records what the
user received even if the cache is later overwritten by a different model.

**Mixed extension versions.** Old builds POST without any attribution. The backend treats every
metadata field as optional and **never writes an empty value over a stored one** — on the
overwrite-with-larger-transcript path it merges, falling back to what Mongo already holds, and the
Supabase index row only ever includes columns that resolved to a value. `trackDownload` strips
attribution from non-transcript rows (a stray field would trip the CHECK and lose the row) and
drops an unrecognised `source` rather than rejecting the request. `model` is the current field
name; `modelName` is still accepted on input and echoed on output for builds that predate it.

**Migration.** `backend/migrations/001_transcript_versions.sql` creates the two new tables
and recreates the `download_history` CHECK. Then `node backfill_transcript_versions.js`
promotes every legacy transcript into a version, seeding `download_count` from
`download_history` so previously popular lectures do not start at zero and lose the
tie-break to a brand-new upload. The backfill is idempotent — version ids are
content-addressed, so re-running skips whatever is already promoted.

A generated transcript is only uploaded when **no chunk failed** (`hasFailures === false`), so a
partial transcript never poisons the cache.

## Provider configuration (processor page)

Provider dropdown + Base URL + Model + API key, persisted in `chrome.storage`, with a
"get an API key" link and a "browse available models" link per provider, and an eye toggle for
the key field.

**Settings are stored per provider**, not globally:

```js
{ provider: "groq", providers: { groq: { baseUrl, model, apiKey }, openai: { … } } }
```

Every provider needs its own key, so a single shared field meant switching Groq → OpenAI → Groq
forced you to paste the Groq key again. `saveConfig` writes the visible fields under
`activeProvider` (tracked separately, because `change` fires *after* `providerSelect.value` has
already moved), and `applyProviderSettings` restores them on the way back. The old single-slot
shape is migrated on first load, so no one re-enters a key they already had.

`PROVIDER_DEFAULT_MODELS` supplies the default model:

| Provider | Default |
|---|---|
| Groq | `whisper-large-v3-turbo` |
| Deepgram | `nova-3` |
| OpenAI | `gpt-transcribe` |
| ElevenLabs | `scribe_v2` |

`SUPERSEDED_DEFAULT_MODELS` upgrades a stored model that exactly matches a *previous* default
(`whisper-large-v3`, `whisper-1`, `scribe_v1`) — those were never chosen, they were just whatever
the field happened to hold. A model the user actually typed is left alone.

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

`fetchMetadataHeader(classId, attribution)` fetches `/api/v2/classroom/{id}/session` and `/meta` in
parallel (`Promise.allSettled`) and prepends:

```
Course Name: …
Lecture Title: …
Start Time: …
Duration: … minutes
Generated by: someone@scaler.com
Model use: groq, whisper-large-v3
Downloaded via: Scaler++ Chrome Extension
Developer: Ritesh prajapati

==================================================
```

`attribution` is `{ generatedBy, provider, model }`. On a fresh generation it comes from the
signed-in user + the selected provider/model; on a cache download it comes from the cached row, so
the header credits whoever actually generated the text. Transcripts cached before these fields
existed render `N/A` — the lines are always present so the header shape stays stable.

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
