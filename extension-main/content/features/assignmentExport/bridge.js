// ============================================
// features/assignmentExport/bridge.js
// Handles Monaco editor communication
// ============================================

/**
 * Helper to fetch Monaco code from the page context using the bridge.
 */
function getEditorCode() {
    return new Promise((resolve) => {
        const reqId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        
        const handleResponse = (e) => {
            if (e.detail && e.detail.type === "code-result" && e.detail.reqId === reqId) {
                window.removeEventListener("scaler-assignment-export-event", handleResponse);
                resolve(e.detail.code || "");
            }
        };
        window.addEventListener("scaler-assignment-export-event", handleResponse);
        
        // Ensure bridge is injected
        if (!document.getElementById("scaler-assignment-export-bridge")) {
            const script = document.createElement("script");
            script.id = "scaler-assignment-export-bridge";
            script.src = chrome.runtime.getURL("content/features/assignmentExport/pageBridge.js");
            script.onload = () => {
                window.dispatchEvent(new CustomEvent("scaler-assignment-export-command", { detail: { type: "get-code", reqId: reqId } }));
            };
            (document.head || document.documentElement).appendChild(script);
        } else {
            window.dispatchEvent(new CustomEvent("scaler-assignment-export-command", { detail: { type: "get-code", reqId: reqId } }));
        }
    });
}

/**
 * Helper to fetch Monaco code directly from a same-origin iframe
 */
function getIframeEditorCode(iframe) {
    try {
        if (iframe.contentWindow.monaco && iframe.contentWindow.monaco.editor) {
            const models = iframe.contentWindow.monaco.editor.getModels();
            if (models.length > 0) return models[0].getValue();
        }
    } catch (e) {}
    return "";
}
