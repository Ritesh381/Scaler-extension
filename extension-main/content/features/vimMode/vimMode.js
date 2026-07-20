// ============================================
// features/vimMode/vimMode.js
// Isolated-world orchestrator for Vim mode. Gates on coding-problem pages,
// injects the page-world bridge + vendored monaco-vim when enabled, and
// relays the toggle. The editor is captured separately by
// vimEditorCapture.js (MAIN world, document_start).
// ============================================

const VIM_PROBLEM_PATH =
  /\/class\/\d+\/(assignment|homework_assignment)\/problems\/\d+(?:\/|$)/;

/**
 * True when the given URL (default: current location) is a coding-problem
 * page that hosts the editor.
 */
function isVimCodingPage(url) {
  return VIM_PROBLEM_PATH.test(url || location.href);
}

let vimBridgeInjected = false;

/**
 * Inject the page-world bridge and vendored library once. They stay resident;
 * enable/disable is driven by postMessage, not by re-injection.
 */
function injectVimBridge() {
  if (vimBridgeInjected || !isExtensionValid()) return;
  vimBridgeInjected = true;

  const lib = document.createElement("script");
  lib.src = chrome.runtime.getURL("content/features/vimMode/libs/monaco-vim.js");
  lib.onload = () => {
    const bridge = document.createElement("script");
    bridge.src = chrome.runtime.getURL("content/features/vimMode/vimBridge.js");
    (document.head || document.documentElement).appendChild(bridge);
  };
  (document.head || document.documentElement).appendChild(lib);
}

/**
 * Post the current enabled state to the page-world bridge.
 */
function postVimState(enabled) {
  window.postMessage(
    { source: "scalerpp-vim", type: enabled ? "enable" : "disable" },
    "*",
  );
}

/**
 * Enable or disable Vim mode at runtime (from the popup toggle).
 */
function setVimEnabled(enabled) {
  if (enabled) {
    injectVimBridge();
    postVimState(true);
  } else {
    postVimState(false);
  }
}

/**
 * Initialize on load / navigation: activate only on coding pages when enabled.
 */
function initVimMode() {
  if (!isExtensionValid()) return;
  if (!currentSettings || !currentSettings["vim-mode"]) return;
  if (!isVimCodingPage()) return;
  injectVimBridge();
  postVimState(true);
}
