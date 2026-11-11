// ============================================
// features/subjectSort.js
// Segregates subjects into Core and Other based on keywords
// ============================================

const SUBJECT_KEYWORDS = [
  "academic",
  "club",
  "misc",
  "miscellaneous",
  "revision",
  "other",
  "others",
  "posh",
  "session",
  "workshop",
  "workshops",
  "interview",
  "prep",
  "prep-",
];

function isSubjectSortPage() {
  return window.location.href.includes("/core-curriculum");
}

/**
 * Sort the subject list, and keep watching it while on a curriculum page.
 * Safe to call on every navigation: off the page, or with the feature off,
 * it stops the observer instead.
 */
function initSubjectSort() {
  if (!shouldHide("subject-sort")) {
    stopSubjectSortObserver();
    restoreSubjectSort();
    return;
  }

  if (!isSubjectSortPage()) {
    stopSubjectSortObserver();
    return;
  }
  observeSubjectList();
  sortSubjects();
}

function sortSubjects() {

  const container = document.querySelector(".m-l-20.m-r-20.m-t-20");
  if (!container) return;

  const subjectDivs = Array.from(container.querySelectorAll(".m-b-20"));
  // Only process if there are elements that haven't been processed
  if (
    subjectDivs.length === 0 ||
    subjectDivs.every((div) => div.hasAttribute("data-subject-processed"))
  )
    return;

  const coreSubjects = [];
  const otherSubjects = [];

  subjectDivs.forEach((div) => {
    div.setAttribute("data-subject-processed", "true");

    const nameEl = div.querySelector("._29EfoWpTY6mSoc0URgsgPl");
    if (nameEl) {
      const name = nameEl.textContent.toLowerCase();
      const hasKeyword = SUBJECT_KEYWORDS.some((kw) => name.includes(kw));
      if (hasKeyword) {
        otherSubjects.push(div);
      } else {
        coreSubjects.push(div);
      }
    } else {
      coreSubjects.push(div);
    }
  });

  let subjectCounter = 1;
  const processDiv = (type) => (div) => {
    const numEl = div.querySelector(".ZV1LrApmcV6Ae3HM7BSTK");
    if (
      numEl &&
      (numEl.textContent.includes("Subject -") ||
        numEl.hasAttribute("data-original-text"))
    ) {
      if (!numEl.hasAttribute("data-original-text")) {
        numEl.setAttribute("data-original-text", numEl.textContent);
      }

      numEl.innerHTML = "";
      numEl.appendChild(
        document.createTextNode(`Subject - ${subjectCounter++}`),
      );

      const tag = document.createElement("span");
      tag.className = "subject-sort-tag";
      tag.textContent = type === "core" ? "Core" : "Other";
      tag.style.marginLeft = "10px";
      tag.style.fontSize = "10px";
      tag.style.padding = "3px 6px";
      tag.style.borderRadius = "4px";
      tag.style.backgroundColor =
        type === "core" ? "rgba(0, 115, 255, 0.1)" : "rgba(100, 100, 100, 0.1)";
      tag.style.color = type === "core" ? "#0073ff" : "#666";
      tag.style.fontWeight = "700";
      tag.style.textTransform = "uppercase";
      tag.style.verticalAlign = "middle";
      tag.style.letterSpacing = "0.5px";
      numEl.appendChild(tag);
    }
    // Reorder by appending to container (moves it to the end)
    container.appendChild(div);
  };

  coreSubjects.forEach(processDiv("core"));
  otherSubjects.forEach(processDiv("other"));
}

function restoreSubjectSort() {
  // If toggled off, we can't easily restore the original order if the user navigated.
  // We can at least restore the original subject numbers.
  const container = document.querySelector(".m-l-20.m-r-20.m-t-20");
  if (container) {
    const subjectDivs = container.querySelectorAll(".m-b-20");
    subjectDivs.forEach((div) => {
      div.removeAttribute("data-subject-processed");
      const numEl = div.querySelector(".ZV1LrApmcV6Ae3HM7BSTK");
      if (numEl && numEl.hasAttribute("data-original-text")) {
        numEl.textContent = numEl.getAttribute("data-original-text");
        // Drop the marker so a second restore is a no-op, not another mutation.
        numEl.removeAttribute("data-original-text");
      }
    });
  }
}

let _subjectSortDebounce = null;

function stopSubjectSortObserver() {
  clearTimeout(_subjectSortDebounce);
  _subjectSortDebounce = null;
  if (window._subjectSortObserver) {
    window._subjectSortObserver.disconnect();
    window._subjectSortObserver = null;
  }
}

/**
 * The subject list renders late and re-renders on SPA updates. Watch for it,
 * debounced, and only ever sort from here — never restore, which used to
 * re-trigger the observer in a loop.
 */
function observeSubjectList() {
  if (window._subjectSortObserver) return; // already watching

  const observer = new MutationObserver(() => {
    clearTimeout(_subjectSortDebounce);
    _subjectSortDebounce = setTimeout(() => {
      if (!isSubjectSortPage()) {
        stopSubjectSortObserver();
        return;
      }
      if (shouldHide("subject-sort")) sortSubjects();
    }, 150);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window._subjectSortObserver = observer;
}

// First load; later navigations call initSubjectSort from content.js. Read
// settings first so a user who turned sorting off never sees it flash on.
setTimeout(async () => {
  if (typeof loadSettings === "function") await loadSettings();
  initSubjectSort();
}, 500);
