# Bulk Lecture Download

**Setting key:** `bulk-download` (default `true`)
**Code:**
[content/features/bulkDownload/bulkDownload.js](../extension-main/content/features/bulkDownload/bulkDownload.js) (class-list bar + picker) ·
[bulkDownloadPage.html / .js](../extension-main/content/features/bulkDownload/bulkDownloadPage.js) (the page that does the work) ·
[bulkJob.js](../extension-main/content/features/bulkDownload/bulkJob.js) (pure helpers) ·
[videoDownloader/hlsDownloadEngine.js](../extension-main/content/features/videoDownloader/hlsDownloadEngine.js) (shared HLS engine) ·
[videoDownloader/transcriptHeader.js](../extension-main/content/features/videoDownloader/transcriptHeader.js) (shared transcript header)

Read [video-downloader.md](video-downloader.md) (stream capture, capture tabs, the proxy) and
[lecture-transcript.md](lecture-transcript.md) (the shared cache) first — bulk download reuses both.

## Motivation

Saving a subject's lectures for offline revision meant opening every lecture, playing it, and
downloading one file at a time. Bulk download does a whole range from the subject's class list
in one go, into one folder.

## User workflow

1. Open a subject's class list (`/academy/mentee-dashboard/core-curriculum/m/{id}/classes`).
2. Click **⬇ Bulk download lectures** above the list.
3. In the picker: choose lectures (From/To range, shift-click, All/None), what to save
   (**Transcripts**, **Video**, **Audio**), and optionally **"Also transcribe lectures nobody has
   transcribed yet"** (off by default — uses the user's saved API key and credits).
4. **Start** opens the bulk download page. **Choose a folder & start** — one folder picker,
   then every file streams into it:

   ```
   01 - 11 Aug - Introduction to DevOps & Microservices.txt
   01 - 11 Aug - Introduction to DevOps & Microservices – Part 1.mp4
   01 - 11 Aug - Introduction to DevOps & Microservices – Part 2.mp4
   02 - 13 Aug - Linux Fundamentals.mp4
   ```

   The number is the lecture's position in the subject, so the folder sorts chronologically.
5. A table shows each lecture × type: Saved, Not transcribed yet, a live %, or `Failed: <reason>`.
   **Cancel** stops new work; **Retry failed** re-runs only the failed lectures.

## Architecture overview

```
class list (content script)            service worker              bulk page (extension tab)
bulkDownload.js ──START_BULK_DOWNLOAD──▶ videoTracker.js ──opens──▶ bulkDownloadPage.html#<job>
                                                                      │
             ◀────────── FETCH_PROXY (CDN fetches via scaler.com) ────┤  per lecture, 2 at a time:
                                         CAPTURE_LECTURE_STREAMS ◀────┤   transcript: /meta → slug →
                                         (capture tabs, PR #2)        │     checkTranscriptCache → file
                                                                      │     [generate: processor tab,
                                                                      │      mode=bulk → BULK_TRANSCRIPT_DONE]
                                                                      │   video/audio: parts → engine → file
```

### Reading the class list (`bulkDownload.js`)

Rows are found by visible text, not Scaler's generated class names:

- every row begins with a stamp, `11 AUG | 03:45 PM` (possibly split across elements —
  `findLectureRows` climbs from each date text until an element's text starts with the full
  stamp);
- a **row** is the widest element holding exactly one stamp (capped at 6 levels and never
  `<main>`, so a page with a single stamp can't widen into the whole page);
- a row is a **lecture** if it has a `Lecture` progress cell — contests ("DevOps End Term",
  `View Details`) don't;
- the **title** is the first text that isn't part of the stamp or a progress cell; icon-font
  ligatures (`<i>chevron_right</i>`) are skipped;
- the **class id** comes from the row's `/class/{id}` link (`extractClassId`, now in
  `utils/stringUtils.js`). Rows without one get it from the dashboard's own events feed
  (`/academy/mentee/events/` — the one `lectureInfo.js` reads) over the rows' date range, matched
  by title; dates carry no year, so it is inferred (`bulkStampToDate`: this year, unless that is
  more than 60 days ahead). Unmatched rows show "link not found" and can't be selected.

The bar is injected once above the list. A debounced `MutationObserver` waits for the list to
render after navigation and **disconnects as soon as the bar is in**, or after 30 s.

### The bulk page (`bulkDownloadPage.js`)

- **Job** — `parseBulkJob()` reads it from the URL hash (`videoTracker.js` puts it there, adding
  the subject tab's id as `sourceTabId`). Lectures without a numeric class id are dropped.
- **Output** — `showDirectoryPicker()` is the first await of the Start click (it needs the user
  activation). Files are written with `createWritable()`; a failed video/audio download aborts
  the writable and removes the half-written file. Without the API (Brave, Firefox), transcripts
  are collected into one JSZip downloaded at the end, and each video/audio file is buffered in
  memory and downloaded on its own — a notice says so.
- **Concurrency** — `runWithConcurrency(lectures, 2, …)`; each lecture's chunk downloads use the
  engine's 6 workers. Generated transcripts are serialised through one promise chain (one
  processor tab at a time).
- **Transcripts** — slug from `/api/v2/classroom/{id}/meta` (memoised), `checkTranscriptCache`,
  then `fetchMetadataHeader()` + text into the folder; the version counts its download
  (`recordVersionDownload`) and `trackDownload` names the version. With no cached transcript and
  "generate" off: *Not transcribed yet*.
- **Generating** — every part's stream via `CAPTURE_LECTURE_STREAMS`, then
  `transcriptProcessor.html?…&mode=bulk` in an inactive tab. In bulk mode the processor starts
  itself with the saved provider config, never alerts or confirms, caches the result as usual,
  skips its own file download, and answers `BULK_TRANSCRIPT_DONE {ok, text, partial | error}`.
  The bulk page writes the text, closes the tab, and removes its `onMessage` / `onRemoved`
  listeners. A transcript with failed chunks is saved but marked *with gaps*.
- **Video / audio** — `CAPTURE_LECTURE_STREAMS` (shared with the single-lecture downloader and
  cached per lecture), then `createHlsEngine({ sourceTabId, type, signal })` per part.

### Shared pieces extracted in this change

- `hlsDownloadEngine.js` — the download engine that used to live inside `videoProcessor.js`
  (manifest → media playlist → segments, worker pool, ordered writes, audio extraction), now a
  factory taking `sourceTabId`, `type`, `onLog`, `onProgress` and an abort `signal`.
  `videoProcessor.js` uses it and behaves as before, with one improvement: when the proxy tab
  can't be reached, chunk fetches now fall back to a direct fetch (the transcript processor
  already did this).
- `transcriptHeader.js` — `fetchMetadataHeader()`, previously duplicated in the processor and the
  versions page.
- `utils/domUtils.js → textNodesMatching()` — the text-node walker the playlist parser and the
  row parser share.

## Teardown & leaks

| What | Where it goes away |
|---|---|
| Class-list `MutationObserver` (`window._bulkDownloadObserver`) | disconnected once the bar is injected, after 30 s, on toggle off, and on every re-init (each navigation) |
| Debounce / cap timers | cleared in `stopBulkObserver()` |
| Picker listeners (incl. `keydown` on `document`) | one `AbortController`, aborted by `closeBulkModal()` |
| Bar + picker DOM | `teardownBulkDownload()` (toggle off, navigation away) |
| Processor tabs + their listeners | closed and removed on result, tab close, or cancel |
| Blob URLs (fallback downloads) | revoked after 10 s |

## Testing

- `tests/bulkDownload.test.js` — row parsing (split stamps, contests, icon text, single-stamp
  pages), subject name, events-feed fallback, year inference, bar injection (incl. a list that
  renders late), the picker (range, shift-click, Start payload, empty selection, Escape cleanup),
  teardown.
- `tests/bulkJob.test.js` — job parsing, file names, `runWithConcurrency`.
- `tests/hlsDownloadEngine.test.js` — rendition choice, ordered writes, failed chunks, proxy and
  its fallback, abort, in-memory download.
- `tests/transcriptParts.test.js` — the processor's bulk mode (auto-start, reporting, no alerts).
- `tests/videoTracker.test.js` — `START_BULK_DOWNLOAD`.

## Known limitations

- The class-list markup was written from a screenshot; if Scaler changes the stamp format or
  drops the `Lecture` cell, no rows are found and the bar doesn't appear.
- Every video/audio lecture needs a capture tab (inactive, muted, ~5–15 s), two at a time.
- Videos are the raw stream concatenated with an `.mp4` name (as with the single downloader);
  parts are separate files.
- Generating transcripts runs in background tabs, which Chrome throttles; long lectures take
  longer than in a foreground tab. It needs a provider key already saved on the transcript page.
- The bulk page and the subject tab must stay open while it runs.
