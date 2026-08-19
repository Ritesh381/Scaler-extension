# Companion Mode Bypass

**Setting key:** `companion-bypass` (default `true`)
**Code:** [background/companionBypass.js](../extension-main/background/companionBypass.js)
**Permissions used:** `declarativeNetRequest`, `tabs` events, host `*://*.scaler.com/*`

## What it does

When a student joins a live class from campus Wi-Fi, Scaler sometimes forces "companion mode"
(a degraded join flow) based on the request's apparent source IP. This feature attaches
IP-forwarding headers to scaler.com requests for a short window around the join, so the join
request is not classified as on-campus.

Nothing is spoofed permanently: the rules live for **5 seconds** and are then removed.

## How it works

1. `chrome.tabs.onUpdated` fires. The handler acts only when
   `changeInfo.status === "complete"` and the URL contains `scaler.com`, `/session`, and
   `joinSession=1` — i.e. exactly the "join a live session" navigation.
2. It reads `cleanerSettings` and checks `companion-bypass !== false` (default ON).
3. `triggerBypass()` clears any existing timer, then `activateCompanionBypass()`.
4. `activateCompanionBypass()` picks one IP at random from `SPOOFED_IPS` and installs **six**
   dynamic `declarativeNetRequest` rules (ids `101–106`), each a `modifyHeaders` rule with
   `operation: "set"`:

   | id | header | value |
   |---|---|---|
   | 101 | `X-Forwarded-For` | random IP |
   | 102 | `X-Real-IP` | same IP |
   | 103 | `X-Client-IP` | same IP |
   | 104 | `CF-Connecting-IP` | same IP |
   | 105 | `X-Forwarded-Proto` | `https` |
   | 106 | `X-Forwarded-Host` | `www.scaler.com` |

   Condition: `urlFilter: "||scaler.com^"` across all resource types.
5. A `setTimeout` of `BYPASS_DURATION_MS` (5000) calls `deactivateCompanionBypass()`, which
   removes rule ids `101–106`.

Stale rules are removed *before* adding, so a double navigation cannot collide on ids.

## The cold-start safety net

The 5 s auto-deactivate is a `setTimeout` inside the service worker. MV3 can terminate the worker
at any moment, and a pending timer does **not** keep it alive — but the dynamic DNR rules survive
worker death. Without a guard, a killed worker would leave the spoofing headers attached to every
scaler.com request forever.

So `deactivateCompanionBypass()` is also called at **top level**, on every worker cold start
(the worker script is re-evaluated each time it wakes). At that instant no bypass from the current
worker can be active yet, so it only ever clears rules orphaned by a previous worker. Because the
call is dispatched synchronously before any awaited work, it is ordered ahead of a same-wake
activation from the `onUpdated` handler and cannot race-clear a fresh rule. This covers browser
launch, extension update, and plain event-driven wake — paths that `onStartup`/`onInstalled`
alone would miss.

## IP pool

`SPOOFED_IPS` mixes RFC-5737 documentation ranges (`203.0.113.195`, `198.51.100.1`, `192.0.2.1`)
with a few real CDN addresses across regions. One is chosen at random per activation, so repeated
joins don't present an identical fingerprint.

## Toggling

There is no content-script teardown to do — the popup toggle only changes the stored setting, and
the next join simply skips activation. If the toggle is flipped off *during* an active 5 s window,
the pending timer still fires and removes the rules.

## Limits

- Only triggers on the exact join URL shape (`/session…joinSession=1`). A manual join through a
  different route won't activate it.
- Whether the headers actually change Scaler's decision is server-side behaviour, not something
  the extension can verify.
- Rules are global to scaler.com for those 5 s, not scoped to one tab — `declarativeNetRequest`
  dynamic rules have no per-tab condition here.
