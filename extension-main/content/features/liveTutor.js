// Live AI Tutor — opt-in help for an active Scaler classroom.
// Audio, transcript and answers stay in memory unless the learner explicitly
// sends an audio chunk to their own transcription provider.
(function (global) {
  const BUTTON_ID = "scaler-live-tutor-button";
  const PANEL_ID = "scaler-live-tutor-panel";
  const CONFIG_KEY = "scaler_live_tutor_config";
  const CHUNK_MS = 20_000;
  const MAX_CONTEXT_CHARS = 24_000;
  let recorder = null;
  let stream = null;
  let transcript = [];
  let observer = null;

  const send = (message) => new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(chrome.runtime.lastError ? { success: false, error: chrome.runtime.lastError.message } : response || { success: false });
    });
  });

  async function config() {
    const result = await chrome.storage.local.get(CONFIG_KEY);
    return result[CONFIG_KEY] || {};
  }

  function isLiveClass() {
    return /\/academy\/mentee-dashboard\/class\//.test(location.pathname) &&
      (location.search.includes("joinSession=1") || Boolean(document.querySelector(".agora_video_player, .streams-layout")));
  }

  function latestContext() {
    return transcript.map((entry) => `[${entry.time}] ${entry.text}`).join("\n").slice(-MAX_CONTEXT_CHARS);
  }

  function addStyles() {
    if (document.getElementById("scaler-live-tutor-styles")) return;
    const style = document.createElement("style");
    style.id = "scaler-live-tutor-styles";
    style.textContent = `
      #${PANEL_ID}{position:fixed;right:78px;bottom:24px;width:min(390px,calc(100vw - 104px));max-height:70vh;background:#fff;color:#172033;border:1px solid #dbe4f0;border-radius:14px;box-shadow:0 18px 48px rgba(15,23,42,.25);z-index:2147483646;font:14px/1.45 system-ui,sans-serif;overflow:hidden}
      #${PANEL_ID} *{box-sizing:border-box} .slt-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid #e8edf5;font-weight:750}.slt-head button,.slt-actions button{border:0;border-radius:8px;padding:7px 10px;cursor:pointer;font-weight:650}.slt-body{padding:14px;display:grid;gap:10px}.slt-status{font-size:12px;color:#56657a}.slt-transcript{max-height:130px;overflow:auto;background:#f7f9fc;border-radius:9px;padding:9px;font-size:12px;white-space:pre-wrap}.slt-messages{display:grid;gap:8px;max-height:190px;overflow:auto}.slt-message{padding:9px 10px;border-radius:10px;background:#f0f5ff}.slt-message.user{background:#e7f7ee}.slt-input,.slt-body input{width:100%;border:1px solid #ccd6e4;border-radius:8px;padding:9px;font:inherit}.slt-actions{display:flex;gap:8px;align-items:center}.slt-primary{background:#275df5;color:#fff}.slt-muted{background:#edf1f7;color:#31415a}.slt-config{display:grid;gap:8px;padding-top:4px}.slt-config label{font-size:12px;font-weight:650;color:#48566a}.slt-notice{font-size:11px;color:#6b7788}
    `;
    document.head.appendChild(style);
  }

  function panel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    addStyles();
    el = document.createElement("section");
    el.id = PANEL_ID;
    el.innerHTML = `<div class="slt-head"><span>✨ Live AI Tutor</span><button class="slt-muted" data-close>×</button></div><div class="slt-body"><div class="slt-status" data-status>Ready. Add your own API keys to start.</div><input data-topic placeholder="Current class topic (optional)" /><div class="slt-actions"><button class="slt-primary" data-start>Start listening</button><button class="slt-muted" data-stop disabled>Stop & clear</button><button class="slt-muted" data-config>Settings</button></div><div class="slt-transcript" data-transcript>Live transcript will appear here. It is cleared when you stop.</div><div class="slt-messages" data-messages></div><div class="slt-actions"><input class="slt-input" data-question placeholder="Ask: What did sir mean by this?" /><button class="slt-primary" data-ask>Ask</button></div><div class="slt-notice">Only the latest audio chunk is sent to your chosen transcription provider. Answers use the recent transcript and your topic.</div></div>`;
    document.body.appendChild(el);
    wirePanel(el);
    return el;
  }

  function setStatus(el, text) { el.querySelector("[data-status]").textContent = text; }
  function renderTranscript(el) { el.querySelector("[data-transcript]").textContent = latestContext() || "Live transcript will appear here. It is cleared when you stop."; }
  function addMessage(el, text, user) { const item = document.createElement("div"); item.className = `slt-message${user ? " user" : ""}`; item.textContent = text; el.querySelector("[data-messages]").appendChild(item); item.scrollIntoView({ block: "nearest" }); }

  async function showConfig(el) {
    const saved = await config();
    const body = el.querySelector(".slt-body");
    if (body.querySelector(".slt-config")) return;
    const form = document.createElement("div");
    form.className = "slt-config";
    form.innerHTML = `<label>Transcription endpoint<input data-stt-url value="${saved.sttUrl || ""}" placeholder="Deepgram, Groq, OpenAI-compatible, or ElevenLabs endpoint" /></label><label>Transcription API key<input type="password" data-stt-key value="${saved.sttKey || ""}" /></label><label>Transcription model (optional)<input data-stt-model value="${saved.sttModel || ""}" /></label><label>LLM base URL<input data-llm-url value="${saved.llmUrl || saved.baseUrl || ""}" placeholder="OpenAI-compatible /v1 URL" /></label><label>LLM API key<input type="password" data-llm-key value="${saved.llmKey || saved.apiKey || ""}" /></label><label>LLM model<input data-llm-model value="${saved.llmModel || saved.model || ""}" placeholder="e.g. llama-3.3-70b-versatile" /></label><button class="slt-primary" data-save>Save keys locally</button>`;
    body.appendChild(form);
    form.querySelector("[data-save]").addEventListener("click", async () => {
      const value = (key) => form.querySelector(`[${key}]`).value.trim();
      await chrome.storage.local.set({ [CONFIG_KEY]: { sttUrl: value("data-stt-url"), sttKey: value("data-stt-key"), sttModel: value("data-stt-model"), llmUrl: value("data-llm-url"), llmKey: value("data-llm-key"), llmModel: value("data-llm-model") } });
      form.remove(); setStatus(el, "Settings saved locally in this browser.");
    });
  }

  function findAudioStream() {
    const video = document.querySelector("video.agora_video_player, .agora_video_player video, .streams-layout video");
    if (!video || typeof video.captureStream !== "function") throw new Error("The live class audio is not ready yet. Start the class video, then try again.");
    const captured = video.captureStream();
    const audioTracks = captured.getAudioTracks();
    if (!audioTracks.length) throw new Error("Could not access class audio. Please make sure the instructor audio is playing.");
    return new MediaStream(audioTracks);
  }

  function blobToBase64(blob) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(blob); }); }
  function clock() { return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }

  async function transcribeChunk(el, blob) {
    const saved = await config();
    if (!saved.sttUrl || !saved.sttKey) { setStatus(el, "Add a transcription endpoint and your own API key in Settings."); stop(el); return; }
    setStatus(el, "Transcribing the latest 20 seconds with your provider…");
    const response = await send({ action: "transcribeLiveTutorAudio", audio: await blobToBase64(blob), mimeType: blob.type, config: saved });
    if (!response.success) { setStatus(el, response.error || "Transcription failed."); return; }
    if (response.text && response.text.trim()) { transcript.push({ time: clock(), text: response.text.trim() }); renderTranscript(el); setStatus(el, "Listening — recent context is ready for questions."); }
    else setStatus(el, "Listening — no speech detected in the latest chunk.");
  }

  async function start(el) {
    if (recorder) return;
    try {
      stream = findAudioStream();
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 48_000 });
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size) transcribeChunk(el, event.data).catch((e) => setStatus(el, e.message)); });
      recorder.addEventListener("stop", () => { recorder = null; stream?.getTracks().forEach((track) => track.stop()); stream = null; });
      recorder.start(CHUNK_MS);
      el.querySelector("[data-start]").disabled = true; el.querySelector("[data-stop]").disabled = false;
      setStatus(el, "Listening to the live class. The first transcript chunk arrives in about 20 seconds.");
    } catch (error) { setStatus(el, error.message || "Could not start live audio capture."); }
  }

  function stop(el) {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorder = null; stream?.getTracks().forEach((track) => track.stop()); stream = null; transcript = [];
    renderTranscript(el); el.querySelector("[data-start]").disabled = false; el.querySelector("[data-stop]").disabled = true;
    setStatus(el, "Stopped. The live transcript and chat context were cleared.");
  }

  async function ask(el) {
    const input = el.querySelector("[data-question]"); const question = input.value.trim();
    if (!question) return;
    const context = latestContext(); if (!context) { setStatus(el, "Start listening and wait for a transcript chunk before asking a question."); return; }
    const saved = await config(); if (!saved.llmUrl || !saved.llmKey) { setStatus(el, "Add your LLM endpoint and API key in Settings."); return; }
    input.value = ""; addMessage(el, question, true); setStatus(el, "Asking your AI tutor…");
    const response = await send({ action: "askLiveTutor", question, transcript: context, topic: el.querySelector("[data-topic]").value.trim(), config: saved });
    if (response.success) { addMessage(el, response.answer, false); setStatus(el, "Answer grounded in the live transcript."); }
    else setStatus(el, response.error || "The tutor could not answer.");
  }

  function wirePanel(el) {
    el.querySelector("[data-close]").addEventListener("click", () => { stop(el); el.remove(); });
    el.querySelector("[data-start]").addEventListener("click", () => start(el));
    el.querySelector("[data-stop]").addEventListener("click", () => stop(el));
    el.querySelector("[data-config]").addEventListener("click", () => showConfig(el));
    el.querySelector("[data-ask]").addEventListener("click", () => ask(el));
    el.querySelector("[data-question]").addEventListener("keydown", (event) => { if (event.key === "Enter") ask(el); });
  }

  function inject() {
    if (!isLiveClass() || document.getElementById(BUTTON_ID)) return;
    const actions = document.querySelectorAll(".m-header__actions"); const target = actions[actions.length - 1];
    if (!target) return;
    const button = document.createElement("button"); button.id = BUTTON_ID; button.type = "button"; button.textContent = "✨ AI Tutor"; button.className = "tappable btn m-btn m-btn--default"; button.style.cssText = "margin-right:8px;font-weight:650";
    button.addEventListener("click", () => panel()); target.prepend(button);
  }

  function initLiveTutor() {
    inject();
    if (!observer) { observer = new MutationObserver(inject); observer.observe(document.documentElement, { childList: true, subtree: true }); }
  }
  global.initLiveTutor = initLiveTutor;
})(window);
