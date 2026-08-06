// Fig — background service worker.
// Injects the overlay on demand (activeTab), so the extension needs no
// <all_urls> host permission: nothing runs until the user asks for Fig.
// PDFs: Brave's built-in PDF viewer is a sealed plugin, so Fig grabs the PDF
// bytes same-origin inside the tab, stashes them in session storage, and
// reopens the document in its own PDF.js viewer where the tools work.

const isPdfUrl = (url) => {
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname) || /\.pdf$/i.test(u.href.split(/[?#]/)[0]);
  } catch { return false; }
};

// Runs inside the tab: fetch the PDF bytes (same-origin) and return base64.
async function grabPdfInTab() {
  const res = await fetch(location.href, { credentials: "include" });
  if (!res.ok) return { error: "fetch failed: " + res.status };
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) return { error: "PDF larger than 8 MB — not supported yet" };
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { b64: btoa(bin) };
}

async function openPdfViewer(tab) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: grabPdfInTab,
  });
  if (!result || result.error) {
    // Failure is always VISIBLE (product standard): badge it, never
    // console-only.
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#8a3b2e" });
    chrome.action.setTitle({ tabId: tab.id, title: "Fig couldn't read this PDF: " + ((result && result.error) || "no bytes returned") });
    return;
  }
  chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  const key = "figpdf-" + tab.id + "-" + Date.now();
  const name = (() => { try { return decodeURIComponent(new URL(tab.url).pathname.split("/").pop()); } catch { return "document.pdf"; } })();
  await chrome.storage.session.set({ [key]: { src: tab.url, b64: result.b64, name } });
  await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL("viewer.html") + "?key=" + encodeURIComponent(key) });
}

async function toggleFig(tab) {
  if (!tab || !tab.id) return;
  // No URL pre-guard: the url is invisible without host access (empty string
  // on some schemes), and a pre-guard turns that into a silent no-op. Try
  // the injection on ANYTHING; if the browser forbids it (chrome:// pages,
  // the Web Store, other extensions), say so on the badge instead of
  // failing silently.
  if (tab.url && isPdfUrl(tab.url)) { await openPdfViewer(tab); return; }
  try {
    // Inject into EVERY frame, not just the top one. A Claude artifact, a
    // Figma embed, a docs preview — the thing worth annotating often lives
    // in a cross-origin iframe, and a top-frame-only overlay can neither
    // see its text nor receive its clicks (2026-08-05). Child frames run
    // the same file in "child mode": no toolbar, they mirror the top
    // frame's tool and hand their markings back at dispatch.
    // Same-origin frames come with activeTab; cross-origin ones need the
    // optional <all_urls> grant (the popup's embedded-content toggle).
    await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ["fig-overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["fig-overlay.js"] });
    // fig-overlay.js defines window.__figToggle and calls it on (re)injection.
    chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (e) {
    // allFrames can fail wholesale on some pages; the top frame alone is
    // still worth having, so fall back before reporting failure.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["fig-overlay.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fig-overlay.js"] });
      chrome.action.setBadgeText({ tabId: tab.id, text: "" });
      return;
    } catch { /* fall through to the honest badge below */ }
    chrome.action.setBadgeText({ tabId: tab.id, text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#8a3b2e" });
    chrome.action.setTitle({ tabId: tab.id, title: "Fig can't run on this page: " + ((e && e.message) || e) });
  }
}

chrome.action.onClicked.addListener((tab) => toggleFig(tab));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-fig") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleFig(tab);
});

// Frames that carry markings, per tab: {tabId: {frameId: {url, marks}}}.
// Children announce themselves whenever their markings change, so at
// dispatch the top frame knows which frames to collect from (a tab message
// can only carry one response, so each frame is asked by frameId).
const figFrames = new Map();
chrome.tabs.onRemoved.addListener((tabId) => figFrames.delete(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // A child frame reporting its marking count (cheap; no HTML).
  if (msg && msg.type === "fig-frame-state" && sender.tab) {
    const byFrame = figFrames.get(sender.tab.id) || {};
    if (msg.marks > 0) byFrame[sender.frameId] = { url: msg.url, marks: msg.marks };
    else delete byFrame[sender.frameId];
    figFrames.set(sender.tab.id, byFrame);
    sendResponse({ ok: true });
    return true;
  }

  // Top frame switching tools -> every child frame follows.
  if (msg && msg.type === "fig-mode" && sender.tab) {
    chrome.tabs.sendMessage(sender.tab.id, { type: "fig-set-mode", mode: msg.mode }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // Dispatch-time collection: ask each recorded child frame for its
  // annotations AND its serialized document.
  if (msg && msg.type === "fig-collect" && sender.tab) {
    (async () => {
      const tabId = sender.tab.id;
      const byFrame = figFrames.get(tabId) || {};
      const out = [];
      for (const frameId of Object.keys(byFrame)) {
        if (Number(frameId) === sender.frameId) continue; // the asker collects itself
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: "fig-serialize" }, { frameId: Number(frameId) });
          if (r && r.annotations) out.push(r);
        } catch { /* frame gone or not reachable; skip it */ }
      }
      sendResponse({ ok: true, frames: out });
    })();
    return true;
  }

  // Popup "Open Fig on this page" button.
  if (msg && msg.type === "fig-open") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https?:/.test(tab.url || "")) {
        sendResponse({ ok: false, error: "Open a normal website or PDF first." });
        return;
      }
      await toggleFig(tab);
      sendResponse({ ok: true });
    })();
    return true;
  }

  // "All figs" popover: human-readable job inventory. Native host FIRST —
  // Brave gates extension access to localhost, so the browser-side fetch
  // below can be blocked outright even with a healthy daemon (2026-08-05).
  // The HTTP path stays as the fallback for installs without the host.
  if (msg && msg.type === "fig-jobs") {
    (async () => {
      const native = await new Promise((resolve) => {
        try {
          chrome.runtime.sendNativeMessage(FIG_HOST, { type: "jobs" }, (resp) => {
            if (chrome.runtime.lastError || !resp || !resp.ok || !Array.isArray(resp.data)) return resolve(null);
            resolve(resp);
          });
        } catch { resolve(null); }
      });
      if (native) { sendResponse(native); return; }
      try {
        const r = await fetch("http://127.0.0.1:41414/jobs.json");
        sendResponse({ ok: r.ok, data: await r.json() });
      } catch {
        sendResponse({ ok: false, error: "companion not reachable" });
      }
    })();
    return true;
  }

  // Settings + publish ops from the overlay -> native host. Everything goes
  // through the host: Brave blocks the extension's own localhost fetch.
  if (msg && ["fig-settings-get", "fig-settings-set", "fig-link-start", "fig-publish", "fig-deploy-status"].includes(msg.type)) {
    (async () => {
      const map = {
        "fig-settings-get": "settings-get", "fig-settings-set": "settings-set",
        "fig-link-start": "link-start", "fig-publish": "publish", "fig-deploy-status": "deploy-status",
      };
      const out = await new Promise((resolve) => {
        try {
          chrome.runtime.sendNativeMessage(FIG_HOST,
            { type: map[msg.type], settings: msg.settings, provider: msg.provider, slug: msg.slug },
            (resp) => resolve(chrome.runtime.lastError || !resp ? { ok: false, error: "companion not reachable" } : resp));
        } catch { resolve({ ok: false, error: "companion not reachable" }); }
      });
      sendResponse(out);
    })();
    return true;
  }

  // Relay from content script: fetch to the companion goes through the worker
  // so the request originates from the extension, not the page origin.
  if (msg && msg.type === "fig-dispatch") {
    (async () => {
      try {
        // Preferred path: the native host. The browser only lets the extension
        // IDs named in the host manifest speak to it, so no token is needed and
        // the user never pastes one. Falls back to the old localhost+token path
        // when the host is not installed, so existing setups keep working.
        let out = await sendNative(msg.payload);
        if (!out) out = await sendLocalHttp(msg.payload);
        sendResponse(out);
        if (out.ok && out.data && out.data.statusUrl) {
          openFigTab(out.data.statusUrl);
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});


// One Fig tab, always: every dispatch reuses the existing companion tab
// (navigated + focused) instead of piling up a new tab per run. The
// 127.0.0.1:41414 host permission is what lets tabs.query see the URL.
async function openFigTab(url) {
  try {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:41414/*" });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { url, active: true });
      if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
      return;
    }
  } catch (e) { /* fall through to a fresh tab */ }
  chrome.tabs.create({ url });
}

// --- companion transports -------------------------------------------------
const FIG_HOST = "com.loqumen.fig";

// Returns null (not an error) when the native host is unavailable, so the
// caller can fall back rather than surfacing a confusing failure.
function sendNative(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(FIG_HOST, { type: "dispatch", payload }, (resp) => {
        if (chrome.runtime.lastError || !resp) return resolve(null);
        resolve(resp);
      });
    } catch { resolve(null); }
  });
}

async function sendLocalHttp(payload) {
  const { token } = await chrome.storage.local.get("token");
  const res = await fetch("http://127.0.0.1:41414/fig", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fig-Token": token || "" },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, data: await res.json() };
}
