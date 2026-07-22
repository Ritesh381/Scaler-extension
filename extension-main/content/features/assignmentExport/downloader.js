// ============================================
// features/assignmentExport/downloader.js
// Handles browser file downloads
// ============================================

/**
 * Triggers a browser download for a Blob
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
