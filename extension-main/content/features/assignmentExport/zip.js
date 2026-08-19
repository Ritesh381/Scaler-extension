// ============================================
// features/assignmentExport/zip.js
// Handles ZIP packaging
// ============================================

/**
 * Initializes a new JSZip instance
 */
function createZip() {
    if (typeof JSZip === 'undefined') {
        throw new Error("JSZip library is not loaded.");
    }
    return new JSZip();
}

/**
 * Adds a file to the zip archive
 */
function addFileToZip(zip, filename, content) {
    zip.file(filename, content);
}

/**
 * Generates the final Blob from the zip archive
 */
async function generateZipBlob(zip) {
    return await zip.generateAsync({ type: "blob" });
}
