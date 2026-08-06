const statusEl = document.getElementById("status");
const dot = document.getElementById("dot");
const connText = document.getElementById("connText");

document.getElementById("open").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "fig-open" }, (res) => {
    if (res && res.ok) { window.close(); return; }
    statusEl.textContent = (res && res.error) || "Could not open Fig here.";
  });
});

// Is the companion reachable? Native host first, then the legacy local port.
function pingNative() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage("com.loqumen.fig", { type: "ping" }, (resp) => {
        resolve(!chrome.runtime.lastError && !!resp);
      });
    } catch { resolve(false); }
  });
}

// Embedded content (a shared Claude artifact, any cross-origin iframe) lives
// in a frame Fig cannot touch without a host grant — activeTab alone stops at
// the top document, so clicks and text selections inside the frame never
// reach the tools. This is the user-consented opt-in; chrome.permissions
// .request needs an extension page and a real click, which is exactly here.
const embedDot = document.getElementById("embedDot");
const embedText = document.getElementById("embedText");
const grantBtn = document.getElementById("grantEmbed");
const EMBED_PERM = { origins: ["<all_urls>"] };

function paintEmbed(granted) {
  embedDot.className = "dot " + (granted ? "ok" : "");
  embedText.textContent = granted ? "Embedded content enabled" : "Embedded content off";
  grantBtn.hidden = granted;
}

grantBtn.addEventListener("click", () => {
  chrome.permissions.request(EMBED_PERM, (granted) => {
    paintEmbed(granted);
    statusEl.textContent = granted
      ? "Press ⌥⇧F again on the page to annotate inside embeds."
      : "Not granted — Fig still works on ordinary pages.";
  });
});

chrome.permissions.contains(EMBED_PERM, paintEmbed);

(async () => {
  if (await pingNative()) {
    dot.className = "dot ok";
    connText.textContent = "Companion connected";
    return;
  }
  try {
    await fetch("http://127.0.0.1:41414/", { method: "GET" });
    dot.className = "dot ok";
    connText.textContent = "Companion connected";
  } catch {
    dot.className = "dot bad";
    connText.textContent = "Companion not running — open Fig Companion";
  }
})();
