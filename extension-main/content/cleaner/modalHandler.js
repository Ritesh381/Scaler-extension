// ============================================
// cleaner/modalHandler.js
// MutationObserver for referral modal detection
// ============================================

/**
 * Setup observer to watch for new modals appearing
 */
function setupModalObserver() {
  if (modalObserverSetup) return;

  // Debounce timer to batch rapid modal-related mutations.
  let _modalDebounceTimer = null;

  // Is this added element a modal, or does it contain one? Leaf elements
  // (most mutations: text spans, icons) skip the subtree query.
  const isModalNode = (node) =>
    node.nodeType === Node.ELEMENT_NODE &&
    (node.classList.contains("sr-modal") ||
      node.classList.contains("sr-backdrop") ||
      (node.firstElementChild !== null && node.querySelector(".sr-modal") !== null));

  const observer = new MutationObserver((mutations) => {
    // Stop at the first modal found instead of querying every added node.
    let shouldCheck = false;
    for (let i = 0; i < mutations.length && !shouldCheck; i++) {
      const added = mutations[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        if (isModalNode(added[j])) {
          shouldCheck = true;
          break;
        }
      }
    }

    if (shouldCheck) {
      // Debounce to let the modal fully render before acting
      clearTimeout(_modalDebounceTimer);
      _modalDebounceTimer = setTimeout(() => {
        hideReferralPopup();
        if (shouldHide("auto-close-modals")) {
          autoCloseReferralModals();
        }
      }, 150);
    }
  });

  // childList + subtree is enough: we only need to know when modal
  // nodes are *added* to the DOM. Watching attributes on every element
  // is expensive and not needed here.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  modalObserverSetup = true;
}
