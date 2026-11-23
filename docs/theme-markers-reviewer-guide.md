# Theme: Late-Sized Panels & Attribute Markers — Reviewer Guide

## What is this PR?

A fix for the lecture page's chat panel (and the other side panels) turning white after being
closed and reopened, until the theme was re-applied. Two commits:

1. **`fix: re-theme elements that get their size after they are first seen`**: hardening. The
   theme's size checks ran once per element. A panel that mounts collapsed and slides open, a
   shell filled after it mounts, a dark drawer mounting at width 0, and a video resized by CSS
   alone all kept their first verdict. These are now re-evaluated through one `ResizeObserver`.
2. **`fix: mark themed and dark elements with attributes, not classes`**: **the fix for the
   reported bug.** Scaler's React sets the sidebar's whole `className` on every close/open. That
   wiped the `.scaler-themed` class the CSS selected on, while the `data-scaler-themed`
   attribute stayed, so every scan treated the sidebar as already handled. The attributes are now
   the only markers.

Commit 1 was written first, from a guessed cause, and did not fix the bug on its own. The gaps it
closes reproduce in Chromium, so it stays. Reviewing commit 2 first is quicker.

## Suggested review order

1. **Commit 2, `themeManager.js`** (small, mechanical):
   - the constants at the top: `SCALER_DARK_SELECTOR`, `SCALER_THEMED_SELECTOR`, and the
     comment explaining why they are attributes;
   - `buildFilteredScopeCss()` (`keepDarkSelectors`) and `buildVideoScopedCss()` (`scope`): the
     CSS now selects on the attributes;
   - `flagDarkCandidates()`, `clearDarkRegions()`, `markThemed()`, `clearScopedTheme()`,
     `extendScopedTheme()`: no class writes left.
2. **Commit 2, tests**: `a themed panel keeps its filter when the page rewrites its class` and
   `a dark region keeps its counter…`. `filterRulesFor()` matches the stylesheet's own filter
   rules against the element, so the tests check what the browser would apply, not a marker.
3. **Commit 1, the growth watch** in `themeManager.js`:
   - `watchForGrowth()`, `onWatchedResize()`, `hasOutgrownGate()`: the four `kind`s and when
     each is released;
   - `clearGrowthWatch()`, `pruneGrowthWatch()`, `stopGrowthWatch()`: teardown;
   - `patchTheme()`: the one path for added nodes and regrown nodes, in both modes.
4. **Commit 1, scoped-mode classification**: `offPathVerdict()` was split out of
   `classifyOffPath()` so `extendScopedTheme()` can walk an added node's ancestors top-down,
   as a full render does. `markThemed()` clears flags *inside* a newly themed subtree, so nothing
   is filtered or countered twice.
5. **Commit 1, tests**: `fakeLayout()` gives jsdom element sizes via `data-box`, and
   `fakeResizeObserver()` lets a test fire resizes by hand.

## Files added

- `docs/theme-markers-reviewer-guide.md`

## Files modified

- `extension-main/content/features/themeManager.js`
- `tests/themeManager.test.js`: 8 new tests, and the existing tests assert the attributes
  instead of the classes.
- `docs/theme-manager.md`: new sections "Markers are attributes, never classes" and "Sized after
  it is first seen", plus limits.
- `CLAUDE.md`: the attribute rule, under Architecture notes, since it applies to every feature.
- `Feature-details.md`, `docs/README.md`.
- `extension-main/manifest.json`: version 1.11.9 → 1.11.10.

## What was intentionally NOT changed

- **`themePreload.js`**: it never used either class.
- **The `<html>` classes** (`scaler-theme-active`, `scaler-theme-scoped`, `scaler-theme-<id>`):
  `<html>` isn't rendered by React, and they are reconciled on every flush anyway.
- **The `MutationObserver`, the rAF flush and the `loadedmetadata` listener**: unchanged. Commit 1
  adds one `ResizeObserver`; no other observer, timer or listener.
- **Theme recipes and colours**: byte-identical filters; only selector text changed.
- **Backgrounds that change by class or stylesheet alone** (no node added, no size change) are
  still not re-evaluated. That is documented as a limit, because watching every class change
  would mean an attribute observer on the whole body.

## Backward compatibility

- An attribute selector has the same specificity as a class, so the cascade order is unchanged.
- Anything outside this repo that styled `.scaler-no-invert` or `.scaler-themed` (a user
  stylesheet, say) needs `[data-scaler-dark-region]` / `[data-scaler-themed]` now. Nothing in the
  repo did.
- Theme off removes every marker and empties the growth watch, as before.

## Risk assessment

- **Commit 2: low.** A rename of the selector the CSS matches on, covered by the new
  class-rewrite tests and the updated existing ones.
- **Commit 1: low to medium.** It re-themes elements later than before. The callback only runs
  for elements that failed a size gate, at most 300 are watched, and every one is released when
  it is themed, removed, re-rendered or the theme goes off. In Chromium, 21 ways of opening a
  panel all end up flagged exactly as a fresh full render flags them.
- **Not verified on scaler.com by the author.** The real page's structure was captured with a
  console dump and rebuilt locally, so please run the PR's "verify on scaler.com" steps.
