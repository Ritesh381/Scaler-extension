# Scaler++ Feature Technical Details

This document provides a technical overview of how each major feature is implemented within the Scaler++ extension. Features that solely rely on CSS/DOM element hiding are excluded.

## 🎨 Dark Mode & Elegant Themes

**Description:** A site-wide theme switcher that recolors the whole Scaler site — Dark, Midnight, Dracula, Nord, Warm Sepia and Solarized, plus an Off/Light option for the native look. Selected from an "Appearance" dropdown in the popup; applies instantly and syncs across devices.
**Implementation:** Rather than re-skinning Scaler's large, frequently-changing SPA selector-by-selector (which breaks on every dashboard tweak), the engine recolors the page with a single CSS `filter` recipe applied to the **root `<html>` element**, and counter-inverts real media (`img`, `video`, `canvas`, `iframe`, `svg image`, and CSS `background-image` elements) with `invert(1) hue-rotate(180deg)` so photos/videos keep their natural colors. Filtering the *root* element is deliberate: per the CSS spec a filter on the root applies to the viewport and does **not** establish a containing block for `position: fixed` descendants, so Scaler's sticky header, modals and the extension's own overlays keep working. Each theme is just a different filter recipe (e.g. `invert(1) hue-rotate(180deg)` for Dark, `invert(0.9) hue-rotate(200deg) saturate(1.15)` for Dracula), giving distinct moods from one robust engine with zero per-page maintenance. The **Midnight** theme additionally ports the look of [refact0r/midnight-discord](https://github.com/refact0r/midnight-discord): its blue-gray darkness (approximated via a tuned filter so it stays fully compatible with Scaler's DOM), plus its **exact Figtree font** — bundled with the extension (`fonts/figtree.woff2`, [SIL OFL 1.1](extension-main/fonts/Figtree-OFL.txt)) and exposed as a web-accessible resource so it loads regardless of the page CSP — and its **rounded corners**, applied to UI elements via case-insensitive class matching so they adapt to Scaler's utility classes without hard-coding selectors. Font/rounding extras are scoped to each theme's own class (`scaler-theme-midnight`), so they never leak to other themes. The selected theme id is persisted in `chrome.storage.sync` under `cleanerSettings.theme` and pushed to the active tab via the existing `toggleSetting` message channel for instant apply; `themeManager.js` toggles a `scaler-theme-active` class on `<html>` and swaps the contents of a single `<style id="scaler-theme-styles">` node. The theme lives on the persistent root element, so it survives SPA navigation without re-injection.

## 🧠 AI Lecture Notes

**Description:** Generates structured, readable notes from a lecture's transcript — a story-style "Lecture Brief" (concept by concept), plus Topics Taught, Key Takeaways, and the headline value: the **Deadlines** and **Announcements** the instructor mentioned during class. Shown in a dedicated "Notes" tab on the session page.
**Implementation:** A `MutationObserver` (with a bounded retry poll for slow loads) injects a "Notes" tab into the classroom navigation bar on session pages. The lecture is identified by resolving its unique slug from Scaler's classroom meta API (`https://www.scaler.com/api/v2/classroom/{classId}/meta`) — the same key the transcript cache uses, so a lecture's transcript and notes share one identifier. Opening the tab queries the extension backend (`GET /api/summary?slug=`) for a cached summary; if none exists it checks whether a transcript is cached, and if so reveals a "Generate" button. Generation sends the transcript plus a structured-output system prompt to a **user-configured, OpenAI-compatible** chat-completions endpoint (OpenAI, Google Gemini, Groq, OpenRouter, Anthropic/Claude, or a custom URL) using the user's own API key. The request is proxied through the background service worker so the page's Content-Security-Policy cannot block it, and the API key lives only in `chrome.storage.local` — it is never sent to the extension backend. The returned JSON (brief + topics/notes/deadlines/announcements) is rendered and then cached on the backend (a MongoDB document indexed in Supabase) keyed by the lecture slug, with the numeric class id, model name, and generating user's email stored as metadata. Caching is first-write-wins, so each lecture is generated only once and reused by everyone.

## ⬇️ Lecture Downloader & 📝 AI Transcription

**Description:** Allows downloading recorded lectures as audio, video, or fetching an AI transcript.
**Implementation:** A DOM observer waits for the `.vp-controls` class indicating a recorded lecture page, then injects a custom dropdown button into the header. When triggered, it communicates with the background service worker to capture the underlying M3U8 streaming link. For transcription requests, the extension downloads the audio chunks directly to the user's browser memory, and sends them directly to a user-configured third-party Speech-To-Text API provider (e.g., Deepgram, Groq, OpenAI, ElevenLabs) using their personal API key. All transcription processing occurs locally on the client without routing through any centralized extension backend, maximizing privacy and flexibility.

## 🔴 Live Stream Recorder & ⏪ DVR

**Description:** Enables recording of live classes with a DVR capability to seek back and play while the session is ongoing.
**Implementation:** Injects an SDK bridge (`agora-sdk.js` and `recorderBridge.js`) to capture the active Agora video/audio streams directly from the page context. It intercepts the stream data, pipes it into a `MediaRecorder` instance inside the extension content script, and tracks video blobs incrementally. When a user requests DVR payback, it creates a blob URL (`URL.createObjectURL()`) to play recorded chunks through a custom overlay `<video>` element.

## 📅 Google Calendar Sync

**Description:** Automatically synchronizes scheduled classes to Google Calendar.
**Implementation:** Utilizes an alarm (`chrome.alarms`) running every 24 hours. It fetches the mentee's upcoming events from the `https://www.scaler.com/academy/mentee/events/` endpoint. Using `chrome.identity.getAuthToken` (or a fallback OAuth web flow), it obtains a Google calendar access token and POSTs the filtered `lesson` events to the user's primary calendar using the Google Calendar API V3.

## 🛡️ Smart Companion Bypass

**Description:** Bypasses Scaler's companion-mode restriction when joining via restrictive campus WiFi networks.
**Implementation:** Upon detecting navigation to a `/session?joinSession=1` URL, it leverages `chrome.declarativeNetRequest` to dynamically inject IP-spoofing HTTP headers (e.g., `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`) using a random IP from a predefined pool. These rules stay active for ~5 seconds to authenticate the session, then auto-deactivate to prevent browser overhead.

## 🏆 Contest Leaderboard

**Description:** Enables viewing the ongoing leaderboard during an active contest.
**Implementation:** Locates the disabled "View Leaderboard" `div` snippet. Fetches the active contest metadata JSON using the `https://www.scaler.com/api/v2/classroom/{contestId}/contest` endpoint to capture the `alias` slug. Finally, it modifies the DOM to replace the non-clickable container with an anchor (`<a>`) tag routing to `/contest/{alias}/scoreboard`.

## 🔍 Global Spotlight Search

**Description:** An Apple Spotlight-like floating search overlay for navigating the dashboard.
**Implementation:** Listens for a global hotkey (`Alt + /` or `Option + /`), injecting a custom floating modal interface. Upon user input, it queries Scaler's `search-with-query` API endpoint. Includes debouncing (300ms) and handles `AbortController` cancellation to prevent race conditions during rapid typing. Search results map into generated DOM snippets for navigation directly via click or arrow keys.

## 🚀 Direct Join Session

**Description:** Provides a direct "Join Session" link for active classes directly on dashboard cards.
**Implementation:** Checks the DOM for parsed active dashboard date tabs and scheduled times. If the class is live, it replaces the "View Details" `span` tag on the class card with a dynamically generated anchor tag pointing directly to the `${classHref}/session?joinSession=1` URL.

## 📚 Subject Sort

**Description:** Separates class subjects into "Core" and "Other" on the curriculum page.
**Implementation:** Matches curriculum tile title strings (`._29EfoWpTY6mSoc0URgsgPl`) against a predefined array of keywords (e.g., `club`, `revision`, `workshop`). It modifies the DOM to reorder the Flexbox/Grid by appending the matched "Other" nodes to the end of the container, while dynamically injecting visual "Core" or "Other" badges and re-indexing the subject counters.

## 🔗 LeetCode Integration for Assignments

**Description:** Instantly maps assignment problems to LeetCode, injecting a direct link alongside the problem title.
**Implementation:** Extracts the problem title, sanitizes it (removing "Q1.", "Unsolved", etc.), and checks LeetCode's GraphQL API (`https://leetcode.com/graphql`) or falls back to a Google Search (`site:leetcode.com/problems`). To bypass CORS, network requests are routed through the background script. Validated links are stored in `chrome.storage.local` with a 30-day TTL for immediate retrieval and caching.

## 📦 Assignment Export

**Description:** Allows students to export coding assignments, problem statements, and MCQs into offline Markdown files or bulk ZIP archives.
**Implementation:** Implements a heavily decoupled, one-way data flow orchestrator (`exporter.js`). When a user requests a bulk export, the orchestrator spawns an invisible `<iframe>` in the background. It sequentially loads sidebar URLs, uses a shared `assignmentParser.js` to parse React DOM nodes into structured data (Title, Statement, Question Type), and injects a `pageBridge.js` script into the main world to extract user code from the isolated `window.monaco` instance via `CustomEvents`. The data is serialized to Markdown via `markdown.js` and packed into an in-memory JSZip archive (`zip.js`). To prevent memory leaks, iframe execution is sandboxed within a 10-second `Promise.race` timeout and strict `try...finally` cleanup blocks. All processing occurs locally.

## 🎯 Practice Mode

**Description:** Auto-resets code editor state if an assignment is unvisited for more than 5 hours to prevent spoilers.
**Implementation:** Intercepts the assignment problem URL (`/class/:id/assignment/problems/:id`), tracking the last visit timestamp via `chrome.storage.local`. If 5 hours have passed, it locates and simulates clicks on the `cr-icon-refresh` reload button and the subsequent confirmation modal's "Reset!" button to clear the persistent IDE state.

## 🔍 Instant Problem Search

**Description:** A custom problem search filter on the dashboard.
**Implementation:** Injects a custom search bar overlay on the problems page (`/academy/mentee-dashboard/problems`) catching the `/` keystroke. Uses Javascript to read and sanitize problem details (name, topic, completion status) from the DOM row text. As the user types, it selectively applies CSS classes (`scaler-search-hidden`) to toggle row visibility, updates counters, and dynamically replaces innerHTML with a regex to highlight the matched substring.
