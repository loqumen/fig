const tokenInput = document.getElementById("token");
const statusEl = document.getElementById("status");

chrome.storage.local.get("token").then(({ token }) => {
  if (token) tokenInput.value = token;
});

document.getElementById("open").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "fig-open" }, (res) => {
    if (res && res.ok) { window.close(); return; }
    statusEl.textContent = (res && res.error) || "Could not open Fig here.";
  });
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ token: tokenInput.value.trim() });
  statusEl.textContent = "Saved.";
  setTimeout(() => { statusEl.textContent = ""; }, 1500);
});
