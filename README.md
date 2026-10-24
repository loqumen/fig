<p align="center">
  <img src="mark/fig-badge.svg" width="96" alt="Fig">
</p>

<h1 align="center">Fig</h1>
<p align="center">Live design feedback. Mark up any web page or PDF; an AI assistant on the machine applies the markings and produces the revised page.</p>

---

Fig is a browser extension paired with a small native companion. A shortcut opens markup tools over the live page: comment pins, text suggestions, and freehand drawing. Pressing the green Fig button captures the page and hands the markings to the AI running locally, which treats them as instructions and generates the revised page. The result opens locally by default; a settings option publishes it to the web instead.

## Two ways to use Fig

Both use the same markup tools, so reviewers and the person revising see one interface.

| | Fig extension | Hosted review page |
|---|---|---|
| Who marks up | You, on any live page or PDF | Anyone you send a link to |
| Where marks live | Your browser (`chrome.storage.local`), until you press Fig | A Cloudflare D1 database behind the review site |
| What happens next | The companion generates the revised page on your machine | Feedback collects in one place for you or an AI to work through |
| Start it | ⌥⇧F on a page | Build a page into a review site (`scaffold/`) and send the link |

The tools are built once, from the overlay in `scaffold/overlay/`. `extension/build-fig-ui.py` turns it into the extension's copy (`extension/fig-ui/`), and `companion/inject-overlay.js` uses it for published review pages.

Fig is part of the [Loqumen product suite](https://loqumen.com/products), alongside HQ and Summon. It works alongside the [Claude Code](https://claude.com/claude-code) command line tool, which does the thinking.

## How it works

1. `extension/` is a Chrome/Brave MV3 extension. Option+Shift+F (or the popup's "Open Fig on this page") injects the review tools into the current page: the shared overlay from `extension/fig-ui/`, a local store (`fig-local-api.js`) that answers the overlay's API inside the page and saves each page's marks, and `fig-ext.js`, which adds the Fig button. It uses `activeTab` with on-demand injection only; there is no `<all_urls>` host permission. The popup holds settings and the list of past figs.
2. The Fig button snapshots the page without Fig's own elements, turns comments, suggestions, and strokes into annotations anchored to page elements, and sends both to the companion.
3. `companion/figd.js` is a zero-dependency Node daemon on `127.0.0.1:41414`. It writes each job to `~/.fig/jobs/<slug>/` (snapshot, annotations, prompt), invokes the local `claude` CLI to generate the revision, serves a self-refreshing status page, and then serves the result.

The annotations are inputs that inform what the new page should be. They are not carried onto the generated page, so no re-anchoring is needed.

## Hosted review pages

`scaffold/` is a ready-to-deploy review site: static pages plus the review API (`/api/comments`, `/api/strokes`, `/api/clear`, `/api/versions`) on Cloudflare D1.

- `scaffold/shared/review-api-core.js` is the API, independent of storage. The extension's local store runs the same file.
- `scaffold/cloudflare/d1-store.js` stores it in D1. Every write is a single statement, so reviewers acting at the same moment never overwrite each other.
- `test/review-api-contract.mjs` checks the API against both an in-memory store and the real D1 SQL on SQLite (Node 22+).

The companion's "Link a review site" setting deploys this scaffold to your own Cloudflare (or Vercel) account and publishes finished figs there.

### PDFs

Browser PDF viewers are sealed plugins, so on a `.pdf` URL Fig grabs the document bytes in the tab and reopens it in the extension's own PDF.js viewer. Pins, suggestions, and drawing all work on the rendered pages. The companion prompts the AI to read the PDF and produce a faithful `edited.html` with the requested changes, then exports `edited.pdf` when a headless browser is available.

## Install (from source)

A signed macOS package is coming to the [products page](https://loqumen.com/products). Until then:

1. Companion: `installer/install-on-demand.sh`. It registers the browser connection and a LaunchAgent that starts the companion only when Fig needs it and stops it after 30 idle minutes (`--remove` undoes it). To run it by hand instead: `node companion/figd.js`.
2. Extension: open `brave://extensions` (or `chrome://extensions`), enable Developer mode, choose Load unpacked, and select the `extension/` folder.
3. The extension reaches the companion through its native messaging host, which the companion installs.

Requires [Claude Code](https://claude.com/claude-code) signed in on the machine. Node 18 or later. No npm installs; the companion has zero dependencies and PDF.js is vendored.

## Settings

`~/.fig/settings.json`:

- `target`: `"localhost"` (default) serves results locally; `"linked"` also publishes each result to the review site you linked from the popup.
- `token`: the shared secret gating the companion's POST endpoint, so arbitrary web pages cannot drive it.
- `claudeArgs`: extra flags for the generation run.

## Design notes

- The companion binds to loopback only and rejects requests without the token.
- The extension asks for the minimum: `activeTab`, injected on demand.
- Generation runs under the user's own `claude` login. No API keys are stored or proxied.
- The AI runner is a thin shell layer. Claude Code is the supported backend today; adapters for other agent CLIs are a roadmap item.

## License

[MIT](LICENSE)
