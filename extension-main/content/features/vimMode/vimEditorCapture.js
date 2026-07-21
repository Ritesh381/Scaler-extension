// ============================================
// features/vimMode/vimEditorCapture.js
// Runs in the page's MAIN world at document_start. Scaler's Monaco build
// has no monaco.editor.getEditors(), so the only reliable way to reach the
// live editor is to wrap monaco.editor.create as it is called. We can't know
// when window.monaco appears, so we install the wrapper the moment it does.
// ============================================

(function () {
  const store = (window.__scalerppVim = window.__scalerppVim || {
    editors: new WeakMap(), // Track editors without preventing garbage collection
    last: null,
    hooked: false,
  });

  function record(editor) {
    // Use WeakMap to track editors; they'll be automatically removed when garbage collected
    if (store.editors.has(editor)) return;
    store.editors.set(editor, true);
    store.last = editor;
    window.dispatchEvent(new CustomEvent("scalerpp-vim-editor"));
    // Tell the (isolated-world) orchestrator that monaco is live now, so it
    // only loads monaco-vim once window.monaco is valid — the library captures
    // window.monaco at load and is inert if it loads too early.
    window.postMessage({ source: "scalerpp-vim-capture", type: "monaco-ready" }, "*");
  }

  function hook(monaco) {
    if (store.hooked || !monaco || !monaco.editor || !monaco.editor.create) {
      return false;
    }
    const originalCreate = monaco.editor.create;
    monaco.editor.create = function (...args) {
      const editor = originalCreate.apply(this, args);
      record(editor);
      return editor;
    };
    // Backstop for editors created through paths that skip our wrapper.
    if (typeof monaco.editor.onDidCreateEditor === "function") {
      monaco.editor.onDidCreateEditor(record);
    }
    store.hooked = true;
    return true;
  }

  if (hook(window.monaco)) return;

  // window.monaco isn't ready yet — install the wrapper the instant it's
  // assigned, then keep a short polling fallback in case it's defined
  // non-writably and the setter never fires.
  let monacoRef;
  try {
    Object.defineProperty(window, "monaco", {
      configurable: true,
      get: () => monacoRef,
      set: (value) => {
        monacoRef = value;
        hook(value);
      },
    });
  } catch (e) {
    // defineProperty blocked; the poll below still covers us.
  }

  const started = Date.now();
  let poll = setInterval(() => {
    if (store.hooked || hook(window.monaco) || Date.now() - started > 20000) {
      clearInterval(poll);
      poll = null; // Clear reference for garbage collection
    }
  }, 50);

  // Answer the orchestrator's readiness query (covers the case where monaco
  // was already captured before its listener was set up).
  const queryListener = (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.source === "scalerpp-vim-mode" && d.type === "query-monaco") {
      if (window.monaco && window.monaco.editor) {
        window.postMessage(
          { source: "scalerpp-vim-capture", type: "monaco-ready" },
          "*",
        );
      }
    }
  };
  window.addEventListener("message", queryListener);

  // Scaler swallows a real Escape (the editor just blurs) before it reaches
  // monaco-vim, so insert -> normal never happens. Registering here at
  // document_start puts this listener ahead of Scaler's, so we can hand Escape
  // to the vim bridge and stop the blur. The bridge only claims it while Vim is
  // on and the editor is focused; otherwise Escape passes through untouched.
  const escapeListener = (e) => {
    if (e.key !== "Escape" && e.keyCode !== 27) return;
    const bridge = window.__scalerppVimBridge;
    if (bridge && bridge.handleEscape && bridge.handleEscape(e.target)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };
  window.addEventListener("keydown", escapeListener, true);
})();
