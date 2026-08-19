// ============================================
// features/assignmentExport/exporter.js
// Orchestrates the export pipelines
// ============================================



let isExporting = false;

/**
 * Orchestrates the export of the current active problem.
 * 
 * @purpose Coordinates data extraction, Markdown generation, and single file downloading.
 * @returns {Promise<void>}
 * @sideeffects Updates UI loading state, reads DOM, triggers browser download.
 * @failures Aborts if already exporting. Displays an alert if extraction or download fails.
 */
async function exportAssignment() {
    if (isExporting) return;
    isExporting = true;
    
    try {
        updateExportButtonText("Exporting...");

    // 1. Parse data
    const title = extractProblemTitle(document);
    const statement = extractProblemStatement(document);
    const mcqOptions = extractMCQOptions(document);
    const sessionTitle = extractSessionTitle(document);
    const questionType = determineQuestionType(document, mcqOptions);
    
    // 2. Fetch code
    const code = await getEditorCode();

    // 3. Generate Markdown
    const markdownContent = generateMarkdown({ 
        title, 
        sessionTitle, 
        questionNumber: "1", 
        questionType, 
        statement, 
        mcqOptions, 
        code 
    });

    // 4. Sanitize and Download
    const safeTitle = (title || "Assignment")
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .replace(/^\.+|\.+$/g, "") // Remove leading/trailing dots
        .substring(0, 80)
        .trim();

    const filename = `01 - ${safeTitle || "Problem"}.md`;
    const blob = new Blob([markdownContent], { type: "text/markdown" });
    downloadBlob(blob, filename);
    
    setExportStatus("success");
    } catch (e) {
        console.error("Assignment Export failed:", e);
        setExportStatus("error");
    } finally {
        isExporting = false;
    }
}


/**
 * Orchestrates the bulk export of all assignment problems in the sidebar.
 * 
 * @purpose Iterates through sidebar links, scrapes them via hidden iframe, zips them, and triggers a download.
 * @returns {Promise<void>}
 * @sideeffects Updates UI loading state, spawns hidden iframe, builds JSZip archive in memory, triggers browser download.
 * @failures Aborts if already exporting, if sidebar links are missing, or if JSZip fails to initialize. Skips individual problems on timeout/error.
 */
async function exportAllAssignments() {
    
    if (isExporting) return;
    isExporting = true;
    // 1. Gather all problem URLs
    // Scan the entire document as strict URL canonicalization prevents duplicate/false exports
    const rawLinks = Array.from(document.querySelectorAll('a[href*="/assignment/problems/"], a[href*="/homework/problems/"]'))
        .map(a => a.href)
        .filter(href => href.startsWith('http'));
        
    // 2. Canonicalize URLs
    const canonicalLinks = rawLinks.map(href => {
        try {
            const url = new URL(href);
            url.search = ''; // Remove query parameters
            url.hash = '';   // Remove hash fragments
            
            // Split path into segments and remove empty strings (handles trailing slashes)
            const parts = url.pathname.split('/').filter(Boolean);
            
            const problemsIdx = parts.indexOf('problems');
            if (problemsIdx === -1 || problemsIdx + 1 >= parts.length) {
                return null;
            }
            
            const type = parts[problemsIdx - 1];
            if (type !== 'assignment' && type !== 'homework') {
                return null;
            }
            
            // Reconstruct pathname up to the problem ID, dropping anything after (like /hints)
            const canonicalParts = parts.slice(0, problemsIdx + 2);
            url.pathname = '/' + canonicalParts.join('/');
            
            return url.href;
        } catch (e) {
            return null;
        }
    }).filter(Boolean);
        
    // 3. Deduplicate
    const uniqueLinks = [...new Set(canonicalLinks)];
    
    if (uniqueLinks.length === 0) {
        alert("Could not find other problems in the assignment sidebar.");
        isExporting = false;
        return;
    }
    
    // 4. Initialize JSZip
    let zip;
    try {
        zip = createZip();
    } catch (e) {
        alert(e.message);
        isExporting = false;
        return;
    }
    
    try {
        const sessionTitle = extractSessionTitle(document);
        const safeSessionFolder = sessionTitle
            .replace(/[\\/:*?"<>|]/g, "-")
            .replace(/\s+/g, " ")
            .replace(/^\.+|\.+$/g, "")
            .trim() || "Assignment";
            
        let nextIndex = 0;
        let completedCount = 0;
        const results = [];
        const errors = [];
        
        const worker = async () => {
            while (nextIndex < uniqueLinks.length) {
                const i = nextIndex++;
                const url = uniqueLinks[i];
                try {
                    const result = await processProblem(url, i, sessionTitle, safeSessionFolder);
                    if (result) results.push(result);
                } catch (e) {
                    console.warn(`Failed to process problem at ${url}`, e);
                    errors.push({ url, error: e });
                }
                completedCount++;
                updateExportButtonText(`Exporting ${completedCount}/${uniqueLinks.length}...`);
            }
        };
        
        // 5. Spawn workers (max concurrency: 6)
        const maxConcurrency = Math.min(6, uniqueLinks.length);
        const workers = Array.from({ length: maxConcurrency }, () => worker());
        
        await Promise.all(workers);
        
        updateExportButtonText("Zipping...");
        
        // Preserve ZIP output order
        results.sort((a, b) => a.index - b.index);
        for (const r of results) {
            addFileToZip(zip, r.filename, r.markdownContent);
        }
        
        if (errors.length > 0) {
            console.warn("Some problems failed to export:", errors);
        }
        
        // 6. Download Zip
        const blob = await generateZipBlob(zip);
        downloadBlob(blob, `${safeSessionFolder}.zip`);
        
        setExportStatus("success");
    } catch(e) {
        console.error("Bulk Assignment Export failed:", e);
        setExportStatus("error");
    } finally {
        isExporting = false;
    }
}

/**
 * Processes a single problem URL within a hidden iframe
 */
async function processProblem(url, index, sessionTitle, safeSessionFolder) {
    const iframe = document.createElement('iframe');
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    iframe.style.position = 'absolute';
    iframe.style.visibility = 'hidden';
    document.body.appendChild(iframe);
    
    try {
        iframe.src = url;
        
        // Wait for iframe to load (max 10 seconds)
        await Promise.race([
            new Promise(resolve => {
                const onload = () => {
                    iframe.removeEventListener('load', onload);
                    resolve();
                };
                iframe.addEventListener('load', onload);
            }),
            new Promise(resolve => setTimeout(resolve, 10000))
        ]);
        
        // Wait for statement to render
        await new Promise(resolve => {
            let retries = 20;
            const check = () => {
                try {
                    const doc = iframe.contentDocument;
                    if (!doc) throw new Error("No doc");
                    const statement = extractProblemStatement(doc);
                    if (statement && statement.trim().length > 0) {
                        resolve();
                    } else if (retries > 0) {
                        retries--;
                        setTimeout(check, 500);
                    } else {
                        resolve(); // Timeout, proceed anyway
                    }
                } catch (e) {
                    if (retries > 0) {
                        retries--;
                        setTimeout(check, 500);
                    } else {
                        resolve();
                    }
                }
            };
            setTimeout(check, 1000);
        });
        
        const doc = iframe.contentDocument;
        if (!doc) throw new Error("Failed to access iframe document");
        
        const title = extractProblemTitle(doc) || ("Problem_" + (index+1));
        const statement = extractProblemStatement(doc);
        const mcqOptions = extractMCQOptions(doc);
        const questionType = determineQuestionType(doc, mcqOptions);
        const code = getIframeEditorCode(iframe);
        
        const questionNumber = String(index + 1).padStart(2, '0');
        
        const markdownContent = generateMarkdown({ 
            title, 
            sessionTitle, 
            questionNumber, 
            questionType, 
            statement, 
            mcqOptions, 
            code 
        });
        
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").substring(0, 80).trim();
        const filename = `${safeSessionFolder}/${questionNumber} - ${safeTitle || "Problem"}.md`;
        
        return { index, filename, markdownContent };
    } finally {
        if (document.body.contains(iframe)) {
            document.body.removeChild(iframe);
        }
    }
}
