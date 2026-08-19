const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome, tick } = require("./helpers/harness");

test("processMessages skips a dismissed one_time message and injects the next", () => {
  const chrome = makeChrome({
    localStore: { dismissed_message_ids: { m1: true } },
  });
  const { window } = loadFeature("content/features/customMessage.js", { chrome });

  const injected = [];
  window.injectCustomMessage = (msg) => injected.push(msg.id);

  window.processMessages([
    { id: "m1", one_time: true, msg: "A" },
    { id: "m2", one_time: false, msg: "B" },
  ]);

  assert.deepEqual(injected, ["m2"]);
});

test("processMessages injects the first message when nothing is dismissed", () => {
  const chrome = makeChrome();
  const { window } = loadFeature("content/features/customMessage.js", { chrome });

  const injected = [];
  window.injectCustomMessage = (msg) => injected.push(msg.id);

  window.processMessages([
    { id: "m1", one_time: true, msg: "A" },
    { id: "m2", one_time: false, msg: "B" },
  ]);

  assert.deepEqual(injected, ["m1"]);
});

test("injectCustomMessage injects the banner once the header is present", async () => {
  const { window } = loadFeature("content/features/customMessage.js", {
    html: `<!DOCTYPE html><html><body>
      <div class="_3waiogKHpNpMjAh8o5lc2v">
        <div class="e7ge61UPj54Me37pqU2Rd">logo</div>
      </div>
    </body></html>`,
  });

  window.injectCustomMessage({ id: "x", msg: "<b>hi</b>", one_time: false }, {});

  // The injector polls on a 500ms interval for the header.
  await tick(700);

  const container = window.document.getElementById("scaler-custom-msg-container");
  assert.ok(container, "banner container should be injected");
  assert.equal(container.innerHTML, "<b>hi</b>");
});

test("initCustomMessages calls processMessages with backend data", () => {
  const chrome = makeChrome({
    sendMessage: (msg, cb) => {
      if (msg.action === "fetchCustomMessages") {
        cb({ success: true, data: [{ id: "z", one_time: false, msg: "Z" }] });
      }
    },
  });
  const { window } = loadFeature("content/features/customMessage.js", { chrome });

  const injected = [];
  window.injectCustomMessage = (msg) => injected.push(msg.id);

  window.initCustomMessages();
  assert.deepEqual(injected, ["z"]);
});

test("initCustomMessages forwards the cached profile email for audience targeting", () => {
  const sent = [];
  const chrome = makeChrome({
    syncStore: {
      scaler_user: { name: "Ritesh", email: "ritesh.24bcs10088@sst.scaler.com" },
    },
    sendMessage: (msg, cb) => {
      sent.push(msg);
      cb({ success: true, data: [] });
    },
  });
  const { window } = loadFeature("content/features/customMessage.js", { chrome });

  window.initCustomMessages();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "fetchCustomMessages");
  assert.equal(sent[0].email, "ritesh.24bcs10088@sst.scaler.com");
});

test("initCustomMessages still fetches with a null email when no profile is cached", () => {
  const sent = [];
  const chrome = makeChrome({
    sendMessage: (msg, cb) => {
      sent.push(msg);
      cb({ success: true, data: [{ id: "b", one_time: false, msg: "B" }] });
    },
  });
  const { window } = loadFeature("content/features/customMessage.js", { chrome });

  const injected = [];
  window.injectCustomMessage = (msg) => injected.push(msg.id);

  window.initCustomMessages();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, null);
  assert.deepEqual(injected, ["b"]);
});
