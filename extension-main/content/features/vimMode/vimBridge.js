// ============================================
// features/vimMode/vimBridge.js
// Runs in the page's MAIN world. Attaches vendored monaco-vim to the editor
// captured by vimEditorCapture.js and renders a mode status line. Driven by
// postMessage from vimMode.js; re-attaches when Scaler swaps the editor.
// ============================================

(function () {
  if (window.__scalerppVimBridge) return;

  const state = {
    enabled: false,
    vim: null,
    editor: null,
    statusNode: null,
    lineNumbersPrev: null,
    messageListener: null,
    editorListener: null,
    subs: [],
    blurAt: 0,
    lastClipboard: null,
    paste: false,
  };

  function ensureStatusNode(editor) {
    if (state.statusNode && state.statusNode.isConnected) return state.statusNode;
    const container = editor.getContainerDomNode
      ? editor.getContainerDomNode()
      : editor.getDomNode && editor.getDomNode();
    if (!container) return null;
    // Overlay the status bar at the bottom of the editor's nearest positioned
    // ancestor. Appending it into the flow (or Scaler's flex parent) lets the
    // layout resize it into a stray column, so we take it out of flow instead.
    const anchor = container.offsetParent || container.parentElement;
    if (!anchor) return null;
    const node = document.createElement("div");
    node.id = "scalerpp-vim-status";
    anchor.appendChild(node);
    state.statusNode = node;
    return node;
  }

  function attach() {
    const store = window.__scalerppVim;
    const editor = store && store.last;
    if (!state.enabled || !editor || !window.MonacoVim) return;
    if (state.vim && state.editor === editor) return; // already attached to this one
    detach();
    const statusNode = ensureStatusNode(editor);
    if (!statusNode) return;
    state.vim = window.MonacoVim.initVimMode(editor, statusNode);
    state.editor = editor;
    state.subs = [
      editor.onDidFocusEditorText(() => syncFromClipboard()),
      editor.onDidBlurEditorText(() => {
        state.blurAt = Date.now();
      }),
    ];
    // Vim-style relative line numbers while attached; remember the editor's own
    // setting so detach can put it back. Monaco's "relative" is the hybrid mode
    // (absolute on the current line, relative elsewhere).
    try {
      const raw = editor.getRawOptions();
      state.lineNumbersPrev =
        raw && raw.lineNumbers != null ? raw.lineNumbers : "on";
      editor.updateOptions({ lineNumbers: "relative" });
    } catch (e) {
      // updateOptions unavailable — leave line numbers untouched
    }
  }

  function detach() {
    if (state.vim) {
      try {
        state.vim.dispose();
      } catch (e) {
        // editor already gone
      }
      state.vim = null;
    }
    state.subs.forEach((sub) => sub.dispose());
    state.subs = [];
    if (state.editor && state.lineNumbersPrev != null) {
      try {
        state.editor.updateOptions({ lineNumbers: state.lineNumbersPrev });
      } catch (e) {
        // editor already gone
      }
    }
    state.lineNumbersPrev = null;
    state.editor = null;
    if (state.statusNode) {
      state.statusNode.remove();
      state.statusNode = null;
    }
  }

  function cleanup() {
    detach();
    if (state.messageListener) {
      window.removeEventListener("message", state.messageListener);
      state.messageListener = null;
    }
    if (state.editorListener) {
      window.removeEventListener("scalerpp-vim-editor", state.editorListener);
      state.editorListener = null;
    }
  }

  // Pull outside copies into vim's unnamed register so p/P paste them. Opt-in
  // via the popup, since reading the clipboard makes Chrome ask for permission.
  // Reading is async, so we can't do it on the keystroke; instead we sync
  // whenever the editor gains focus (click in, or return to the tab/window).
  // Only a clipboard change since we last looked replaces the register, so
  // ddp still pastes the deleted line; an explicit copy (force) always does.
  // ponytail: misses a clipboard change made while the editor keeps focus
  // (e.g. a clipboard manager); intercept p and read first if that matters.
  function syncFromClipboard(force) {
    if (!state.paste || !state.vim || !navigator.clipboard || !navigator.clipboard.readText) return;
    const Vim = window.MonacoVim.VimMode.Vim;
    const vim = state.vim;
    const before = Vim.getRegisterController().unnamedRegister.toString();
    navigator.clipboard
      .readText()
      .then((text) => {
        // Drop a stale read: the register changed while it was pending (a dd
        // while Chrome's permission prompt was up), or vim was turned off.
        const register = Vim.getRegisterController().unnamedRegister;
        if (!state.paste || state.vim !== vim || register.toString() !== before) return;
        if (!text || (!force && text === state.lastClipboard)) return;
        state.lastClipboard = text;
        register.setText(text, text.endsWith("\n"));
      })
      .catch(() => {}); // permission denied: p keeps using vim's own register
  }

  // Called by the document_start Escape interceptor in vimEditorCapture.js.
  // Returns true when we've handled the key (so the caller suppresses Scaler's
  // blur): only while Vim is attached and the Escape is meant for the code.
  function handleEscape() {
    if (!state.enabled || !state.vim || !state.editor || !window.MonacoVim) return false;
    // Handle Escape when focus is in the editor's text, or when it slipped to
    // <body> just before the key reached us — some setups (e.g. a CapsLock->Esc
    // remap that emits Ctrl first) blur the editor a beat before Escape lands.
    // Everything else keeps its own Escape: Monaco's find box, page dialogs.
    const active = document.activeElement;
    const justBlurred =
      (!active || active === document.body) && Date.now() - state.blurAt < 1000;
    if (!state.editor.hasTextFocus() && !justBlurred) return false;
    window.MonacoVim.VimMode.Vim.handleKey(state.vim, "<Esc>", "user");
    if (state.editor.focus) state.editor.focus();
    return true;
  }

  if (window.MonacoVim) {
    const Vim = window.MonacoVim.VimMode.Vim;
    // Mirror every yank to the system clipboard (like clipboard=unnamedplus,
    // but yank only, so x/dd don't clobber what you copied).
    const registers = Object.getPrototypeOf(Vim.getRegisterController());
    const pushText = registers.pushText;
    registers.pushText = function (registerName, operator) {
      pushText.apply(this, arguments);
      if (operator === "yank" && registerName !== "_") {
        state.lastClipboard = this.unnamedRegister.toString();
        navigator.clipboard.writeText(state.lastClipboard).catch(() => {});
      }
    };
    // A copy that bypasses vim (Cmd+C, the context menu) doesn't move focus,
    // so resync after it too.
    document.addEventListener("copy", () => setTimeout(() => syncFromClipboard(true), 0));
    // monaco-vim maps <C-c> to <Esc> and swallows the keydown, so the browser
    // never copies (ggVG + Ctrl+C just drops to normal mode). Make it a yank
    // in visual mode; normal/insert mode keep Ctrl+C as Esc.
    Vim.map("<C-c>", "y", "visual");
    // :w runs the code (Scaler's "Test" button), :wq submits it.
    const clickEditorAction = (label) => {
      const btn = [...document.querySelectorAll("button.ce-btn")].find(
        (b) => b.textContent.trim() === label,
      );
      if (btn) btn.click();
    };
    Vim.defineEx("write", "w", () => clickEditorAction("Test"));
    Vim.defineEx("wq", "wq", () => clickEditorAction("Submit"));
  }

  state.messageListener = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "scalerpp-vim") return;
    if (data.type === "enable") {
      state.enabled = true;
      state.paste = !!data.paste;
      attach();
      // Already focused (e.g. paste just switched on): no focus event is coming.
      if (state.editor && state.editor.hasTextFocus()) syncFromClipboard();
    } else if (data.type === "disable") {
      state.enabled = false;
      detach();
    }
  };
  window.addEventListener("message", state.messageListener);

  // Re-attach when the capture shim reports a new editor (SPA navigation).
  state.editorListener = () => {
    if (state.enabled) attach();
  };
  window.addEventListener("scalerpp-vim-editor", state.editorListener);

  window.__scalerppVimBridge = {
    attach,
    detach,
    cleanup,
    handleEscape,
    get enabled() {
      return state.enabled;
    },
  };

  // Tell the orchestrator our listener is live so it can (re)send the desired
  // state — the first "enable" may have been posted before this script loaded.
  window.postMessage({ source: "scalerpp-vim-bridge", type: "ready" }, "*");
})();
