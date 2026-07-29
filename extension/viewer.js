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

// Builds the selectable text layer OURSELVES, calibrated to the PDF's own
// geometry. PDF.js's TextLayer sizes spans from font metrics (measureText),
// which drift from the painted glyphs on some machines (Brave farbles text
// metrics under fingerprint protection) — the layer LOOKS fine (transparent)
// but every span sits offset/compressed vs the visible text, so precise
// highlighting misses. Instead: place each span at the item's transform
// origin, then scaleX it so its measured width EQUALS the item's width from
// the PDF (item.width × viewport.scale) — alignment with the canvas glyphs
// by construction, immune to font metrics. Returns the span count.
async function renderTextLayer(page, viewport, container) {
  const tc = await page.getTextContent();
  const placed = [];
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!fontHeight) continue;
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = tx[4] + "px";
    span.style.top = tx[5] - fontHeight + "px";
    span.style.fontSize = fontHeight + "px";
    span.style.fontFamily = "sans-serif";
    container.appendChild(span);
    placed.push({ span, expected: item.width * viewport.scale });
  }
  // Batch-read natural widths, then batch-write scaleX (avoids layout thrash).
  const widths = placed.map(({ span }) => span.getBoundingClientRect().width);
  placed.forEach(({ span, expected }, i) => {
    if (widths[i] > 0 && expected > 0) {
      span.style.transform = `scaleX(${expected / widths[i]})`;
    }
  });
  return placed.length;
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
  let textSpans = 0;
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

    // Text layer FIRST, canvas paint decoupled. A canvas render that never
    // resolves (GPU stalls, background-tab rAF starvation) previously hung
    // this loop BEFORE any text layer was built — the page still looked
    // rendered (PDF.js paints progressively), but highlight had no text to
    // grab. The text layer must never wait on the canvas.
    try {
      textSpans += await renderTextLayer(page, viewport, textLayerDiv);
    } catch { /* one bad page must not block the rest */ }
    page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    }).promise.catch(() => { /* canvas paint is best-effort */ });
  }

  loadingEl.remove();
  // Surface a dead text layer instead of letting highlight fail silently.
  if (!textSpans) {
    const note = document.createElement("div");
    note.className = "fig-pdf-toolbar-note";
    note.textContent = "This PDF exposes no selectable text, so the highlight tool has nothing to grab here. Comments and drawing still work.";
    document.body.insertBefore(note, pagesEl);
  }
  // Hand the source PDF to the overlay's dispatch.
  window.__figPDF = { src: entry.src, b64: entry.b64, name: entry.name };

  // Load the Fig overlay (classic script; auto-activates).
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("fig-overlay.js");
  document.body.appendChild(s);
}

main().catch((e) => { loadingEl.textContent = "Could not render PDF: " + e.message; });
