// Fig PDF viewer — renders the captured PDF with PDF.js so the Fig overlay
// tools (pins, text highlighting via the text layer, drawing) work on it.
// The PDF bytes arrive via chrome.storage.session (fetched same-origin inside
// the original tab by background.js), keyed by the `key` query param.

import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

const loadingEl = document.getElementById("loading");
const pagesEl = document.getElementById("pages");

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function renderTextLayer(page, viewport, container) {
  try {
    if (pdfjsLib.TextLayer) {
      const layer = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container,
        viewport,
      });
      await layer.render();
      return;
    }
  } catch { /* fall through to manual layer */ }
  // Manual fallback: absolutely positioned transparent spans per text item.
  const tc = await page.getTextContent();
  for (const item of tc.items) {
    if (!item.str) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = tx[4] + "px";
    span.style.top = tx[5] - fontHeight + "px";
    span.style.fontSize = fontHeight + "px";
    span.style.fontFamily = "sans-serif";
    container.appendChild(span);
  }
}

async function main() {
  const key = new URL(location.href).searchParams.get("key");
  if (!key) { loadingEl.textContent = "Missing PDF reference."; return; }
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key];
  if (!entry || !entry.b64) {
    loadingEl.textContent = "PDF data expired — reopen the PDF and press the Fig shortcut again.";
    return;
  }
  document.title = "Fig — " + (entry.name || entry.src);
  const doc = await pdfjsLib.getDocument({ data: b64ToBytes(entry.b64) }).promise;

  const targetWidth = Math.min(Math.max(window.innerWidth - 96, 640), 1100);
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = targetWidth / base.width;
    const viewport = page.getViewport({ scale });

    const wrap = document.createElement("div");
    wrap.className = "fig-pdf-page";
    wrap.dataset.page = String(n);
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";

    const canvas = document.createElement("canvas");
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    wrap.appendChild(canvas);

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.style.setProperty("--scale-factor", String(scale));
    textLayerDiv.style.width = viewport.width + "px";
    textLayerDiv.style.height = viewport.height + "px";
    wrap.appendChild(textLayerDiv);

    pagesEl.appendChild(wrap);

    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    }).promise;
    await renderTextLayer(page, viewport, textLayerDiv);
  }

  loadingEl.remove();
  // Hand the source PDF to the overlay's dispatch.
  window.__figPDF = { src: entry.src, b64: entry.b64, name: entry.name };

  // Load the Fig overlay (classic script; auto-activates).
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("fig-overlay.js");
  document.body.appendChild(s);
}

main().catch((e) => { loadingEl.textContent = "Could not render PDF: " + e.message; });
