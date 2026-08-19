# 🤝 Contributing to Scaler++

Thanks for your interest in contributing to **Scaler++**! Whether you're fixing a bug, adding a feature, or improving docs — every contribution helps the Scaler community.

---

## 📋 Table of Contents

- [Getting Started](#-getting-started)
- [Project Structure](#-project-structure)
- [Development Workflow](#-development-workflow)
- [Loading the Extension Locally](#-loading-the-extension-locally)
- [Making Changes](#-making-changes)
- [Keeping Docs Updated](#-keeping-docs-updated)
- [Submitting a Pull Request](#-submitting-a-pull-request)
- [Code Guidelines](#-code-guidelines)
- [Chrome Web Store Review Timeline](#-chrome-web-store-review-timeline)

---

## 🚀 Getting Started

### Prerequisites

- **Google Chrome** (or any Chromium-based browser like Brave, Edge, etc.)
- A **Scaler account** to test features on `scaler.com`

### Fork & Clone

1. **Fork** this repository by clicking the **Fork** button on GitHub.
2. **Clone** your fork locally:

   ```bash
   git clone https://github.com/<your-username>/Scaler-DOM-Cleaner.git
   cd Scaler-DOM-Cleaner
   ```

3. Add the upstream remote so you can stay in sync:

   ```bash
   git remote add upstream https://github.com/Ritesh381/Scaler-DOM-Cleaner.git
   ```

> **Note:** This is a pure Chrome Extension project — there is **no `npm install`** or build step required. The source files run directly in the browser.

---

## 🏗️ Project Structure

```
Scaler-DOM-Cleaner/
├── README.md
├── CONTRIBUTING.md
├── .gitignore
├── extension-main/              ← The actual Chrome extension
│   ├── manifest.json            ← Extension manifest (Manifest V3)
│   ├── popup.html               ← Popup UI
│   ├── popup.css                ← Popup styles
│   ├── popup.js                 ← Popup logic & settings management
│   ├── icons/                   ← Extension icons
│   ├── background/              ← Background service worker
│   │   ├── background.js        ← Service worker entry point
│   │   ├── companionBypass.js   ← Smart Companion Bypass logic
│   │   ├── leetcodeLink.js      ← LeetCode search & verification
│   │   └── videoTracker.js      ← M3U8 stream capture
│   └── content/                 ← Content scripts (injected into scaler.com)
│       ├── content.js           ← Entry point & message handler
│       ├── core/                ← Settings, style injection, URL observation
│       ├── cleaner/             ← DOM cleaner engine, selectors, handlers
│       ├── features/            ← Feature modules
│       │   ├── videoDownloader/ ← Lecture download & transcription
│       │   ├── problemSearch.js
│       │   ├── practiceMode.js
│       │   ├── leetcodeLink.js
│       │   ├── joinClassButton.js
│       │   └── subjectSort.js
│       └── utils/               ← Shared utilities (DOM helpers, string utils)
└── addons-reference/            ← Reference/addon code (not part of main extension)
```

---

## 🔧 Loading the Extension Locally

Since this is a Manifest V3 Chrome extension, you can load it directly into Chrome for development:

1. Open Chrome and navigate to:

   ```
   chrome://extensions
   ```

2. Enable **Developer mode** using the toggle in the top-right corner.

3. Click **"Load unpacked"**.

4. Select the **`extension-main`** folder (not the root of the repo — the `extension-main/` subdirectory).

5. The extension icon should now appear in your toolbar. Pin it for easy access.

### Reloading After Changes

- **Content scripts & popup changes:** Click the 🔄 refresh icon on the extension card at `chrome://extensions`, then **reload the Scaler tab** (`Cmd+R` / `Ctrl+R`).
- **Background service worker changes:** Click the 🔄 refresh icon on the extension card. The service worker restarts automatically.
- **`manifest.json` changes:** You **must** click 🔄 refresh on the extension card. Chrome re-reads the manifest only on reload.

> 💡 **Tip:** Keep `chrome://extensions` open in a separate tab for quick reloads while developing.

---

## ✏️ Making Changes

1. **Create a feature branch** from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes inside the `extension-main/` directory.

3. **Test thoroughly:**
   - Load the unpacked extension and verify your changes on `scaler.com`.
   - Check the **Console** (`Cmd+Option+J` / `Ctrl+Shift+J`) for errors.
   - Inspect the **Service Worker** logs by clicking "Inspect views: service worker" on the extension card at `chrome://extensions`.
   - Test that existing features still work (toggle switches, LeetCode links, downloads, etc.).

4. **Update the docs as soon as the change converges** — see
   [Keeping Docs Updated](#-keeping-docs-updated). Do this before you start the next piece of work,
   not at the end of the branch.

5. **Commit** with a clear, descriptive message:

   ```bash
   git add .
   git commit -m "feat: add dark mode toggle to popup"
   ```

   Use [conventional commit](https://www.conventionalcommits.org/) prefixes when possible:

   | Prefix      | Usage                            |
   | ----------- | -------------------------------- |
   | `feat:`     | New feature                      |
   | `fix:`      | Bug fix                          |
   | `docs:`     | Documentation changes            |
   | `style:`    | Code style / formatting          |
   | `refactor:` | Refactoring without new features |
   | `chore:`    | Build/config/tooling changes     |

---

## 📚 Keeping Docs Updated

**A change is not done until the docs match it.** Docs are not a final cleanup pass — they get
written the moment a feature or fix **converges**.

Converged means you have stopped iterating on the behaviour: the code works on `scaler.com`, the
toggle turns the feature both on *and* off cleanly, and `npm test` in `tests/` passes. That is the
point where you know what actually shipped, so that is when docs are cheapest and most accurate to
write. Don't batch them to the end of a long session, and don't wait to be asked.

At that checkpoint, in order:

1. **`README.md`** — add or adjust the feature section (keep the emoji heading style) for anything
   user-visible.
2. **`docs/<feature>.md`** — create or update one for any non-trivial feature. Document architecture,
   data flow, teardown (observers / intervals / listeners), and intentional limitations. Use
   [`docs/assignment-export.md`](docs/assignment-export.md) as the template; see also
   `docs/architecture.md`, `docs/calendar-sync.md`, `docs/companion-bypass.md`,
   `docs/dom-cleaner.md`, `docs/leetcode-link.md`, `docs/problem-search.md`.
3. **`Feature-details.md`** and popup copy — keep in sync with what actually ships.
4. **`CONTRIBUTING.md`** (this file) — update if project structure, workflow, or guidelines changed.
   **`CLAUDE.md`** — update if architecture, conventions, or commands changed.
5. **`extension-main/manifest.json`** — bump `version` for a release-worthy change.

Then commit code and docs together, or as a `docs:` commit immediately after on the same branch, so no
commit on the branch describes behaviour the docs contradict.

If a later iteration changes the behaviour again, run the same checkpoint again — docs get updated
every time the feature re-converges, not once per PR. A feature PR with no README change gets
bounced, and a stale doc is treated the same as a failing test.

---

## 📬 Submitting a Pull Request

1. Push your branch to your fork:

   ```bash
   git push origin feature/your-feature-name
   ```

2. Open a **Pull Request** against the `main` branch of the upstream repository.

3. In the PR description, include:
   - **What** the change does.
   - **Why** the change is needed.
   - **Screenshots / GIFs** if it's a UI change.
   - **Testing steps** you followed.
   - **Which docs you updated** — README section, `docs/<feature>.md`, `Feature-details.md`, popup
     copy, manifest `version`. If you updated none, say why.

4. Wait for a review. Address any feedback and push follow-up commits to the same branch.

---

## 📐 Code Guidelines

- **No build tools needed** — keep the extension dependency-free. All code runs directly in Chrome.
- **Modular design** — place new features in `content/features/` as separate files. Add reusable helpers to `content/utils/`.
- **Settings integration** — if your feature has a toggle, add it to `popup.html` / `popup.js` and persist the state with `chrome.storage.sync`.
- **Manifest awareness** — if you add a new content script, register it in `manifest.json` under `content_scripts.js`. If you need new permissions, add them to `permissions` or `host_permissions`.
- **Consistent styling** — match the existing popup design (dark theme, spacing, font sizes) defined in `popup.css`.
- **No external CDNs in content scripts** — Manifest V3 requires all scripts to be bundled locally.

---

## ⏳ Chrome Web Store Review Timeline

> **Important:** After a new feature or bug fix is merged, it may take **7 – 15 days** for the update to appear on the official Chrome Web Store version of Scaler++. This is because every new version submitted to the Chrome Web Store goes through **Google's review process**, which typically takes 1 – 2 weeks.
>
> During this period:
>
> - The reviewed version of Scaler++ on the Chrome Web Store remains unchanged.
> - Users who have installed the extension via the Web Store will **not** see the update until Google approves and publishes the new version.
> - Contributors and testers can always use the **latest code** by loading the extension unpacked from the `extension-main/` folder (see [Loading the Extension Locally](#-loading-the-extension-locally)).
>
> Please be patient — this delay is entirely controlled by Google and is standard for all Chrome extensions.

---

## 💬 Questions?

If you have any questions, feel free to open a [GitHub Issue](https://github.com/Ritesh381/Scaler-DOM-Cleaner/issues) or reach out.

---

Made with ❤️ by the Scaler++ community.
