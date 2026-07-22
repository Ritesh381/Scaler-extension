# Assignment Export - Reviewer Guide

Welcome to the Assignment Export feature PR! This guide is designed to help you review the architectural improvements and feature additions quickly and confidently.

## What is this PR?
This PR introduces the **Assignment Export** feature, allowing students to export their coding assignments and MCQs into offline Markdown files or ZIP archives. 

More importantly, this PR introduces a robust, heavily decoupled architecture for DOM parsing and background scraping that sets a new standard for feature modules in this extension.

## Suggested Review Order

1. **`content/features/assignmentExport/assignmentExport.js`**
   - **Why:** The entry point. It's only 30 lines long and demonstrates how features should be initialized (polling the DOM, checking settings).
2. **`content/utils/assignmentParser.js`**
   - **Why:** The generic extraction utility. Notice how it takes an optional `doc` parameter. This allows it to parse both the current page AND our background iframes.
3. **`content/features/assignmentExport/ui.js` & `markdown.js` & `zip.js` & `downloader.js`**
   - **Why:** The single-responsibility modules. Review these to verify that they do exactly one thing and have zero side-effects on each other.
4. **`content/features/assignmentExport/bridge.js` & `pageBridge.js`**
   - **Why:** The Monaco extraction layer. `pageBridge.js` is injected into the DOM to bypass the extension sandbox, and `bridge.js` safely listens for its CustomEvents.
5. **`content/features/assignmentExport/exporter.js`**
   - **Why:** The Orchestrator. This is the heart of the feature. Pay special attention to the `try...finally` blocks, concurrency locks (`isExporting`), and `Promise.race` timeouts in the bulk export loop.

## Files Added
- `content/utils/assignmentParser.js`
- `content/features/assignmentExport/assignmentExport.js`
- `content/features/assignmentExport/bridge.js`
- `content/features/assignmentExport/downloader.js`
- `content/features/assignmentExport/exporter.js`
- `content/features/assignmentExport/markdown.js`
- `content/features/assignmentExport/pageBridge.js`
- `content/features/assignmentExport/ui.js`
- `content/features/assignmentExport/zip.js`
- `docs/assignment-export.md`
- `docs/reviewer-guide.md`

## Files Modified
- `manifest.json`: Added permissions and resource loading for the new modular files.
- `content/features/leetcodeLink.js`: Removed duplicated problem extraction logic, now relying entirely on `assignmentParser.js`.

## What was intentionally NOT changed
- **No API reverse engineering:** We intentionally avoided hitting Scaler's backend APIs directly to prevent auth token complexities and rate limits. The hidden iframe approach reuses the existing SPA safely.
- **UI Styling:** The export button inherits colors consistent with the existing Scaler theme rather than introducing a custom design system.

## Backward Compatibility
- 100% compatible. The extraction logic was carefully stripped from `leetcodeLink.js` into a shared parser, ensuring the LeetCode feature continues functioning exactly as it did before.

## Risk Assessment
- **Low Risk:** The bulk of the execution relies on local string manipulation. The background iframe is heavily sandboxed within `Promise.race` timeouts and `try...finally` blocks, ensuring it will never memory leak or hang the user's browser, even if Scaler's website goes offline midway through an export.
