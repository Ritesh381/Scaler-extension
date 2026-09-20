const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome, makeFetch, tick } = require("./helpers/harness");

const SESSION_URL =
  "https://www.scaler.com/academy/mentee-dashboard/class/777/session";

const metaFetch = makeFetch((url) => {
  if (url.includes("/api/v2/classroom/777/meta")) {
    return {
      json: {
        data: {
          attributes: {
            slug: "lec-777",
            // Course/module name — must NOT be used as the title.
            academy_module: { name: "SST Neural Network (ML III)" },
            // The actual lecture title — this is what we should store.
            current_topic: { title: "Perceptron to MLP" },
          },
        },
      },
    };
  }
  return { ok: false, status: 404 };
});

const SESSION_HTML = `<!DOCTYPE html><html><body>
  <div class="me-cr-body">
    <div class="navigation-tabs"></div>
    <div class="me-cr-lecture-container">lecture</div>
  </div>
</body></html>`;

function clickTab(window) {
  const tab = window.document.getElementById("classroom-lecture-summary");
  tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
}

// Build a chrome mock whose sendMessage routes by action, recording calls.
function summaryChrome(handlers, stores = {}) {
  const calls = [];
  const chrome = makeChrome({
    localStore: stores.local,
    syncStore: stores.sync,
    sendMessage: (msg, cb) => {
      calls.push(msg);
      const h = handlers[msg.action];
      const resp = typeof h === "function" ? h(msg) : h;
      if (cb) cb(resp ?? { success: true });
    },
  });
  chrome.__calls = calls;
  return chrome;
}

test("renders a cached summary's sections", async () => {
  const chrome = summaryChrome({
    checkSummaryCache: {
      success: true,
      data: {
        cached: true,
        summary: {
          brief: [
            { title: "Binary Trees", body: "The lecture opened with binary trees.\n\nIt explained nodes and edges." },
            { title: "Traversals", body: "It then moved on to traversals and wrapped up with a recap." },
          ],
          topics: ["Trees 101"],
          notes: [],
          deadlines: ["HW due Fri"],
          announcements: [],
        },
        generatedBy: "a@b.com",
        model: "gpt-4o-mini",
      },
    },
  });

  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    html: SESSION_HTML,
    fetch: metaFetch,
    chrome,
  });

  window.initLectureSummary();
  await tick(20);
  clickTab(window);
  await tick(50);

  const panel = window.document.getElementById("scaler-summary-panel");
  assert.match(panel.textContent, /Lecture Brief/);
  assert.match(panel.textContent, /opened with binary trees/);
  // two concepts, each with a title
  assert.equal(panel.querySelectorAll(".scaler-notes-concept").length, 2);
  assert.equal(panel.querySelectorAll(".scaler-notes-ctitle").length, 2);
  assert.match(panel.textContent, /Binary Trees/);
  assert.match(panel.textContent, /Traversals/);
  // first concept body has two paragraphs (split on the blank line)
  assert.equal(panel.querySelectorAll(".scaler-notes-para").length, 3);
  assert.match(panel.textContent, /Topics Taught/);
  assert.match(panel.textContent, /Trees 101/);
  assert.match(panel.textContent, /HW due Fri/);
  // author is never surfaced in the UI — only the model
  assert.doesNotMatch(panel.textContent, /a@b\.com/);
  assert.match(panel.textContent, /Model: gpt-4o-mini/);
  // AI Settings button is hidden once notes exist
  assert.equal(panel.querySelector(".scaler-notes-gear"), null);

  // Download control offers Transcript + Notes
  const dlBtn = panel.querySelector(".scaler-notes-dl");
  assert.ok(dlBtn, "download button should be shown");
  dlBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const menuLabels = [...panel.querySelectorAll(".scaler-notes-menu button")].map(
    (b) => b.textContent,
  );
  assert.ok(menuLabels.some((t) => /Transcript/i.test(t)), "Transcript option");
  assert.ok(menuLabels.some((t) => /Notes/i.test(t)), "Notes option");
});

test("shows Generate button when a transcript exists but no summary", async () => {
  const chrome = summaryChrome({
    checkSummaryCache: { success: true, data: { cached: false } },
    checkTranscriptCache: { success: true, data: { cached: true, text: "full transcript text" } },
  });

  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    html: SESSION_HTML,
    fetch: metaFetch,
    chrome,
  });

  window.initLectureSummary();
  await tick(20);
  clickTab(window);
  await tick(50);

  const panel = window.document.getElementById("scaler-summary-panel");
  const buttons = [...panel.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(buttons.includes("✨ Generate Notes"), "Generate button should be shown");
  // AI Settings button is available while notes don't exist yet
  assert.ok(panel.querySelector(".scaler-notes-gear"), "AI Settings button should be shown");
});

test("asks for a transcript first when neither summary nor transcript is cached", async () => {
  const chrome = summaryChrome({
    checkSummaryCache: { success: true, data: { cached: false } },
    checkTranscriptCache: { success: true, data: { cached: false } },
  });

  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    html: SESSION_HTML,
    fetch: metaFetch,
    chrome,
  });

  window.initLectureSummary();
  await tick(20);
  clickTab(window);
  await tick(50);

  const panel = window.document.getElementById("scaler-summary-panel");
  assert.match(panel.textContent, /transcript/i);
  assert.match(panel.textContent, /first/i);
  const btns = [...panel.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(
    btns.includes("🎙️ Generate Transcript"),
    "Generate Transcript button should be shown",
  );
});

test("Generate flow calls the LLM, renders the result and caches it", async () => {
  const generated = {
    topics: ["Recursion"],
    notes: ["Base case matters"],
    deadlines: [],
    announcements: ["Quiz next week"],
  };

  const chrome = summaryChrome(
    {
      checkSummaryCache: { success: true, data: { cached: false } },
      checkTranscriptCache: { success: true, data: { cached: true, text: "transcript" } },
      generateSummary: { success: true, summary: generated },
      saveSummary: { success: true, data: { saved: true } },
    },
    {
      local: { scaler_summary_config: { baseUrl: "https://api.x/v1", apiKey: "sk-1", model: "m" } },
      sync: { scaler_user: { email: "gen@scaler.com" } },
    },
  );

  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    html: SESSION_HTML,
    fetch: metaFetch,
    chrome,
  });

  window.initLectureSummary();
  await tick(20);
  clickTab(window);
  await tick(50);

  const panel = window.document.getElementById("scaler-summary-panel");
  const genBtn = [...panel.querySelectorAll("button")].find(
    (b) => b.textContent === "✨ Generate Notes",
  );
  assert.ok(genBtn, "Generate button present");
  genBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(50);

  // rendered the generated summary
  assert.match(panel.textContent, /Recursion/);
  assert.match(panel.textContent, /Quiz next week/);

  // called generate + save with the right payload
  const calls = chrome.__calls;
  const gen = calls.find((c) => c.action === "generateSummary");
  assert.ok(gen, "generateSummary was called");
  assert.equal(gen.transcript, "transcript");
  assert.equal(gen.apiKey, "sk-1");

  const save = calls.find((c) => c.action === "saveSummary");
  assert.ok(save, "saveSummary was called");
  assert.equal(save.slug, "lec-777");
  assert.equal(save.classId, "777");
  assert.equal(save.generatedBy, "gen@scaler.com");
  // Title is the lecture topic (current_topic.title), NOT the course/module name.
  assert.equal(save.title, "Perceptron to MLP");
  assert.deepEqual(save.summary, generated);
});

test("adds the Notes tab when the tab-bar renders after init (slow load)", async () => {
  const chrome = summaryChrome({});
  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    // Session page, but the navigation tab-bar hasn't rendered yet.
    html: `<!DOCTYPE html><html><body><div class="me-cr-body"></div></body></html>`,
    fetch: metaFetch,
    chrome,
  });

  window.initLectureSummary();
  assert.equal(
    window.document.getElementById("classroom-lecture-summary"),
    null,
    "no tab yet — the tab-bar isn't in the DOM",
  );

  // The tab-bar renders late (slow load).
  const tabs = window.document.createElement("div");
  tabs.className = "navigation-tabs";
  window.document.querySelector(".me-cr-body").appendChild(tabs);

  await tick(20);
  assert.ok(
    window.document.getElementById("classroom-lecture-summary"),
    "Notes tab should be injected once the tab-bar appears",
  );
});

test("shows the humorous message when the transcript exceeds the model's context limit", async () => {
  const chrome = summaryChrome(
    {
      checkSummaryCache: { success: true, data: { cached: false } },
      checkTranscriptCache: { success: true, data: { cached: true, text: "transcript" } },
      generateSummary: {
        success: false,
        error:
          "HTTP 400: {\"error\":{\"message\":\"This endpoint's maximum context length is 10240 tokens. However, you requested about 14920 tokens. Please reduce the length.\"}}",
      },
    },
    {
      local: { scaler_summary_config: { baseUrl: "https://api.x/v1", apiKey: "sk-1", model: "m" } },
      sync: { scaler_user: { email: "gen@scaler.com" } },
    },
  );

  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    html: SESSION_HTML,
    fetch: metaFetch,
    chrome,
  });

  window.initLectureSummary();
  await tick(20);
  clickTab(window);
  await tick(50);

  const panel = window.document.getElementById("scaler-summary-panel");
  const genBtn = [...panel.querySelectorAll("button")].find(
    (b) => b.textContent === "✨ Generate Notes",
  );
  genBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(50);

  // A friendly "use a paid model" hint is shown (exact joke copy may vary)…
  assert.match(panel.textContent, /paid/i);
  // …and the raw provider error is not dumped to the user.
  assert.doesNotMatch(panel.textContent, /maximum context length/);
});

test("download filename uses the class name from the session header", async () => {
  const chrome = summaryChrome({
    checkSummaryCache: {
      success: true,
      data: {
        cached: true,
        summary: { brief: [], topics: ["X"], notes: [], deadlines: [], announcements: [] },
        generatedBy: "",
        model: "",
      },
    },
  });

  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    html: `<!DOCTYPE html><html><body><div class="me-cr-body">
      <div class="navigation-tabs"></div>
      <div class="me-cr-header-dropdown-title__label">
        <span class="bold">Model Context Protocol (MCP) & Agent Communication</span>
      </div>
      <div class="me-cr-lecture-container">lecture</div>
    </div></body></html>`,
    fetch: metaFetch,
    chrome,
  });

  // Capture the download without needing a real blob URL (not in jsdom).
  const downloads = [];
  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download);
  };

  window.initLectureSummary();
  await tick(20);
  clickTab(window);
  await tick(50);

  const panel = window.document.getElementById("scaler-summary-panel");
  panel.querySelector(".scaler-notes-dl").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true }),
  );
  const notesItem = [...panel.querySelectorAll(".scaler-notes-menu button")].find(
    (b) => /Notes/i.test(b.textContent),
  );
  notesItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.equal(downloads.length, 1);
  assert.equal(
    downloads[0],
    "Model-Context-Protocol-MCP-Agent-Communication-notes.md",
  );
});

test("places the Notes tab before the Instructor Info tab", () => {
  const chrome = summaryChrome({});
  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: SESSION_URL,
    html: `<!DOCTYPE html><html><body><div class="me-cr-body">
      <div class="navigation-tabs">
        <a class="navigation-tab-item" id="classroom-instructor-info"><div>Instructor Info</div></a>
      </div>
      <div class="me-cr-lecture-container"></div>
    </div></body></html>`,
    fetch: metaFetch,
    chrome,
  });

  window.initLectureSummary();

  const ids = [
    ...window.document.querySelectorAll(".navigation-tabs .navigation-tab-item"),
  ].map((t) => t.id);
  const notesIdx = ids.indexOf("classroom-lecture-summary");
  const instrIdx = ids.indexOf("classroom-instructor-info");
  assert.ok(notesIdx !== -1, "Notes tab should be injected");
  assert.ok(notesIdx < instrIdx, "Notes tab should come before Instructor Info");
});

test("does not inject the Summary tab on non-session pages", () => {
  const { window } = loadFeature("content/features/lectureSummary.js", {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    fetch: metaFetch,
  });
  window.initLectureSummary();
  assert.equal(window.document.getElementById("classroom-lecture-summary"), null);
});
