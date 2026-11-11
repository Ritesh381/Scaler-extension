// ============================================================
// transcriptProviderConfig.js
// The speech-to-text provider fields — provider, base URL, model, API key —
// and their persistence. Shared by the transcript page and the bulk download
// page so both show the same fields and read/write the same saved settings
// (the bulk page's background transcript tabs start from whatever was saved).
// Styles: transcriptProviderConfig.css.
// ============================================================

const TRANSCRIPT_CONFIG_KEY = "scaler_transcript_config";

const TRANSCRIPT_PROVIDERS = [
  {
    id: "groq",
    label: "Groq (Recommended)",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    keyLink: "https://console.groq.com/keys",
    modelsLink: "https://console.groq.com/docs/models",
  },
  {
    id: "deepgram",
    label: "Deepgram",
    url: "https://api.deepgram.com/v1/listen",
    keyLink: "https://console.deepgram.com/",
    modelsLink: "https://developers.deepgram.com/docs/models-languages-overview",
  },
  {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1/audio/transcriptions",
    keyLink: "https://platform.openai.com/api-keys",
    modelsLink: "https://platform.openai.com/docs/models",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    url: "https://api.elevenlabs.io/v1/speech-to-text",
    keyLink: "https://elevenlabs.io/api",
    modelsLink: "https://elevenlabs.io/docs/overview/models",
  },
  { id: "custom", label: "Custom (OpenAI Compatible API)", url: "", keyLink: "", modelsLink: "" },
];

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

const PROVIDER_EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const PROVIDER_EYE_OFF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;

/**
 * Render the provider fields into `container` (given the
 * `config-section` class), restore the saved settings, and keep them saved as
 * they change.
 *
 * Settings are stored PER PROVIDER. Every provider needs its own key, base URL
 * and model, so a single shared set of fields meant switching Groq -> OpenAI ->
 * Groq made you paste the Groq key again. Shape:
 *
 *   { provider: "groq", providers: { groq: {baseUrl, model, apiKey}, ... } }
 *
 * @param {HTMLElement} container
 * @param {{onLoaded?: () => void}} [opts] onLoaded runs once the saved
 *   settings are in the fields (always after this call returns)
 * @returns {{select, baseUrlInput, modelInput, apiKeyInput, save: () => void,
 *   values: () => {provider: string, baseUrl: string, model: string, apiKey: string}}}
 */
function mountProviderConfig(container, { onLoaded } = {}) {
  container.classList.add("config-section");
  container.innerHTML = `
    <label for="provider-select">Service Provider (Suggestion):</label>
    <select id="provider-select"></select>

    <a id="get-key-link" class="service-link" target="_blank"></a>
    <a id="models-link" class="service-link" target="_blank">Browse available models</a>

    <label for="base-url">Base URL:</label>
    <input type="text" id="base-url" placeholder="https://api.groq.com/openai/v1/audio/transcriptions" />

    <label id="model-name-label" for="model-name">Model Name:</label>
    <input type="text" id="model-name" placeholder="e.g. whisper-1" />

    <label for="api-key">API Key:</label>
    <div class="api-key-container">
      <input type="password" id="api-key" placeholder="Enter your API Key" />
      <button type="button" id="toggle-api-key-btn" class="toggle-api-key-btn" title="Toggle visibility">${PROVIDER_EYE_SVG}</button>
    </div>

    <p class="privacy-note">🔒 Your data remains on your browser and is never sent to any third-party servers by this
      extension.</p>`;

  const $ = (id) => container.querySelector(`#${id}`);
  const select = $("provider-select");
  const baseUrlInput = $("base-url");
  const modelInput = $("model-name");
  const modelLabel = $("model-name-label");
  const apiKeyInput = $("api-key");
  const keyLink = $("get-key-link");
  const modelsLink = $("models-link");
  const toggleKeyBtn = $("toggle-api-key-btn");

  for (const p of TRANSCRIPT_PROVIDERS) {
    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = p.label;
    select.appendChild(option);
  }
  const providerInfo = (id) => TRANSCRIPT_PROVIDERS.find((p) => p.id === id);

  // `providerSettings` is the in-memory copy; the picker reads and writes it
  // as you switch, and every change is persisted.
  let providerSettings = {};
  // The provider the visible fields currently belong to. `change` fires after
  // select.value has already moved, so the old value has to be tracked.
  let activeProvider = select.value;

  function save() {
    providerSettings[activeProvider] = {
      baseUrl: baseUrlInput.value,
      model: modelInput.value,
      apiKey: apiKeyInput.value,
    };
    chrome.storage.local.set(
      { [TRANSCRIPT_CONFIG_KEY]: { provider: select.value, providers: providerSettings } },
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
    // Custom is the only provider whose URL is the user's to invent.
    baseUrlInput.value = saved.baseUrl || providerInfo(provider)?.url || "";
    modelInput.value =
      saved.model !== undefined && saved.model !== ""
        ? upgradeSupersededModel(provider, saved.model)
        : PROVIDER_DEFAULT_MODELS[provider] || "";
    apiKeyInput.value = saved.apiKey || "";
    activeProvider = provider;
  }

  function updateProviderLinks(applySaved = true) {
    if (select.selectedIndex < 0) select.selectedIndex = 0;
    const info = providerInfo(select.value) || {};

    // Switching provider restores that provider's own key/model/URL rather
    // than resetting to the default and discarding what worked last time.
    if (applySaved) {
      applyProviderSettings(select.value);
    } else if (select.value !== "custom" && info.url && !baseUrlInput.value) {
      baseUrlInput.value = info.url;
    }

    const defaultModel = PROVIDER_DEFAULT_MODELS[select.value];
    const showModel = (defaultModel !== undefined && defaultModel !== "") || select.value === "custom";
    modelInput.style.display = showModel ? "block" : "none";
    modelLabel.style.display = showModel ? "block" : "none";

    if (info.keyLink) {
      keyLink.href = info.keyLink;
      keyLink.innerText = `Get API Key for ${info.label.split(" (")[0]}`;
      keyLink.style.display = "inline-block";
    } else {
      keyLink.style.display = "none";
    }
    if (info.modelsLink) {
      modelsLink.href = info.modelsLink;
      modelsLink.style.display = "inline-block";
    } else {
      modelsLink.style.display = "none";
    }
    save();
  }

  function load() {
    chrome.storage.local.get([TRANSCRIPT_CONFIG_KEY], (result) => {
      const config = result[TRANSCRIPT_CONFIG_KEY];
      if (config) {
        if (config.providers) {
          providerSettings = config.providers;
        } else if (config.baseUrl || config.model || config.apiKey) {
          // Migrate the old single-slot shape onto whichever provider it
          // belonged to, so nobody has to re-enter a key they already had.
          providerSettings = {
            [config.provider || select.value]: {
              baseUrl: config.baseUrl || "",
              model: config.model || "",
              apiKey: config.apiKey || "",
            },
          };
        }
        // Only select a provider that still exists: a stored value for a
        // removed provider would leave selectedIndex at -1.
        if (config.provider && providerInfo(config.provider)) {
          select.value = config.provider;
        } else if (config.provider) {
          console.warn(
            `[Scaler++] Stored provider "${config.provider}" no longer exists — falling back to ${select.value}.`,
          );
        }
      }
      applyProviderSettings(select.value);
      updateProviderLinks(false);
      if (onLoaded) onLoaded();
    });
  }

  select.addEventListener("change", () => {
    // Persist the fields under the provider they belong to BEFORE switching away.
    save();
    updateProviderLinks(true);
  });
  baseUrlInput.addEventListener("input", save);
  modelInput.addEventListener("input", save);
  apiKeyInput.addEventListener("input", save);
  toggleKeyBtn.addEventListener("click", () => {
    const show = apiKeyInput.type === "password";
    apiKeyInput.type = show ? "text" : "password";
    toggleKeyBtn.innerHTML = show ? PROVIDER_EYE_OFF_SVG : PROVIDER_EYE_SVG;
  });

  // After the caller has its handles (and its own setup) in place.
  setTimeout(load, 0);

  return {
    select,
    baseUrlInput,
    modelInput,
    apiKeyInput,
    save,
    values: () => ({
      provider: select.value,
      baseUrl: baseUrlInput.value.trim(),
      model: modelInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
    }),
  };
}
