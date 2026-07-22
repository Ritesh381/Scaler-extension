// ============================================
// features/assignmentExport/markdown.js
// Handles markdown generation
// ============================================

/**
 * Converts parsed data into a formatted Markdown string
 */
function generateMarkdown({ title, sessionTitle, questionNumber, questionType, statement, mcqOptions, code }) {
    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    
    return [
        "# " + (title || "Assignment"),
        "",
        "**Session:**",
        (sessionTitle || "Unknown"),
        "",
        "**Question Number:**",
        (questionNumber || "1"),
        "",
        "**Question Type:**",
        (questionType || "Coding"),
        "",
        "**Exported using:**",
        "Scaler++",
        "",
        "**Export Date:**",
        today,
        "",
        "---",
        "",
        "## Problem Statement",
        (statement || "No problem statement found."),
        "",
        mcqOptions ? mcqOptions : "## Code\n````\n" + (code || "No code found in the editor.") + "\n````\n"
    ].filter(s => s !== undefined && s !== null).join("\n");
}
