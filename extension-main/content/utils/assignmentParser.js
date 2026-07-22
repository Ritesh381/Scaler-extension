// ============================================
// utils/assignmentParser.js
// Shared utilities for extracting problem data
// from the Scaler DOM.
// ============================================

/**
 * Extract problem title from the page
 */
function extractProblemTitle(doc = document) {
  let rawTitle = null;

  // Strategy 1: Specific Class (Priority) - cr-p-heading__text
  const specificSelectors = [
    ".cr-p-heading__text span",
    ".cr-p-heading__text",
    '[class*="heading__text"]',
    '[class*="heading_text"]',
  ];

  for (const sel of specificSelectors) {
    const el = doc.querySelector(sel);
    if (el && el.innerText.trim()) {
      rawTitle = el.innerText;
      break;
    }
  }

  // Strategy 2: H1 fallback
  if (!rawTitle) {
    const h1 = doc.querySelector("h1");
    if (h1) {
      rawTitle = h1.innerText;
    }
  }

  if (rawTitle) {
    // CLEANUP logic
    let clean = rawTitle
      .replace(/^Q\d+\.\s*/i, "") // Remove Q1., Q2., etc.
      .replace(/<\/?>/g, "") // Remove tags
      .replace(/\bSolved\b/gi, "")
      .replace(/\bUnsolved\b/gi, "")
      .replace(/\s-\sProblem$/i, "") // Remove " - Problem"
      .replace(/\sProblem$/i, "")
      .trim();

    clean = clean.split("\n")[0].trim();
    return clean;
  }

  return null;
}

/**
 * Extract the problem statement text from the page
 */
function extractProblemStatement(doc = document) {
  const CONTENT_SELECTORS = [
    ".cr-p-problem-statement",
    "[class*='problemStatement']",
    "[class*='problem-statement']",
    "[class*='ProblemStatement']",
    "[class*='problem-description']",
    "[class*='problemDescription']",
    "[class*='statement']",
    "[class*='description']",
  ];

  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel);
    const text = el && el.innerText ? el.innerText.trim() : "";
    if (text && text.length > 40) {
      return text.slice(0, 4000);
    }
  }

  // Fallback: the largest text block under the heading's container.
  const heading = doc.querySelector(".cr-p-heading__text");
  const container = heading ? heading.closest("section, article, div") : null;
  if (container && container.innerText) {
    return container.innerText.trim().slice(0, 4000);
  }
  return "";
}

/**
 * Extract MCQ options if present
 */
function extractMCQOptions(doc = document) {
    const getLetter = (index) => String.fromCharCode(65 + index); // 0 -> A, 1 -> B, etc.
    
    // 1. Try to find the heading "Choose the correct answer"
    const els = Array.from(doc.querySelectorAll('div, p, span, h1, h2, h3, h4'));
    const heading = els.find(el => el.innerText && el.innerText.includes("Choose the correct answer"));
    
    if (heading && heading.parentElement) {
        // Grab the text of the container, remove the heading part
        let text = heading.parentElement.innerText.replace(heading.innerText, "").trim();
        if (text) {
             const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
             if (lines.length > 0) {
                 // The lines might just be the options
                 return "\n## Options\n" + lines.map((l, i) => `- [ ] **${getLetter(i)})** ${l}`).join("\n") + "\n";
             }
        }
    }
    
    // 2. Fallback to inputs
    const inputs = doc.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    if (inputs.length > 0) {
        const options = [];
        inputs.forEach(input => {
            // Find closest parent that contains text
            let current = input.parentElement;
            let text = "";
            while (current && current !== doc.body) {
                if (current.innerText && current.innerText.trim()) {
                    text = current.innerText.trim();
                    break;
                }
                current = current.parentElement;
            }
            if (text) options.push(text);
        });
        if (options.length > 0) {
            const uniqueOptions = [...new Set(options)]; // Deduplicate
            return "\n## Options\n" + uniqueOptions.map((l, i) => `- [ ] **${getLetter(i)})** ${l}`).join("\n") + "\n";
        }
    }
    
    return "";
}

/**
 * Extracts the session title from the page
 */
function extractSessionTitle(doc = document) {
    let sessionTitle = "Assignment";
    const header = doc.querySelector('.header-title') || doc.querySelector('[class*="Header_title"]');
    if (header && header.innerText.trim()) {
        sessionTitle = header.innerText.trim();
    } else if (doc.title) {
        sessionTitle = doc.title.replace(/\s*-\s*Scaler.*$/, '').trim();
    }
    return sessionTitle;
}

/**
 * Determines the question type (Coding, MCQ, or Multiple Correct)
 */
function determineQuestionType(doc = document, mcqOptions = "") {
    if (!mcqOptions) return "Coding";
    
    // Look for radio vs checkbox
    const checkboxes = doc.querySelectorAll('input[type="checkbox"]');
    if (checkboxes.length > 0) return "Multiple Correct MCQ";
    
    const radios = doc.querySelectorAll('input[type="radio"]');
    if (radios.length > 0) return "Single Correct MCQ";
    
    // Fallback if inputs aren't found
    return "MCQ";
}
