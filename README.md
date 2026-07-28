<p align="center">
  <img src="mark/fig-badge.svg" width="96" alt="Fig">
</p>

<h1 align="center">Fig</h1>
<p align="center">Live design feedback. Mark up any web page or PDF; an AI assistant on the machine applies the markings and produces the revised page.</p>

---

Fig is a browser extension paired with a small native companion. A shortcut opens markup tools over the live page: comment pins, text highlights, and freehand drawing. Pressing the Fig button captures the page and hands the markings to the AI running locally, which treats them as instructions and generates the revised page. The result opens locally by default; a settings option publishes it to the web instead.

Fig is part of the [Loqumen product suite](https://loqumen.com/products), alongside HQ and Summon. It works alongside the [Claude Code](https://claude.com/claude-code) command line tool, which does the thinking.

## How it works

1. `extension/` is a Chrome/Brave MV3 extension. Option+Shift+F (or the toolbar icon) injects the overlay on the current page. It uses `activeTab` with on-demand injection only; there is no `<all_urls>` host permission.
2. The Fig button serializes the page, strips the overlay chrome and scripts, and sends the snapshot plus structured annotations to the companion.
3. `companion/figd.js` is a zero-dependency Node daemon on `127.0.0.1:41414`. It writes each job to `~/.fig/jobs/<slug>/` (snapshot, annotations, prompt), invokes the local `claude` CLI to generate the revision, serves a self-refreshing status page, and then serves the result.

The annotations are inputs that inform what the new page should be. They are not carried onto the generated page, so no re-anchoring is needed.

### PDFs

Browser PDF viewers are sealed plugins, so on a `.pdf` URL Fig grabs the document bytes in the tab and reopens it in the extension's own PDF.js viewer. Pins, highlights, and drawing all work on the rendered pages. The companion prompts the AI to read the PDF and produce a faithful `edited.html` with the requested changes, then exports `edited.pdf` when a headless browser is available.

## Install (from source)

A signed macOS package is coming to the [products page](https://loqumen.com/products). Until then:

1. Companion: `node companion/figd.js`. It prints its access token on start.
2. Extension: open `brave://extensions` (or `chrome://extensions`), enable Developer mode, choose Load unpacked, and select the `extension/` folder.
3. Open the Fig popup from the toolbar and paste the token once.

Requires [Claude Code](https://claude.com/claude-code) signed in on the machine. Node 18 or later. No npm installs; the companion has zero dependencies and PDF.js is vendored.

## Settings

`~/.fig/settings.json`:

- `target`: `"localhost"` (default) serves results locally; `"vercel"` publishes each result to the web.
- `token`: the shared secret gating the companion's POST endpoint, so arbitrary web pages cannot drive it.
- `claudeArgs`: extra flags for the generation run.

## Design notes

- The companion binds to loopback only and rejects requests without the token.
- The extension asks for the minimum: `activeTab`, injected on demand.
- Generation runs under the user's own `claude` login. No API keys are stored or proxied.
- The AI runner is a thin shell layer. Claude Code is the supported backend today; adapters for other agent CLIs are a roadmap item.

## License

[MIT](LICENSE)
