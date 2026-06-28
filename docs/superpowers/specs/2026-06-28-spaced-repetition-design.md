# Smart Revision — Spaced Repetition for Scaler Problems

**Date:** 2026-06-28  
**Branch:** `feature/smart-revision`  
**Status:** Approved

---

## Problem

Scaler students solve problems but rarely revisit them. Without revision, retention drops sharply within days. No existing tool inside Scaler or the extension surfaces a structured revision queue.

---

## Goal

Automatically track problems a student solves on Scaler and surface them for revision at spaced intervals (1 → 3 → 7 → 14 → 30 days). Once a problem is revisited through all five stages it is considered retained and removed from the queue. An in-page panel on the Scaler dashboard shows today's due problems.

---

## Scope

- Detect solves via the existing `/academy/mentee/problems-data` API (same endpoint used by `problemPicker.js`)
- Fixed interval schedule: `[1, 3, 7, 14, 30]` days
- UI: injected in-page panel on `scaler.com/academy/**` dashboard pages
- Toggle in extension popup (default: on)
- No server, no external service, no paid API

Out of scope: LeetCode problems, custom problem sets, SM-2 adaptive scheduling, browser notifications.

---

## Architecture

### New files

| File | Purpose |
|---|---|
| `extension-main/content/features/revisionTracker.js` | Core logic: solve detection, scheduling, panel injection |
| `extension-main/content/features/revisionPanel.css` | Panel styles |

### Modified files

| File | Change |
|---|---|
| `extension-main/content/content.js` | Call `initRevisionTracker()` on dashboard URL match |
| `extension-main/content/cleaner/selectors.js` | Add `"revision-tracker": true` to `DEFAULT_SETTINGS` |
| `extension-main/popup.html` | Add toggle row in Settings section |
| `extension-main/popup.js` | Wire toggle save/load/reset |
| `extension-main/popup.css` | Toggle style (matches existing) |

---

## Data Model

Stored in `chrome.storage.local` under key `scalerpp_revision_log`.

```js
// scalerpp_revision_log shape
{
  "<ib_problem_id>": {
    title: string,           // problem title from API
    url: string,             // full Scaler problem URL
    solvedAt: number,        // ms timestamp of first solve detection
    intervals: [1, 3, 7, 14, 30],  // days (constant)
    stage: number,           // 0–4, current index into intervals
    nextDue: number          // ms timestamp: solvedAt + intervals[stage]*day
  }
}
```

- **Graduation:** when `stage` would exceed `intervals.length - 1`, delete the entry.
- **Storage cost:** ~200 bytes/problem × 1000 problems = ~200 KB. Well within the 10 MB `chrome.storage.local` limit.
- **No sync storage:** revision log is device-local (`chrome.storage.local`), not synced across devices. Keeps writes cheap and avoids sync quota pressure.

---

## Component Flow

```
Page load on scaler.com/academy/**
        │
        ▼
initRevisionTracker()
        │
        ├─ setting "revision-tracker" off → return (zero cost)
        │
        ├─ data-revision-injected already set → return (SPA guard)
        │
        ▼
fetch /academy/mentee/problems-data  { credentials: "include" }
        │
        ├─ fetch fails (network / 401 / 403) → silently return
        │
        ▼
chrome.storage.local.get("scalerpp_revision_log")
        │
        ├─ storage error → treat as {} (fresh start)
        │
        ▼
DIFF: API problems where status === "solved" AND id not in log
   → add entry with stage:0, nextDue = solvedAt + 1 day
        │
        ▼
Write updated log to chrome.storage.local (only if new entries)
        │
        ▼
Filter log: entries where nextDue <= Date.now()  →  dueToday[]
        │
        ▼
Inject panel into dashboard DOM (set data-revision-injected)
   Shows dueToday list, or "Nothing due today ✓" if empty
        │
        ▼
User clicks "Revisit" on a problem card
        │
        ├─ Opens problem URL in new tab
        ├─ stage++
        ├─ stage >= intervals.length → delete entry (graduated)
        ├─ else → nextDue = Date.now() + intervals[stage] * DAY_MS
        └─ Write updated log to chrome.storage.local
```

---

## Performance Budget

| Operation | Cost | Frequency |
|---|---|---|
| API fetch `/mentee/problems-data` | ~50–100 KB | Once per page load |
| `chrome.storage.local` read | < 1 ms | Once per page load |
| `chrome.storage.local` write | < 1 ms | Only on new solve or Revisit click |
| Panel DOM nodes | ~15 nodes | Once per page load |
| MutationObserver | **none** | — |
| `setInterval` / polling | **none** | — |
| Background alarm | **none** | — |

API response cached in a module-level variable for the session lifetime. If the page navigates within the SPA, the injection guard prevents a second fetch or panel re-render.

---

## Panel UI

Injected as a card after the existing Scaler dashboard header. Matches Scaler's existing card style and respects dark mode (uses the extension's theme classes).

```
┌─────────────────────────────────────┐
│  📚 Revise Today (3)          [−]   │
├─────────────────────────────────────┤
│  Two Sum                 [Revisit]  │
│  Binary Search           [Revisit]  │
│  Merge Sort              [Revisit]  │
└─────────────────────────────────────┘
```

- Collapsible (chevron toggle, state persisted in `sessionStorage`)
- "Revisit" opens problem in new tab and advances stage immediately
- Panel removed and re-injected on SPA nav only if panel is absent

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Not logged in / API 401 or 403 | Silently skip — no panel, no error shown |
| Network timeout | Silently skip |
| Problem URL missing in entry | Fall back to `https://www.scaler.com/academy` |
| `chrome.storage.local` quota exceeded | Catch + `console.warn`, skip write |
| Extension context invalidated | `isExtensionValid()` guard — same pattern as all other features |
| Panel already present on SPA nav | `data-revision-injected` attribute guard |

All failure paths are silent to the user — the feature must never break the Scaler page.

---

## Testing (`tests/revisionTracker.test.js`)

| Test | Assertion |
|---|---|
| New solve detected | Solved problem absent from log → entry created, `stage:0` |
| Already-logged solve not overwritten | Existing entry unchanged on re-fetch |
| Due-today filter | `nextDue <= now` included; `nextDue > now` excluded |
| Revisit advances stage | `stage` increments, `nextDue` correct for each interval |
| Graduation after last revisit | Entry deleted when `stage` exceeds last interval |
| API failure graceful | Fetch rejects → no throw, log unchanged |
| Storage failure graceful | `get` rejects → defaults to `{}` |
| Duplicate injection guard | `initRevisionTracker()` called twice → panel injected once |
| Setting off | Feature disabled → fetch never called |

Test stack: Node.js built-in runner + jsdom. No new dependencies.

---

## Implementation Plan (high level)

1. New branch `feature/smart-revision` off latest `main`
2. `revisionTracker.js` — pure logic functions first (testable), then DOM injection
3. `revisionPanel.css` — minimal styles
4. Wire into `content.js` and `selectors.js`
5. Popup toggle in `popup.html` / `popup.js` / `popup.css`
6. Tests in `tests/revisionTracker.test.js`
7. GPG-signed commit, push, PR against `Ritesh381/Scaler-extension:main`
