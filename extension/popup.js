// Fig popup: open the tools, see every fig, and change settings. The page toolbar is
// the /fig toolbar plus the Fig button; everything else about Fig lives here.
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const send = (msg) => new Promise((resolve) => {
  try {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
      resolve(r || { ok: false });
    });
  } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
});
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const NOT_RUNNING = "The Fig companion isn't running. Open Fig Companion, then reopen this.";

$("open").addEventListener("click", async () => {
  const r = await send({ type: "fig-open" });
  if (r.ok) { window.close(); return; }
  statusEl.textContent = r.error || "Could not open Fig here.";
});

// ---------- companion status ----------
function pingNative() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage("com.loqumen.fig", { type: "ping" }, (resp) => resolve(!chrome.runtime.lastError && !!resp));
    } catch { resolve(false); }
  });
}
(async () => {
  let up = await pingNative();
  if (!up) { try { await fetch("http://127.0.0.1:41414/", { method: "GET" }); up = true; } catch { up = false; } }
  $("dot").className = "dot " + (up ? "ok" : "bad");
  $("connText").textContent = up ? "Companion running" : "Companion not running. Open Fig Companion.";
})();

// ---------- your figs ----------
const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); }
  catch { return ""; }
};
(async () => {
  const box = $("figs");
  const r = await send({ type: "fig-jobs" });
  if (!r.ok || !Array.isArray(r.data)) { box.replaceChildren(el("p", null, NOT_RUNNING)); return; }
  if (!r.data.length) { box.replaceChildren(el("p", null, "No figs yet. Mark a page up and press Fig.")); return; }
  box.replaceChildren();
  for (const j of r.data) {
    const row = el("div", "fig-row");
    row.appendChild(el("b", null, j.title || j.slug));
    const meta = [];
    if (j.startedAt) meta.push(fmtDate(j.startedAt));
    if (j.markings != null) meta.push(j.markings + " marking" + (j.markings === 1 ? "" : "s"));
    if (j.rounds > 1) meta.push("round " + j.rounds);
    row.appendChild(el("span", null, meta.join(", ")));
    if (j.phase === "generating") row.appendChild(el("span", "gen", ", generating"));
    if (j.phase === "error") row.appendChild(el("span", "err", ", failed (open to retry)"));
    row.addEventListener("click", () => chrome.tabs.create({ url: "http://127.0.0.1:41414" + j.url }));
    box.appendChild(row);
  }
})();

// ---------- settings ----------
const opt = (pairs, current) => pairs.map(([v, label]) => `<option value="${v}"${(current || "") === v ? " selected" : ""}>${label}</option>`).join("");

function renderSettings(data, note) {
  const box = $("settings");
  const publish = (data && data.publish) || {};
  const linked = publish.status === "linked";
  const linking = publish.status === "linking";
  const err = publish.status === "error" ? publish.error : null;
  const target = (data && data.target) || "localhost";
  const legacy = !!(data && data.legacyVercel);
  const canPublish = linked || legacy;
  const publishOn = target !== "localhost" && canPublish;
  const dests = [];
  if (linked) dests.push(["linked", publish.url ? publish.url.replace(/^https?:\/\//, "") : "Linked review site"]);
  if (legacy) dests.push(["vercel", "Old Vercel review site"]);
  const dest = target === "vercel" || target === "linked" ? target : (linked ? "linked" : "vercel");

  box.innerHTML =
    `<label class="toggle"><input type="checkbox" id="pubOn"${publishOn ? " checked" : ""}${canPublish ? "" : " disabled"}>
       <span>Publish for team review<em>${canPublish ? "Each new fig also goes to your review site. Off keeps everything on this Mac." : "Link a review site to turn this on."}</em></span></label>` +
    (canPublish && dests.length > 1 ? `<div class="row"><span>Site</span><select id="dest">${opt(dests, dest)}</select></div>` : "") +
    (canPublish && dests.length === 1 ? `<div class="hint">Review site: ${dests[0][1]}</div>` : "") +
    (canPublish ? `<button class="quiet" id="publishNow">Publish the latest fig now</button><div class="hint" id="pubNote"></div>` : "") +
    (linking
      ? `<div class="hint">Linking… ${publish.step || ""} A browser sign-in window may open.</div>`
      : `<button class="quiet" id="linkMore">${linked ? "Use a different review site" : "Link a review site"}</button>
         <div id="linkBox" hidden>
           <div class="row"><span>Provider</span><select id="provider">${opt([["cloudflare", "Cloudflare"], ["vercel", "Vercel"]], "cloudflare")}</select></div>
           <div class="hint">Cloudflare's free tier allows commercial use. Vercel's free Hobby tier is personal use only.</div>
           <button id="linkGo">Link site</button>
         </div>`) +
    (err ? `<div class="hint" style="color:#916031">Link failed: ${err}</div>` : "") +
    `<div class="row"><span>Model</span><select id="model">${opt([["", "Default"], ["fable", "Fable"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]], data.model)}</select></div>` +
    `<div class="row"><span>Effort</span><select id="effort">${opt([["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], data.effort)}</select></div>` +
    `<div class="hint">Stronger models and higher effort give better revisions and take longer. Default follows the claude CLI's own setting.</div>` +
    `<button id="save">Save</button><div class="status" id="saveNote">${note || ""}</div>`;

  const more = $("linkMore");
  if (more) more.addEventListener("click", () => { $("linkBox").hidden = !$("linkBox").hidden; });

  const linkGo = $("linkGo");
  if (linkGo) linkGo.addEventListener("click", async () => {
    await send({ type: "fig-link-start", provider: $("provider").value });
    const poll = setInterval(async () => {
      const r = await send({ type: "fig-settings-get" });
      if (r.ok) renderSettings(r.data);
      if (!r.ok || !r.data.publish || r.data.publish.status !== "linking") clearInterval(poll);
    }, 2000);
    const r = await send({ type: "fig-settings-get" });
    renderSettings(r.ok ? r.data : data);
  });

  const pubBtn = $("publishNow");
  if (pubBtn) pubBtn.addEventListener("click", async () => {
    const noteEl = $("pubNote");
    pubBtn.disabled = true;
    pubBtn.textContent = "Publishing…";
    const r = await send({ type: "fig-publish", slug: null });
    if (!r.ok) {
      pubBtn.disabled = false;
      pubBtn.textContent = "Publish the latest fig now";
      noteEl.textContent = (r.data && r.data.error) || r.error || "Could not publish";
      return;
    }
    const which = r.data.publishing;
    noteEl.textContent = `Publishing "${r.data.title || which}"…`;
    // deploys take a while; poll until the companion writes the outcome
    let tries = 0;
    const poll = setInterval(async () => {
      if (++tries > 90) { clearInterval(poll); return; }
      const d = await send({ type: "fig-deploy-status", slug: which });
      const line = d.ok && d.data && d.data.deploy;
      if (!line || /^Publishing/.test(line)) return;
      clearInterval(poll);
      noteEl.textContent = line;
      pubBtn.disabled = false;
      pubBtn.textContent = "Publish again";
    }, 2000);
  });

  $("save").addEventListener("click", async () => {
    let newTarget = "localhost";
    if ($("pubOn") && $("pubOn").checked) newTarget = $("dest") ? $("dest").value : (linked ? "linked" : "vercel");
    const r = await send({ type: "fig-settings-set", settings: { target: newTarget, model: $("model").value, effort: $("effort").value } });
    renderSettings(r.data || data, r.ok ? "Saved" : "Could not save");
  });
}

(async () => {
  const r = await send({ type: "fig-settings-get" });
  if (!r.ok) { $("settings").replaceChildren(el("p", null, NOT_RUNNING)); return; }
  renderSettings(r.data);
})();
