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

## Multi-part lectures (playlists)

Some recordings are split into parts ("Part 1 · 15 minutes", "Part 2 · 99 minutes" in the player's
**Playlist** panel). Each part is its own HLS stream, and the player only requests a part's
`.m3u8` once that part plays — so the single URL `videoTracker.js` stores for a tab is just
whichever part played first. Downloading "the" stream gave Part 1 only, and a transcript of a
two-part lecture silently covered Part 1 and was cached as the whole lecture's.

**Detection** — `lectureHasPlaylist()` in
[playlistCapture.js](../extension-main/content/features/videoDownloader/playlistCapture.js): when the
playlist panel is open, two or more listed parts; when it's closed, a player control labelled
"playlist" (`title` / `aria-label` / tooltip attributes inside `.vp-controls`). Single-part
lectures keep the old flow untouched.

**Parsing the panel** is text-based, not class-based: the panel is found from its "Playlist"
heading and widened until it contains a duration (`/\d+ minutes?/`); each duration's item is the
widest element around it holding no other duration; the label is the item's other text, skipping
icon-font ligatures (`<i>videocam</i>`) and preferring a "Part N" text.

**Capture tabs** — to learn every part's stream without touching the user's own player:

1. `videoDownloader.js` sends `CAPTURE_LECTURE_STREAMS { lectureUrl, lectureKey }`.
2. `videoTracker.js` opens the lecture in an **inactive, muted** tab (`captureTabs`), at most
   **2** at once (queued beyond that). Results are cached per lecture for **10 minutes** (the
   URLs are signed and expire); concurrent requests for the same lecture share one capture.
3. In that tab `playlistCapture.js` asks `IS_CAPTURE_TAB` (only lecture pages ask; only tabs the
   worker opened get "yes") and runs `capturePlaylistStreams()`:
   - waits for `.vp-controls` (20 s), clicks the player's own Play control (muted `play()` as a
     fallback) and waits for its first `.m3u8` (10 s each);
   - opens the playlist panel if needed, then clicks each part **last to first** and records
     the playlists requested after each click (repeats included — switching back to a part
     re-requests its playlist). Last-to-first means the part already playing on a fresh page
     (Part 1) is clicked last, after another part, so every click switches streams;
   - per part, `hlsChooseTopLevelStream()` ([hlsPlaylist.js](../extension-main/content/utils/hlsPlaylist.js))
     picks the master playlist out of everything requested (deduped by path — signed URLs change
     their query on every request);
   - a part with no requests inherits the stream loaded before the clicks **only** when it is
     the single part left without one and no other part already owns that stream; otherwise it
     is reported with `url: null` rather than handed another part's video.
4. The tab reports `CAPTURE_RESULT`; the worker closes it. A 120 s timeout, or the user closing
   the tab, settles the job with an error and closes it too.

**What the user gets** — **Audio** / **Video** turn the download menu into a part picker (each
part with its duration, plus "All parts"); each chosen part opens its own processor tab titled
`"<lecture> – Part N"`. **Transcript** passes every part to the versions page as
`parts=[{label, url}]` (JSON), which hands them on to the processor (see
[lecture-transcript.md](lecture-transcript.md#multi-part-lectures)). If any part's stream is
missing, the transcript is refused — a partial transcript would be cached as the whole lecture's.

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

Chunks are served from CloudFront, whose CORS headers are cut for the scaler.com origin. So
whenever a source tab is known, the processor sends `FETCH_PROXY` to the **content script in the
source tab**, which fetches from the scaler.com origin and returns text or a
`Uint8Array`-as-`Array` (arrays survive structured message passing). The proxy goes first:
`fetchText` falls back to a direct fetch only when the source tab can't be reached; the video
processor's `fetchChunk` uses the proxy alone; the transcript processor's `fetchChunk` tries the
proxy, then a direct fetch.

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
- Multi-part lectures: the playlist markup was written from a screenshot, not a DOM sample, so
  detection is text-based; if Scaler renames the "Playlist" heading or drops the durations,
  multi-part detection falls back to "single part" (today's behaviour). A capture tab briefly
  appears in the tab strip (inactive, muted) for ~5–15 s. Video/audio parts are separate files;
  they are not concatenated.
