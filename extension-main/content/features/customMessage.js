/**
 * Checks for custom messages from Scaler++ backend and injects them into the header.
 *
 * The cached profile email (chrome.storage.sync -> scaler_user, written by
 * usernameTracker.js) is forwarded so the backend can return audience-targeted
 * messages (specific batch / email domain / individual user). With no cached
 * email yet, the backend replies with broadcast messages only.
 */

async function initCustomMessages() {
  try {
    chrome.storage.sync.get(["scaler_user"], (result) => {
      if (chrome.runtime.lastError || !chrome.runtime?.id) return;

      const email = result?.scaler_user?.email || null;
      fetchCustomMessages(email);
    });
  } catch (error) {
    console.error("Scaler++: Error initializing custom messages fetch", error);
  }
}

function fetchCustomMessages(email) {
  chrome.runtime.sendMessage(
    { action: "fetchCustomMessages", email },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error(
          "Scaler++: Error connecting to background script",
          chrome.runtime.lastError,
        );
        return;
      }

      if (
        response &&
        response.success &&
        response.data &&
        response.data.length > 0
      ) {
        processMessages(response.data);
      }
    },
  );
}

function processMessages(messages) {
  chrome.storage.local.get(["dismissed_message_ids"], (result) => {
    let dismissedIds = result.dismissed_message_ids || {};

    for (let msg of messages) {
      // If it's a one-time message and already clicked/dismissed, skip it
      if (msg.one_time && dismissedIds[msg.id]) {
        continue;
      }

      // We found the highest priority valid message to show.
      injectCustomMessage(msg, dismissedIds);
      break;
    }
  });
}

function injectCustomMessage(msgData, dismissedIds) {
  // Wait for the header to be ready
  const checkInterval = setInterval(() => {
    // The logo section
    const logoArea = document.querySelector(
      "._3waiogKHpNpMjAh8o5lc2v > .e7ge61UPj54Me37pqU2Rd",
    );

    if (logoArea && logoArea.parentNode) {
      clearInterval(checkInterval);

      // Check if we already injected
      if (document.getElementById("scaler-custom-msg-container")) return;

      const msgContainer = document.createElement("div");
      msgContainer.id = "scaler-custom-msg-container";

      msgContainer.style.display = "flex";
      msgContainer.style.alignItems = "center";
      msgContainer.style.justifyContent = "center";
      msgContainer.style.padding = "4px 12px";
      msgContainer.style.fontSize = "20px";
      msgContainer.style.position = "relative";

      msgContainer.innerHTML = msgData.msg;

      // Insert between Logo Area and Stats Area
      // The parent is `._3waiogKHpNpMjAh8o5lc2v`
      logoArea.parentNode.insertBefore(msgContainer, logoArea.nextSibling);

      // Handle interactions
      const markAsDismissed = () => {
        msgContainer.style.display = "none";
        if (msgData.one_time) {
          dismissedIds[msgData.id] = true;
          chrome.storage.local.set({ dismissed_message_ids: dismissedIds });
        }
      };

      // If user clicks a link inside the injected HTML, mark as interactive
      const links = msgContainer.querySelectorAll("a");
      links.forEach((link) => {
        link.addEventListener("click", markAsDismissed);
      });

      // ── Wire up interactive buttons ────────────────────
      // Any <button> with data-action-endpoint will be treated
      // as an interactive action button.
      const actionButtons = msgContainer.querySelectorAll(
        "button[data-action-endpoint]",
      );

      actionButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const endpoint = btn.dataset.actionEndpoint;
          const method = btn.dataset.actionMethod || "POST";
          let body = null;

          try {
            body = btn.dataset.actionPayload
              ? JSON.parse(btn.dataset.actionPayload)
              : null;
          } catch (e) {
            console.error("Scaler++: Invalid JSON in data-action-payload", e);
          }

          // Disable button to prevent double-clicks
          btn.disabled = true;
          btn.style.opacity = "0.6";

          chrome.runtime.sendMessage(
            {
              action: "proxyButtonClick",
              endpoint,
              method,
              body,
            },
            (response) => {
              if (chrome.runtime.lastError) {
                console.error(
                  "Scaler++: Error proxying button click",
                  chrome.runtime.lastError,
                );
                btn.disabled = false;
                btn.style.opacity = "1";
                return;
              }

              console.log("Scaler++: Button action response", response);

              // Re-enable in case user wants to click again
              btn.disabled = false;
              btn.style.opacity = "1";

              // Dismiss the message if the button asks for it
              if (btn.hasAttribute("data-action-dismiss")) {
                markAsDismissed();
              }
            },
          );
        });
      });
    }
  }, 500);

  // Stop checking after 10 seconds if header never loads
  setTimeout(() => clearInterval(checkInterval), 10000);
}
