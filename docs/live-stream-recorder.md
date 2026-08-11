# Live Stream Recorder + DVR

> **Status: shipped OFF.** `LIVE_STREAM_RECORDER_FORCE_DISABLED = true` in
> [liveStreamRecorder.js](../extension-main/content/features/liveStreamRecorder/liveStreamRecorder.js)
> and `live-stream-recorder` is in `FORCE_DISABLED_FEATURES` in
> [popup.js](../extension-main/popup.js), which forces the toggle off **and disables it**. Even a
> user whose stored setting is `true` gets nothing: `init()` returns immediately — no UI, no
> observers, no listeners. To re-ship, remove it from both places.

**Setting key:** `live-stream-recorder` (default `false`)
**Code:** `content/features/liveStreamRecorder/liveStreamRecorder.js` (isolated world, UI + DVR) ·
`recorderBridge.js` (MAIN world, Agora + MediaRecorder) · `liveStreamRecorder.css` ·
vendored `libs/agora-sdk.js`

## What it does (when enabled)

Joins the live class's Agora channel as an audience member with its own client, records the
instructor's screenshare/camera plus audio with `MediaRecorder`, and gives the player DVR
controls — pause live, seek backwards, step, resume live, and download the recording so far as
`.webm`.

## Why a page-world bridge

`AgoraRTC` is a page global. A content script in the isolated world cannot see it, so all Agora
work lives in `recorderBridge.js`, injected as a `<script src>` from
`web_accessible_resources` after the vendored SDK. The two halves talk over `CustomEvent`s:

| Direction | Event | Payloads |
|---|---|---|
| content → page | `scaler-stream-command` | `init` (with config), `set-live`, `request-download`, `cleanup` |
| page → content | `scaler-stream-event` | `connection-status`, `layout-update`, `chunk-available`, `recording-status`, `download-ready` |

## Credentials

`fetchCredentials()` chains Scaler's own APIs: events → the session slug → the live-session
endpoint, extracting the Agora `appId`, `channel`, `token` and `uid`. No credentials are stored;
they are handed straight to the bridge for that session.

## Bridge: `StreamDirector`

- `AgoraRTC.createClient({ mode: "live", codec: "vp8" })`, role **audience**, then `join()`.
- `user-published` → subscribe. Audio tracks are played and collected into `audioTracks`;
  video tracks are classified by uid prefix — `2…` = **screenshare**, `1…` = **camera** — and
  stored as `screenshareTrack` / `cameraTrack`.
- `updateLayout()` plays the main track (screenshare preferred, else camera) into
  `#live-video-container`, and the camera into Scaler's own sidebar tile
  (`#recorder-sidebar-camera`) when both exist.
- `manageRecording()` records whichever is the main track. If the main track changes (instructor
  starts/stops sharing) the existing `MediaRecorder` is stopped and a new one started 150 ms
  later; if it is already recording the same uid, nothing happens.
- `startRecording()` builds a fresh `MediaStream` from the video track plus every live audio
  track, prefers `video/webm; codecs=vp8,opus`, and calls `start(1000)` — a chunk per second,
  emitted to the content script as `chunk-available`.
- `setLive(false)` mutes all audio tracks (volume 0) so DVR playback isn't doubled by the live
  feed.
- `cleanup()` stops the recorder, leaves the channel, and stops every track.

## Content side: UI and DVR

- `checkAndInject()` detects a live page (`.agora_video_player` / URL shape) and injects the
  toolbar button; a debounced `MutationObserver` scoped to the app root re-injects after SPA
  navigation.
- `prepareUI()` hides Scaler's own layout, creates the custom video container, injects status
  controls into Scaler's footer control panel, and prepares the sidebar camera tile (storing the
  original content so it can be restored).
- `hideConnectionError()` hides — and keeps hiding, via its own observer — the "Connection has
  been interrupted" overlay Scaler shows when *its* Agora client disconnects, which is expected
  once our client takes over.
- `getElement(key)` re-queries and re-caches DOM references when a cached node is detached, since
  React can swap the footer out from under us.
- **DVR** — recorded chunks are kept in an array. `enableDVRMode(seekToTime, shouldPlay)` builds a
  `Blob` from them, **revokes the previous object URL first**, sets it as the `<video>` source,
  waits for `loadedmetadata`, clamps the target time to the real duration, and switches the
  display. Concurrent transitions are guarded by a loading flag with a pending-seek slot.
  `jumpToLive()` cancels pending DVR work, restores the live view and unmutes.
  `stepSeek`, `handleSeek`, `togglePlayPause` and keyboard shortcuts drive it; the timeline is
  updated from `timeupdate` during DVR and from the buffer length while live.

## Teardown (`deactivate()`)

Removes the UI and restores Scaler's layout; removes the footer controls; restores the sidebar
tile's original content; disconnects the connection-error observer and un-hides the error;
removes the injected scripts and the `scaler-stream-event` listener; sends `cleanup` to the
bridge; **drops the chunk array**, revokes the DVR blob URL, and nulls the UI element cache so
detached nodes aren't retained.

## Limits and risks

- Joining the Agora channel with a second client is heavy: memory grows with recording length
  (chunks are held in RAM, not streamed to disk) and the DVR blob is rebuilt on each entry.
- Deeply coupled to Scaler's live-classroom markup and to Agora uid conventions
  (`1…` camera / `2…` screenshare).
- Output is `.webm` only.
- This is the reason for the kill switch: the feature is invasive enough that it is disabled for
  everyone until it can be re-validated.
