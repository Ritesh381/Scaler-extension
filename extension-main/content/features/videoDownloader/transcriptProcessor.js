// ============================================================
// transcriptProcessor.js
// Handles client-side transcription using CustomAudioTranscriber
// ============================================================

const logsElem = document.getElementById("logs");
const statusText = document.getElementById("status-text");
const progressBar = document.getElementById("progress-bar");
const chunksText = document.getElementById("progress-chunks");
const percentText = document.getElementById("progress-percent");
const startBtn = document.getElementById("start-btn");
const cacheBtn = document.getElementById("cache-btn");
const btnDivider = document.getElementById("btn-divider");

const providerSelect = document.getElementById("provider-select");
const baseUrlInput = document.getElementById("base-url");
const modelInput = document.getElementById("model-name");
const modelLabel = document.getElementById("model-name-label");
const apiKeyInput = document.getElementById("api-key");
const getKeyLink = document.getElementById("get-key-link");
const modelsLink = document.getElementById("models-link");

const CONCURRENCY = 6;

// ── Backend Cache Config ──
const BACKEND_BASE_URL = "https://scalerbackend.vercel.app";
// const BACKEND_BASE_URL = "http://localhost:3001";
const EXTENSION_TOKEN =
  "Ritesh-Prajapati-created-started-this-extension-super-secret-key-12345";

/**
 * Check the backend transcript cache for cacheKey.
 * Returns { cached: true, text } if found, or { cached: false } if not.
 */
async function checkTranscriptCache(key) {
  if (!key || !key.trim()) return { cached: false };
  try {
    const res = await fetch(
      `${BACKEND_BASE_URL}/api/transcript?slug=${encodeURIComponent(key.trim())}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${EXTENSION_TOKEN}` },
      },
    );
    if (!res.ok) return { cached: false };
    const data = await res.json();
    return data.cached
      ? {
          cached: true,
          text: data.text,
          generatedBy: data.generatedBy || "",
          provider: data.provider || "",
          model: data.model || data.modelName || "",
        }
      : { cached: false };
  } catch (e) {
    console.warn("[Scaler++] Cache lookup failed:", e.message);
    return { cached: false };
  }
}

/**
 * Save a generated transcript to the backend cache.
 * Delegates to the background service worker so the request survives
 * even if this page (transcriptProcessor tab) is closed immediately
 * after the transcript file download begins.
 * Fire-and-forget — never throws.
 */
function saveTranscriptToCache(key, title, text, classId, generatedBy, provider, model, countDownload) {
  if (!key || !text) return;
  try {
    chrome.runtime.sendMessage({
      action: "saveTranscriptToCache",
      slug: key.trim(),
      title: (title || key).trim(),
      text: text.trim(),
      classId: classId ? String(classId).trim() : "",
      generatedBy: generatedBy || "",
      provider: provider || "",
      model: model || "",
      countDownload: countDownload === true,
    });
    console.log("[Scaler++] Transcript save dispatched to background for key:", key);
  } catch (e) {
    console.warn("[Scaler++] Failed to dispatch transcript save:", e.message);
  }
}

/**
 * Resolve the signed-in Scaler++ user email from sync storage.
 * Resolves to "" when unavailable — never rejects.
 */
function getUserEmail() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(["scaler_user"], (result) => {
        resolve(result?.scaler_user?.email || "");
      });
    } catch (_) {
      resolve("");
    }
  });
}

/**
 * After a generation completes, surface a link back to the versions page.
 *
 * Injected rather than baked into the HTML so nothing changes visually until
 * there is actually a new version to compare.
 */
function offerVersionsLink() {
  if (!cacheKey || document.getElementById("versions-link")) return;

  const link = document.createElement("button");
  link.id = "versions-link";
  link.type = "button";
  link.textContent = "Compare all versions of this lecture";
  link.style.cssText =
    "background:#18181b;border:1px solid #27272a;color:#a1a1aa;margin-top:10px;" +
    "font-size:13px;font-weight:600;padding:11px 20px;border-radius:10px;";
  link.addEventListener("click", () => {
    const query = new URLSearchParams({
      url: urlParams.get("url") || "",
      type: "transcript",
      title: videoTitle,
      lectureSlug,
      classId: classId || "",
      sourceTabId: urlParams.get("sourceTabId") || "",
    });
    window.location.href = `transcriptVersions.html?${query.toString()}`;
  });

  startBtn.parentNode.insertBefore(link, startBtn.nextSibling);
}

/**
 * Track completed download to the backend.
 * Fire-and-forget.
 */
function trackCompletedDownload(type, attribution = {}) {
  try {
    chrome.storage.sync.get(["scaler_user"], (result) => {
      const email = result?.scaler_user?.email;
      if (email && chrome.runtime?.id) {
        chrome.runtime.sendMessage({
          action: "trackDownload",
          email,
          downloadType: type,
          lecture: videoTitle || "",
          lectureSlug: cacheKey,
          // "cache" = served from the shared cache, no API call made;
          // "generated" = this download actually invoked the provider.
          source: attribution.source || "",
          provider: attribution.provider || "",
          model: attribution.model || "",
        });
      }
    });
  } catch (_) {
    /* fail silently */
  }
}

/**
 * Validate that the given API key is accepted by the provider.
 *
 * Strategy: each provider exposes a lightweight, read-only endpoint
 * (models list, account info, etc.) that returns 401/403 on a bad key
 * and 200 on a good one — zero transcription credits consumed.
 *
 * Falls back to sending a ~1 KB silent WAV blob for truly custom/unknown URLs
 * to distinguish network errors from auth errors.
 *
 * Returns { ok: true } or { ok: false, reason: string }.
 */
async function validateApiKey(baseUrl, apiKey, modelName) {
  const u = baseUrl.toLowerCase();

  try {
    let res;

    if (u.includes("deepgram.com")) {
      // Deepgram: GET /v1/projects — free account info endpoint
      res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${apiKey}` },
      });
    } else if (u.includes("groq.com")) {
      // Groq: GET /openai/v1/models
      res = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } else if (u.includes("openai.com")) {
      // OpenAI: GET /v1/models
      res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } else if (u.includes("elevenlabs.io")) {
      // ElevenLabs: GET /v1/user
      res = await fetch("https://api.elevenlabs.io/v1/user", {
        headers: { "xi-api-key": apiKey },
      });
    } else {
      // Custom / unknown provider: send a tiny silent WAV (44-byte minimal
      // header + silence) and look only for 401/403 to detect bad keys.
      // Any other status (400 format error, 413 size, etc.) means the key
      // itself is likely fine — we let the real transcription attempt proceed.
      const silentWav = new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0x24,
        0x00,
        0x00,
        0x00, // RIFF....$..
        0x57,
        0x41,
        0x56,
        0x45,
        0x66,
        0x6d,
        0x74,
        0x20, // WAVEfmt
        0x10,
        0x00,
        0x00,
        0x00,
        0x01,
        0x00,
        0x01,
        0x00, // PCM, 1ch
        0x44,
        0xac,
        0x00,
        0x00,
        0x88,
        0x58,
        0x01,
        0x00, // 44100 Hz
        0x02,
        0x00,
        0x10,
        0x00, // blockAlign, bitsPerSample
        0x64,
        0x61,
        0x74,
        0x61,
        0x00,
        0x00,
        0x00,
        0x00, // data chunk (0 bytes)
      ]);
      const formData = new FormData();
      formData.append("model", modelName || "whisper-1");
      formData.append(
        "file",
        new Blob([silentWav], { type: "audio/wav" }),
        "health.wav",
      );

      res = await fetch(baseUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      });

      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch (_) {}
      const detail = bodyText ? ": " + bodyText : "";

      // 401/403 — bad key.
      if (res.status === 401 || res.status === 403) {
        const errorMsg = `HTTP ${res.status}${detail}`;
        log(`❌ API key check failed. Detail: ${errorMsg}`);
        return { ok: false, reason: errorMsg };
      }
      // 404 — the Base URL isn't a real transcription endpoint.
      if (res.status === 404) {
        const errorMsg = `HTTP 404 — endpoint not found. Check the Base URL points to /audio/transcriptions${detail}`;
        log(`❌ ${errorMsg}`);
        return { ok: false, reason: errorMsg };
      }
      // 400 mentioning the model — the model name is rejected by the provider.
      if (res.status === 400 && /\bmodel\b/i.test(bodyText)) {
        const errorMsg = `Model rejected by provider${detail}`;
        log(`❌ ${errorMsg}`);
        return { ok: false, reason: errorMsg };
      }
      // Any other status (e.g. 400 "audio too short" from the silent probe) —
      // the key/URL/model are accepted; let real transcription proceed.
      return { ok: true };
    }

    if (!res.ok) {
      let bodyText = "";
      try {
        bodyText = await res.text();
      } catch (_) {}
      
      const errorMsg = `HTTP ${res.status}${bodyText ? ": " + bodyText : ""}`;
      log(`❌ API key check failed. Detail: ${errorMsg}`);
      
      if (res.status === 401 || res.status === 403) {
        return { ok: false, reason: errorMsg };
      }
      
      // Unexpected server error (like 500, 502) — treat as "key probably fine, let transcription try"
      console.warn(
        `[Scaler++] Health check returned ${errorMsg} — proceeding anyway.`,
      );
    }
    return { ok: true };
  } catch (e) {
    // Network error (CORS on health endpoint, offline, etc.) —
    // don't block the user; let the actual transcription surface the real error.
    console.warn("[Scaler++] API key health check network error:", e.message);
    return { ok: true };
  }
}

/**
 * Synchronous, no-network validation for the "Custom (OpenAI Compatible API)"
 * provider. The named providers auto-fill a correct full endpoint URL, but in
 * custom mode the user types everything by hand — so guard against the common
 * mistakes: an unparseable URL, a base URL that isn't the transcription
 * endpoint (e.g. ".../v1" instead of ".../v1/audio/transcriptions"), and a
 * missing model.
 *
 * Returns { ok: true, warnSuggestedUrl? } or { ok: false, reason: string }.
 * `warnSuggestedUrl` is a soft signal — the caller confirms before proceeding.
 */
function validateCustomInputs(baseUrl, modelName) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (_) {
    return {
      ok: false,
      reason:
        "Base URL is not a valid URL.\nExample: https://api.openai.com/v1/audio/transcriptions",
    };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "Base URL must start with https:// (or http://)." };
  }

  if (!modelName) {
    return {
      ok: false,
      reason:
        "Model Name is required for a custom provider.\nExamples: whisper-1, gpt-4o-mini-transcribe",
    };
  }
  if (/\s/.test(modelName)) {
    return { ok: false, reason: "Model Name must not contain spaces." };
  }

  // OpenAI-compatible transcription lives at /audio/transcriptions. If the path
  // doesn't end there, it's almost certainly a base URL missing the endpoint —
  // surface a suggested fix but let the user override (some proxies differ).
  const result = { ok: true };
  if (!/\/audio\/transcriptions\/?$/.test(parsed.pathname)) {
    result.warnSuggestedUrl =
      parsed.origin + parsed.pathname.replace(/\/+$/, "") + "/audio/transcriptions";
  }
  return result;
}

function log(msg) {
  const p = document.createElement("div");
  p.innerText = `> ${msg}`;
  logsElem.appendChild(p);
  logsElem.scrollTop = logsElem.scrollHeight;
}

// ── Get params from URL ──
const urlParams = new URLSearchParams(window.location.search);
const m3u8Url = urlParams.get("url");
const videoTitle = urlParams.get("title") || "";
const lectureSlug = urlParams.get("lectureSlug") || "";
const classId = urlParams.get("classId") || "";
const sourceTabId = parseInt(urlParams.get("sourceTabId"), 10);
const cacheKey = lectureSlug || videoTitle;

const titleElem = document.getElementById("video-title");
if (titleElem && videoTitle) {
  titleElem.textContent = videoTitle;
  titleElem.style.display = "block";
}

// ── Show the cache button whenever we have a lookup key ──
if (cacheKey) {
  if (cacheBtn) cacheBtn.style.display = "block";
  if (btnDivider) btnDivider.style.display = "flex";
}

if (!m3u8Url) {
  log("Error: No M3U8 URL provided.");
  statusText.innerText = "Error: Invalid Stream Data";
  startBtn.disabled = true;
} else {
  log("Mode: TRANSCRIPT");
  log(`Stream: ${m3u8Url.substring(0, 60)}...`);
}

// ── Cache Button: check cache and download instantly (no API key needed) ──
if (cacheBtn) {
  cacheBtn.addEventListener("click", async () => {
  if (!cacheKey) return;

  cacheBtn.disabled = true;
  startBtn.disabled = true;
  cacheBtn.textContent = "Checking cache...";
  statusText.innerText = "Looking up cached transcript...";
  log("Checking transcript cache...");

  try {
    const cached = await checkTranscriptCache(cacheKey);
    if (cached.cached && cached.text) {
      log("✅ Cache HIT — serving cached transcript.");
      statusText.innerText = "🎉 Loaded from Cache!";
      progressBar.style.width = "100%";
      progressBar.style.background = "#10b981";

      let finalTranscript = cached.text;
      try {
        if (classId) {
          const header = await fetchMetadataHeader(classId, {
            generatedBy: cached.generatedBy,
            provider: cached.provider,
            model: cached.model,
          });
          finalTranscript = header + finalTranscript;
        }
      } catch (e) {
        console.error("[Scaler++] Error adding metadata to cache download:", e);
      }

      const blob = new Blob([finalTranscript], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = getSuggestedName("txt");
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const wordCount = cached.text.split(/\s+/).length;
      log(`📦 ${wordCount} words downloaded from cache.`);
      cacheBtn.textContent = "✅ Downloaded from Cache";
      trackCompletedDownload("transcript", {
        source: "cache",
        provider: cached.provider,
        model: cached.model,
      });
    } else {
      log("Cache MISS — no cached transcript found for this lecture.");
      statusText.innerText = "Not in cache. Use your API key to transcribe.";
      cacheBtn.textContent = "⚡ Check Cache";
      cacheBtn.disabled = false;
      startBtn.disabled = false;
    }
  } catch (err) {
    log(`❌ Cache check error: ${err.message}`);
    statusText.innerText = "Cache check failed.";
    cacheBtn.textContent = "⚡ Check Cache";
    cacheBtn.disabled = false;
    startBtn.disabled = false;
  }
  });
}

// ── Configuration Management ──

const PROVIDER_DEFAULT_MODELS = {
  groq: "whisper-large-v3-turbo",
  deepgram: "nova-3",
  openai: "gpt-transcribe",
  elevenlabs: "scribe_v2",
  custom: "",
};

/**
 * Defaults these providers used to ship with.
 *
 * A stored model that exactly matches an old default was never actually chosen
 * — it was just whatever the field happened to contain — so it gets upgraded to
 * the current default. Anything a user genuinely typed is left alone.
 */
const SUPERSEDED_DEFAULT_MODELS = {
  groq: ["whisper-large-v3"],
  openai: ["whisper-1"],
  elevenlabs: ["scribe_v1"],
};

function upgradeSupersededModel(provider, model) {
  const superseded = SUPERSEDED_DEFAULT_MODELS[provider];
  if (superseded && superseded.includes(model)) {
    return PROVIDER_DEFAULT_MODELS[provider] || model;
  }
  return model;
}

/**
 * Settings are stored PER PROVIDER.
 *
 * Every provider needs its own key, base URL and model, so a single shared set
 * of fields meant switching Groq -> OpenAI -> Groq made you paste the Groq key
 * again. Shape:
 *
 *   { provider: "groq", providers: { groq: {baseUrl, model, apiKey}, ... } }
 *
 * `providerSettings` is the in-memory copy; the picker reads and writes it as
 * you switch, and every change is persisted.
 */
let providerSettings = {};
// The provider the visible fields currently belong to. `change` fires after
// providerSelect.value has already moved, so the old value has to be tracked.
let activeProvider = providerSelect.value;

/** Is this provider still offered in the dropdown? */
function isKnownProvider(provider) {
  return Boolean(
    provider && providerSelect.querySelector(`option[value="${provider}"]`),
  );
}

function saveConfig() {
  providerSettings[activeProvider] = {
    baseUrl: baseUrlInput.value,
    model: modelInput.value,
    apiKey: apiKeyInput.value,
  };

  chrome.storage.local.set(
    {
      scaler_transcript_config: {
        provider: providerSelect.value,
        providers: providerSettings,
      },
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("Config save failed:", chrome.runtime.lastError.message);
      }
    },
  );
}

/** Put a provider's remembered values into the visible fields. */
function applyProviderSettings(provider) {
  const saved = providerSettings[provider] || {};
  const option = providerSelect.querySelector(`option[value="${provider}"]`);
  const defaultUrl = option?.getAttribute("data-url") || "";

  // Custom is the only provider whose URL is the user's to invent.
  baseUrlInput.value = saved.baseUrl || defaultUrl;
  modelInput.value =
    saved.model !== undefined && saved.model !== ""
      ? upgradeSupersededModel(provider, saved.model)
      : PROVIDER_DEFAULT_MODELS[provider] || "";
  apiKeyInput.value = saved.apiKey || "";
  activeProvider = provider;
}

function loadConfig() {
  chrome.storage.local.get(["scaler_transcript_config"], (result) => {
    const config = result.scaler_transcript_config;

    if (config) {
      if (config.providers) {
        providerSettings = config.providers;
      } else if (config.baseUrl || config.model || config.apiKey) {
        // Migrate the old single-slot shape onto whichever provider it belonged
        // to, so nobody has to re-enter a key they already had.
        providerSettings = {
          [config.provider || providerSelect.value]: {
            baseUrl: config.baseUrl || "",
            model: config.model || "",
            apiKey: config.apiKey || "",
          },
        };
      }
      // Only select a provider that still exists. A stored value for a
      // provider that has since been removed leaves selectedIndex at -1, and
      // every read of providerSelect.options[selectedIndex] then throws —
      // taking the whole config block down and bricking the page.
      if (config.provider && isKnownProvider(config.provider)) {
        providerSelect.value = config.provider;
      } else if (config.provider) {
        console.warn(
          `[Scaler++] Stored provider "${config.provider}" no longer exists — falling back to ${providerSelect.value}.`,
        );
      }
    }

    applyProviderSettings(providerSelect.value);
    updateProviderLink(false);
  });
}

function updateProviderLink(applySaved = true) {
  if (providerSelect.selectedIndex < 0) providerSelect.selectedIndex = 0;
  const selectedOption = providerSelect.options[providerSelect.selectedIndex];
  if (!selectedOption) return;
  const url = selectedOption.getAttribute("data-url");
  const link = selectedOption.getAttribute("data-link");
  const modelsUrl = selectedOption.getAttribute("data-models");

  // Switching provider restores that provider's own key/model/URL rather than
  // resetting to the default and discarding what worked last time.
  if (applySaved) {
    applyProviderSettings(providerSelect.value);
  } else if (providerSelect.value !== "custom" && url && !baseUrlInput.value) {
    baseUrlInput.value = url;
  }

  const defaultModel = PROVIDER_DEFAULT_MODELS[providerSelect.value];
  const hasModel = defaultModel !== undefined && defaultModel !== "";

  if (hasModel || providerSelect.value === "custom") {
    modelInput.style.display = "block";
    if (modelLabel) modelLabel.style.display = "block";
  } else {
    modelInput.style.display = "none";
    if (modelLabel) modelLabel.style.display = "none";
  }

  if (link) {
    getKeyLink.href = link;
    getKeyLink.innerText = `Get API Key for ${selectedOption.text.split(" (")[0]}`;
    getKeyLink.style.display = "inline-block";
  } else {
    getKeyLink.style.display = "none";
  }

  if (modelsLink) {
    if (modelsUrl) {
      modelsLink.href = modelsUrl;
      modelsLink.style.display = "inline-block";
    } else {
      modelsLink.style.display = "none";
    }
  }

  saveConfig();
}

providerSelect.addEventListener("change", () => {
  // Persist the fields under the provider they belong to BEFORE switching away.
  saveConfig();
  updateProviderLink(true);
});
baseUrlInput.addEventListener("input", saveConfig);
modelInput.addEventListener("input", saveConfig);
apiKeyInput.addEventListener("input", saveConfig);

// Toggle API Key visibility
const toggleApiKeyBtn = document.getElementById("toggle-api-key-btn");
if (toggleApiKeyBtn) {
  const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
  const EYE_OFF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

  toggleApiKeyBtn.addEventListener("click", () => {
    if (apiKeyInput.type === "password") {
      apiKeyInput.type = "text";
      toggleApiKeyBtn.innerHTML = EYE_OFF_SVG;
    } else {
      apiKeyInput.type = "password";
      toggleApiKeyBtn.innerHTML = EYE_SVG;
    }
  });
}

// Initialize config
loadConfig();

// ── M3U8 Download Helpers ──

async function fetchText(url) {
  if (sourceTabId && !isNaN(sourceTabId)) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        sourceTabId,
        { action: "FETCH_PROXY", url, type: "text" },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("Proxy error:", chrome.runtime.lastError);
            fetch(url)
              .then((res) => res.text())
              .then(resolve)
              .catch(reject);
          } else if (response && response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response?.error || "Proxy fetch failed"));
          }
        },
      );
    });
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return relative;
  }
}

function getMediaPlaylistUrl(masterText, baseUrl) {
  const lines = masterText.split("\n").map((l) => l.trim());
  if (!lines[0].startsWith("#EXTM3U")) throw new Error("Invalid M3U8 format");
  if (lines.some((l) => l.startsWith("#EXTINF"))) return baseUrl;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA") && line.includes("TYPE=AUDIO")) {
      const match = line.match(/URI="([^"]+)"/);
      if (match && match[1]) {
        return resolveUrl(baseUrl, match[1]);
      }
    }
  }

  let bestBandwidth = 0;
  let bestUrl = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      if (bwMatch) {
        const bw = parseInt(bwMatch[1], 10);
        if (bw > bestBandwidth) {
          bestBandwidth = bw;
          for (let j = i + 1; j < lines.length; j++) {
            if (lines[j] && !lines[j].startsWith("#")) {
              bestUrl = lines[j];
              break;
            }
          }
        }
      }
    }
  }

  if (bestUrl) return resolveUrl(baseUrl, bestUrl);
  const fallback = lines.find((l) => l && !l.startsWith("#"));
  if (fallback) return resolveUrl(baseUrl, fallback);
  throw new Error("No media streams found.");
}

function extractSegments(mediaText, baseUrl) {
  const lines = mediaText.split("\n").map((l) => l.trim());
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXTINF")) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith("#")) {
          segments.push(resolveUrl(baseUrl, lines[j]));
          break;
        }
      }
    }
  }
  return segments;
}

async function fetchChunk(url, index) {
  for (let retry = 0; retry < 3; retry++) {
    try {
      if (sourceTabId && !isNaN(sourceTabId)) {
        const response = await new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(
            sourceTabId,
            { action: "FETCH_PROXY", url, type: "binary" },
            (resp) => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
              } else if (resp && resp.success) {
                resolve(resp.data);
              } else {
                reject(new Error(resp?.error || "Proxy fetch failed"));
              }
            },
          );
        });

        const uint8 = new Uint8Array(response);
        return uint8.buffer;
      } else {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      }
    } catch (e) {
      if (retry < 2)
        await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
    }
  }
  return null;
}

// downloadSegments returns the raw per-segment audio Uint8Arrays in order.
// For small lectures these are combined later; for large ones the transcriber
// processes them in batches so the browser never chokes on one giant buffer.
async function downloadSegments(segments, audioExtractor) {
  const total = segments.length;
  let nextToFetch = 0;
  let nextToWrite = 0;
  const buffer = new Map();
  const audioSegments = []; // one Uint8Array per TS segment
  let fetchFailures = 0;
  let extractedBytes = 0;

  function updateUI(written) {
    const pct = ((written / total) * 100).toFixed(1);
    progressBar.style.width = pct + "%";
    chunksText.innerText = `${written} / ${total} chunks`;
    percentText.innerText = `${pct}%`;
  }

  function flush() {
    while (buffer.has(nextToWrite)) {
      const data = buffer.get(nextToWrite);
      buffer.delete(nextToWrite);
      // Keep even empty Uint8Arrays so indices stay aligned
      audioSegments.push(data && data.byteLength > 0 ? data : new Uint8Array(0));
      nextToWrite++;
      updateUI(nextToWrite);
    }
  }

  async function worker() {
    while (true) {
      const idx = nextToFetch++;
      if (idx >= total) break;
      const raw = await fetchChunk(segments[idx], idx);

      // fetchChunk returns null after exhausting retries. Without this line a
      // whole lecture of 403s looks identical to a decode failure downstream.
      if (!raw) {
        fetchFailures++;
        if (fetchFailures <= 5) {
          log(`⚠ Chunk ${idx + 1} FETCH FAILED (null) — ${segments[idx]}`);
        }
      }

      const processed = raw ? audioExtractor.extract(raw) : new Uint8Array(0);

      // Sample the first few chunks: fetched vs extracted byte counts plus the
      // leading bytes identify the container (0x47 = MPEG-TS, ftyp/styp = fMP4,
      // neither = encrypted or unknown).
      if (idx < 3 && raw) {
        const hex = (buf) =>
          [...new Uint8Array(buf).slice(0, 16)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ");
        // ADTS frames start with sync word 0xFFF (ff f1 / ff f9). Anything else
        // here means decodeAudioData will reject the payload.
        const first = processed[0];
        const second = processed[1];
        const isAdts = first === 0xff && (second & 0xf0) === 0xf0;
        const st = audioExtractor.audioStreamType;
        log(
          `Chunk ${idx + 1}: fetched ${raw.byteLength}B, extracted ${processed.byteLength}B, head=${hex(raw)}`,
        );
        log(
          `Chunk ${idx + 1}: streamType=${st === null ? "none" : "0x" + st.toString(16)}, ` +
            `audioPid=${audioExtractor.audioPid}, ADTS=${isAdts ? "yes" : "NO"}, ` +
            `extractedHead=${hex(processed)}`,
        );
      }

      extractedBytes += processed.byteLength;
      buffer.set(idx, processed);
      flush();
    }
  }

  log(`Downloading audio (${CONCURRENCY}x parallel)...`);
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  flush();

  if (fetchFailures > 5) {
    log(`⚠ ...and ${fetchFailures - 5} more chunk fetch failures (${fetchFailures}/${total} total).`);
  }
  log(
    `Audio extracted: ${(extractedBytes / 1024 / 1024).toFixed(2)} MB from ${total} segment(s)` +
      (fetchFailures > 0 ? ` — ${fetchFailures} fetch failure(s).` : "."),
  );
  if (extractedBytes === 0) {
    log(
      fetchFailures === total
        ? "❌ Every segment fetch failed — this is an auth/URL problem, not an audio problem."
        : "❌ Segments downloaded but 0 audio bytes extracted — segments are not MPEG-TS AAC (see head= bytes above).",
    );
  }

  return audioSegments;
}

function getSuggestedName(ext) {
  if (videoTitle) {
    const slug = videoTitle
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 80)
      .replace(/_+$/, "");
    if (slug) return `${slug}.${ext}`;
  }
  return `Scaler_Lecture.${ext}`;
}

// ── Main Flow ──

startBtn.addEventListener("click", async () => {
  const baseUrl = baseUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const modelName = modelInput.value.trim();

  if (!baseUrl || !apiKey) {
    alert("Please provide both Base URL and API Key.");
    return;
  }

  // Custom provider is hand-entered — validate URL/endpoint/model before we
  // burn time downloading audio only to fail on a malformed request.
  if (providerSelect.value === "custom") {
    const v = validateCustomInputs(baseUrl, modelName);
    if (!v.ok) {
      alert(v.reason);
      return;
    }
    if (
      v.warnSuggestedUrl &&
      !confirm(
        "This Base URL doesn't look like an OpenAI-compatible transcription " +
          'endpoint (expected it to end in "/audio/transcriptions").\n\n' +
          `Did you mean:\n${v.warnSuggestedUrl}\n\n` +
          "Continue with the URL exactly as entered?",
      )
    ) {
      baseUrlInput.value = v.warnSuggestedUrl;
      saveConfig();
      statusText.innerText = "Base URL updated — press Start Transcription again.";
      return;
    }
  }

  try {
    startBtn.disabled = true;
    if (cacheBtn) cacheBtn.disabled = true;

    // Disable inputs during processing
    providerSelect.disabled = true;
    baseUrlInput.disabled = true;
    modelInput.disabled = true;
    apiKeyInput.disabled = true;

    // ── STEP 1: API Key Health Check ────────────────────────────
    log("Step 1/3: Validating API key...");
    statusText.innerText = "Step 1/3: Validating API key...";
    const health = await validateApiKey(baseUrl, apiKey, modelName);
    if (!health.ok) {
      log(`❌ API key invalid: ${health.reason}`);
      statusText.innerText = `❌ API Key Error: ${health.reason}`;
      // Re-enable inputs so user can fix the key
      providerSelect.disabled = false;
      baseUrlInput.disabled = false;
      modelInput.disabled = false;
      apiKeyInput.disabled = false;
      startBtn.disabled = false;
      if (cacheBtn) cacheBtn.disabled = false;
      return;
    }
    log("✅ API key validated successfully.");
    // ───────────────────────────────────────────────────────────

    // ── STEP 2: Download audio ──────────────────────────────────
    statusText.innerText = "Step 2/3: Downloading audio...";
    const masterText = await fetchText(m3u8Url);
    const mediaPlaylistUrl = getMediaPlaylistUrl(masterText, m3u8Url);
    const mediaText = await fetchText(mediaPlaylistUrl);
    const segments = extractSegments(mediaText, mediaPlaylistUrl);

    if (segments.length === 0) throw new Error("0 segments found.");

    // TSAudioExtractor only understands MPEG-TS. These two tags mean the
    // segments are a format it will silently return 0 bytes for, so surface it
    // here rather than letting it look like a decode failure 400 chunks later.
    if (/#EXT-X-MAP/.test(mediaText)) {
      log("⚠ Playlist has EXT-X-MAP — fMP4 segments, TS demuxer will not work.");
    }
    if (/#EXT-X-KEY:(?!METHOD=NONE)/.test(mediaText)) {
      log("⚠ Playlist encrypted (EXT-X-KEY) — decryption not implemented.");
    }

    const audioExtractor = new TSAudioExtractor();
    // Download all segments as individual buffers (not one combined blob).
    // This prevents the browser from choking on a single massive ArrayBuffer
    // for long lectures (700+ segments / 3.5 hrs).
    const audioSegments = await downloadSegments(segments, audioExtractor);

    progressBar.style.width = "0%";
    chunksText.innerText = "—";
    percentText.innerText = "0%";

    statusText.innerText = "Step 3/3: Transcribing via your API...";

    const transcriber = new CustomAudioTranscriber(
      baseUrl,
      apiKey,
      modelName,
      log,
    );

    const startTime = Date.now();
    const transcribeResult = await transcriber.transcribeFromSegments(
      audioSegments,
      (pct, current, total) => {
        progressBar.style.width = pct.toFixed(1) + "%";
        chunksText.innerText = `${current} / ${total} segments`;
        percentText.innerText = `${pct.toFixed(1)}%`;
      },
    );

    const transcript = transcribeResult.text;
    const hasFailures = transcribeResult.hasFailures;

    if (!transcript || transcript.trim().length === 0) {
      throw new Error(
        "Transcription produced no text. Audio may be silent or unsupported.",
      );
    }

    // Save locally
    const userEmail = await getUserEmail();
    let finalTranscript = transcript;
    try {
      if (classId) {
        const header = await fetchMetadataHeader(classId, {
          generatedBy: userEmail,
          provider: providerSelect.value,
          model: modelName,
        });
        finalTranscript = header + finalTranscript;
      }
    } catch (e) {
      console.error("[Scaler++] Error adding metadata to generated download:", e);
    }

    const blob = new Blob([finalTranscript], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = getSuggestedName("txt");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const wordCount = transcript.split(/\s+/).length;
    log(`✅ Transcript saved! ${wordCount} words in ${elapsed} min.`);
    statusText.innerText = `🎉 Transcript Complete! (${wordCount} words, ${elapsed} min)`;
    progressBar.style.width = "100%";
    progressBar.style.background = "#10b981";

    // ── Save to backend cache via background worker (fire-and-forget) ─────
    if (cacheKey) {
      if (!hasFailures) {
        log("Saving transcript to cache for future use...");
        // Hand off to the service worker, which outlives this page context.
        saveTranscriptToCache(
          cacheKey,
          videoTitle,
          transcript,
          classId,
          userEmail,
          providerSelect.value,
          modelName,
          // The file was handed to the user a few lines above, so this counts.
          true,
        );
      } else {
        log("Skipping cache save: Some chunks failed to transcribe.");
      }
    }
    // ─────────────────────────────────────────────────────────

    // Track
    trackCompletedDownload("transcript", {
      source: "generated",
      provider: providerSelect.value,
      model: modelName,
    });

    // Offer a way back to the versions list. The transcript just generated is
    // now one version among however many others exist, and comparing them is
    // the whole point of keeping them all.
    offerVersionsLink();
  } catch (err) {
    log(`❌ Error: ${err.message}`);
    console.error(err);
    statusText.innerText = "Transcript Failed!";
    progressBar.style.background = "#ef4444";
  } finally {
    startBtn.disabled = false;
    if (cacheBtn) cacheBtn.disabled = false;
    providerSelect.disabled = false;
    baseUrlInput.disabled = false;
    modelInput.disabled = false;
    apiKeyInput.disabled = false;
  }
});

async function fetchMetadataHeader(classId, attribution = {}) {
  if (!classId) return "";
  
  let courseName = "N/A";
  let title = "N/A";
  let startTime = "N/A";
  let duration = "N/A";

  try {
    const [sessionRes, metaRes] = await Promise.allSettled([
      fetch(`https://www.scaler.com/api/v2/classroom/${classId}/session`, { credentials: "include" }),
      fetch(`https://www.scaler.com/api/v2/classroom/${classId}/meta`, { credentials: "include" })
    ]);

    if (sessionRes.status === "fulfilled" && sessionRes.value.ok) {
      try {
        const sessionJson = await sessionRes.value.json();
        const batchLesson = sessionJson?.data?.attributes?.batch_lesson;
        if (batchLesson) {
          title = batchLesson.title || "N/A";
          startTime = batchLesson.start_time || "N/A";
          duration = batchLesson.duration || "N/A";
        }
      } catch (e) {
        console.error("[Scaler++] Error parsing session metadata:", e);
      }
    }

    if (metaRes.status === "fulfilled" && metaRes.value.ok) {
      try {
        const metaJson = await metaRes.value.json();
        courseName = metaJson?.data?.attributes?.academy_module?.name || "N/A";
      } catch (e) {
        console.error("[Scaler++] Error parsing meta metadata:", e);
      }
    }
  } catch (err) {
    console.error("[Scaler++] Error fetching classroom metadata:", err);
  }

  // Format Start Time
  let formattedStartTime = startTime;
  if (startTime && startTime !== "N/A") {
    try {
      const date = new Date(startTime);
      if (!isNaN(date.getTime())) {
        formattedStartTime = date.toLocaleString();
      }
    } catch (e) {}
  }

  // Format Duration
  let formattedDuration = duration;
  if (typeof duration === "number") {
    formattedDuration = `${duration} minutes`;
  } else if (duration && duration !== "N/A") {
    formattedDuration = `${duration} minutes`;
  }

  // Attribution: who generated the transcript and with what. Older cached
  // transcripts predate these fields, so fall back to N/A rather than omitting
  // the lines — keeps the header shape stable across downloads.
  const generatedBy = attribution.generatedBy || "N/A";
  const modelUsed = [attribution.provider, attribution.model]
    .filter(Boolean)
    .join(", ") || "N/A";

  return `Course Name: ${courseName}\n` +
         `Lecture Title: ${title}\n` +
         `Start Time: ${formattedStartTime}\n` +
         `Duration: ${formattedDuration}\n` +
         `Generated by: ${generatedBy}\n` +
         `Model use: ${modelUsed}\n` +
         `Downloaded via: Scaler++ Chrome Extension\n` +
         `Developer: Ritesh prajapati\n\n` +
         `==================================================\n\n`;
}
