// Provider-agnostic live-tutor proxy. It only receives short, user-triggered
// audio chunks and never persists audio, transcript, keys, or answers.
(function () {
  function base64ToBlob(base64, mimeType) {
    const bytes = atob(base64); const data = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) data[i] = bytes.charCodeAt(i);
    return new Blob([data], { type: mimeType || "audio/webm" });
  }
  async function textFromResponse(res) { const body = await res.json(); return body.text || body.results?.channels?.[0]?.alternatives?.[0]?.transcript || body.text || ""; }
  async function transcribe(blob, config) {
    const url = config.sttUrl; const model = config.sttModel || (url.includes("groq.com") ? "whisper-large-v3" : "whisper-1");
    if (url.includes("deepgram.com")) {
      const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}&smart_format=true`, { method: "POST", headers: { Authorization: `Token ${config.sttKey}`, "Content-Type": blob.type }, body: blob });
      if (!res.ok) throw new Error(`Transcription provider returned HTTP ${res.status}.`); return textFromResponse(res);
    }
    const data = new FormData(); data.append("file", blob, "live-class.webm"); data.append("model", model);
    const headers = url.includes("elevenlabs.io") ? { "xi-api-key": config.sttKey } : { Authorization: `Bearer ${config.sttKey}` };
    const res = await fetch(url, { method: "POST", headers, body: data });
    if (!res.ok) throw new Error(`Transcription provider returned HTTP ${res.status}.`); return textFromResponse(res);
  }
  function chatUrl(baseUrl) { const value = (baseUrl || "").trim().replace(/\/+$/, ""); return /\/chat\/completions$/.test(value) ? value : `${value}/chat/completions`; }
  async function answer(message) {
    const res = await fetch(chatUrl(message.config.llmUrl), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${message.config.llmKey}` }, body: JSON.stringify({ model: message.config.llmModel || "gpt-4o-mini", messages: [{ role: "system", content: "You are a secondary tutor during a live class. Answer only from the provided live transcript and topic. If the transcript does not contain enough information, say so clearly and ask the learner to wait for the explanation or provide more context. Be concise and educational." }, { role: "user", content: `Current topic: ${message.topic || "not provided"}\n\nLive transcript:\n${message.transcript}\n\nStudent question: ${message.question}` }] }) });
    if (!res.ok) throw new Error(`LLM provider returned HTTP ${res.status}.`); const body = await res.json(); return body.choices?.[0]?.message?.content || "I could not find an answer in the live transcript.";
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.action === "transcribeLiveTutorAudio") { transcribe(base64ToBlob(message.audio, message.mimeType), message.config).then((text) => respond({ success: true, text })).catch((error) => respond({ success: false, error: error.message })); return true; }
    if (message.action === "askLiveTutor") { answer(message).then((answer) => respond({ success: true, answer })).catch((error) => respond({ success: false, error: error.message })); return true; }
  });
})();
