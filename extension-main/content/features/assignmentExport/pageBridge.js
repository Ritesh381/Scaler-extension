// ============================================================
// assignmentExportBridge.js
// Runs in the PAGE context to access window.monaco
// ============================================================

(function() {
    if (window.__SCALER_ASSIGNMENT_EXPORT_BRIDGE__) return;
    window.__SCALER_ASSIGNMENT_EXPORT_BRIDGE__ = true;

    window.addEventListener("scaler-assignment-export-command", (e) => {
        if (e.detail && e.detail.type === "get-code") {
            let code = "";
            try {
                // Try Monaco (Scaler's current default editor)
                if (window.monaco && window.monaco.editor && window.monaco.editor.getModels) {
                    const models = window.monaco.editor.getModels();
                    if (models.length > 0) {
                        code = models[0].getValue();
                    }
                }
                
                // Fallback to scraping view-lines if Monaco isn't exposed globally
                if (!code) {
                    const lines = document.querySelectorAll('.view-lines .view-line');
                    if (lines.length > 0) {
                        code = Array.from(lines).map(l => l.innerText.replace(/\u00a0/g, ' ')).join('\n');
                    }
                }
            } catch (err) {
                console.warn("[Scaler++] Assignment Export Bridge error:", err);
            }
            
            // Dispatch result back to content script
            window.dispatchEvent(new CustomEvent("scaler-assignment-export-event", { 
                detail: { 
                    type: "code-result", 
                    code: code, 
                    reqId: e.detail.reqId 
                } 
            }));
        }
    });
})();
