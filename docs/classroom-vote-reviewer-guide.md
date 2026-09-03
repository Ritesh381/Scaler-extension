# Reviewer Guide — Classroom Tag (crowdsourced room allocation)

## What is this PR?

Adds a room tag to dashboard class cards, crowdsourced from students, because Scaler exposes the
physical room nowhere — not in the UI, not in any API. Full feature doc:
[classroom-vote.md](classroom-vote.md). Design record and every deviation from it:
[specs/2026-09-02-classroom-allocation-design.md](superpowers/specs/2026-09-02-classroom-allocation-design.md).

Spans two repos. **The backend must deploy first** — the extension points at prod, and an
undeployed backend answers `/api/classroom/*` with 404, which the UI renders as an unreachable vote
server with every room disabled.

## Suggested review order

1. `backend/src/services/classroomTrust.js` — the whole policy, pure and dependency-free. Everything
   else is plumbing around it. Read `pickLabel` and the two threshold constants first.
2. `backend/tests/classroomTrust.test.js` — 50 tests; the worked scenarios are the spec in
   executable form.
3. `backend/migrations/002_classroom_votes.sql`, `003_classroom_vote_history.sql` — four tables.
4. `backend/src/services/classroom.service.js` — Supabase I/O, settling, the daily cap, withdrawal.
5. `backend/src/controllers/classroom.controller.js` + `routes/classroom.routes.js` — guards: shared
   extension token for students, admin cookie JWT for anything exposing identities.
6. `extension-main/content/features/classroomVote/classroomLogic.js` — pure: vote window, card
   parsing, tag copy.
7. `extension-main/content/features/classroomVote/classroomVote.js` — injection, popover, teardown.
   The interesting parts are `_classroomSignature` and `_castClassroomVote`.
8. `extension-main/background/classroomProxy.js` — one fetch helper, two message handlers.
9. `tests/classroomVote.test.js` — 44 tests covering copy, DOM placement, resilience and leaks.

## Files added

**Backend**
- `migrations/002_classroom_votes.sql` — `classroom_votes`, `classroom_settled`,
  `classroom_voter_stats`
- `migrations/003_classroom_vote_history.sql` — `classroom_vote_history` (append-only audit trail)
- `src/services/classroomTrust.js` — trust math, no I/O
- `src/services/classroom.service.js` — Supabase reads/writes, settling, withdrawal
- `src/controllers/classroom.controller.js`, `src/routes/classroom.routes.js`
- `tests/classroomTrust.test.js` — first tests in this repo; `npm test` = `node --test`, no new deps

**Extension**
- `content/features/classroomVote/classroomLogic.js`, `classroomVote.js`
- `background/classroomProxy.js`
- `tests/classroomVote.test.js`
- `docs/classroom-vote.md`, this guide, and the design spec under `docs/superpowers/specs/`

## Files modified

**Backend** — `src/app.js` (one `app.use`), `package.json` (test script), `schema.sql` (context dump).

**Extension** — `manifest.json` (two content scripts after `lectureInfo.js`, version),
`background/background.js` (one `importScripts`), `content/content.js` (init on load + on
navigation, toggle-off branch), `popup.js` + `popup.html` + `content/cleaner/selectors.js` (the
`classroom-tag` setting in **both** `DEFAULT_SETTINGS` copies), `README.md`, `Feature-details.md`,
`CLAUDE.md`.

## Leak and performance statement

Added, and where each is torn down by `teardownClassroomTags()` (wired to the `classroom-tag`
toggle-off branch in `content.js`):

| Added | Torn down |
|---|---|
| one `MutationObserver`, 300 ms debounce, scoped to `.mentee-dashboard__content` | `window._classroomVoteObserver` disconnected and nulled |
| the observer's debounce `setTimeout` | `window._classroomVoteDebounce` cleared — a pass armed just before toggle-off would otherwise re-inject everything |
| the toast `setTimeout` | `window._classroomToastTimer` cleared, node removed |
| popover outside-click, Escape and scroll listeners | one `AbortController` on `window._classroomPopoverAbort` |
| injected `<style>`, `.scaler-classroom-info` nodes, `data-classroom-rendered` stamps | all removed |

No `setInterval`, no polling, no unbounded retries, no blob URLs.

Renders are idempotent by signature (`data-classroom-rendered`). That is a correctness requirement,
not an optimisation: the observer watches the subtree the feature writes into, so an unconditional
re-render re-triggers the observer, which re-renders — a 300 ms loop for the lifetime of the tab.
Two tests pin it by node identity.

Network: one batched `/states` request for all visible cards, cached 60 s by the sorted class-id
set, invalidated by a successful vote. Votes are fire-and-forget so the UI never blocks. Backend
side, voter scoring is two queries per class rather than two per voter, the daily-cap check is
`count: exact, head: true`, and the three prior-tier queries are memoised per request.

## What was intentionally NOT changed

- No new permission. `scalerbackend.vercel.app` was already a host permission; the localhost entry
  used during development has been removed.
- `lectureInfo.js` is untouched. The tag renders into its own container because
  `_applyInstructorInfo()` does `container.innerHTML = ""` on re-render, and it goes on the
  class-type line rather than in `.mentee-card__header`, which is a nowrap flex row shared with
  Scaler's own tags.
- No `geolocation`. Proof of presence would strengthen the trust model, but it flags Chrome review
  for a nice-to-have; recency and earned weight carry that load instead.
- No changes to any existing table, endpoint or response shape.

## Backward compatibility

Purely additive on both sides. Extension builds that predate this feature never call
`/api/classroom/*` and are unaffected by the deploy. Both migrations are `IF NOT EXISTS` and safe to
re-run. The state response dropped `myVoteLocked` for `myVoteEdits`, and the extension ignores the
old flag entirely, so a stale deploy still sending it cannot strand a voter.

## Risk assessment

**Low risk to existing behaviour.** Nothing shared is modified; a failure of the new feature
degrades to `Room : ?` with a disabled popover and one console warning.

**Medium risk in the trust model itself, by design.** Thresholds are one voter to show a room and
two to replace one, so a class with no history is a one-person label and two people agreeing beat
any prior. What remains: every vote is tied to a real synced Scaler account, `classroom_vote_history`
records every change and withdrawal, settling needs two voters before anything becomes permanent,
and repeated wrong answers decay a voter's weight to 0.25 and then to 0 (their votes still stored,
still counted as nothing, never disclosed to them).

**Privacy.** Head counts are public; names and emails are reachable only through
`/api/classroom/admin/*` behind the cookie JWT. Weights and accuracy scores never leave the server.

**Known gaps**, all documented under *Intentional limitations*: no proof of presence, no pre-class
freeze, prior tier 1 dormant until Scaler's events payload is confirmed to carry a course field, and
week 1 shows `Room : ?` on most cards.
