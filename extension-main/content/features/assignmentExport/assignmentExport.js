// ============================================
// features/assignmentExport/assignmentExport.js
// Entry point for the Assignment Export feature
// ============================================

/**
 * Initializes the Assignment Export feature by polling the DOM.
 * 
 * @purpose Serves as the main entry point to inject the export button once the page is fully loaded.
 * @returns {void}
 * @sideeffects Modifies the DOM to inject the export UI if the page is an assignment page.
 * @failures Silently fails and aborts if settings disable the feature or if DOM polling times out.
 */
function initAssignmentExport() {
    if (typeof isAssignmentProblemPage === "function" && !isAssignmentProblemPage()) {
        return;
    }

    // Check if the feature is enabled in settings
    if (typeof shouldHide === "function" && shouldHide("assignment-export")) {
        // Remove existing button if feature is disabled
        document.querySelectorAll("[data-assignment-export-injected]").forEach(el => el.remove());
        return;
    }

    // Since SPAs can be slow to render, poll for the problem statement/DOM before injecting
    let retries = 15;
    const checkAndInject = () => {
        const statement = extractProblemStatement();
        if (statement && statement.trim().length > 0) {
             createExportButton(exportAssignment, exportAllAssignments);
        } else if (retries > 0) {
             retries--;
             setTimeout(checkAndInject, 1000);
        }
    };
    
    checkAndInject();
}
