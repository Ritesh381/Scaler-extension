# Classroom Allocation — Crowdsourced Room Tags on Class Cards

**Date:** 2026-09-02
**Status:** implemented — see Implementation deviations at the end
**Touches:** `Scaler++` extension repo + `backend` repo (Supabase/Postgres, Express on Vercel)

## Problem

Classes are scheduled but the physical room is nowhere in Scaler's UI or APIs. Seven rooms
exist: `0C`, `1A`, `1B`, `2A`, `2B1`, `2B2`, `2C`. Students find the room by asking around.

No API provides it, so the data has to come from the students themselves. That makes it a
crowdsourcing problem, and crowdsourcing a single mutable value invites the failure mode
"Where Is My Train" has at the platform level: one bad actor changes the value shortly before
the event and a crowd walks to the wrong place.

## Prior art

**Where Is My Train.** Its core tracking is not crowdsourced voting — it is cell-tower
fingerprinting plus anonymized background location logs from users physically on the train.
Platform numbers are crowdsourced on top of that, and reports are implicitly location-verified:
the reporter's phone is at that station at that time. That verification is the load-bearing part,
and it is exactly what we cannot have. Its anti-abuse specifics are not publicly documented.

**Waze**, which is documented: reports need multiple independent confirmations before being
trusted; single unconfirmed reports get filtered; reporters with a bad history are down-weighted;
reports expire on a timer; other users up/downvote live reports. Trust-fusion literature supports
weighted aggregation over raw majority.

**Why the stampede is rare there and would be common here.** Waze/WIMT attackers must out-shout
hundreds of people physically present, inside a short window. Our crowd is one batch — tens of
people. Raw majority is not safe at that scale. Hence: earned weight, vote caps, and a threshold
that a single voter can never cross.

**What we have that they do not:** identity. `usernameTracker.js` already syncs a real Scaler
email, name and batch into `extension_users`. There is no anonymous voting, and no cheap way to
manufacture accounts.

## Decisions

1. Room values: the 7 rooms plus `online`. Default display before any signal: `Room ?`.
2. History-based prediction holds the label. A single dissenting vote never flips the display —
   it shows as a secondary line. Two or more agreeing voters (subject to weight, below) flip it.
3. Exactly one label on display at a time.
4. Vote counts are public; voter names and emails are admin-only.
5. Hardening: vote window + per-user caps + earned weight. No pre-class freeze.
6. Vote window is `[class_start − 24h, class_end]`, with recency-weighted votes.
7. Tag renders next to the `lectureInfo` tags on the dashboard class card.

## Data model

Three tables. Tallies are aggregated on read, never kept in counter columns — the same reasoning
recorded in `backend/migrations/001_transcript_versions.sql`: concurrent votes cannot lose a race.

### `classroom_votes` — one row per user per class

```sql
CREATE TABLE IF NOT EXISTS public.classroom_votes (
  class_id       text NOT NULL,
  email          text NOT NULL,
  room           text NOT NULL CHECK (room IN ('0C','1A','1B','2A','2B1','2B2','2C','online')),
  batch          text,          -- super_batch_name, denormalized for prior grouping
  subject        text,          -- course/module if available, else NULL (see Open item)
  lecture_title  text,          -- diagnostic only, never a prior key
  class_date     date NOT NULL,
  weekday        smallint NOT NULL,      -- 0-6, prior tier 2
  slot_start     text NOT NULL,          -- 'HH:MM' 24h local, prior tier 2
  class_start    timestamptz NOT NULL,
  class_end      timestamptz NOT NULL,
  weight_at_vote numeric NOT NULL DEFAULT 0.5,  -- snapshot, never rewritten
  edits          smallint NOT NULL DEFAULT 0,   -- 0 -> 1, then locked
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classroom_votes_pkey PRIMARY KEY (class_id, email)
);

CREATE INDEX IF NOT EXISTS classroom_votes_class_idx ON public.classroom_votes (class_id);
CREATE INDEX IF NOT EXISTS classroom_votes_email_idx ON public.classroom_votes (email, created_at DESC);
```

`weight_at_vote` is a snapshot so that recomputing voter stats later can never retroactively
rewrite what a past class displayed.

### `classroom_settled` — the settled truth per class

```sql
CREATE TABLE IF NOT EXISTS public.classroom_settled (
  class_id   text PRIMARY KEY,
  batch      text,
  subject    text,
  weekday    smallint NOT NULL,
  slot_start text NOT NULL,
  class_date date NOT NULL,
  room       text NOT NULL,
  vote_count integer NOT NULL,
  weight_sum numeric NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS classroom_settled_prior_idx
  ON public.classroom_settled (batch, subject, class_date DESC);
CREATE INDEX IF NOT EXISTS classroom_settled_slot_idx
  ON public.classroom_settled (batch, weekday, slot_start, class_date DESC);
```

The only table the prior and the accuracy scoring read.

### `classroom_voter_stats` — earned weight

```sql
CREATE TABLE IF NOT EXISTS public.classroom_voter_stats (
  email      text PRIMARY KEY,
  correct    integer NOT NULL DEFAULT 0,
  incorrect  integer NOT NULL DEFAULT 0,
  weight     numeric NOT NULL DEFAULT 0.5,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Fully derived from the other two tables, so it is rebuildable from scratch.

## Trust math

### Earned weight

Evaluated in order; first match wins.

| Voter state | Weight |
|---|---|
| `incorrect >= 4` and accuracy `< 0.34` | 0 — vote stored, counted as nothing, user is never told |
| `incorrect >= 2` and accuracy `< 0.5` | 0.25 |
| `correct >= 8` and accuracy `>= 0.9` | 1.25 (cap) |
| `correct >= 2` and `incorrect = 0` | 1.0 |
| anything else, including a first-time voter | 0.5 |

`accuracy = correct / (correct + incorrect)`.

A vote whose `weight_at_vote` is 0 is stored and still settles for accuracy purposes, but it is
excluded from every read-side tally: it does not contribute to a room's weight sum, it does not
count toward distinct voters, and it never appears in a displayed count or dissent line. The voter
still sees their own pick highlighted, so the muting is not observable from the UI.

### Recency factor

Applied at read time from `created_at` against `class_start`. A vote cast a day early is real
information (a notice board, a WhatsApp message) but weaker than one cast by someone in the
corridor.

| Cast at | Factor |
|---|---|
| within 60 min of start, or after start | 1.0 |
| 1–6 h before start | 0.8 |
| 6–24 h before start | 0.6 |

`effective_weight = weight_at_vote × recency_factor`.

### Prior from history

Cascade; the first tier with at least 2 settled rows wins.

1. `(batch, subject)` — last 3 settled rows by `class_date DESC`.
2. `(batch, weekday, slot_start)` — last 3. "Tue 2 PM is always 2B1."
3. `(batch)` — last 3 overall, and the resulting `prior_weight` is reduced by 0.5.

Within the chosen tier, the mode of the rooms wins; a tie is broken by the most recent row.

| Agreement in tier | `prior_weight` |
|---|---|
| 3 of 3 identical | 1.5 |
| 2 of 3 identical | 1.0 |
| fewer than 2 settled rows in every tier | no prior at all |

Tier 3 subtracts 0.5, so a tier-3 prior is 1.0 or 0.5.

### The override rule

Let `R` be the room with the highest summed effective weight, `D` its number of distinct voters
with non-zero weight, `W` its summed effective weight.

- **No standing label** (week 1, or a subject/slot with no history): `R` becomes the label when
  `D >= 2` and `W >= 1.0`.
- **A standing label exists** (from a prior, or from a live label already established):
  `R` replaces it when `D >= 2` and `W > standing_weight + 0.5`.

`standing_weight` is `prior_weight` when the current label came from history, or the winning
room's own summed effective weight when the current label came from live votes.

Worked cases:

| Scenario | Arithmetic | Outcome |
|---|---|---|
| One troll, any weight | `D = 1` | never flips anything |
| Two fresh colluders vs a 3-of-3 prior | `0.5 + 0.5 = 1.0`, needs `> 2.0` | blocked; they would need five |
| Three established voters, real room change | `1.0 × 3 = 3.0 > 2.0` | flips in one round |
| Week 1, two fresh voters near class time | `0.5 + 0.5 = 1.0 >= 1.0` | label establishes |
| Two fresh voters, 20 h early | `0.5 × 0.6 × 2 = 0.6 < 1.0` | recorded, no label yet |
| Two established voters, 20 h early | `1.0 × 0.6 × 2 = 1.2 >= 1.0` | label establishes |

### Vote window and caps

- Window `[class_start − 24h, class_end]`, validated against the **server** clock. Client-sent
  times are a hint only.
- One vote per user per class. One edit (a withdrawal counts as the edit). Then locked.
- Global cap 30 vote writes per user per UTC day, counting both first votes and edits, measured on
  the server's own clock.

### Settling

On the first read that walks past a class whose `class_end < now()` and which has no
`classroom_settled` row: the room with the highest summed effective weight and `D >= 2` is
written as settled. Lazy, so no cron and no new infrastructure on Vercel. An admin endpoint can
force a re-settle.

No votes, or no room reaching `D >= 2`: no settled row, no accuracy movement, prior untouched.

Once settled: voters who chose the settled room get `correct + 1`, all other voters of that class
get `incorrect + 1`, and `weight` is recomputed from the ladder above.

## Display states

| State | Tag | Secondary line |
|---|---|---|
| No prior, no votes | `Room ?` (muted) | — |
| Prior only | `2B1 · from history` (muted) | — |
| Live label | `2B1 · 4` | — |
| Live label with sub-threshold dissent | `2B1 · 4` | `1 says 1A` |
| Voting closed, class ended, settled | settled room, muted | — |
| Voting closed, never settled | last label that stood, or `Room ?`, muted | — |

Counts shown are distinct voters. Weights, accuracy scores and names are never sent to the
extension.

## Backend surface

New files in the `backend` repo:

- `migrations/002_classroom_votes.sql` — the three tables, idempotent, safe to re-run.
- `src/routes/classroom.routes.js`
- `src/controllers/classroom.controller.js`
- `src/services/classroom.service.js`
- mounted in `src/app.js` as `app.use("/api/classroom", classroomRoutes)`.

Guards follow `transcriptCache.routes.js`: the shared extension bearer token for student-facing
routes, the admin cookie JWT (`verifyToken`) for anything that exposes identities or mutates
settled state.

```
GET    /api/classroom?classIds=575444,575445&email=<viewer>   Bearer extension token
POST   /api/classroom/:classId/vote                           Bearer extension token
GET    /api/classroom/admin/votes?classId=|email=             cookie JWT
POST   /api/classroom/admin/resettle/:classId                 cookie JWT
```

`GET` response, per class id:

```json
{
  "classId": "575444",
  "room": "2B1",
  "source": "live",
  "voters": 4,
  "dissent": { "room": "1A", "voters": 1 },
  "myVote": "2B1",
  "votingOpen": true,
  "updatedAt": "2026-09-02T08:31:00Z"
}
```

`source` is `live`, `history` or `none`. `room` is `null` when `source` is `none`, `dissent` is
`null` when no sub-threshold dissent exists, and `myVote` is `null` when the viewer has not voted
or no `email` was supplied.

`POST` body:

```json
{
  "email": "...",
  "room": "2B1",
  "batch": "SST DevOps & Cloud 2028 Batch A",
  "subject": null,
  "lectureTitle": "Kubernetes Pods, ReplicaSets & Deployments",
  "classDate": "2026-09-02",
  "startsAt": "2026-09-02T08:30:00Z",
  "endsAt": "2026-09-02T10:30:00Z"
}
```

The server re-derives `weekday` and `slot_start` from `startsAt`, re-validates the window,
enforces the caps, snapshots `weight_at_vote` from `classroom_voter_stats`, and returns the same
shape as one `GET` entry. Rejections are explicit: `window_closed`, `already_locked`, `daily_cap`,
`bad_room`.

**`batch` is not taken from the request.** A client-supplied batch would let one student poison
another cohort's prior grouping, so the server reads `cohort`/batch for that email out of
`extension_users` and stores that. The client's `batch` field is ignored, and `subject` /
`lectureTitle` are stored as-is but are only ever grouping labels within that server-derived
batch — never across batches.

## Extension surface

New files in `extension-main`:

- `background/classroomProxy.js` — `importScripts`ed by `background/background.js`, handling
  actions `getClassrooms` and `voteClassroom`. Keeps the bearer token out of page reach; the host
  permission for `https://scalerbackend.vercel.app/*` already exists.
- `content/features/classroomVote/classroomLogic.js` — pure, DOM-free, side-effect-free:
  `computePrior`, `effectiveWeight`, `pickLabel`, `isVotingOpen`, `voteWindow`, `weightFor`.
  This is the testable core.
- `content/features/classroomVote/classroomVote.js` — `initClassroomVote()`, injection, popover,
  teardown. Registered in `manifest.json` in the `document_idle` block immediately after
  `content/features/lectureInfo.js`.

### DOM integration

Card anchor: `a.me-cr-classroom-url[data-cy="classroom-link"]`. Class id from
`data-lecture-instructor-info-id` when `lectureInfo` has already stamped it, else from the `href`
via the existing `/\/class\/(\d+)/` regex — which handles both the relative href the live
dashboard renders and the absolute form in the `addons/` snapshots.

**Our tag gets its own container.** `lectureInfo._applyInstructorInfo` does
`container.innerHTML = ""` when it re-applies, so anything appended into
`.scaler-lecture-instructor-info` is silently destroyed. Instead: a `.scaler-classroom-info`
container appended to `.mentee-card__header` directly after `lectureInfo`'s container — visually
adjacent, structurally independent, and unaffected if `lecture-info` is toggled off. Inline styles
match `lectureInfo`'s tags (11px, `4px 6px`, radius 6, `0.2px` letter-spacing) with a distinct
background tint per display state.

Class times come from `._1EQZYaGMSYVhKTiIKY-qXP > div > span` through `parseClassTime`; the date
comes from the active date tab via `getActiveDashboardDate`, so tomorrow's tab yields tomorrow's
window.

This feature must **not** copy `joinClassButton`'s today-only gate — the 24 h window spans
tomorrow's date tab.

### Popover

One popover element, created once and reused. Eight rows (7 rooms + Online), each with its
distinct-voter count; the viewer's own pick highlighted; the dissent line; a one-line notice that
votes are attributed to the student's account. Dismissed on outside click and on Escape through a
single `AbortController` signal. Clicks inside call `stopPropagation()` so the parent card anchor
does not navigate — the pattern `joinClassButton` already uses.

### Settings and teardown

Setting key `classroom-tag`, default `true`, added to **both** `DEFAULT_SETTINGS` copies
(`popup.js` and `content/cleaner/selectors.js`) plus the popup toggle and its copy.

The `content.js` off-branch must: remove every `.scaler-classroom-info` node, remove the popover
element, abort the popover's listener signal, and disconnect and null
`window._classroomVoteObserver`. Re-enabling re-injects from scratch.

### Performance

- One batched `GET` for every visible class id, not one per card.
- 60 s in-memory cache keyed by the sorted class-id set; a successful vote invalidates that entry.
- One `MutationObserver`, 300 ms debounce, scoped to `.mentee-dashboard__content` with the same
  fallback chain `lectureInfo` uses.
- Idempotent re-init on SPA URL change; bounded retries, no unbounded "wait for element" polling.

## Tests

`tests/classroomVote.test.js`, table-driven against `classroomLogic.js`:

- one voter never flips a label, at any weight
- two fresh colluders cannot beat a 1.5 prior; five can
- three established voters flip a 1.5 prior
- establish at exactly `W = 1.0`, reject at `0.99`
- recency tier boundaries: 60 min, 6 h, 24 h, and after start
- window edges: `start − 24h`, `start − 24h − 1s`, `end`, `end + 1s`
- prior tie broken by most recent
- prior cascade falls to tier 2 when subject is null, and tier 3 subtracts 0.5
- weight ladder boundaries, including the muted `weight = 0` case
- settling with no votes leaves stats and prior untouched

## Docs

At the converge checkpoint, in the same change: `docs/classroom-vote.md` (data flow, trust math,
teardown, limits), a README feature section, `Feature-details.md`, popup copy, and a
`manifest.json` version bump.

## Open item

`mentee/events/` is keyed by `sbat_id` (the class id) and `lectureInfo` reads only
`super_batch_name` and `instructors_name`. Whether the payload carries a course/module field is
unknown, and the card's `<p>` is the lecture title, not the course — it cannot key a prior.

Action during implementation: log the keys of one event object. If a course field exists, prior
tier 1 becomes active and `subject` is populated. If not, `subject` stays `NULL` and tier 2 —
`(batch, weekday, slot_start)` — carries the prior. Every vote row stores all four grouping
fields either way, so tier 1 starts working retroactively the moment the field is confirmed.

## Known limits

- **No proof of presence.** A student can vote from home. Priced in through recency and earned
  weight; not eliminated. Adding `geolocation` would flag Chrome review for a nice-to-have and is
  deliberately rejected.
- Client-sent class times are a hint; the server clock decides. Spoofing them buys only an early
  vote at factor 0.6.
- **No pre-class freeze**, by choice. Three established voters can still flip the label 5 minutes
  before class. Handled after the fact: admin sees names, and those voters go `incorrect` at
  settling and drop toward 0.25, then 0.
- Week 1 shows `Room ?` on most cards. That is the data-collection week.
- A class with fewer than 2 voters never settles, so it contributes nothing to any prior.

## Implementation deviations

Recorded as built, so this document does not contradict the code.

1. **`GET /api/classroom?classIds=` became `POST /api/classroom/states`.** A class nobody has voted
   on exists in no table, and that is exactly the case where the history prior matters, so the card
   metadata has to travel in a request body. It is still a read.
2. **No vote withdrawal.** One vote, one change of mind, then locked. The row is the only place the
   edit counter lives, so deleting a row on withdrawal would hand back a fresh pair of votes, and
   the `room` column is `NOT NULL` with a CHECK — a null sentinel would have meant a schema hole.
3. **The trust math lives server-side only.** The spec put `computePrior` / `pickLabel` in the
   extension's `classroomLogic.js`; they are in `backend/src/services/classroomTrust.js` instead.
   A client that computes its own label can be edited to award itself weight. The extension module
   keeps only the vote window, card parsing and tag copy.
4. **The label is recomputed statelessly on every read**, so the value a challenger must beat is
   always the *prior*, never a stored live label. Among live rooms the strongest weight simply wins,
   because they are all live evidence of the same kind. This removes the spec's
   "standing_weight = the live label's own weight" case, which only made sense if a label were
   persisted.
5. **The state response carries `tallies`** (head counts per room, no weights) so the picker can
   show how many people said each room, plus `myVoteLocked` so the UI can explain a locked vote.
6. **Settling is a bounded opportunistic sweep**, not a lazy settle inside the prior query: today's
   and tomorrow's classes are the ones being read, so a prior walk never passes a finished class.
   ~15 % of state reads settle up to 20 finished-but-unsettled classes;
   `POST /api/classroom/admin/sweep` and `.../admin/resettle/:classId` force it.
7. **Slot keys are UTC** (`weekday`, `slot_start`). Grouping only needs consistency, and IST has no
   DST.
8. **`manifest.json` gained `http://localhost:3001/*`** so the extension can talk to a local
   backend, together with a `chrome.storage.local` override (`scalerpp_backend_override`) that
   avoids editing source to switch. Remove the host permission before the next Web Store submission.
9. **Trust-math tests live in the backend repo** (`backend/tests/classroomTrust.test.js`, run by a
   new `npm test` = `node --test tests/*.test.js`, zero dependencies). The extension suite covers
   the window, card parsing and tag copy. 43 backend + 15 extension tests.

10. **The card shows one chip, not two.** The spec's display table put a head count in the tag
    (`2B1 · 4`) and a sub-threshold dissent line beside it (`1 says 1A`). Shipped: a single
    `Room : 1A` chip. Counts, the contested room and the report-vs-guess distinction moved into the
    popover, with tone (green/amber/grey/slate) and the tooltip keeping the guess distinguishable at
    a glance. Two chips plus Scaler's own batch and instructor tags left the card unreadable.
    `formatDissent` was deleted rather than left unused.

11. **Edits are unlimited, and superseded answers are kept.** The spec allowed one change of mind
    and then locked the vote. Shipped: unlimited edits while the window is open, with every replaced
    answer appended to a new `classroom_vote_history` table (`migrations/003`). The lock was wrong on
    the merits — a room really does change, and the person best placed to correct a stale label is
    someone who already voted. Two consequences followed:
    - Recency is measured from `updated_at`, not `created_at`. Under the old rule an edited vote kept
      whatever discount its first guess earned, so a voter who corrected themselves from the corridor
      still counted as a day-early guess. The trust module's ballot field was renamed
      `createdAtMs` → `castAtMs` so the name stops lying, with the old key accepted as a fallback.
    - `myVoteLocked` is gone from the state response, replaced by `myVoteEdits` (a count, for
      diagnostics). The extension ignores the old flag entirely, so a stale deploy still sending it
      cannot strand a voter.
    Oscillation is bounded by the two-voter threshold and the 30-writes-per-UTC-day cap; there is
    deliberately no per-edit cooldown. `GET /api/classroom/admin/history` exposes the trail.

12. **Thresholds became counts of people, not sums of weight.** The spec gated on weight
    (`W >= 1.0` to establish, `W > prior_weight + 0.5` to override) with a hard two-voter floor.
    Shipped: `ESTABLISH_VOTERS = 1`, `OVERRIDE_VOTERS = 2`, `SETTLE_VOTERS = 2`.
    - One vote now shows a room when nothing else is known. Showing `Room : ?` to a whole batch while
      one person stands in the doorway was the wrong default.
    - Replacing a room that is already showing still takes two people, so no single student moves a
      crowd.
    - Room ranking flipped to head count first, weight second, so the card shows the actual majority.
      Weight now only breaks ties and still zeroes muted voters.
    - Settling kept the two-voter bar. Display is provisional; history and accuracy records are not.
    Cost, stated plainly: a class with no history is now a one-person label. `weightFor` and the
    recency discount still shape which room leads and who gets believed over time, but the
    "two fresh colluders cannot move a strong prior" property is gone by choice — two people agreeing
    now beats any prior. `prior.weight` survives as a record of how consistent the history was; it no
    longer gates anything.

13. **Withdrawal shipped after all.** Both the spec and deviation 2 refused it, reasoning that the
    vote row was the only place the edit allowance lived. Deviation 11 removed that allowance, so the
    reasoning no longer held: `room: null` now deletes the row and appends the old answer to history
    as `replaced_by = 'withdrawn'`. Clicking the room you already hold takes it back, and the popover
    carries an explicit *Remove my answer* control for discoverability. The audit row is written
    before the delete — the reverse of an edit — because a deleted row is unrecoverable, so a failed
    audit refuses the withdrawal instead of silently losing evidence. Withdrawing twice is a no-op,
    not a refusal.

14. **Votes are fire-and-forget from the UI's point of view.** The first implementation awaited the
    round trip before closing the popover, which read as a hang on every vote. Now the popover closes
    on click, the chip goes translucent with a "Saving…" tooltip, the write runs in the background,
    and the server's authoritative state replaces the placeholder when it arrives; failures surface
    as a transient toast. Cards with a vote in flight are skipped by injection passes so a background
    read cannot stamp a stale label over a pending answer, and the signed-in email is warmed at init
    so the first vote has nothing to await.

15. **Renders are idempotent by signature — a bug fix, not an optimisation.** `_applyClassroomState`
    used to rewrite the card unconditionally. The `MutationObserver` watches the same subtree, so
    every render re-triggered it, which rendered again: a 300 ms loop for the lifetime of the tab,
    burning CPU in a long-lived SPA exactly the way CLAUDE.md's performance rules warn against. Cards
    now carry `data-classroom-rendered` and an unchanged pass writes nothing. Two tests pin it by
    node identity: an identical pass must leave the same element in place, a changed state must
    replace it.

16. **Leak and efficiency pass.** Five defects found by auditing the shipped code, each now pinned
    by a test where the behaviour is observable:
    - **The observer's debounce timer outlived teardown.** It lived in a closure, so a pass armed
      moments before the feature was switched off fired afterwards and re-injected everything
      teardown had just removed. The handle moved to `window._classroomVoteDebounce` and is cleared
      in `teardownClassroomTags`. The toast timer got the same treatment.
    - **An SPA navigation could orphan the popover.** It is anchored to a card element that a
      re-render detaches, leaving a panel pointing at nothing. `initClassroomVote` now closes it.
    - **An empty email read was cached forever.** `usernameTracker` syncs the profile
      asynchronously, so a read before it finished cached `""` permanently and the feature told a
      signed-in student to sign in for the rest of the session. Only a real address is cached now.
    - **A stale read could clobber a newer one.** `_fetchClassroomStates` compared against the
      shared cache's `key`, which may have moved on by the time a reply landed — switching date tabs
      mid-flight let an old reply install states for cards no longer on screen. The request key is
      captured and re-checked before the cache is written.
    - **Voter scoring was two round trips per voter.** A 40-person class meant 80 sequential queries
      inside a request a student was waiting on, since settling runs opportunistically on reads. Now
      one batched read plus one batched upsert per class.
    Two further backend wins: the daily-cap check uses `count: "exact", head: true` instead of
    shipping up to 30 rows on every vote, and the three prior-tier queries are memoised per request
    (promise, not just result), so eight dashboard cards fire 3-10 queries instead of 24. The shared
    query deliberately drops its `class_id` exclusion — filtering the caller's own class server-side
    would make every card's query unique and unshareable — and instead fetches one extra row and
    drops the self-row in JS, so a class can never become its own evidence.
