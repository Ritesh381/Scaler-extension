# Vim Mode

**Setting key:** `vim-mode` (default `false`)
**Code:**
[vimMode/vimEditorCapture.js](../extension-main/content/features/vimMode/vimEditorCapture.js) (MAIN world, `document_start`) ·
[vimMode/vimMode.js](../extension-main/content/features/vimMode/vimMode.js) (ISOLATED world orchestrator) ·
[vimMode/vimBridge.js](../extension-main/content/features/vimMode/vimBridge.js) (MAIN world, attaches monaco-vim) ·
`vimMode/libs/monaco-vim.js` (vendored) · `vimMode.css`
**Pages:** `/class/{id}/{assignment|homework}/problems/{id}`

## What it does

Turns Scaler's Monaco code editor into a Vim editor: modal editing, a mode status line under the
editor, and relative line numbers while attached.

## Why three files

Two hard constraints shape the design:

1. **The editor instance is a page global.** Scaler's Monaco build has no
   `monaco.editor.getEditors()`, so the only reliable way to get the live editor is to wrap
   `monaco.editor.create` **as it is called** — which must happen before Scaler creates it, in the
   MAIN world.
2. **`monaco-vim` captures `window.monaco` at load time.** Load it too early and it is inert
   forever. So it may only be injected *after* monaco is confirmed live.

Hence: a `document_start` MAIN-world capture shim, an isolated-world orchestrator that owns the
setting and the injection timing, and a MAIN-world bridge that does the attaching.

## `vimEditorCapture.js` — capture (MAIN, `document_start`)

- Keeps `window.__scalerppVim = { editors: WeakMap, last, hooked }`. A `WeakMap` so tracking an
  editor never keeps it alive.
- `hook(monaco)` wraps `monaco.editor.create` to `record()` every editor it returns, and also
  registers `monaco.editor.onDidCreateEditor` as a backstop for creation paths that skip the
  wrapper.
- `window.monaco` may not exist yet, so it installs an accessor via `Object.defineProperty` that
  hooks the moment monaco is assigned — plus a 50 ms polling fallback, bounded at **20 s**, in
  case the property is defined non-writably and the setter never fires.
- `record()` fires the `scalerpp-vim-editor` `CustomEvent` (for the bridge) and posts
  `{ source: "scalerpp-vim-capture", type: "monaco-ready" }` (for the orchestrator).
- Answers the orchestrator's `query-monaco` message, covering the case where monaco was captured
  before the orchestrator's listener existed.
- **Escape interceptor.** Scaler swallows a real `Escape` (the editor just blurs) before
  monaco-vim sees it, so insert → normal never happened. Registering a capture-phase `keydown`
  listener here — at `document_start`, ahead of Scaler's — lets it hand Escape to the bridge and
  `preventDefault` + `stopImmediatePropagation` the blur. It only claims the key when the bridge
  says it handled it.

## `vimMode.js` — orchestrator (ISOLATED)

- `isVimCodingPage()` gates on
  `/\/class\/\d+\/(assignment|homework)\/problems\/\d+(?:[/?#]|$)/`.
- `initVimMode()` (called by `content.js` 1.8 s after load and 2 s after every URL change) runs
  only when the extension context is valid, `currentSettings["vim-mode"]` is true, and the page is
  a coding page.
- `requestVimEnable()` sets `vimDesiredEnabled` and retries up to **25 times at 400 ms** (~10 s),
  each attempt either injecting (if `monacoReady`) or posting `query-monaco`. This survives both a
  `monaco-ready` that landed before our listener existed and a slow editor mount. Every timeout is
  tracked in `pendingAttempts` so `cancelPendingAttempts()` can clear them.
- `injectVimBridge()` injects the vendored `monaco-vim.js`, and only in its `onload` the bridge —
  order matters. It runs **once**; enable/disable afterwards is pure `postMessage`, never
  re-injection.
- The bridge announces `{ source: "scalerpp-vim-bridge", type: "ready" }` when its listener is
  live, and the orchestrator re-sends the desired state then, so an `enable` posted during the
  injection gap isn't lost.
- `setVimEnabled(value)` is what `content.js` calls on the popup toggle.

## `vimBridge.js` — attach (MAIN)

- Idempotent via `window.__scalerppVimBridge`.
- `attach()` — takes `__scalerppVim.last`, creates the status node, calls
  `MonacoVim.initVimMode(editor, statusNode)`, and switches the editor to
  `lineNumbers: "relative"` (Monaco's hybrid mode), remembering the previous value.
- `ensureStatusNode()` appends `#scalerpp-vim-status` to the container's `offsetParent` — i.e.
  **out of flow**. Appending it into Scaler's flex layout made it get resized into a stray column.
- `detach()` disposes the vim instance, restores the original `lineNumbers`, and removes the
  status node.
- `handleEscape(target)` returns `true` only while Vim is attached and focus is inside this editor
  — or already slipped to `<body>`, which happens with e.g. a CapsLock→Esc remap that emits Ctrl
  first and blurs the editor a beat early. It sends `<Esc>` to the Vim instance and refocuses.
  Focus genuinely in another field → returns `false` and Escape passes through untouched.
- Re-attaches on the `scalerpp-vim-editor` event, which is how SPA navigation between problems is
  handled without re-injecting anything.

## Message summary

| From | Message | Meaning |
|---|---|---|
| capture → orchestrator | `scalerpp-vim-capture / monaco-ready` | monaco is live, safe to load monaco-vim |
| orchestrator → capture | `scalerpp-vim-mode / query-monaco` | are you ready? |
| bridge → orchestrator | `scalerpp-vim-bridge / ready` | listener installed, resend state |
| orchestrator → bridge | `scalerpp-vim / enable` \| `disable` | attach / detach |
| capture → bridge (same world) | `scalerpp-vim-editor` event | new editor, re-attach |

## Teardown

`cleanupVimMode()` clears pending timeouts and removes the orchestrator's `message` listener;
`bridge.cleanup()` detaches and removes both of its listeners. The injected scripts themselves
stay resident by design — disabling is a `postMessage`, not a teardown, so re-enabling is instant.

## Limits

- Only Monaco. Other editors are not supported.
- Ships default-off: it changes fundamental typing behaviour.
- `monaco-vim` is vendored (`libs/monaco-vim.js`, ~9.9k lines) and must be replaced wholesale from
  upstream, never hand-edited.
- The Escape interception is a capture-phase `window` listener registered at `document_start` and
  is therefore always installed on scaler.com — but it no-ops unless Vim is attached and focused.
