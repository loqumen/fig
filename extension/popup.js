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
