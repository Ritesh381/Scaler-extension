# Live AI Tutor

## What it does

The Live AI Tutor is an opt-in floating panel on an active Scaler classroom. A learner provides a transcription endpoint/key and an OpenAI-compatible chat endpoint/key. After the learner presses **Start listening**, Scaler++ captures the audio track exposed by the live video player in 20-second chunks.

Each chunk is sent directly to the learner's chosen transcription provider. The returned text is kept only in the content script's in-memory rolling transcript. When the learner asks a question, the extension sends the recent transcript, the optional current-topic field, and the question to the learner's chosen LLM. The LLM is instructed to answer only from that context and to say when the lecture has not covered the answer.

## Privacy and storage

- No shared API key, server, audio storage, transcript cache, or analytics are used.
- API credentials are stored in `chrome.storage.local` on the learner's device.
- Audio leaves the browser only after the learner presses **Start listening**, and only for the transcription endpoint they configured.
- Stopping or closing the panel stops the recorder and clears the transcript and messages from memory.

## Supported endpoints

The transcription proxy supports Deepgram, ElevenLabs, and OpenAI-compatible transcription endpoints (including Groq). The tutor response uses an OpenAI-compatible `chat/completions` endpoint. The manifest contains host access for the built-in provider presets; a custom endpoint must permit extension-origin requests or be added as a host permission in a future provider-permission flow.

## Limitations

The feature depends on the live player exposing an audio track through `HTMLMediaElement.captureStream()`. If Scaler changes its player or the instructor stream has no accessible audio track, the panel explains that listening cannot start. The current implementation retains only a bounded recent transcript, so it is intentionally a live “what was just explained?” companion rather than a permanent recording archive.
