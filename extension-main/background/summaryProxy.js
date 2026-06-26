// ============================================================
// summaryProxy.js — Lecture Summary cache + LLM proxy
// ────────────────────────────────────────────────────────────
// Runs in the service-worker context so it is NOT bound by the
// scaler.com page CSP (connect-src). This lets the content script
// reach the backend summary cache and the user's own LLM endpoint
// without being blocked by the host page.
//
// Handles three actions:
//   checkSummaryCache  — GET  /api/summary?slug=
//   saveSummary        — POST /api/summary/save
//   generateSummary    — POST {baseUrl}/chat/completions (user's key)
// ============================================================

// Base URL for the backend API (toggle for dev / prod)
const SUMMARY_BACKEND_BASE_URL = "https://scalerbackend.vercel.app";
// const SUMMARY_BACKEND_BASE_URL = "http://localhost:3001";

const SUMMARY_EXTENSION_TOKEN =
  "Ritesh-Prajapati-created-started-this-extension-super-secret-key-12345";

// Transcripts can be huge; cap what we send to keep within model context
// limits. ~120k chars ≈ 30k tokens — safe for most modern long-context models.
const SUMMARY_MAX_TRANSCRIPT_CHARS = 120000;

const SUMMARY_SYSTEM_PROMPT = [
  "You are an assistant that summarises a single recorded lecture using its transcript.",
  "Read the transcript and produce a faithful summary. Do NOT invent facts that are not supported by the transcript.",
  "Respond with ONLY a JSON object (no markdown, no prose outside the JSON) with exactly these keys:",
  '  "brief"         — (array of objects) the lecture told as a sequence of concepts, in the order they were taught. Each object is { "title": "<the concept name, e.g. \'Write-Ahead Log (WAL)\'>", "body": "<a detailed, story-telling explanation of this concept in flowing prose (NOT bullet points): definitions, key components, the reasoning, any algorithms / data structures / methods involved, and how it ties into the larger topic. Relate it to real-world applications or examples when relevant. Use multiple paragraphs separated by a blank line.>" }. Cover every significant concept (typically 4-10) so a student who missed the class can read it like a story and understand everything.',
  '  "topics"        — (array of strings) the main topics/concepts taught in the session.',
  '  "notes"         — (array of strings) important points, explanations or takeaways worth remembering.',
  '  "deadlines"     — (array of strings) any deadlines, due dates or time-bound tasks mentioned (include the date/timeframe in the text if stated).',
  '  "announcements" — (array of strings) important announcements, instructions or logistics mentioned by the instructor.',
  'For the array keys, return an empty array if there is nothing, and keep each item short and self-contained. For "brief", return an empty string only if the transcript is unusable.',
].join("\n");

/**
 * Build the chat/completions endpoint from a user-supplied base URL.
 * Accepts either a full endpoint (".../chat/completions") or a base
 * (".../v1" or just the host) and normalises to a full endpoint.
 */
function buildChatCompletionsUrl(baseUrl) {
  let url = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) throw new Error("Base URL is required.");
  if (!/\/chat\/completions$/.test(url)) {
    url += "/chat/completions";
  }
  return url;
}

/**
 * Extract a JSON object from a model response that may be wrapped in
 * code fences or contain leading/trailing prose.
 */
function parseSummaryJson(content) {
  if (!content || typeof content !== "string") {
    throw new Error("Empty response from the model.");
  }

  let text = content.trim();
  // Strip ```json ... ``` / ``` ... ``` fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();

  try {
    return JSON.parse(text);
  } catch (e) {
    // Fall back to the first balanced-looking { ... } block.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Model did not return valid JSON.");
  }
}

/**
 * Normalise an arbitrary parsed object into the fixed summary shape.
 */
function normaliseSummaryShape(raw) {
  const toStringArray = (val) => {
    if (!val) return [];
    if (!Array.isArray(val)) val = [val];
    return val
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .map((v) => v.trim())
      .filter(Boolean);
  };
  const normaliseBrief = (val) => {
    if (!val) return [];
    if (typeof val === "string") {
      const t = val.trim();
      return t ? [{ title: "", body: t }] : [];
    }
    if (!Array.isArray(val)) return [];
    return val
      .map((c) => {
        if (typeof c === "string") return { title: "", body: c.trim() };
        if (c && typeof c === "object") {
          return {
            title: String(c.title || "").trim(),
            body: String(c.body || c.text || "").trim(),
          };
        }
        return null;
      })
      .filter((c) => c && (c.title || c.body));
  };

  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    brief: normaliseBrief(obj.brief),
    topics: toStringArray(obj.topics),
    notes: toStringArray(obj.notes),
    deadlines: toStringArray(obj.deadlines),
    announcements: toStringArray(obj.announcements),
  };
}

/**
 * Call the user's OpenAI-compatible chat/completions endpoint and return
 * a structured summary object.
 */
async function generateSummaryViaLLM({ baseUrl, apiKey, model, transcript }) {
  if (!apiKey || !apiKey.trim()) throw new Error("API key is required.");
  if (!transcript || !transcript.trim()) {
    throw new Error("Transcript is empty.");
  }

  const url = buildChatCompletionsUrl(baseUrl);
  let text = transcript.trim();
  if (text.length > SUMMARY_MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, SUMMARY_MAX_TRANSCRIPT_CHARS);
  }

  // Keep the request minimal for broad OpenAI-compatible support: only the
  // baseUrl/apiKey essentials plus model + messages. No temperature or other
  // tuning params — some models (e.g. gpt-5.5) reject any non-default value.
  const body = {
    model: model && model.trim() ? model.trim() : "gpt-4o-mini",
    messages: [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object" },
  };

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // Some providers reject the response_format param — retry once without it.
    throw new Error(`Request failed: ${e.message}`);
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch (e) {
      /* ignore */
    }
    // Retry once without response_format for providers that don't support it.
    if (res.status === 400 && /response_format/i.test(detail)) {
      delete body.response_format;
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${t || detail}`);
      }
    } else {
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseSummaryJson(content);
  return normaliseSummaryShape(parsed);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Check summary cache ──────────────────────────────────────
  if (message.action === "checkSummaryCache") {
    fetch(
      `${SUMMARY_BACKEND_BASE_URL}/api/summary?slug=${encodeURIComponent(message.slug)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${SUMMARY_EXTENSION_TOKEN}` },
      },
    )
      .then((res) => (res.ok ? res.json() : { cached: false }))
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error("Scaler++: Error checking summary cache", error);
        sendResponse({ success: false, error: error.toString() });
      });
    return true;
  }

  // ── Save summary to cache (first-write-wins on the backend) ──
  if (message.action === "saveSummary") {
    fetch(`${SUMMARY_BACKEND_BASE_URL}/api/summary/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUMMARY_EXTENSION_TOKEN}`,
      },
      body: JSON.stringify({
        slug: message.slug,
        classId: message.classId || "",
        title: message.title || message.slug,
        summary: message.summary,
        model: message.model || "",
        generatedBy: message.generatedBy || "",
      }),
    })
      .then((res) => (res.ok ? res.json() : { success: false }))
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.error("Scaler++: Error saving summary", error);
        sendResponse({ success: false, error: error.toString() });
      });
    return true;
  }

  // ── Generate a summary via the user's own LLM endpoint ───────
  if (message.action === "generateSummary") {
    generateSummaryViaLLM({
      baseUrl: message.baseUrl,
      apiKey: message.apiKey,
      model: message.model,
      transcript: message.transcript,
    })
      .then((summary) => sendResponse({ success: true, summary }))
      .catch((error) => {
        console.error("Scaler++: Error generating summary", error);
        sendResponse({ success: false, error: error.message || String(error) });
      });
    return true;
  }
});
