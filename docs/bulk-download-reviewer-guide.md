# Bulk Lecture Download — Reviewer Guide

## What is this PR?

A **Bulk download** button on a subject's class list. It saves transcripts, video and/or audio
for a range of lectures into one folder. The work runs on a dedicated extension page.

The PR is stacked on **PR #2** (`fix/playlist-part-downloads`). It reuses PR #2's capture tabs
(`CAPTURE_LECTURE_STREAMS`) to find every lecture's streams, including multi-part lectures,
without opening them in the user's own tab.

## Suggested review order

1. **`content/features/bulkDownload/bulkJob.js`**: the pure helpers (job parsing, file names, the
   concurrency runner). They're short and fully tested.
2. **`content/features/videoDownloader/hlsDownloadEngine.js`** and the diff of
   **`videoProcessor.js`**. The engine is the code that used to live in `videoProcessor.js`,
   wrapped in a factory. Diffing the two shows it moved almost verbatim. The deliberate changes:
   - an injected `onLog` / `onProgress` / `signal`;
   - chunks fall back to a direct fetch when the proxy tab is unreachable.
3. **`content/features/bulkDownload/bulkDownload.js`**: the class-list side. Row parsing is
   text-based (see `docs/bulk-download.md`). Also check the observer lifecycle and the
   `AbortController` on the picker.
4. **`background/videoTracker.js`**: one new message, `START_BULK_DOWNLOAD`.
5. **`content/features/bulkDownload/bulkDownloadPage.js`**: the orchestrator. Focus on:
   - `awaitGeneratedTranscript()`: listener cleanup and tab closing on every path;
   - `downloadStream()`: abort and half-file removal;
   - `run()`: cancel and retry.
6. **`transcriptProcessor.js`** bulk mode, all gated on `bulkMode`:
   - the deferred auto-start in `loadConfig`;
   - early exits report instead of `alert`;
   - no local file;
   - the `finally` guard that always reports once.
7. Settings wiring: `popup.html`, `popup.js`, `cleaner/selectors.js`, `content.js`,
   `manifest.json`.

## Files added

- `content/features/bulkDownload/bulkDownload.js`, `bulkDownload.css`
- `content/features/bulkDownload/bulkDownloadPage.html`, `bulkDownloadPage.js`, `bulkJob.js`
- `content/features/videoDownloader/hlsDownloadEngine.js`
- `content/features/videoDownloader/transcriptHeader.js`
- `docs/bulk-download.md`, `docs/bulk-download-reviewer-guide.md`
- `tests/bulkDownload.test.js`, `tests/bulkJob.test.js`, `tests/hlsDownloadEngine.test.js`

## Files modified

- **`manifest.json`**: `bulkDownload.js` and `.css` added to the main content-script block. No
  new permissions.
- **`videoProcessor.js` / `.html`**: use the shared engine (−313 lines).
- **`transcriptProcessor.js` / `.html` and `transcriptVersions.js` / `.html`**: use the shared
  `transcriptHeader.js`, and the processor gains bulk mode.
- **`content/utils/stringUtils.js`**: `extractClassId()`.
- **`content/utils/domUtils.js`**: `textNodesMatching()`. `playlistCapture.js` (PR #2) now uses
  it instead of its own copy.
- **`background/videoTracker.js`**: `START_BULK_DOWNLOAD`.
- **`popup.html`, `popup.js`, `content/cleaner/selectors.js`, `content/content.js`**: the
  `bulk-download` toggle.
- **Docs**: `README.md`, `Feature-details.md`, `docs/README.md`, `docs/video-downloader.md`,
  `docs/lecture-transcript.md`.

## What was intentionally NOT changed

- **No private Scaler APIs.**
  - Class ids come from the row links.
  - The fallback is the events feed `lectureInfo.js` already reads.
  - Streams come from capture tabs that play the lecture like a user would.
  - The only Scaler JSON read is `/api/v2/classroom/{id}/meta` and `/session`, which every
    transcript download already reads.
- **The four existing private `_extractClassId` copies** in `lectureInfo.js`, `instructorInfo.js`,
  `videoDownloader.js` and `lectureSummary.js` are left alone. Swapping them for the new util is
  a separate cleanup that touches four untested features.
- **No backend changes.**
- **The single-lecture download flow** is unchanged for the user.

## Backward compatibility

- `videoProcessor.html` behaves as before. The only behavioural difference is the direct-fetch
  fallback when its source tab is gone; before, those chunks were skipped.
- The transcript header text is byte-for-byte what both pages produced before; the two copies
  were identical in output.
- The processor without `mode=bulk` is untouched. Bulk-mode branches are all behind `bulkMode`.

## Merge notes

- **Merge after PR #2.** This branch is built on it.
- **If PR #3 (same-model prompt) merges too**, two things need attention:
  - PR #3's processor calls `fetchMetadataHeader()`. That name is kept on purpose, now in
    `transcriptHeader.js`.
  - In bulk mode the same-model prompt never shows, because bulk only generates lectures without
    a cached transcript. If a version appears between the bulk page's check and the run, the
    prompt would wait in a background tab. Guarding PR #3's prompt with `if (!bulkMode)` closes
    that gap.

## Risk assessment

- **Medium, because of unverified markup.** The class-list row and title heuristics were written
  from a screenshot. If they miss, the bar simply doesn't appear; nothing else breaks.
- **Low for the engine move.** It's covered by new tests (ordering, retries, proxy, abort), and
  the existing suite passes unchanged.
- **Resource use is bounded:**
  - 2 lectures at a time × 6 chunk workers;
  - at most 2 capture tabs;
  - 1 transcription tab at a time;
  - every tab, listener, observer and timer has an explicit teardown (table in
    `docs/bulk-download.md`).
