// ============================================
// utils/domUtils.js
// Generic DOM helper utilities
// ============================================

/**
 * Helper function to get element by XPath
 */
function getElementByXPath(xpath) {
  return document.evaluate(
    xpath,
    document,
    null,
    XPathResult.FIRST_ORDERED_NODE_TYPE,
    null,
  ).singleNodeValue;
}

/**
 * Text nodes under `root`, in document order, whose trimmed text satisfies
 * `test`. Matching on visible text survives the generated class names
 * Scaler's markup is built from.
 * @param {Node} root
 * @param {(text: string) => boolean} test
 * @returns {Text[]}
 */
function textNodesMatching(root, test) {
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (test(n.nodeValue.trim())) out.push(n);
  }
  return out;
}
