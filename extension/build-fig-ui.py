#!/usr/bin/env python3
"""Build extension/fig-ui/ from the /fig review templates, so the extension's markup
tools ARE the /fig tools: same toolbar, pins, suggestions, drawing, cards, onboarding.
The extension adds only the green Fig button and keeps its marks on this computer.

Sources (override with env):
  FIG_TEMPLATES  the /fig overlay templates   (default ~/CLAUDE/tools/fig/templates)
  FIG_BUILDER    the /fig page builder         (default ~/CLAUDE/tools/fig/build-overlay.py)
  the review API core from this repo (scaffold/shared/review-api-core.js)

Outputs (all generated; edit the sources, then rerun this):
  fig-ui/fig-ui.css       /fig overlay styles, each rule raised one id-level of specificity
                          so a live site's own CSS can't restyle the tools
  fig-ui/fig-comments.js  the /fig overlay script, pointed at the local store
  fig-ui/toolbar.js       the /fig toolbar markup plus the green Fig button
  fig-ui/review-core.js   the review API core as a classic script (the local store runs it)
  ../scaffold/overlay/    the same templates, for the companion's team-review publishing

Run: python3 extension/build-fig-ui.py
"""
import importlib.util, json, os, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent
TEMPLATES = pathlib.Path(os.environ.get("FIG_TEMPLATES", pathlib.Path.home() / "CLAUDE/tools/fig/templates"))
BUILDER = pathlib.Path(os.environ.get("FIG_BUILDER", pathlib.Path.home() / "CLAUDE/tools/fig/build-overlay.py"))
OUT = HERE / "fig-ui"
LOCAL = "https://fig.local"      # never a real host: fig-local-api.js answers it in the page
BOOST = ":root:not(#fig-x)"      # one id of specificity, applied to every overlay selector

spec = importlib.util.spec_from_file_location("fig_builder", BUILDER)
builder = importlib.util.module_from_spec(spec)
sys.argv = [str(BUILDER)]
spec.loader.exec_module(builder)
builder.TEMPLATES = TEMPLATES


# ---------------------------------------------------------------- CSS
def split_top(s, sep=","):
    """Split on sep outside parentheses and brackets."""
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch in "([": depth += 1
        elif ch in ")]": depth -= 1
        if ch == sep and depth == 0:
            out.append(cur); cur = ""
        else:
            cur += ch
    out.append(cur)
    return out

def boost_selector(sel):
    s = sel.strip()
    if not s: return s
    if s.startswith(":root"): return BOOST + s[len(":root"):]
    if re.match(r"html\b", s): return BOOST + s[4:]
    return f"{BOOST} {s}"

def boost_css(css):
    """Prefix every style-rule selector; leave @keyframes steps and @font-face alone."""
    out, i, n = [], 0, len(css)
    stack = []                      # kinds of the open blocks: 'group', 'keyframes', 'rule', 'other'
    buf = ""
    while i < n:
        if css.startswith("/*", i):
            j = css.find("*/", i + 2); j = n if j < 0 else j + 2
            out.append(css[i:j]); i = j; continue
        ch = css[i]
        if ch == "{":
            prelude = buf.strip()
            inside = stack[-1] if stack else "group"
            if prelude.startswith("@"):
                kind = "keyframes" if re.match(r"@(-\w+-)?keyframes", prelude) else (
                       "group" if re.match(r"@(media|supports|layer|container|document)", prelude) else "other")
                out.append(buf + "{")
            elif inside == "group":
                kind = "rule"
                lead = buf[: len(buf) - len(buf.lstrip())]
                out.append(lead + ", ".join(boost_selector(x) for x in split_top(prelude)) + " {")
            else:
                kind = "rule"
                out.append(buf + "{")
            stack.append(kind); buf = ""; i += 1; continue
        if ch == "}":
            out.append(buf + "}"); buf = ""
            if stack: stack.pop()
            i += 1; continue
        buf += ch; i += 1
    out.append(buf)
    return "".join(out)

FIG_GO_CSS = """
/* ---- extension only: the green Fig button (sends the markings to the companion) ---- */
.fig-toolbar .fig-go {
  display: flex; align-items: center; gap: 7px; height: 40px; width: auto;
  border: none; outline: none; border-radius: 9px; margin: 0; padding: 2px 16px 0;
  background: #2C9F28; color: #fafaf8;
  font-family: 'DM Sans', -apple-system, system-ui, sans-serif; font-size: 15px; font-weight: 500;
  letter-spacing: 0.02em; text-transform: none; line-height: 1; cursor: pointer; box-shadow: none;
  transition: background 150ms cubic-bezier(0.32, 0.72, 0, 1);
}
.fig-toolbar .fig-go svg { height: 19px; width: auto; display: block; fill: currentColor; }
.fig-toolbar .fig-go.fig-go-busy { opacity: 0.55; pointer-events: none; }
@media (hover: hover) and (pointer: fine) { .fig-toolbar .fig-go:hover { background: #26881f; } }
/* toggled off: every Fig element hides; the page is untouched underneath */
html.fig-ext-off .fig-toolbar, html.fig-ext-off .comment-pin, html.fig-ext-off .comment-popover,
html.fig-ext-off .comment-detail, html.fig-ext-off .fig-draw-canvas, html.fig-ext-off .author-overlay,
html.fig-ext-off .fig-onboard, html.fig-ext-off .fig-toast { display: none; }
html.fig-ext-off mark.fig-suggest { background: none; color: inherit; box-shadow: none; }
"""

def build_css():
    css = builder.load_stabilizer_css() + builder.load_overlay_css() + FIG_GO_CSS
    return "/* GENERATED by extension/build-fig-ui.py from the /fig templates. Do not edit. */\n" + boost_css(css)


# ---------------------------------------------------------------- JS
def build_overlay_js():
    js = builder.load_fig_js()
    for old, new in [("const API = '/api/comments';", f"const API = '{LOCAL}/api/comments';"),
                     ("const STROKES_API = '/api/strokes';", f"const STROKES_API = '{LOCAL}/api/strokes';")]:
        if old not in js:
            raise SystemExit(f"fig-comments.js changed shape: missing {old!r}")
        js = js.replace(old, new)
    return ("// GENERATED by extension/build-fig-ui.py from the /fig template fig-comments.js. Do not edit.\n"
            "// Identical to /fig except the API constants, which point at the local store.\n"
            "window.__figInit = function () {\n" + js + "\n};\n")

def build_toolbar_js():
    html = builder.fig_toolbar_html(clear_all=True, clear_mine=False)
    svg = (HERE / "fig-mark.svg").read_text().strip()   # the Fig mark, as on the original button
    go = ('<span class="fig-divider"></span>'
          f'<button class="fig-go" id="figGo" type="button" title="Generate the revised page from these markings">{svg}<span>Fig</span></button>')
    assert html.rstrip().endswith("</div>")
    html = html.rstrip()[: -len("</div>")] + go + "</div>\n"
    return ("// GENERATED by extension/build-fig-ui.py. The /fig toolbar plus the green Fig button.\n"
            "window.__figToolbarHTML = " + json.dumps(html) + ";\n")

def build_core_js():
    src = (REPO / "scaffold/shared/review-api-core.js").read_text()
    src = re.sub(r"^export (async function|function|const)", r"\1", src, flags=re.M)
    return ("// GENERATED by extension/build-fig-ui.py from scaffold/shared/review-api-core.js. Do not edit.\n"
            "window.__figReviewCore = (() => {\n" + src +
            "\nreturn { handleComments, handleStrokes, handleClear };\n})();\n")


# The companion's publish path (companion/inject-overlay.js) builds team-review pages
# from scaffold/overlay: keep it on the same /fig templates.
import shutil
for f in ["fig-comments.js", "fig-styles.css", "fig-overlay-stabilizer.css"]:
    shutil.copy(TEMPLATES / f, REPO / "scaffold/overlay" / f)
for svg in (TEMPLATES / "icons").glob("*.svg"):
    shutil.copy(svg, REPO / "scaffold/overlay/icons" / svg.name)

OUT.mkdir(exist_ok=True)
files = {"fig-ui.css": build_css(), "fig-comments.js": build_overlay_js(),
         "toolbar.js": build_toolbar_js(), "review-core.js": build_core_js()}
for name, text in files.items():
    (OUT / name).write_text(text)
print("built", ", ".join(f"fig-ui/{k} ({len(v):,} chars)" for k, v in files.items()))
