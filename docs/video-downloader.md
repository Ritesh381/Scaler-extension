# Lecture Recording Downloader (video / audio)

**Setting key:** `video-downloader` (default `true`)
**Code:**
[content/features/videoDownloader/videoDownloader.js](../extension-main/content/features/videoDownloader/videoDownloader.js) (button + stream capture) ·
[background/videoTracker.js](../extension-main/background/videoTracker.js) (stream store + tab launcher) ·
`videoProcessor.html` / `videoProcessor.js` (the download engine, an extension page) ·
[tsAudioExtractor.js](../extension-main/content/features/videoDownloader/tsAudioExtractor.js) (MPEG-TS demuxer) ·
`modeBadge.js` (badge on the processor page)

Transcript mode shares the first half of this pipeline but is documented separately in
[lecture-transcript.md](lecture-transcript.md).

## What it does

Adds a download icon to the recording player's header with three options — **Audio**, **Video**,
**Transcript**. Choosing one opens a dedicated extension page that downloads the HLS stream
chunk-by-chunk and writes an `.mp4` / `.mp3` / `.txt` file.

## Finding the stream URL

Scaler plays recordings over HLS (`.m3u8` playlist + `.ts` chunks). The URL is not in the DOM.

Rather than a `webRequest` listener (which would need broad host permissions), the **content
script** watches the page's own network activity with a `PerformanceObserver`:

```js
new PerformanceObserver(list => …).observe({ type: "resource", buffered: true })
```

Entries with `initiatorType` `xmlhttprequest` / `fetch` / `other` whose name contains `.m3u8` are
forwarded to the service worker as `{ type: "M3U8_CAPTURED", url }`. Because the content script
only runs on scaler.com (manifest `matches`), the sender is always a Scaler tab — scoping is free
and no extra host permission is needed. `buffered: true` also replays entries that fired before
the observer was installed.

`background/videoTracker.js` keeps `tabVideoStreams[tabId]`, storing the first `.m3u8` seen and
**upgrading** to a master playlist if a later URL contains `master` or `index`. The entry is
deleted on `tabs.onRemoved` and on any `tabs.onUpdated` with `status === "loading"`, so a stale
URL never leaks into the next lecture.

## Injecting the button

`VideoDownloader.checkAndInject()` requires **both**:

- `.vp-controls` — present on recordings, absent on live sessions (this is the recording test);
- `document.querySelectorAll(".m-header__actions")[1]` — the header slot.

It bails if `#scaler-video-downloader` already exists, pre-fetches the lecture slug
(non-blocking), then builds an icon button plus a dark dropdown with the three options. A
debounced (300 ms) `MutationObserver` on `document.body` re-injects after SPA navigation; the
outside-click handler that closes the menu is **removed before being re-added**, so repeated
injections don't stack listeners on `document`.

## Lecture slug

`_fetchLectureSlug()` extracts `classId` from `/class/(\d+)` and calls
`https://www.scaler.com/api/v2/classroom/{classId}/meta`, reading
`data.attributes.slug`. This slug is the **cache key shared with the transcript and AI-notes
features** — unique per lecture even across batches that share a class title. It is cached per
URL, and concurrent callers share one in-flight promise (`_slugPromise`).

## Handoff to the processor page

`startDownload(type)` shows a spinner, resolves the slug, then asks the worker for the captured
URL (`GET_VIDEO_URL`). If there is none it alerts *"Please ensure the video is playing first"* —
the stream URL only appears once playback has begun.

It then sends `INITIATE_DOWNLOAD` with `{ url, type, title, lectureSlug, classId }`.
`videoTracker.js` opens a new tab:

```
chrome-extension://…/content/features/videoDownloader/{videoProcessor|transcriptProcessor}.html
  ?url=…&type=…&title=…&lectureSlug=…&classId=…&sourceTabId=…
```

Running in an extension page (not the Scaler tab) means: no page CSP, a stable context that
survives SPA navigation, and its own progress UI. `modeBadge.js` colours the page badge
AUDIO / VIDEO / TRANSCRIPT from the `type` param.

## The download engine (`videoProcessor.js`)

1. **Save target, first.** `window.showSaveFilePicker` is requested **synchronously inside the
   click handler**, before any `await` — the File System Access API needs transient user
   activation and a network await would burn it. Brave is excluded explicitly
   (`!navigator.brave`); Firefox has no API. `AbortError` = user cancelled → stop. Any other error
   → fall back to memory buffering.
2. **Manifest** — fetch the master `.m3u8`. `getMediaPlaylistUrl()` returns it unchanged if it
   already lists segments; otherwise it picks a rendition. For **audio/transcript** it prefers a
   dedicated audio-only rendition; for video it takes the highest-bandwidth stream.
3. **Segments** — `extractSegments()` resolves each chunk URL against the playlist base.
4. **Concurrent worker pool** — `CONCURRENCY = 6` workers each claim the next unclaimed index,
   `fetchChunk()` it (3 retries), optionally run it through `TSAudioExtractor`, and submit to an
   **ordered write queue**. Chunks download in parallel but are written strictly in sequence.
5. **Two output paths**:
   - *Streaming* (Chrome/Edge): each chunk is written straight to disk, so RAM stays flat
     (~5–10 MB) regardless of lecture length. On error the writable is `abort()`ed so no
     half-written file is left behind.
   - *Memory fallback* (Brave/Firefox): buffer everything, then download via a blob URL, revoked
     after 10 s.
6. On success, log the elapsed time and fire `trackCompletedDownload(type)`.

### CORS proxy

Chunks are served from CloudFront. If a direct `fetch` from the extension page fails, the
processor sends `FETCH_PROXY` back to the **content script in the source tab**, which fetches from
the scaler.com origin and returns text or a `Uint8Array`-as-`Array` (arrays survive structured
message passing). `fetchText`/`fetchChunk` try direct first and fall back to the proxy.

## Audio extraction (`tsAudioExtractor.js`)

A dependency-free MPEG-TS demuxer — no WebAssembly, no ffmpeg.

- Walks the buffer in 188-byte packets aligned on the `0x47` sync byte.
- PID `0x0000` = **PAT** → gives the PMT PID.
- **PMT** → gives the audio elementary-stream PID by stream type: `0x03`/`0x04` (MP3),
  `0x0F` (AAC/ADTS), `0x11` (AAC-LATM), `0x81` (AC-3).
- For audio packets, the PES header is skipped on start packets and continuation packets are
  copied raw.
- Because each HLS `.ts` segment carries its own PAT/PMT, PIDs are reset per chunk and extraction
  works segment-independently.
- Output is finally filtered to **valid ADTS frames only** (sync word `0xFFF`, frame length parsed
  from the header). Stray bytes that slip through the demuxer otherwise make players miscalculate
  duration.

The `.mp3` extension is a convenience label — the bytes are the stream's native ADTS AAC (or MP3)
frames, which players handle fine.

## Usage tracking

`trackCompletedDownload(type)` reads `scaler_user.email` from `chrome.storage.sync` and sends
`trackDownload` to the worker, which POSTs `{ email, type, lecture, lectureSlug }` to the Scaler++
backend. Fire-and-forget; failures are swallowed and never block a download. See
[user-profile-sync.md](user-profile-sync.md).

## Toggling

`videoDownloader.js` listens for `toggleSetting` with key `video-downloader` itself (it does not
go through `content.js`):

- **off** — remove `#scaler-video-downloader`, disconnect both the injection observer and the
  `PerformanceObserver`;
- **on** — re-inject and **re-arm both observers**. Re-arming the network observer matters: an
  earlier version left it dead after an off→on toggle, so every subsequent download failed with
  "could not locate stream".

## Limits

- The stream must have been requested by the page at least once (i.e. playback started) before a
  URL exists to capture.
- Container remuxing is not performed: video output is the raw concatenated TS payload written
  with an `.mp4` name.
- Streaming-to-disk requires the File System Access API; Brave and Firefox use the higher-RAM
  memory path.
- The processor tab must stay open for the duration of the download.
