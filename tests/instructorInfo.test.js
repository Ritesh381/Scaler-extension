const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeFetch, tick } = require("./helpers/harness");

const LECTURE = {
  sbat_id: 123,
  super_batch_name: "DSA Batch",
  instructors_name: "Jane Doe",
  instructors_email: "jane@scaler.com",
  instructors_position: "SDE III",
  instructors_company: "Acme",
};

const eventsFetch = makeFetch((url) => {
  if (url.includes("/academy/mentee/events")) {
    return { json: { pastEvents: [LECTURE], futureEvents: [] } };
  }
  return { ok: false, status: 404 };
});

test("session page: injects an Instructor Info tab + panel with instructor data", async () => {
  const { window } = loadFeature("content/features/instructorInfo.js", {
    url: "https://www.scaler.com/academy/mentee-dashboard/class/123/session",
    fetch: eventsFetch,
    html: `<!DOCTYPE html><html><body>
      <div class="me-cr-body">
        <div class="navigation-tabs"></div>
        <div class="me-cr-lecture-container">lecture</div>
      </div>
    </body></html>`,
  });

  window.initInstructorInfo();
  await tick(50);

  const tab = window.document.getElementById("classroom-instructor-info");
  assert.ok(tab, "instructor tab should be injected");
  assert.match(tab.textContent, /Instructor Info/);
  assert.match(tab.textContent, /Jane/, "tab heading should show first name");

  const panel = window.document.getElementById("scaler-instructor-panel");
  assert.ok(panel, "instructor panel should exist");
  assert.match(panel.textContent, /Jane Doe/);
  assert.match(panel.textContent, /jane@scaler\.com/);
  assert.match(panel.textContent, /Acme/);
});

test("session page: activating the tab hides the lecture container", async () => {
  const { window } = loadFeature("content/features/instructorInfo.js", {
    url: "https://www.scaler.com/academy/mentee-dashboard/class/123/session",
    fetch: eventsFetch,
    html: `<!DOCTYPE html><html><body>
      <div class="me-cr-body">
        <div class="navigation-tabs"></div>
        <div class="me-cr-lecture-container">lecture</div>
      </div>
    </body></html>`,
  });

  window.initInstructorInfo();
  await tick(50);

  const tab = window.document.getElementById("classroom-instructor-info");
  tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

  const container = window.document.querySelector(".me-cr-lecture-container");
  assert.equal(container.style.display, "none");
  const panel = window.document.getElementById("scaler-instructor-panel");
  assert.equal(panel.style.display, "block");
});

test("todos dashboard: tags class cards with subject + instructor", async () => {
  const { window } = loadFeature("content/features/instructorInfo.js", {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    fetch: eventsFetch,
    html: `<!DOCTYPE html><html><body>
      <div class="mentee-dashboard__content">
        <a class="me-cr-classroom-url" data-cy="classroom-link" href="/academy/mentee-dashboard/class/123/session">
          <div class="mentee-card__header">Card</div>
        </a>
      </div>
    </body></html>`,
  });

  window.initInstructorInfo();
  await tick(50);

  const card = window.document.querySelector('a[data-cy="classroom-link"]');
  const info = card.querySelector(".scaler-instructor-info");
  assert.ok(info, "instructor tag container should be added to the card");
  assert.match(info.textContent, /Jane Doe/);
  assert.match(info.textContent, /DSA Batch/);
  assert.equal(card.getAttribute("data-instructor-info-id"), "123");
});

test("does nothing on unrelated pages", () => {
  const { window } = loadFeature("content/features/instructorInfo.js", {
    url: "https://www.scaler.com/academy/some-other-page",
    fetch: eventsFetch,
  });
  // should not throw and should not create a tab
  window.initInstructorInfo();
  assert.equal(window.document.getElementById("classroom-instructor-info"), null);
});

test("session page: the panel is not rebuilt on every page mutation (no self-triggering loop)", async () => {
  const { window } = loadFeature("content/features/instructorInfo.js", {
    url: "https://www.scaler.com/academy/mentee-dashboard/class/123/session",
    fetch: eventsFetch,
    html: `<!DOCTYPE html><html><body>
      <div class="me-cr-body">
        <div class="navigation-tabs"></div>
        <div class="me-cr-lecture-container">lecture</div>
      </div>
    </body></html>`,
  });

  window.initInstructorInfo();
  await tick(400);
  const panel = window.document.getElementById("scaler-instructor-panel");
  const card = panel.querySelector(".event-card");
  assert.ok(card, "panel rendered");

  // Count our own writes into the observed root over the next ticks.
  let ownWrites = 0;
  new window.MutationObserver((records) => {
    ownWrites += records.filter((r) => panel.contains(r.target) || r.target === panel).length;
  }).observe(window.document.body, { childList: true, subtree: true });

  window.document.querySelector(".me-cr-lecture-container").append(window.document.createElement("span"));
  await tick(1200);
  assert.equal(panel.querySelector(".event-card"), card, "same card element: not re-rendered");
  assert.equal(ownWrites, 0, "the panel settles instead of rewriting itself every 300 ms");
});

test("session page: no mount point means no detached panels are built", async () => {
  const { window } = loadFeature("content/features/instructorInfo.js", {
    url: "https://www.scaler.com/academy/mentee-dashboard/class/123/session",
    fetch: eventsFetch,
    html: `<!DOCTYPE html><html><body><div class="me-cr-body"><div class="navigation-tabs"></div></div></body></html>`,
  });
  window.initInstructorInfo();
  await tick(400);
  assert.equal(window.document.getElementById("scaler-instructor-panel"), null);
});
