// ============================================
// features/vimMode/vimBridge.js
// Runs in the page's MAIN world. Attaches vendored monaco-vim to the editor
// captured by vimEditorCapture.js and renders a mode status line. Driven by
// postMessage from vimMode.js; re-attaches when Scaler swaps the editor.
// ============================================

(function () {
  if (window.__scalerppVimBridge) return;

  const state = { enabled: false, vim: null, editor: null, statusNode: null };

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
    state.editor = null;
    if (state.statusNode) {
      state.statusNode.remove();
      state.statusNode = null;
    }
  }

  // Called by the document_start Escape interceptor in vimEditorCapture.js.
  // Returns true when we've handled the key (so the caller suppresses Scaler's
  // blur): only while Vim is attached and focus is inside this editor.
  function handleEscape(target) {
    if (!state.enabled || !state.vim || !window.MonacoVim) return false;
    const container =
      state.editor &&
      state.editor.getContainerDomNode &&
      state.editor.getContainerDomNode();
    if (!container) return false;
    // Handle Escape when focus is in the editor, or when it has already slipped
    // to <body> before the key reached us — some setups (e.g. a CapsLock->Esc
    // remap that emits Ctrl first) blur the editor a beat before Escape lands.
    // Ignore it only when focus is genuinely in some other field.
    const active = document.activeElement;
    const inEditor = container.contains(target) || container.contains(active);
    const looseBody = !active || active === document.body;
    if (!inEditor && !looseBody) return false;
    window.MonacoVim.VimMode.Vim.handleKey(state.vim, "<Esc>", "user");
    if (state.editor.focus) state.editor.focus();
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "scalerpp-vim") return;
    if (data.type === "enable") {
      state.enabled = true;
      attach();
    } else if (data.type === "disable") {
      state.enabled = false;
      detach();
    }
  });

  // Re-attach when the capture shim reports a new editor (SPA navigation).
  window.addEventListener("scalerpp-vim-editor", () => {
    if (state.enabled) attach();
  });

  window.__scalerppVimBridge = {
    attach,
    detach,
    handleEscape,
    get enabled() {
      return state.enabled;
    },
  };

  // Tell the orchestrator our listener is live so it can (re)send the desired
  // state — the first "enable" may have been posted before this script loaded.
  window.postMessage({ source: "scalerpp-vim-bridge", type: "ready" }, "*");
})();
