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
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["fig-overlay.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fig-overlay.js"] });
    // fig-overlay.js defines window.__figToggle and calls it on (re)injection.
    chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  } catch (e) {
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
          chrome.tabs.create({ url: out.data.statusUrl });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
});

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
