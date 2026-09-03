# Classroom Tag (crowdsourced room allocation)

**Setting key:** `classroom-tag` (default `true`, declared in `popup.js` **and**
`content/cleaner/selectors.js`)
**Code:** [content/features/classroomVote/classroomLogic.js](../extension-main/content/features/classroomVote/classroomLogic.js),
[content/features/classroomVote/classroomVote.js](../extension-main/content/features/classroomVote/classroomVote.js),
[background/classroomProxy.js](../extension-main/background/classroomProxy.js)
**Backend:** `src/routes/classroom.routes.js`, `src/controllers/classroom.controller.js`,
`src/services/classroom.service.js`, `src/services/classroomTrust.js`,
`migrations/002_classroom_votes.sql`, `migrations/003_classroom_vote_history.sql`
**Tests:** [tests/classroomVote.test.js](../tests/classroomVote.test.js) (extension),
`backend/tests/classroomTrust.test.js` (trust math)
**Reviewer guide:** [classroom-vote-reviewer-guide.md](classroom-vote-reviewer-guide.md)

## What it does

Adds one room tag to every class card on the mentee dashboard — `Room : 1A`, or `Room : ?` when
nothing is known — and lets students vote on which of the seven rooms (`0C`, `1A`, `1B`, `2A`,
`2B1`, `2B2`, `2C`, or `online`) the class is actually in.

Scaler exposes the room nowhere: not in the UI, not in any API. The only available source is the
students themselves.

## Why it is not a simple majority vote

A single mutable value, crowdsourced from one batch, with no way to prove a reporter is physically
in the room, is the "everyone runs to the wrong platform" failure waiting to happen. Waze and
Where Is My Train survive it because a bad report has to out-shout hundreds of people who are
demonstrably at the location; a Scaler batch is a few dozen people, where two friends are a
majority.

So the label is not "whatever the newest vote says". Three things gate it:

1. **A history prior holds the label.** What the room was for the last few sessions of this
   course/slot is displayed until live votes clearly disagree.
2. **Two distinct voters minimum.** One person can never move a label, at any trust level.
3. **Earned weight.** A voter's ballot is worth 0 to 1.25 depending on how often their past votes
   matched the room the class actually settled on, so fresh accounts cannot brute-force a change.

## Trust math

All of it runs **server-side only** (`backend/src/services/classroomTrust.js`), and none of it is
sent to the client. A student never learns their own weight, and never sees who voted — knowing
whose vote counts double is exactly what an abuser needs.

### Earned weight (first match wins)

| Voter state | Weight |
|---|---|
| `incorrect >= 4` and accuracy `< 0.34` | 0 — stored, counted as nothing, never disclosed |
| `incorrect >= 2` and accuracy `< 0.5` | 0.25 |
| `correct >= 8` and accuracy `>= 0.9` | 1.25 (cap) |
| `correct >= 2` and `incorrect = 0` | 1.0 |
| anything else, including a first-time voter | 0.5 |

### Recency

Voting opens 24 h before a class and closes when it ends. A vote is discounted by how far ahead it
was cast, because someone in the corridor is better evidence than someone reading a notice board
yesterday — but yesterday is still evidence, so it is discounted, not discarded.

| Cast at | Factor |
|---|---|
| within 60 min of start, or after start | 1.0 |
| 1–6 h before | 0.8 |
| 6–24 h before | 0.6 |

`effective weight = weight_at_vote × factor`.

### The history prior

First tier with at least two settled sessions and a repeat wins:

1. `(batch, subject)` — the same course for this batch
2. `(batch, weekday, slot_start)` — the same weekday and time
3. `(batch)` — anything this batch has done, and the result is penalised by 0.5

Mode of the last three sessions, ties broken by recency. `1.5` when all three agree, `1.0` when two
of three do.

### Override rule

Thresholds count **people**, not weight. Weight still decides which room leads when heads are tied,
and a muted voter still counts as nobody, but "two people agree" is a rule a student can hold in
their head — and a rule nobody understands is a rule nobody trusts.

`R` is the leading room, `D` its distinct non-muted voters.

- **Nothing is showing** (no prior, no label): `R` shows when `D >= 1`. One person in the doorway
  beats showing `Room : ?` to the whole batch.
- **Something is already showing** (a prior, or a room the votes already put up): `R` replaces it
  when `D >= 2`. No single student can move a crowd — including a student who is simply wrong.
- Votes that **agree** with what is showing only need the establish bar, so the first agreeing vote
  flips the tone from guess to report.

Rooms rank by head count first, then weight, then name. Heads lead because the card promises the
majority; weight breaks ties so an even split resolves toward the fresher, better-earned report.

| Scenario | Result |
|---|---|
| One vote, nothing else known | that room shows immediately |
| One vote against a standing room | standing room holds, dissenter listed in the popover |
| Two agreeing against a standing room | they take it over, however strong the history was |
| Two voters, one each on different rooms, prior standing | prior holds — neither reached two |
| 1 highly-trusted voter vs 2 fresh ones | the two win; heads beat trust |
| Muted voter alone | nothing shows; they still see their own pick |

### Settling and scoring

A finished class is settled at the first opportunity: the leading room is written to
`classroom_settled`, then every voter of that class is scored — matched the settled room or not —
and their weight recomputed.

**Settling requires two voters even though displaying requires one.** The asymmetry is deliberate: a
displayed room is provisional and costs nothing to correct, while a settled room seeds the prior for
every future session of that course *and* moves each voter's permanent accuracy record. One
person's word is enough to help their classmates today, not enough to become history. A single-voter
class returns `needs_corroboration` and stays unsettled.

Settling runs opportunistically on ~15 % of state reads (`sweepSettlements`, capped at 20 classes
per sweep) because Vercel serverless has nowhere to host a cron. `POST /api/classroom/admin/sweep`
forces one; `POST /api/classroom/admin/resettle/:classId` redoes a single class.

Admin reads: `GET /api/classroom/admin/votes` for current answers with names attached, and
`GET /api/classroom/admin/history` for every answer that was replaced. Both accept `classId` and
`email`.

A class with fewer than two voters never settles, contributes to no prior, and moves nobody's score.

## Data model

Four tables. Tallies are aggregated on read, never kept in counter columns — the same reasoning as
`migrations/001_transcript_versions.sql`: concurrent votes cannot lose a race.

| Table | Key | Holds |
|---|---|---|
| `classroom_votes` | `(class_id, email)` | each student's **current** answer, plus the weight snapshot it was cast with and an `edits` counter |
| `classroom_settled` | `class_id` | the room a finished class actually happened in — the only thing the prior and the scoring read |
| `classroom_voter_stats` | `email` | `correct` / `incorrect` / `weight`, fully derivable from the two above |
| `classroom_vote_history` | append-only | every **superseded** answer: the room replaced, what it was worth, when it was cast, what replaced it, which edit number |

`classroom_votes` holds only the current answer, so without the history table an edit would erase
its own evidence — and a flip-flopper trying to swing a label near class time is exactly what needs
evidence. `weight_at_vote` is a snapshot, never rewritten, so recomputing voter stats later cannot
retroactively change what a past class displayed.

## Data flow

```
class card ──▶ buildClassroomMeta()          classroomLogic.js (pure, tested)
                     │  classId, times, batch, lecture title
                     ▼
          POST /api/classroom/states         via background/classroomProxy.js
                     │  one request for every visible card
                     ▼
          classroom.service.js               votes + 3 prior tiers from Supabase
                     │
                     ▼
          classroomTrust.pickLabel()         room, source, voters, dissent, tallies
                     │
                     ▼
          _applyClassroomState()             one `Room : X` chip on the card
                     │  click
                     ▼
          POST /api/classroom/:id/vote       server re-validates window, caps, weight
```

`/states` is a POST despite being a read: a class nobody has voted on exists in no table, and that
is exactly when the history prior matters, so the card metadata has to travel in a body.

## Voting rules enforced server-side

- Window `[start − 24h, end]`, checked against the **server** clock. The client's times are a hint.
- One row per `(class_id, email)` — a student's current answer. **Edits are unlimited** while the
  window is open, because changing your mind is usually honest: rooms move, and a guess made from a
  notice board deserves correcting by the person who then saw the door. Every superseded answer is
  appended to `classroom_vote_history`.
- Recency is measured from `updated_at`, not `created_at`. Someone who guessed a day early (×0.6)
  and corrected themselves from the corridor counts at ×1.0 — the evidence is as fresh as their
  current answer, not as stale as their first one.
- **Withdrawal is allowed.** `room: null` deletes the row, and the answer it held is appended to
  history with `replaced_by = 'withdrawn'`. Clicking the room you already hold takes it back, and the
  popover also carries an explicit *Remove my answer* control. Deleting the row is safe now that
  edits are unlimited — there is no per-row allowance left to hand back — and it is the honest
  representation of "I no longer know", which a sentinel room value would not be.
- A withdrawal writes its audit row **before** deleting the vote, the opposite order to an edit: once
  the row is gone the previous answer is unrecoverable, so a failed audit insert refuses the
  withdrawal rather than quietly losing evidence.
- Withdrawing twice is a no-op, not a 409 — a double click must not read as an error.
- 30 vote writes per student per UTC day. That cap plus the two-voter threshold is what bounds
  oscillation now that edits are unlimited — there is deliberately no per-edit cooldown.
- `batch` is read from `extension_users`, never from the request — a client-supplied batch would let
  one student write rows into another cohort's prior grouping. The client value is a fallback only
  for users whose profile sync has not recorded a cohort.

## What the card shows

Exactly one chip, always reading `Room : <room>` (or `Room : ?`). Head counts, the room other people
voted for, and whether the answer is a report or a history guess are all one click away in the
popover — a dashboard card has space for a room number, not for an argument.

| State | Chip | Tone |
|---|---|---|
| live votes decided it | `Room : 1A` | green |
| no votes, history guess | `Room : 1A` | amber |
| nothing known | `Room : ?` | grey |
| voting closed | `Room : 1A` | slate |

A guess stays distinguishable without opening anything — amber rather than green, and the tooltip
says "nobody has voted yet". Acting on a stale guess as though it were a report is the failure this
feature exists to avoid, so that signal never disappears entirely.

The popover carries the rest: every room with its head count, the viewer's own pick highlighted, a
line naming the runner-up room when one is contested (`1 also said 2B1`), and why voting is
unavailable when it is.

## Privacy

Counts are public; identities are not. Every vote row carries the student's email and is fully
attributable, but that is reachable only through `GET /api/classroom/admin/votes` behind the admin
cookie JWT. The extension response contains head counts per room and nothing else — no names, no
emails, no weights. The popover says so, because attribution only deters if people know about it.

## DOM integration

Cards are `a.me-cr-classroom-url[data-cy="classroom-link"]`. Class id comes from
`data-lecture-instructor-info-id` when `lectureInfo` has stamped it, else from the `href`
(`/\/class\/(\d+)/`, which matches both the relative href the live dashboard renders and the
absolute form in `addons/`).

The tag lives in its **own** `.scaler-classroom-info` container, appended **inside** Scaler's
class-type line (`._2GsNsJLDK4elcdmjka5HmF`, the "Live Class" row) so it renders in the empty space
to the right of that text. Fallbacks, since those class names are hashed: before the time row, then
appended to `.mentee-card__content`.

The container is `inline-flex`, which is what puts it beside the text without touching a single
Scaler style — the div stays a block, its text node stays first, and teardown removes only our node.

Two things forced that placement:

- It is **not** in `.scaler-lecture-instructor-info`. `lectureInfo._applyInstructorInfo()` calls
  `container.innerHTML = ""` when it re-applies, so anything injected there is silently destroyed on
  the next render. A separate container also means the room tag survives `lecture-info` being
  toggled off.
- It is **not** in `.mentee-card__header` either, which was the first attempt. That header is a
  nowrap flex row shared with lectureInfo's batch and instructor tags, so a third chip pushed them
  off the edge of the card.

Times come from `._1EQZYaGMSYVhKTiIKY-qXP > div > span` through `joinClassButton`'s
`extractClassTimes` / `parseClassTime` — reused rather than copied. The date comes from the active
date tab via `getActiveDashboardDate()`, so **tomorrow's tab is votable**. This feature must never
adopt `joinClassButton`'s today-only gate; the 24 h window depends on it.

If the active tab cannot be read, tags are **skipped entirely** (one console warning) rather than
defaulting to today. A guessed date is worse than no tag twice over: it closes the vote window on
every class shown on a future tab, and any vote that slipped through would be stored under the wrong
`class_date`, `weekday` and `slot_start`, poisoning that batch's history prior.

Batch name is read from the first `.scaler-lecture-instructor-tag`'s `title` attribute (the full
`super_batch_name`). Absent when `lecture-info` is off, in which case the server falls back to the
stored cohort.

## Degraded backend

The tag is painted from local card data **before** the `/states` request resolves, and survives it
failing: an unreachable or undeployed backend leaves `Room : ?` in place, logs one warning per class
set (not per observer tick), and a click explains that the vote server could not be reached with the
room buttons disabled. The first version injected nothing until the fetch succeeded, which made a
404 indistinguishable from the feature being switched off.

## Performance and teardown

- **A vote never blocks the UI.** The popover closes on click and the chip goes translucent with a
  "Saving your answer…" tooltip; the write runs in the background and the server's authoritative
  state replaces it when it lands. Waiting for the round trip made every vote feel like the extension
  had hung. A failure surfaces as a transient toast, since the popover is already gone by then.
- **Renders are idempotent by signature.** Each card is stamped
  `data-classroom-rendered="<text>|<tone>|<myVote>|<open>"`, and a pass computing the same signature
  writes nothing. This is a bug fix, not an optimisation: the `MutationObserver` watches the very
  subtree this feature writes into, so an unconditional re-render re-triggered the observer, which
  re-rendered — a 300 ms loop for as long as the tab stayed open. Two tests pin it by node identity.
- A card with a vote in flight is skipped by injection passes, so a background read cannot stamp a
  stale label over someone's pending answer.
- The signed-in email is fetched at init, so the first vote has no `chrome.storage` round trip to
  wait on.
- One batched `/states` request for all visible cards, cached 60 s keyed by the sorted class-id set;
  a successful vote invalidates it.
- One `MutationObserver`, 300 ms debounce, scoped to `.mentee-dashboard__content` with the same
  fallback chain `lectureInfo` uses, stored on `window._classroomVoteObserver`.
- The popover installs its outside-click, Escape and scroll listeners under a single
  `AbortController` on `window._classroomPopoverAbort`.
- `teardownClassroomTags()` (called by `content.js` on toggle-off) removes every
  `.scaler-classroom-info`, the popover, the injected `<style>`, aborts the listener signal,
  disconnects and nulls the observer, and clears the cache. Re-enabling re-injects from scratch.

## Local testing

`background/classroomProxy.js` points at `https://scalerbackend.vercel.app`. **The classroom routes
have to be deployed there** — an undeployed backend answers `/api/classroom/*` with a 404, which the
UI shows as an unreachable vote server with every room disabled.

For local work, override the base URL instead of editing the file:

1. Run `migrations/002_classroom_votes.sql` and `migrations/003_classroom_vote_history.sql` in the
   Supabase SQL editor.
2. Start the backend: `node server.js` (port from `.env`, currently 3001).
3. Temporarily add `"http://localhost:3001/*"` to `host_permissions` in `manifest.json`. It is
   **not** in the shipped manifest — an unused localhost permission is a Chrome review flag — so a
   local run has to put it back, and must take it out again before publishing.
4. In the **service worker** console:
   `chrome.storage.local.set({ scalerpp_backend_override: "http://localhost:3001" })`
5. Reload the extension card, then reload the Scaler tab.

The service worker console prints which backend is in use on the first request
(`Scaler++: classroom API → …`), plus a warning whenever that base is not HTTPS.

`chrome.storage.local.set({ scalerpp_backend_override: "http://localhost:3001" })` still overrides
the constant, but it must be run from an **extension** context (service worker console) — the page
console has no `chrome.storage`, which is the trap that made the first local test fail.

A single account cannot promote a label, since two distinct voters are always
required. To watch a promotion locally, add a second voter directly:

```bash
curl -s -X POST localhost:3001/api/classroom/<classId>/vote \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <extension token>' \
  -d '{"email":"second@example.com","room":"2B1","classDate":"2026-09-03",
       "startsAt":"2026-09-03T08:30:00Z","endsAt":"2026-09-03T10:30:00Z"}'
```

### Before publishing

- **Deploy the backend first.** The extension points at prod, so shipping it without the routes
  leaves every card showing `Room : ?` with voting disabled.
- Confirm `migrations/002_classroom_votes.sql` and `003_classroom_vote_history.sql` have been run
  against the production database.
- `host_permissions` must not contain a localhost entry (it does not in the shipped manifest).
- The service worker console should be silent on load: the classroom proxy only logs when the base
  URL is overridden or non-HTTPS.

## Backward compatibility

Purely additive on both sides. No existing table, column, endpoint or response shape changed, so
extension builds that predate this feature keep working against the same backend. Old builds simply
never call `/api/classroom/*`.

## Intentional limitations

- **No proof of presence.** A student can vote from home. Priced in through recency and earned
  weight, not eliminated. `geolocation` was rejected deliberately: it flags Chrome review for a
  nice-to-have.
- **No pre-class freeze.** Three established voters can still flip the label minutes before class.
  Handled after the fact — admin sees names, and those voters go `incorrect` at settling and drop
  toward 0.25, then 0.
- **Week 1 shows `Room : ?` on most cards.** That is the data-collection week; priors need two
  settled sessions before they say anything.
- **Prior tier 1 is dormant until Scaler's `mentee/events/` payload is confirmed to carry a
  course/module field.** Until then `subject` is `NULL` and tier 2 `(batch, weekday, slot_start)`
  carries the prior. Every vote row stores all four grouping fields, so tier 1 activates
  retroactively the moment the field name is known.
- **Slot keys are UTC.** Consistent for grouping, but a batch that straddles a DST change (Scaler is
  IST, which has none) would group two different local slots together.
