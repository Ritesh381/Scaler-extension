# Scaler++ docs

Start with **[architecture.md](architecture.md)** — execution contexts, load order, settings,
message routing, SPA handling. Every feature doc assumes it.

## Feature docs

| Doc | Setting key | Default |
|---|---|---|
| [dom-cleaner.md](dom-cleaner.md) — decluttering, modals, sidebar, mess-fee card, header icons | many (`referral-*`, `mess-fee`, `auto-close-modals`, `core-curriculum`, …) | on |
| [companion-bypass.md](companion-bypass.md) — join-session IP headers | `companion-bypass` | on |
| [calendar-sync.md](calendar-sync.md) — classes → Google Calendar | `calendar-sync` | on |
| [leetcode-link.md](leetcode-link.md) — LeetCode badge with confidence matching | `leetcode-link` | on |
| [problem-search.md](problem-search.md) — filter bar on the problems page | `problem-search` | on |
| [problem-picker.md](problem-picker.md) — Pick Random unsolved problem | `problem-picker` | on |
| [smart-revision.md](smart-revision.md) — spaced-repetition queue for solved problems | `revision-tracker` | on |
| [practice-mode.md](practice-mode.md) — auto-reset assignment code | `practice-mode` | off |
| [join-session-button.md](join-session-button.md) — live-class join button | `join-session` | on |
| [subject-sort.md](subject-sort.md) — Core vs Other curriculum split | `subject-sort` | on |
| [contest-leaderboard.md](contest-leaderboard.md) — unlock the live scoreboard link | `contest-leaderboard` | on |
| [spotlight-search.md](spotlight-search.md) — `Alt + /` search overlay | `spotlight-search` | on |
| [theme-manager.md](theme-manager.md) — dark mode + 6 themes, anti-FOUC preload | `theme` | `dark` |
| [video-downloader.md](video-downloader.md) — recording download (video/audio) | `video-downloader` | on |
| [lecture-transcript.md](lecture-transcript.md) — transcription + shared cache | (transcript option of the downloader) | — |
| [lecture-summary.md](lecture-summary.md) — AI lecture notes tab | `lecture-summary` | on |
| [lecture-info.md](lecture-info.md) — subject/instructor pills on dashboard cards | `lecture-info` | on |
| [instructor-info.md](instructor-info.md) — instructor pills + session tab | `instructor-info` | on |
| [assignment-export.md](assignment-export.md) — export problems to Markdown/ZIP | `assignment-export` | off |
| [vim-mode.md](vim-mode.md) — Vim keybindings in the Monaco editor | `vim-mode` | off |
| [live-stream-recorder.md](live-stream-recorder.md) — live DVR (**force-disabled**) | `live-stream-recorder` | off, locked |
| [custom-messages.md](custom-messages.md) — in-header announcements | — | always |
| [user-profile-sync.md](user-profile-sync.md) — profile sync, ping, download counters | — | always |
| [popup-settings.md](popup-settings.md) — the settings UI and how to add a toggle | — | — |

## Process docs

- [reviewer-guide.md](reviewer-guide.md) — template for a large-PR reviewer guide.
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — contributor workflow.
- [../CLAUDE.md](../CLAUDE.md) — conventions, leak rules, docs policy.
- [../tests/README.md](../tests/README.md) — the jsdom harness.

## Writing a new feature doc

Model it on an existing one. Cover, in order: what it does · setting key + files · how it works
(the mechanism, not a code dump) · data flow across contexts · teardown / leak notes ·
intentional limitations. Docs are updated the moment a feature converges, not at the end of a
session.
