# Custom Messages (in-header announcements)

**Setting key:** none — always on when the backend has something to show
**Code:** [content/features/customMessage.js](../extension-main/content/features/customMessage.js) ·
[background/messagesProxy.js](../extension-main/background/messagesProxy.js)
**Backend:** `https://scalerbackend.vercel.app`

## What it does

Lets the extension author push a short announcement (new feature, outage, survey link, action
button) into the Scaler header for users, without shipping an extension update. One message at a
time, dismissible, optionally one-time-only, and optionally targeted at an audience.

## Fetch path

`initCustomMessages()` reads the cached profile email from `chrome.storage.sync` → `scaler_user`
(written by [user-profile-sync.md](user-profile-sync.md)) and calls `fetchCustomMessages(email)`,
which sends `{ action: "fetchCustomMessages", email }` to the service worker.

The worker fetches `GET /api/messages/active?email=…`. The email lets the backend return
audience-targeted messages (a specific batch, an email domain, or an individual user). With no
cached email yet, the backend replies with **broadcast messages only**.

The proxy exists because a content script cannot make this cross-origin request from the
scaler.com page.

## Selection

`processMessages(messages)` reads `dismissed_message_ids` from `chrome.storage.local`, walks the
list in the order the backend returned (i.e. backend-controlled priority), skips any `one_time`
message already dismissed, and injects the **first** remaining one. Only ever one message.

## Injection

`injectCustomMessage()` polls every 500 ms for the header logo area
(`._3waiogKHpNpMjAh8o5lc2v > .e7ge61UPj54Me37pqU2Rd`) and **gives up after 10 s**
(`setTimeout(() => clearInterval(...), 10000)`). On success it inserts
`#scaler-custom-msg-container` between the logo area and the stats area, with `msgData.msg` set as
`innerHTML` — messages are authored as HTML.

An `#scaler-custom-msg-container` existence check prevents a double inject.

## Interactions

- **Links** — every `<a>` inside the message gets a click handler that marks the message
  dismissed.
- **Action buttons** — any `<button data-action-endpoint="…">` becomes an interactive control.
  Optional attributes: `data-action-method` (default `POST`), `data-action-payload` (JSON, parse
  errors logged), `data-action-dismiss` (dismiss after a successful call).
  The click disables the button, sends `proxyButtonClick` to the worker, which calls
  `{BACKEND}{endpoint}` and returns the JSON; the button is re-enabled either way.
- **Dismissal** — `markAsDismissed()` hides the container and, for a `one_time` message, records
  `dismissed_message_ids[id] = true` in `chrome.storage.local` so it never returns.

## Security note

`msgData.msg` is injected as raw HTML from the backend. That is deliberate (rich announcements)
and means the backend is trusted content: anything it serves executes inside the Scaler page's DOM
context. It is not user-generated content.

## Limits

- No popup toggle — announcements can only be dismissed, not disabled.
- Non-`one_time` messages reappear on the next page load until the backend deactivates them.
- Tied to the header's hashed class names; if they change, the 10 s poll expires and nothing is
  shown (fails silently, by design).
