// ============================================
// features/vimMode/vimEditorCapture.js
// Runs in the page's MAIN world at document_start. Scaler's Monaco build
// has no monaco.editor.getEditors(), so the only reliable way to reach the
// live editor is to wrap monaco.editor.create as it is called. We can't know
// when window.monaco appears, so we install the wrapper the moment it does.
// ============================================

(function () {
  const store = (window.__scalerppVim = window.__scalerppVim || {
    editors: [],
    last: null,
    hooked: false,
  });

  function record(editor) {
    if (store.editors.includes(editor)) return;
    store.editors.push(editor);
    store.last = editor;
    window.dispatchEvent(new CustomEvent("scalerpp-vim-editor"));
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
  const poll = setInterval(() => {
    if (store.hooked || hook(window.monaco) || Date.now() - started > 20000) {
      clearInterval(poll);
    }
  }, 50);
})();
