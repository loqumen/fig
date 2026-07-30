// Inject the Fig review overlay into a published page — the product-bundled
// port of the canonical build-overlay.py (same rules, same order):
// overlay-only CSS (after the sentinel), stabilizer CSS, toolbar, comment JS
// wrapped in a window.load init, body data-fig-version (+ scoped clear).
// Used when publishing to a SCAFFOLDED review site; Brady's legacy edits
// deploys keep routing through build-overlay.py itself.
const fs = require("fs");
const path = require("path");

const OVERLAY_DIR = [
  path.join(__dirname, "..", "scaffold", "overlay"),   // repo layout
  path.join(__dirname, "scaffold", "overlay"),          // installed layout
].find((d) => fs.existsSync(d));
const SENTINEL = "/* @FIG_OVERLAY_ONLY_START";

function icon(name) {
  const raw = fs.readFileSync(path.join(OVERLAY_DIR, "icons", name + ".svg"), "utf8");
  return raw.replace("<svg ", '<svg width="20" height="20" aria-hidden="true" ', 1);
}

function toolbarHtml(clearMine) {
  const trashTitle = clearMine ? "Delete all of your feedback" : "Delete all comments";
  return (
    '\n<!-- Fig toolbar -->\n<div class="fig-toolbar">' +
    '<div class="draw-colors" id="drawColors"></div>' +
    `<button class="fig-btn draw-toggle" id="drawToggle" title="Draw — freehand annotation">${icon("pencil-simple")}</button>` +
    `<button class="fig-btn comment-toggle" id="commentToggle" title="Comment — design & layout feedback">${icon("chat-circle")}</button>` +
    `<button class="fig-btn suggest-toggle" id="suggestToggle" title="Suggest — highlight text & flag inaccuracies">${icon("highlighter")}</button>` +
    '<span class="fig-divider"></span>' +
    `<button class="fig-btn clear-all-btn" id="clearAllComments" title="${trashTitle}">${icon("trash")}</button>` +
    `<button class="fig-btn help-btn" id="figHelp" title="How to use these tools">${icon("question")}</button>` +
    "</div>\n"
  );
}

function overlayCss() {
  const full = fs.readFileSync(path.join(OVERLAY_DIR, "fig-styles.css"), "utf8");
  if (!full.includes(SENTINEL)) throw new Error("fig-styles.css missing overlay sentinel");
  const after = full.split(SENTINEL, 2)[1];
  return after.slice(after.indexOf("*/") + 2);
}

function stabilizerCss() {
  return fs.readFileSync(path.join(OVERLAY_DIR, "fig-overlay-stabilizer.css"), "utf8");
}

function figJs() {
  return fs.readFileSync(path.join(OVERLAY_DIR, "fig-comments.js"), "utf8");
}

function injectBodyAttrs(html, version, clearMine) {
  return html.replace(/<body[^>]*>/, (tag) => {
    if (/data-fig-version/.test(tag)) tag = tag.replace(/data-fig-version="[^"]*"/, `data-fig-version="${version}"`);
    else tag = tag.slice(0, -1) + ` data-fig-version="${version}">`;
    if (clearMine && !/data-fig-clear/.test(tag)) tag = tag.slice(0, -1) + ' data-fig-clear="mine">';
    return tag;
  });
}

// Full-page replica injection (the only mode the product needs):
// overlay CSS in a <style>, body position:relative, toolbar + load-wrapped JS.
function injectOverlay(html, { version, clearMine = true }) {
  let out = injectBodyAttrs(html, version, clearMine);
  const css =
    "\n<style>\n/* Fig review overlay */\nbody { position: relative !important; }\n" +
    stabilizerCss() + overlayCss() + "\n</style>\n";
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, css + "</head>") : css + out;
  const script =
    toolbarHtml(clearMine) +
    "<script>\nfunction __initFig(){\n" + figJs() + "\n}\n" +
    'if (document.readyState === "complete") __initFig();\n' +
    'else window.addEventListener("load", __initFig);\n</script>\n';
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, script + "</body>") : out + script;
  return out;
}

module.exports = { injectOverlay };
