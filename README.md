# Scaler++

Bypass companion-mode on campus WiFi, download lecture recordings as audio/video/transcript, sync lectures with google Calendar, get LeetCode links on assignments & declutter your Scaler dashboard — all in one lightweight Chrome extension.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Available-green?logo=googlechrome)](https://chromewebstore.google.com/detail/scaler++/fpnleckmeeahiognlpphbadchogfjgcg)

---

## 🚀 ENHANCEMENTS

## 🧠 AI Lecture Summary

Adds a **"Summary"** tab on the session page that shows an AI-generated summary of the lecture — **Topics taught**, **Notes**, **Deadlines**, and **Announcements** — built from the lecture transcript.

## ⬇️ Lecture Downloader & 📝 AI Transcription

Download recorded lectures directly from the Scaler recordings page as **audio**, **video**, or **transcript** (using your own custom API key for providers like Deepgram, Groq, OpenAI, or ElevenLabs).

## 🛡️ Smart Companion Bypass

Bypass Scaler's companion-mode when joining with SST's campus wifi.

Credits - [PHATWalrus](https://github.com/PHATWalrus)

## 🔴 Live Stream Recorder & ⏪ DVR

Rewind the live lecture.

## 📅 Google Calendar Sync

Automatically adds your upcoming Scaler classes directly to your Google
Calendar — no manual entry needed.

## 🚀 Direct Join Session

Replaces the "View Details" text on live class cards with a direct **"Join Session"** button.

## � Subject Sort

Automatically organizes your curriculum subjects into **Core** and **Other** categories for a cleaner learning experience.

## 🔗 LeetCode Integration for Assignments

Automatically detects assignment problems and adds a **direct link** to the corresponding LeetCode problem with **intelligent caching** for instant results.

Credits - Siddhanth kapoor

## 📦 Assignment Export

Export your assignment problems, MCQs, and written code directly to formatted Markdown files for offline review or archiving.
- Click **Export** to download the current problem.
- Select **Export All (ZIP)** to seamlessly scrape and package your entire assignment session into a cleanly structured ZIP archive.
- Runs 100% locally in your browser. No backend required. Supports Coding, Single Correct, and Multiple Correct MCQs.

## 📘 Lecture Info

Show session metadata (title, date, instructor/company, rating) directly on class session pages and dashboard cards for quick reference.

## 🧑‍🏫 Instructor Info

Display instructor name, company and role on dashboard class cards and inside a dedicated "Instructor Info" tab on the session page.

## 🎯 Practice Mode

Automatically resets the code editor in assignments if not touched for 5+ hours. Includes a customizable auto-disable timer (1–30 days) and tracks manual resets to prevent accidental spoilers.

## 🔍 Instant Problem Search

Search from all the problems instantly by name, topic, type, or day.

## 🏆 Contest Leaderboard

Always shows a clickable "View Leaderboard" link on contest pages, even during active contests when it's normally disabled.

## 🔍 Global Spotlight Search

Press **`Alt + /`** (Option + / on Mac) or click the **Search** button in the Scaler header to open a floating Apple-style search bar. Instantly find and jump to **Classes**, **Problems**, or **Events** from anywhere on Scaler.

## 🎨 Dark Mode & Elegant Themes

Recolor the **entire Scaler website** with a single click. Open the popup → **Appearance** → pick a theme: **Dark**, **Midnight**, **Dracula**, **Nord**, **Warm Sepia**, or **Solarized** (or **Light / Off** for the native look). Themes apply instantly, sync across your devices, and keep images, videos and the sticky header working correctly.

The **Midnight** theme ports the look of [refact0r/midnight-discord](https://github.com/refact0r/midnight-discord) — its blue-gray darkness, its **Figtree** font (bundled, [SIL OFL 1.1](extension-main/fonts/Figtree-OFL.txt)) and its rounded corners.

## 🧹 CLEANER DASHBOARD

### 🌍 Global Elements (All Pages)

- **Refer & Earn** - Hide the ₹ referral button in the header.
- **Scaler Coins** - Remove the coin counter and store link.
- **Popups & Widgets** - Auto-hide referral modals and floating notebook buttons.
- **Auto-Close** - Automatically dismisses referral/NSET popups as they appear.

### 📋 Dashboard (Todos) & Sidebar

- **Promotional Cards** - Hide "2025 Revisited", referral banners, and promo cards.
- **Counters & Stats** - Hide live referral counters and recording carousels.
- **Smart Mess Fee** - Hidden by default, auto-shows whenever the submission form link is live.
- **Clean Sidebar** - Remove store links and "Refer Friends" badges.

---

## ✨ KEY BENEFITS

- ✅ **Instant Apply** - Settings take effect immediately without a page reload.
- ✅ **Smart Bypass** - Companion mode bypassed on-demand with zero permanent overhead.
- ✅ **Lecture Downloads** - Download 2-hour recordings as lightweight audio, full video, or fully local AI transcripts.
- ✅ **Smart Caching** - LeetCode links load instantly on revisits (20-50× faster).
- ✅ **Lightweight & Fast** - Native performance with no external dependencies.
- ✅ **Privacy Centric** - No data collection; works entirely via local storage.
- ✅ **Sync Support** - Your preferences are saved automatically across devices.

---

## 🛠️ Installation

1. **Install** from the [Chrome Web Store](https://chromewebstore.google.com/detail/scaler++/fpnleckmeeahiognlpphbadchogfjgcg) or load unpacked in Developer Mode.
2. Open chrome://extensions/ and enable Developer Mode.
3. Click on "Load unpacked" and select the extension folder.

---

## 🏗️ Architecture

```
extension-main/
├── manifest.json
├── popup.html / popup.css / popup.js
├── background/
│   ├── background.js        ← Service worker entry point (importScripts only)
│   ├── companionBypass.js   ← Smart Companion Bypass logic
│   ├── leetcodeLink.js      ← LeetCode search & verification
    ├── calendarSync.js      ← Sync classes directly into Google Calendar
│   ├── summaryProxy.js      ← AI summary cache + LLM proxy (CSP-safe)
│   └── videoTracker.js      ← M3U8 stream capture & download initiation
└── content/
    ├── content.js           ← Entry point & message handler
    ├── core/                ← settings, styleInjector, urlObserver
    ├── cleaner/             ← selectors, cleanerEngine, modalHandler, sidebarHandler
    ├── features/
    │   ├── videoDownloader/  ← Lecture download & transcript module
    │   │   ├── videoDownloader.js    ← Button injection & recording detection
    │   │   ├── videoProcessor.html   ← Download progress UI
    │   │   ├── videoProcessor.js     ← Concurrent HLS downloader engine
    │   │   ├── transcriptProcessor.html ← Dedicated transcription UI
    │   │   ├── transcriptProcessor.js   ← Client-side transcript orchestrator
    │   │   ├── customAudioTranscriber.js ← Custom STT API adapters (Deepgram, Groq, etc)
    │   │   └── modeBadge.js          ← Audio/Video mode badge
    │   ├── liveStreamRecorder/ ← Live recording & DVR module
    │   │   ├── liveStreamRecorder.js ← Main logic & UI injection
    │   │   ├── recorderBridge.js     ← Page context Agora handler
    │   │   └── liveStreamRecorder.css ← Custom player styles
    │   ├── lectureInfo.js / instructorInfo.js ← Session/dashboard metadata & instructor tab
    │   ├── lectureSummary.js ← AI lecture summary tab (topics/notes/deadlines/announcements)
    │   ├── themeManager.js   ← Site-wide Dark Mode & theme engine (root-filter recipes)
    │   ├── problemSearch, practiceMode, leetcodeLink, spotlightSearch,
    │   │   joinClassButton, companionBypass, subjectSort, contestLeaderboard
    └── utils/               ← domUtils, stringUtils

tests/                       ← jsdom + node:test suite for content features (see tests/README.md)
```

---

## 🧪 Testing

Unit + integration tests for the content-script features live in [`Scaler++/tests`](tests/) and run on Node's built-in test runner with jsdom (no Jest):

```bash
cd Scaler++/tests
npm install      # one-time: installs jsdom
npm test         # runs the full suite
```

Coverage includes the string/DOM utilities, join-class time logic, custom-message selection, the Instructor Info tab/dashboard tagging, and the full **AI Lecture Summary** flow (cached render, Generate-button states, and the generate→cache path). A `smoke.test.js` loads the entire manifest content-script bundle in one scope and asserts every feature entrypoint is wired up — so newly added content scripts are covered automatically. See [`tests/README.md`](tests/README.md) for details.

---

Made with ❤️ by **Scaler community** for the Scaler community.

_Focus on what matters — your learning journey!_
