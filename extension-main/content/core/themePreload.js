// ============================================
// core/themePreload.js
// Runs at document_start (before first paint) to re-apply the saved theme
// immediately, eliminating the light→dark flash (FOUC) that happens when the
// main themeManager.js applies the theme later at document_idle.
//
// It reads a mirror of the selected theme that themeManager.js writes into the
// page's localStorage. themeManager.js then takes over and REMOVES this shim
// (#scaler-theme-preload) once its own class-gated styles are in place — so on
// a natively-dark page (listed in scalerpp_dark_paths) this preload is skipped
// and never inverts it.
// ============================================

(function () {
  try {
    var theme = localStorage.getItem("scalerpp_theme");
    var filter = localStorage.getItem("scalerpp_theme_filter");
    if (!theme || theme === "off" || !filter) return;

    // Sanitize values read from page localStorage before putting them in CSS,
    // so a hostile value can't break out of the declaration. Only the small
    // character set used by CSS filter()/color values is allowed.
    if (!/^[a-zA-Z0-9().,%\s/-]+$/.test(filter)) return;
    var bg = localStorage.getItem("scalerpp_theme_bg") || "#ffffff";
    if (!/^[a-zA-Z0-9().,%#\s/-]+$/.test(bg)) bg = "#ffffff";

    // Skip pages known to be natively dark — pre-inverting them would flash.
    var darkPaths = [];
    try {
      darkPaths = JSON.parse(localStorage.getItem("scalerpp_dark_paths") || "[]") || [];
    } catch (e) {
      darkPaths = [];
    }
    if (darkPaths.indexOf(location.pathname) !== -1) return;

    var counter = "invert(1) hue-rotate(180deg)";
    var css =
      "html{filter:" + filter + " !important;background-color:" + bg + " !important;}" +
      "html img,html video,html canvas,html iframe,html embed,html object," +
      'html svg image,html [style*="background-image"],html .monaco-editor,' +
      "html .cm-editor,html .CodeMirror,html .ace_editor{filter:" + counter + " !important;}";

    var s = document.createElement("style");
    s.id = "scaler-theme-preload";
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {
    /* localStorage blocked or unavailable — no preload, main script still works */
  }
})();
