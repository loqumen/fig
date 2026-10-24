(function() {
  // Ensure body is the positioning context for absolute pins/popovers
  document.body.style.position = 'relative';

  const API = '/api/comments';
  const STROKES_API = '/api/strokes';
  const VERSION = document.body.dataset.figVersion || 'default';
  let commentMode = false;
  let suggestMode = false;
  let comments = [];
  let openPopover = null;
  let dragState = null;

  const STATUS_LABELS = {
    open: 'Open', diagnosed: 'Diagnosed', approved: 'Approved',
    rejected: 'Rejected', applied: 'Applied'
  };

  // ══════════════════════════════════════════════
  //  Sync layer
  //  The server is the source of truth. A browser shows the server's list plus
  //  only its own not-yet-acknowledged writes (queued in localStorage), and
  //  re-reads the server every few seconds, so every reviewer converges on the
  //  same state and a delete made anywhere disappears everywhere.
  //  Writes run one at a time, in order, so a delete can never overtake the
  //  create it cancels. IDs are client-generated, so POST retries are idempotent.
  // ══════════════════════════════════════════════
  var LS_CACHE = 'fig-cache-' + VERSION;        // local snapshot of all comments
  var LS_QUEUE_POST = 'fig-queue-post-' + VERSION;     // pending creates/replies
  var LS_QUEUE_PATCH = 'fig-queue-patch-' + VERSION;   // pending edits/moves
  var LS_QUEUE_DELETE = 'fig-queue-delete-' + VERSION; // pending deletes

  function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
  function backupToLocal() { lsSet(LS_CACHE, comments); }
  function restoreFromLocal() { return lsGet(LS_CACHE); }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function queueAdd(key, item) {
    var q = lsGet(key);
    var existing = q.findIndex(function(x) { return x.id === item.id; });
    if (existing >= 0) q[existing] = item;
    else q.push(item);
    lsSet(key, q);
  }
  function queueRemove(key, id) {
    var q = lsGet(key).filter(function(x) { return x.id !== id; });
    lsSet(key, q);
  }
  // Patches to one comment merge, so a status change can't drop a pending text edit.
  function queuePatch(patch) {
    var q = lsGet(LS_QUEUE_PATCH);
    var i = q.findIndex(function(x) { return x.id === patch.id; });
    if (i >= 0) q[i] = Object.assign({}, q[i], patch); else q.push(patch);
    lsSet(LS_QUEUE_PATCH, q);
    return i >= 0 ? q[i] : patch;
  }

  // Every write is a commit to the GitHub-backed store, and simultaneous commits
  // from different reviewers can collide (the server answers 5xx). Retry those,
  // and network drops, with backoff before giving up to the retry queue.
  async function send(url, opts) {
    var wait = [400, 900, 1800, 3500];
    for (var i = 0; ; i++) {
      try {
        var res = await fetch(url, opts);
        if (res.status < 500 || i >= wait.length) return res;
      } catch (err) {
        if (i >= wait.length) throw err;
      }
      await new Promise(function(r) { setTimeout(r, wait[i] + Math.random() * 300); });
    }
  }

  var opChain = Promise.resolve();
  function serial(fn) {
    var run = opChain.then(fn, fn);
    opChain = run.catch(function() {});
    return run;
  }

  function mergeById(a, b) {
    var map = new Map();
    [a, b].forEach(function(list) {
      list.forEach(function(item) {
        var existing = map.get(item.id);
        // Prefer the version with more replies, or newer timestamp
        if (!existing) {
          map.set(item.id, item);
        } else {
          var aReplies = (existing.replies || []).length;
          var bReplies = (item.replies || []).length;
          if (bReplies > aReplies) map.set(item.id, item);
          else if (bReplies === aReplies && (item.timestamp || 0) > (existing.timestamp || 0)) {
            map.set(item.id, item);
          }
        }
      });
    });
    return Array.from(map.values()).sort(function(a, b) {
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
  }

  // Sync individual operations (idempotent on the server). The _ versions do the
  // request; the public ones run through serial() so writes stay in order.
  function syncPost(comment) { return serial(function() { return _syncPost(comment); }); }
  function syncPatch(patch) { return serial(function() { return _syncPatch(patch); }); }
  function syncDelete(id) { return serial(function() { return _syncDelete(id); }); }

  async function _syncPost(comment) {
    try {
      var res = await send(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, comment, { version: VERSION }))
      });
      if (res.ok) {
        queueRemove(LS_QUEUE_POST, comment.id);
        return true;
      }
    } catch (err) { /* network failure — stays in queue */ }
    return false;
  }
  async function _syncPatch(patch) {
    try {
      var res = await send(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, patch, { version: VERSION }))
      });
      // 404: someone deleted the comment; the edit has nothing left to apply to.
      if (res.ok || res.status === 404) {
        queueRemove(LS_QUEUE_PATCH, patch.id);
        return true;
      }
    } catch (err) {}
    return false;
  }
  async function _syncDelete(id) {
    try {
      var res = await send(apiDelete(id), { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        queueRemove(LS_QUEUE_DELETE, id);
        return true;
      }
    } catch (err) {}
    return false;
  }

  function flushQueues() {
    return serial(async function() {
      var posts = lsGet(LS_QUEUE_POST);
      for (var i = 0; i < posts.length; i++) await _syncPost(posts[i]);
      var patches = lsGet(LS_QUEUE_PATCH);
      for (var j = 0; j < patches.length; j++) await _syncPatch(patches[j]);
      var deletes = lsGet(LS_QUEUE_DELETE);
      for (var k = 0; k < deletes.length; k++) await _syncDelete(deletes[k].id);
    });
  }

  // Background flush every 30s
  setInterval(flushQueues, 30000);
  // Flush when network comes back
  window.addEventListener('online', flushQueues);
  // Flush before unload (best-effort)
  window.addEventListener('beforeunload', function() { flushQueues(); });

  // ══════════════════════════════════════════════
  //  Draw state
  // ══════════════════════════════════════════════
  let drawMode = false;
  let drawing = false;
  let currentStroke = [];
  let strokes = [];
  let drawColor = '#FF1493';
  let drawWidth = 3;
  let canvas, ctx;
  let eraseMode = false;     // erase sub-mode of draw: click a stroke to remove just that one
  let hoveredStroke = null;  // stroke currently under the cursor in erase mode (gets a halo)
  let eraseBtn = null;       // the Erase toggle in the draw palette (built by initColorPicker)

  const DRAW_COLORS = [
    { color: '#FF1493', label: 'Hot Pink' },
    { color: '#FF4444', label: 'Red' },
    { color: '#4488FF', label: 'Blue' },
    { color: '#44DD66', label: 'Green' },
    { color: '#FFD700', label: 'Yellow' },
    { color: '#FFFFFF', label: 'White' },
  ];

  const DRAW_SIZES = [
    { width: 2, dot: 4 },
    { width: 4, dot: 8 },
    { width: 8, dot: 12 },
  ];

  // ── API helpers ──
  function apiGet() {
    return API + '?v=' + encodeURIComponent(VERSION);
  }
  function apiDelete(id) {
    return API + '?v=' + encodeURIComponent(VERSION) + '&id=' + encodeURIComponent(id);
  }
  function apiClearAll() {
    return API + '?v=' + encodeURIComponent(VERSION) + '&all=true';
  }
  function strokesGet() {
    return STROKES_API + '?v=' + encodeURIComponent(VERSION);
  }
  function strokesDelete(id) {
    return STROKES_API + '?v=' + encodeURIComponent(VERSION) + '&id=' + encodeURIComponent(id);
  }
  function strokesClearAll() {
    return STROKES_API + '?v=' + encodeURIComponent(VERSION) + '&all=true';
  }

  // ── Coordinate helpers ──
  // Popovers are centred on their anchor (translate -50%), so one anchored near
  // a screen edge (a highlight that starts at the page's left margin) opens
  // half off-screen. Nudge it back inside the viewport after it renders.
  function keepInViewport(el) {
    var r = el.getBoundingClientRect(), m = 8, dx = 0;
    if (r.left < m) dx = m - r.left;
    else if (r.right > window.innerWidth - m) dx = window.innerWidth - m - r.right;
    if (dx) el.style.marginLeft = dx + 'px';
  }

  function pageToPercent(pageX, pageY) {
    // Use clientWidth/Height (body's padding box) to match what CSS % renders against.
    // scrollWidth/Height can be much larger than visible area on pages using
    // `margin: 0 -9999px` tricks for full-bleed sections — that throws pins ~99% left.
    return {
      x: (pageX / document.body.clientWidth) * 100,
      y: (pageY / document.body.clientHeight) * 100
    };
  }

  // ── Context capture (what the comment is pointing at) ──
  function captureContext(pageX, pageY) {
    var clientX = pageX - window.scrollX;
    var clientY = pageY - window.scrollY;
    var el = document.elementFromPoint(clientX, clientY);
    if (!el) return {};

    var ctx = {};

    // Before/after column detection
    var card = el.closest('.before-card, .after-card');
    if (card) {
      ctx.column = card.classList.contains('before-card') ? 'before' : 'after';
    }

    // Fig section label
    var section = el.closest('.article-section');
    if (section) {
      var label = section.querySelector('.article-section-label');
      if (label) ctx.section = label.textContent.trim().slice(0, 200);
    }

    // Nearest heading — walk backwards through DOM
    var heading = findNearestHeading(el);
    if (heading) ctx.heading = heading.textContent.trim().slice(0, 150);

    // Nearby text snippet from the element under the cursor
    var text = el.innerText || el.textContent || '';
    text = text.trim();
    if (text.length > 200) {
      // Try to find a more specific child
      for (var i = 0; i < el.children.length; i++) {
        var ct = (el.children[i].innerText || '').trim();
        if (ct.length > 0 && ct.length <= 200) { text = ct; break; }
      }
    }
    if (text) ctx.nearbyText = text.slice(0, 200);

    return ctx;
  }

  function findNearestHeading(el) {
    var hTags = { H1:1, H2:1, H3:1, H4:1, H5:1, H6:1 };
    var current = el;
    while (current && current !== document.body) {
      if (hTags[current.tagName]) return current;
      var prev = current.previousElementSibling;
      while (prev) {
        if (hTags[prev.tagName]) return prev;
        var nested = prev.querySelectorAll('h1,h2,h3,h4,h5,h6');
        if (nested.length) return nested[nested.length - 1];
        prev = prev.previousElementSibling;
      }
      current = current.parentElement;
    }
    return null;
  }

  // ── Author management ──
  function getAuthor() {
    return localStorage.getItem('fig-comment-author') || '';
  }
  function setAuthor(name) {
    localStorage.setItem('fig-comment-author', name);
  }

  function promptAuthor() {
    return new Promise(resolve => {
      const existing = getAuthor();
      if (existing) return resolve(existing);

      const overlay = document.createElement('div');
      overlay.className = 'author-overlay';
      overlay.innerHTML = `
        <div class="author-dialog">
          <h3>Your name for comments</h3>
          <input type="text" id="authorInput" placeholder="e.g. Brady" maxlength="50" autofocus>
          <button id="authorSubmit">Continue</button>
        </div>`;
      document.body.appendChild(overlay);

      const input = document.getElementById('authorInput');
      const submit = document.getElementById('authorSubmit');

      function done() {
        const name = input.value.trim() || 'Anonymous';
        setAuthor(name);
        overlay.remove();
        resolve(name);
      }
      submit.addEventListener('click', done);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); });
      input.focus();
    });
  }

  // ══════════════════════════════════════════════
  //  Toggle modes (mutually exclusive)
  // ══════════════════════════════════════════════
  const commentToggle = document.getElementById('commentToggle');
  const suggestToggle = document.getElementById('suggestToggle');
  const drawToggle = document.getElementById('drawToggle');
  const drawColors = document.getElementById('drawColors');
  const clearAllBtn = document.getElementById('clearAllComments');

  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', clearAllComments);
  }

  function deactivateComment() {
    commentMode = false;
    commentToggle.classList.remove('active');
    document.body.classList.remove('comment-mode');
  }
  function deactivateSuggest() {
    suggestMode = false;
    if (suggestToggle) suggestToggle.classList.remove('active');
    document.body.classList.remove('suggest-mode');
  }

  commentToggle.addEventListener('click', () => {
    if (drawMode) deactivateDraw();
    if (suggestMode) deactivateSuggest();

    commentMode = !commentMode;
    commentToggle.classList.toggle('active', commentMode);
    document.body.classList.toggle('comment-mode', commentMode);
    closeAllPopovers();
  });

  if (suggestToggle) suggestToggle.addEventListener('click', () => {
    if (drawMode) deactivateDraw();
    if (commentMode) { deactivateComment(); closeAllPopovers(); }

    suggestMode = !suggestMode;
    suggestToggle.classList.toggle('active', suggestMode);
    document.body.classList.toggle('suggest-mode', suggestMode);
    closeAllPopovers();
  });

  drawToggle.addEventListener('click', () => {
    if (commentMode) { deactivateComment(); closeAllPopovers(); }
    if (suggestMode) { deactivateSuggest(); closeAllPopovers(); }

    drawMode = !drawMode;
    drawToggle.classList.toggle('active', drawMode);
    document.body.classList.toggle('draw-mode', drawMode);
    drawColors.classList.toggle('visible', drawMode);
    if (!drawMode) setErase(false);
  });

  function deactivateDraw() {
    drawMode = false;
    setErase(false);
    drawToggle.classList.remove('active');
    document.body.classList.remove('draw-mode');
    drawColors.classList.remove('visible');
  }

  // ── Close helpers ──
  function closeAllPopovers() {
    document.querySelectorAll('.comment-popover, .comment-detail').forEach(el => el.remove());
    openPopover = null;
    clearPendingHighlight();
  }

  // Yellow boxes over the text a suggestion is being written for: drawn while
  // dragging inside buttons/links (where browsers paint no selection) and kept
  // while the composer is open, since focusing its textarea clears the selection.
  function clearPendingHighlight() {
    document.querySelectorAll('.fig-pending-hl').forEach(function(el) { el.remove(); });
  }
  function showPendingHighlight(range) {
    clearPendingHighlight();
    if (!range || range.collapsed) return;
    var host = range.commonAncestorContainer;
    if (host.nodeType === 3) host = host.parentElement;
    var fixed = false;
    for (var a = host; a && a !== document.body; a = a.parentElement) {
      if (getComputedStyle(a).position === 'fixed') { fixed = true; break; }
    }
    var box = document.createElement('div');
    box.className = 'fig-pending-hl' + (fixed ? ' is-fixed' : '');
    var dx = fixed ? 0 : window.scrollX, dy = fixed ? 0 : window.scrollY;
    Array.prototype.forEach.call(range.getClientRects(), function(r) {
      if (r.width < 1 || r.height < 1) return;
      var hl = document.createElement('span');
      hl.style.left = (r.left + dx) + 'px'; hl.style.top = (r.top + dy) + 'px';
      hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px';
      box.appendChild(hl);
    });
    document.body.appendChild(box);
  }

  // ══════════════════════════════════════════════
  //  Comment system
  // ══════════════════════════════════════════════

  // ── Place comment on click ──
  async function placeCommentOnClick(e) {
    if (!commentMode) return;
    // A popover button (Edit / Approve / Reject) may have rebuilt the popover via
    // innerHTML mid-dispatch, detaching e.target. A detached node's closest() returns
    // null, which would wrongly pass the exclusion below and drop a STRAY new comment
    // (reported 2026-06-17: clicking "Edit" opened a new comment box). Mirror the
    // close-popover handler's guard and bail when the target is no longer in the DOM.
    if (!e.target.isConnected) return;
    if (e.target.closest('.fig-toolbar, .comment-popover, .comment-detail, .comment-pin, .author-overlay')) return;

    closeAllPopovers();

    const { x: xPct, y: yPct } = pageToPercent(e.pageX, e.pageY);
    const commentContext = captureContext(e.pageX, e.pageY);
    const author = await promptAuthor();

    const popover = document.createElement('div');
    popover.className = 'comment-popover';
    popover.style.left = xPct + '%';
    popover.style.top = yPct + '%';
    popover.innerHTML = `
      <textarea class="comment-popover-input" rows="3" placeholder="Leave a comment..." autofocus></textarea>
      <div class="comment-popover-hint">Press Enter to save &middot; Esc to cancel</div>`;
    document.body.appendChild(popover);
    keepInViewport(popover);

    const textarea = popover.querySelector('textarea');
    textarea.focus();

    textarea.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        popover.remove();
        return;
      }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        const text = textarea.value.trim();
        if (!text) { popover.remove(); return; }

        // Client-generated ID — POST is idempotent so safe to retry
        var comment = {
          id: genId(),
          x: xPct, y: yPct, text: text, author: author,
          timestamp: Date.now(), context: commentContext
        };

        // 1. Show locally immediately (optimistic UI)
        comments.push(comment);
        backupToLocal();
        renderPin(comment, comments.length);
        popover.remove();

        // 2. Add to retry queue (in case the POST fails)
        queueAdd(LS_QUEUE_POST, comment);

        // 3. Try to sync now (queue removes on success)
        syncPost(comment);
      }
    });
  }
  document.addEventListener('click', placeCommentOnClick);

  // ══════════════════════════════════════════════
  //  Suggest mode — text-anchored accuracy feedback
  //  Reviewer drag-selects text → highlight + anchored note with a status
  //  (open → diagnosed → approved → applied). Anchors use a text-quote
  //  selector (quote + prefix/suffix) so they re-locate on reload.
  // ══════════════════════════════════════════════
  // The whole page is suggestable (header, nav and footer included); fig's own UI is not.
  var FIG_UI = '.fig-toolbar,.comment-detail,.comment-popover,.comment-pin,.author-overlay,.fig-onboard,.draw-colors,.fig-draw-canvas,.fig-pending-hl,.fig-toast';
  function getContentRoot() { return document.body; }

  function buildTextIndex() {
    var nodes = [], text = '';
    var tw = document.createTreeWalker(getContentRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && n.parentElement.closest(FIG_UI + ',script,style,noscript,template'))
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n; while ((n = tw.nextNode())) { nodes.push({ node: n, start: text.length }); text += n.nodeValue; }
    return { nodes: nodes, text: text };
  }

  function rangeFromOffsets(idx, start, end) {
    var sNode, sOff, eNode, eOff;
    for (var i = 0; i < idx.nodes.length; i++) {
      var e = idx.nodes[i], nEnd = e.start + e.node.nodeValue.length;
      if (sNode == null && start < nEnd) { sNode = e.node; sOff = start - e.start; }
      if (sNode != null && end <= nEnd) { eNode = e.node; eOff = end - e.start; break; }
    }
    if (!sNode || !eNode) return null;
    var r = document.createRange();
    try { r.setStart(sNode, Math.max(0, sOff)); r.setEnd(eNode, Math.max(0, eOff)); } catch (e) { return null; }
    return r;
  }

  function anchorFromRange(range) {
    var idx = buildTextIndex();
    function offsetOf(node, off) {
      for (var i = 0; i < idx.nodes.length; i++) if (idx.nodes[i].node === node) return idx.nodes[i].start + off;
      return -1;
    }
    var s = offsetOf(range.startContainer, range.startOffset);
    var e = offsetOf(range.endContainer, range.endOffset);
    if (s < 0 || e < 0 || e <= s) return { quote: range.toString().trim(), prefix: '', suffix: '' };
    return { quote: idx.text.slice(s, e), prefix: idx.text.slice(Math.max(0, s - 40), s), suffix: idx.text.slice(e, e + 40) };
  }

  function locate(anchor) {
    if (!anchor || !anchor.quote) return null;
    var idx = buildTextIndex();
    var needle = (anchor.prefix || '') + anchor.quote + (anchor.suffix || ''), qs;
    var pos = idx.text.indexOf(needle);
    if (pos >= 0) { qs = pos + (anchor.prefix || '').length; }
    else { pos = idx.text.indexOf(anchor.quote); if (pos < 0) return null; qs = pos; }
    return rangeFromOffsets(idx, qs, qs + anchor.quote.length);
  }

  function wrapRange(range, id, status) {
    var marks = [], root = range.commonAncestorContainer;
    if (root.nodeType === 3) root = root.parentNode;
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        return (n.nodeValue && n.nodeValue.length && range.intersectsNode(n))
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var list = [], n; while ((n = tw.nextNode())) list.push(n);
    list.forEach(function(node) {
      var s = node === range.startContainer ? range.startOffset : 0;
      var e = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (s >= e) return;
      // In a flex/grid parent (a button laid out with inline-flex + gap) every
      // split piece becomes its own flex item, so the gap opens up mid-word.
      // Keep the pieces together in one inline wrapper first.
      var par = node.parentNode;
      if (par && par.nodeType === 1 && !par.classList.contains('fig-flow') &&
          /(flex|grid)/.test(getComputedStyle(par).display)) {
        var flow = document.createElement('span');
        flow.className = 'fig-flow';
        par.insertBefore(flow, node); flow.appendChild(node);
      }
      var mid = s > 0 ? node.splitText(s) : node;
      if (e - s < mid.nodeValue.length) mid.splitText(e - s);
      var mark = document.createElement('mark');
      mark.className = 'fig-suggest'; mark.dataset.commentId = id; mark.dataset.status = status || 'open';
      mid.parentNode.insertBefore(mark, mid); mark.appendChild(mid);
      marks.push(mark);
    });
    return marks;
  }

  function unwrapMark(m) {
    var p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize();
    // Drop the flex wrapper wrapRange added once no highlight is left inside it.
    if (p.classList && p.classList.contains('fig-flow') && !p.querySelector('mark.fig-suggest')) {
      var g = p.parentNode; while (p.firstChild) g.insertBefore(p.firstChild, p); g.removeChild(p); g.normalize();
    }
  }

  function unwrapSuggestion(id) {
    document.querySelectorAll('mark.fig-suggest[data-comment-id="' + id + '"]').forEach(unwrapMark);
  }

  function setStatus(comment, status) {
    comment.status = status; backupToLocal();
    syncPatch(queuePatch({ id: comment.id, status: status }));
    document.querySelectorAll('mark.fig-suggest[data-comment-id="' + comment.id + '"]')
      .forEach(function(m) { m.dataset.status = status; });
  }

  function anchorSuggestion(comment) {
    var range = comment.anchor ? locate(comment.anchor) : null;
    if (!range) return false;
    var marks = wrapRange(range, comment.id, comment.status || 'open');
    marks.forEach(function(m) {
      m.addEventListener('click', function(ev) {
        if (suggestMode || drawMode) return;
        ev.preventDefault(); ev.stopPropagation(); showDetail(comment, m);
      });
    });
    if (!marks.length) return false;
    comment._anchored = true;
    return true;
  }

  function renderSuggestion(comment) {
    if (anchorSuggestion(comment)) return;
    // Orphaned (text changed / not found): keep it visible as a pin so feedback isn't lost.
    comment._orphan = true;
    renderPin(comment, comments.indexOf(comment) + 1);
  }

  // Dynamic pages (rotating text, scroll-driven sections, React re-renders)
  // replace the text a highlight was wrapped around, which drops the <mark>.
  // Watch the content for changes and re-apply any suggestion whose highlight
  // is gone once its text is back on the page. An orphan pin is swapped for
  // the highlight as soon as its text reappears.
  function reanchorSuggestions() {
    comments.forEach(function(c) {
      if (c.kind !== 'suggest' || !c.anchor) return;
      if (document.querySelector('mark.fig-suggest[data-comment-id="' + c.id + '"]')) return;
      if (!anchorSuggestion(c)) return;
      if (c._orphan) {
        c._orphan = false;
        document.querySelectorAll('.comment-pin[data-comment-id="' + c.id + '"]')
          .forEach(function(pin) { pin.remove(); });
      }
    });
  }
  var reanchorTimer = null;
  new MutationObserver(function(muts) {
    function isFig(n) {
      var el = n && (n.nodeType === 3 ? n.parentElement : n);
      return !!(el && el.closest && el.closest(FIG_UI + ',mark.fig-suggest'));
    }
    var external = muts.some(function(m) {
      if (m.type === 'childList') {
        var changed = Array.prototype.slice.call(m.addedNodes).concat(Array.prototype.slice.call(m.removedNodes));
        if (changed.length && changed.every(isFig)) return false;
      }
      return !isFig(m.target);
    });
    if (!external) return;
    clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(reanchorSuggestions, 150);
  }).observe(getContentRoot(), { childList: true, subtree: true, characterData: true });

  // Capture a text selection in suggest mode and open the anchored composer.
  document.addEventListener('mouseup', function(e) {
    if (!suggestMode) return;
    if (e.target.closest && e.target.closest(FIG_UI)) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (range.collapsed || !range.toString().trim()) return;
    if (!getContentRoot().contains(range.commonAncestorContainer)) return;
    openSuggestComposer(range);
  });

  // Buttons and links: dragging across them drags the link (or, for <button>,
  // selects nothing) and the release clicks through. In suggest mode a click on
  // one suggests its whole label instead, and nothing navigates or submits.
  var SUGGEST_CLICKABLE = 'a,button,[role="button"],input[type="submit"],input[type="button"],summary,label';
  var lastComposerAt = 0;
  // Browsers won't drag-select inside a link or <button> (Safari never; Chrome
  // only sometimes), so suggest mode drives that selection itself from the caret
  // under the pointer. A drag picks exactly those letters; a plain click falls
  // through to the whole-label handler below.
  function caretAt(x, y) {
    var node, off;
    if (document.caretPositionFromPoint) {
      var cp = document.caretPositionFromPoint(x, y); if (cp) { node = cp.offsetNode; off = cp.offset; }
    } else if (document.caretRangeFromPoint) {
      var cr = document.caretRangeFromPoint(x, y); if (cr) { node = cr.startContainer; off = cr.startOffset; }
    }
    return (node && node.nodeType === 3) ? { node: node, off: off } : null;
  }
  var dragSel = null;
  document.addEventListener('mousedown', function(e) {
    dragSel = null;
    if (!suggestMode || e.button !== 0 || !e.target.closest) return;
    if (e.target.closest(FIG_UI) || !e.target.closest(SUGGEST_CLICKABLE)) return;
    e.preventDefault();   // no link drag, no button focus, no native selection
    var c = caretAt(e.clientX, e.clientY);
    window.getSelection().removeAllRanges();
    clearPendingHighlight();
    if (c) dragSel = c;
  }, true);
  document.addEventListener('mousemove', function(e) {
    if (!dragSel || !(e.buttons & 1)) return;
    var c = caretAt(e.clientX, e.clientY); if (!c) return;
    var sel = window.getSelection();
    sel.setBaseAndExtent(dragSel.node, dragSel.off, c.node, c.off);
    if (sel.rangeCount) showPendingHighlight(sel.getRangeAt(0));
  }, true);
  document.addEventListener('mouseup', function() { dragSel = null; }, true);
  function suggestOnClick(e) {
    if (!suggestMode || !e.target.closest) return;
    if (e.target.closest(FIG_UI)) return;
    var el = e.target.closest(SUGGEST_CLICKABLE);
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    if (Date.now() - lastComposerAt < 400) return;   // a drag-selection just opened the composer
    // Bound the range by text nodes so the anchor carries prefix/suffix context.
    var tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) { return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
    });
    var first = tw.nextNode(), last = first, n;
    if (!first) return;
    while ((n = tw.nextNode())) last = n;
    var range = document.createRange();
    range.setStart(first, first.nodeValue.search(/\S/));
    range.setEnd(last, last.nodeValue.replace(/\s+$/, '').length);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    openSuggestComposer(range);
  }
  document.addEventListener('click', suggestOnClick, true);

  async function openSuggestComposer(range) {
    lastComposerAt = Date.now();
    var sel = window.getSelection();
    var anchor = anchorFromRange(range);
    var rect = range.getBoundingClientRect();
    var pct = pageToPercent(rect.right + window.scrollX, rect.top + window.scrollY);
    var author = await promptAuthor();

    closeAllPopovers();
    var pop = document.createElement('div');
    pop.className = 'comment-popover suggest-popover';
    pop.style.left = pct.x + '%'; pop.style.top = pct.y + '%';
    pop.innerHTML =
      '<div class="suggest-quote">“' + escapeHtml(anchor.quote.slice(0, 180)) + '”</div>' +
      '<textarea class="comment-popover-input" rows="3" placeholder="What is inaccurate or needs changing?"></textarea>' +
      '<div class="comment-popover-hint">Enter to save · Esc to cancel</div>';
    document.body.appendChild(pop);
    keepInViewport(pop);
    showPendingHighlight(range);
    var ta = pop.querySelector('textarea'); ta.focus();
    ta.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); pop.remove(); clearPendingHighlight(); return; }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        var text = ta.value.trim(); if (!text) { pop.remove(); clearPendingHighlight(); return; }
        var comment = {
          id: genId(), kind: 'suggest', status: 'open',
          x: pct.x, y: pct.y, text: text, author: author,
          anchor: anchor, timestamp: Date.now()
        };
        comments.push(comment); backupToLocal();
        if (sel) sel.removeAllRanges();
        renderSuggestion(comment);
        pop.remove(); clearPendingHighlight();
        queueAdd(LS_QUEUE_POST, comment); syncPost(comment);
      }
    });
  }

  // ── Render pins ──
  function renderPin(comment, index) {
    const pin = document.createElement('div');
    pin.className = 'comment-pin';
    pin.dataset.commentId = comment.id;
    pin.style.left = comment.x + '%';
    pin.style.top = comment.y + '%';
    pin.textContent = index;

    // ── Drag handling ──
    pin.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAllPopovers();
      dragState = {
        pin,
        comment,
        startX: e.pageX,
        startY: e.pageY,
        moved: false
      };
      pin.classList.add('dragging');
    });

    pin.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.body.appendChild(pin);
  }

  // ── Global drag listeners ──
  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.pageX - dragState.startX;
    const dy = e.pageY - dragState.startY;
    if (!dragState.moved && Math.abs(dx) + Math.abs(dy) > 4) {
      dragState.moved = true;
    }
    if (dragState.moved) {
      const { x, y } = pageToPercent(e.pageX, e.pageY);
      dragState.pin.style.left = x + '%';
      dragState.pin.style.top = y + '%';
    }
  });

  document.addEventListener('mouseup', async (e) => {
    if (!dragState) return;
    const { pin, comment, moved } = dragState;
    pin.classList.remove('dragging');

    if (moved) {
      const { x, y } = pageToPercent(e.pageX, e.pageY);
      comment.x = x;
      comment.y = y;
      pin.style.left = x + '%';
      pin.style.top = y + '%';

      backupToLocal();
      syncPatch(queuePatch({ id: comment.id, x: x, y: y }));
    } else {
      showDetail(comment, pin);
    }

    dragState = null;
  });

  // ── Show comment detail popover ──
  function showDetail(comment, pin) {
    closeAllPopovers();

    const detail = document.createElement('div');
    detail.className = 'comment-detail';
    // Anchor the popover to the clicked element (the suggestion highlight or the
    // pin) so it opens next to the text, not at the stored fallback coords. Stored
    // x/y are only the orphan fallback (seeded suggestions, or text that moved).
    if (pin && typeof pin.getBoundingClientRect === 'function' && pin.isConnected) {
      var pr = pin.getBoundingClientRect();
      var pp = pageToPercent(pr.left + window.scrollX, pr.bottom + window.scrollY);
      detail.style.left = pp.x + '%';
      detail.style.top = pp.y + '%';
    } else {
      detail.style.left = comment.x + '%';
      detail.style.top = comment.y + '%';
    }

    const date = new Date(comment.timestamp);
    const timeStr = date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });

    // Build replies HTML
    let repliesHtml = '';
    if (comment.replies && comment.replies.length) {
      repliesHtml = '<div class="fig-replies">';
      comment.replies.forEach(r => {
        const rd = new Date(r.timestamp);
        const rt = rd.toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        repliesHtml += `<div class="fig-reply"><div><div class="fig-reply-text">${escapeHtml(r.text)}</div><div class="fig-reply-meta"><strong>${escapeHtml(r.author)}</strong> · ${rt}</div></div><button class="reply-delete-btn" data-reply-id="${r.id}" title="Delete reply">&times;</button></div>`;
      });
      repliesHtml += '</div>';
    }

    let suggestHtml = '';
    if (comment.kind === 'suggest') {
      const st = comment.status || 'open';
      suggestHtml = `
        <div class="suggest-detail-quote">&ldquo;${escapeHtml(((comment.anchor && comment.anchor.quote) || '').slice(0, 180))}&rdquo;</div>
        <div class="suggest-status-row">
          <span class="suggest-status-badge st-${st}">${STATUS_LABELS[st] || st}</span>
          ${comment._orphan ? '<span class="suggest-orphan" title="The underlying text changed; this feedback could not be re-anchored.">&#9888; text moved</span>' : ''}
        </div>
        ${comment.diagnosis ? `<div class="suggest-diagnosis"><div class="suggest-diagnosis-label">Proposed change</div>${escapeHtml(comment.diagnosis)}</div>` : ''}
        ${st === 'diagnosed' ? `<div class="suggest-approve-row"><button class="suggest-approve" data-id="${comment.id}">&#10003; Approve</button><button class="suggest-reject" data-id="${comment.id}">&#10005; Reject</button></div>` : ''}`;
    }

    detail.innerHTML = `
      ${suggestHtml}
      <div class="comment-detail-text">${escapeHtml(comment.text)}</div>
      <div class="comment-detail-meta"><strong>${escapeHtml(comment.author)}</strong> &middot; ${timeStr}</div>
      ${repliesHtml}
      <div style="margin-top:8px;">
        <textarea class="comment-popover-input" rows="1" placeholder="Reply..." style="font-size:12px;padding:7px 10px;"></textarea>
      </div>
      <div class="comment-detail-actions">
        <button class="comment-detail-edit" data-id="${comment.id}">Edit</button>
        <button class="comment-detail-delete" data-id="${comment.id}">Delete</button>
      </div>`;
    document.body.appendChild(detail);
    keepInViewport(detail);
    openPopover = detail;

    // ── Suggest status: Approve / Reject ──
    const apprBtn = detail.querySelector('.suggest-approve');
    if (apprBtn) apprBtn.addEventListener('click', () => {
      setStatus(comment, 'approved'); detail.remove(); openPopover = null; showDetail(comment, pin);
    });
    const rejBtn = detail.querySelector('.suggest-reject');
    if (rejBtn) rejBtn.addEventListener('click', () => {
      setStatus(comment, 'rejected'); detail.remove(); openPopover = null; showDetail(comment, pin);
    });

    // ── Reply handler ──
    const replyInput = detail.querySelector('.comment-popover-input');
    replyInput.addEventListener('click', (e) => e.stopPropagation());
    replyInput.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        const replyText = replyInput.value.trim();
        if (!replyText) return;
        const author = getAuthor() || 'Anonymous';
        try {
          // Through serial(): the parent's own create (if still pending) lands first.
          const res = await serial(() => send(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: genId(), text: replyText, author, parentId: comment.id, version: VERSION })
          }));
          if (!res.ok) throw new Error('Reply failed');
          const reply = await res.json();
          if (!comment.replies) comment.replies = [];
          comment.replies.push(reply);
          detail.remove();
          openPopover = null;
          showDetail(comment, pin);
        } catch (err) {
          replyInput.style.borderColor = '#8a3b2e';
          console.error('Failed to save reply:', err);
        }
      }
    });

    // ── Reply delete handlers ──
    detail.querySelectorAll('.reply-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const replyId = btn.dataset.replyId;
        try {
          const res = await serial(() => send(apiDelete(replyId), { method: 'DELETE' }));
          if (!res.ok && res.status !== 404) throw new Error('DELETE reply ' + res.status);
          if (comment.replies) comment.replies = comment.replies.filter(r => r.id !== replyId);
          detail.remove();
          openPopover = null;
          showDetail(comment, pin);
        } catch (err) {
          console.error('Failed to delete reply:', err);
          figToast('That reply could not be deleted. Please try again.');
        }
      });
    });

    // ── Edit handler ──
    detail.querySelector('.comment-detail-edit').addEventListener('click', () => {
      const textEl = detail.querySelector('.comment-detail-text');
      const actionsEl = detail.querySelector('.comment-detail-actions');
      const metaEl = detail.querySelector('.comment-detail-meta');

      const textarea = document.createElement('textarea');
      textarea.className = 'comment-edit-input';
      textarea.rows = 3;
      textarea.value = comment.text;
      textEl.replaceWith(textarea);
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      actionsEl.innerHTML = `
        <button class="comment-edit-save">Save</button>
        <button class="comment-edit-cancel">Cancel</button>`;
      metaEl.style.display = 'none';

      async function saveEdit() {
        const newText = textarea.value.trim();
        if (!newText) return;
        comment.text = newText;
        backupToLocal();
        syncPatch(queuePatch({ id: comment.id, text: newText }));
        detail.remove();
        openPopover = null;
        showDetail(comment, pin);
      }

      function cancelEdit() {
        detail.remove();
        openPopover = null;
        showDetail(comment, pin);
      }

      actionsEl.querySelector('.comment-edit-save').addEventListener('click', saveEdit);
      actionsEl.querySelector('.comment-edit-cancel').addEventListener('click', cancelEdit);
      textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); saveEdit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelEdit(); }
      });
    });

    // ── Delete handler ──
    detail.querySelector('.comment-detail-delete').addEventListener('click', async () => {
      // Optimistic delete + queue
      queueAdd(LS_QUEUE_DELETE, { id: comment.id });
      // Also remove from POST queue if it was never synced
      queueRemove(LS_QUEUE_POST, comment.id);
      queueRemove(LS_QUEUE_PATCH, comment.id);
      syncDelete(comment.id);
      comments = comments.filter(c => c.id !== comment.id);
      backupToLocal();
      if (comment.kind === 'suggest') { unwrapSuggestion(comment.id); if (pin && pin.classList && pin.classList.contains('comment-pin')) pin.remove(); }
      else if (pin) pin.remove();
      detail.remove();
      renumberPins();
    });
  }

  // Number pins by comment order (oldest first), not by when this browser
  // happened to draw them, so every reviewer sees the same numbers.
  function renumberPins() {
    let n = 0;
    comments.forEach(c => {
      const pin = document.querySelector('.comment-pin[data-comment-id="' + c.id + '"]');
      if (pin) pin.textContent = ++n;
    });
  }

  // Small notice for a write that failed, so nothing fails silently.
  function figToast(msg) {
    var t = document.createElement('div');
    t.className = 'fig-toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.remove(); }, 6000);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Close popover on outside click ──
  function closeOnOutsideClick(e) {
    if (!openPopover) return;
    // If the clicked element was detached mid-handler (Edit/Approve/Reply rebuild
    // the popover's buttons via innerHTML, removing e.target), closest() returns
    // null and would falsely read as an outside click. Skip detached targets so
    // the popover doesn't vanish when its own buttons are used.
    if (!e.target.isConnected) return;
    if (!e.target.closest('.comment-detail, .comment-pin, mark.fig-suggest, .comment-popover')) {
      closeAllPopovers();
    }
  }
  document.addEventListener('click', closeOnOutsideClick);

  // ── While a tool is on, the page under review is inert ──
  // Comment, suggest or draw mode: no click, hover, focus, key press or form
  // submit reaches the site (no lightbox, no link, no hover preview, no form).
  // Fig's own UI is untouched. Window-capture runs before every page listener;
  // fig's own click handlers are then called directly, so only the tool acts.
  function anyMode() { return commentMode || suggestMode || drawMode; }
  function onPage(e) {
    var t = e.target;
    if (t && t.nodeType === 3) t = t.parentElement;
    return !!(t && t.closest && !t.closest(FIG_UI + ',.fig-replies'));
  }
  window.addEventListener('click', function(e) {
    if (!anyMode() || !onPage(e)) return;
    e.preventDefault(); e.stopPropagation();
    suggestOnClick(e); placeCommentOnClick(e); closeOnOutsideClick(e);
  }, true);
  ['dblclick', 'auxclick', 'contextmenu', 'submit', 'focusin', 'focus',
   'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
   'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointerdown', 'pointerup',
   'touchstart', 'touchend', 'dragstart', 'change', 'input'].forEach(function(type) {
    window.addEventListener(type, function(e) {
      if (!anyMode() || !onPage(e)) return;
      if (type === 'dragstart' || type === 'submit' || type === 'dblclick' || type === 'auxclick') e.preventDefault();
      e.stopPropagation();
    }, true);
  });
  window.addEventListener('keydown', function(e) {
    if (!anyMode() || !onPage(e) || e.key === 'Escape') return;   // Esc still closes boxes / exits the tool
    e.preventDefault(); e.stopPropagation();
  }, true);

  // ── Close on Escape ──
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Esc with a box open closes just the box. Leaving the mode as well made the
      // next click on a button follow its link, which jumped reviewers off the spot.
      if (document.querySelector('.comment-popover, .comment-detail')) { closeAllPopovers(); return; }
      closeAllPopovers();
      if (drawMode) deactivateDraw();
      if (commentMode) deactivateComment();
      if (suggestMode) deactivateSuggest();
    }
  });

  // ══════════════════════════════════════════════
  //  Draw system
  // ══════════════════════════════════════════════

  function initCanvas() {
    canvas = document.createElement('canvas');
    canvas.className = 'fig-draw-canvas';
    canvas.width = document.body.scrollWidth;
    canvas.height = document.body.scrollHeight;
    canvas.style.width = document.body.scrollWidth + 'px';
    canvas.style.height = document.body.scrollHeight + 'px';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Resize canvas when page dimensions change
    const ro = new ResizeObserver(() => {
      const w = document.body.scrollWidth;
      const h = document.body.scrollHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        redrawAll();
      }
    });
    ro.observe(document.body);
  }

  function percentToPixel(xPct, yPct) {
    return {
      x: (xPct / 100) * canvas.width,
      y: (yPct / 100) * canvas.height
    };
  }

  function pixelToPercent(px, py) {
    return {
      x: (px / canvas.width) * 100,
      y: (py / canvas.height) * 100
    };
  }

  function drawStrokePath(points, color, width) {
    if (points.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    const start = percentToPixel(points[0].x, points[0].y);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < points.length; i++) {
      const pt = percentToPixel(points[i].x, points[i].y);
      ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
  }

  function redrawAll() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes.forEach(s => {
      // In erase mode, draw a soft red halo behind the stroke the cursor is over
      // so it's obvious which one a click will remove.
      if (s === hoveredStroke) {
        drawStrokePath(s.points, 'rgba(224,96,96,0.45)', (s.width || drawWidth) + 10);
      }
      drawStrokePath(s.points, s.color, s.width);
    });
  }

  // ── Erase: hit-test a click against every stroke's polyline ──
  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Return the nearest stroke whose path passes within a small threshold of (pageX,pageY),
  // or null. pageX/pageY are page pixels, which equal canvas pixels (canvas covers the body 1:1).
  function strokeAtPoint(pageX, pageY) {
    let best = null, bestDist = Infinity;
    for (const s of strokes) {
      const pts = s.points.map(p => percentToPixel(p.x, p.y));
      const thresh = Math.max(12, (s.width || drawWidth) + 10);
      if (pts.length === 1) {
        const d = Math.hypot(pageX - pts[0].x, pageY - pts[0].y);
        if (d < thresh && d < bestDist) { bestDist = d; best = s; }
        continue;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(pageX, pageY, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        if (d < thresh && d < bestDist) { bestDist = d; best = s; }
      }
    }
    return best;
  }

  function setErase(on) {
    eraseMode = !!on;
    if (eraseBtn) {
      eraseBtn.style.background = eraseMode ? '#1a1a1a' : 'none';
      eraseBtn.style.color = eraseMode ? '#fafaf8' : '#1a1a1a';
      eraseBtn.style.borderColor = eraseMode ? '#1a1a1a' : '#555';
    }
    if (canvas) canvas.style.cursor = eraseMode ? 'crosshair' : '';
    if (!eraseMode) { hoveredStroke = null; redrawAll(); }
  }

  // Optimistically remove the stroke locally, then delete it on the server by id.
  const erasing = new Set();   // ids mid-delete: a refresh must not bring them back
  async function eraseStroke(s) {
    if (!s) return;
    let id = s.id;
    strokes = strokes.filter(x => x !== s);
    if (hoveredStroke === s) hoveredStroke = null;
    redrawAll();
    if (!id && s._saving) { await s._saving; }   // still saving: let it land, then delete it
    if (!s.id) return;                             // never saved; local removal is enough
    id = s.id;
    erasing.add(id);
    try {
      const res = await serial(() => send(strokesDelete(id), { method: 'DELETE' }));
      if (!res.ok) throw new Error('DELETE stroke ' + res.status);
    } catch (err) {
      console.error('Failed to delete stroke:', err);
      strokes.push(s);
      redrawAll();
      figToast('That drawing could not be erased. Please try again.');
    } finally {
      erasing.delete(id);
    }
  }

  // ── Canvas mouse events ──
  function onCanvasDown(e) {
    if (!drawMode) return;
    if (e.target !== canvas) return;
    if (eraseMode) {
      e.preventDefault();
      const s = strokeAtPoint(e.pageX, e.pageY);
      if (s) eraseStroke(s);
      return;
    }
    e.preventDefault();
    drawing = true;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left + window.scrollX * 0;
    const py = e.clientY - rect.top + window.scrollY * 0;
    // Use pageX/pageY relative to canvas position (which is at 0,0 of body)
    const pt = pixelToPercent(e.pageX, e.pageY);
    currentStroke = [pt];
    ctx.beginPath();
    ctx.strokeStyle = drawColor;
    ctx.lineWidth = drawWidth;
    const pixel = percentToPixel(pt.x, pt.y);
    ctx.moveTo(pixel.x, pixel.y);
  }

  function onCanvasMove(e) {
    if (eraseMode) {
      if (!drawMode || e.target !== canvas) {
        if (hoveredStroke) { hoveredStroke = null; redrawAll(); }
        return;
      }
      const s = strokeAtPoint(e.pageX, e.pageY);
      if (s !== hoveredStroke) { hoveredStroke = s; redrawAll(); }
      if (canvas) canvas.style.cursor = s ? 'pointer' : 'crosshair';
      return;
    }
    if (!drawing) return;
    e.preventDefault();
    const pt = pixelToPercent(e.pageX, e.pageY);
    currentStroke.push(pt);
    const pixel = percentToPixel(pt.x, pt.y);
    ctx.lineTo(pixel.x, pixel.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pixel.x, pixel.y);
  }

  async function onCanvasUp(e) {
    if (!drawing) return;
    drawing = false;
    if (currentStroke.length < 2) return;

    const author = getAuthor() || 'Anonymous';
    const stroke = {
      id: undefined,          // set once saved; the request carries clientId so retries can't duplicate it
      clientId: genId(),
      points: currentStroke,
      color: drawColor,
      width: drawWidth,
      author
    };

    // Show it right away, then save; on failure take it back off and say so.
    strokes.push(stroke);
    currentStroke = [];
    let done; stroke._saving = new Promise(r => { done = r; });
    try {
      const res = await serial(() => send(STROKES_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: stroke.clientId, points: stroke.points, color: stroke.color, width: stroke.width, author: stroke.author, version: VERSION })
      }));
      if (!res.ok) throw new Error('POST stroke ' + res.status);
      Object.assign(stroke, await res.json());
    } catch (err) {
      console.error('Failed to save stroke:', err);
      strokes = strokes.filter(x => x !== stroke);
      redrawAll();
      figToast('That drawing did not save. Please draw it again.');
    } finally {
      done(); delete stroke._saving;
    }
  }

  // ── Color picker ──
  function initColorPicker() {
    const picker = document.getElementById('drawColors');

    DRAW_COLORS.forEach(({ color, label }) => {
      const btn = document.createElement('button');
      btn.className = 'draw-color-btn' + (color === drawColor ? ' active' : '');
      btn.style.background = color;
      btn.title = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        drawColor = color;
        setErase(false); // picking a color returns to drawing
        picker.querySelectorAll('.draw-color-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      picker.appendChild(btn);
    });

    // Size buttons separator
    const sep = document.createElement('div');
    sep.style.cssText = 'width:1px;height:20px;background:#444;flex-shrink:0;';
    picker.appendChild(sep);

    // Size buttons
    DRAW_SIZES.forEach(({ width, dot }, i) => {
      const btn = document.createElement('button');
      btn.className = 'draw-size-btn' + (i === 0 ? ' active' : '');
      btn.title = width + 'px';
      const dotEl = document.createElement('div');
      dotEl.className = 'draw-size-dot';
      dotEl.style.width = dot + 'px';
      dotEl.style.height = dot + 'px';
      btn.appendChild(dotEl);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        drawWidth = width;
        setErase(false); // picking a size returns to drawing
        picker.querySelectorAll('.draw-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      picker.appendChild(btn);
    });

    // Separator before erase/clear
    const sep2 = document.createElement('div');
    sep2.style.cssText = 'width:1px;height:20px;background:#444;flex-shrink:0;';
    picker.appendChild(sep2);

    // Erase toggle: click a single stroke to remove just that one (vs. Clear = all).
    eraseBtn = document.createElement('button');
    eraseBtn.className = 'draw-erase-btn';
    eraseBtn.textContent = 'Erase';
    eraseBtn.title = 'Erase one drawing — toggle on, then click any stroke to remove it';
    eraseBtn.style.cssText = 'background:none;border:1px solid #555;color:#1a1a1a;font-size:10px;'
      + 'font-weight:500;letter-spacing:.02em;padding:3px 9px;border-radius:6px;cursor:pointer;'
      + 'flex-shrink:0;transition:background .15s,color .15s,border-color .15s;';
    eraseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setErase(!eraseMode);
    });
    picker.appendChild(eraseBtn);

    // Clear all button
    const clearBtn = document.createElement('button');
    clearBtn.className = 'draw-clear-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Team pages: Clear removes only this reviewer's drawings, never everyone's.
      if (document.body.getAttribute('data-fig-clear') === 'mine') {
        const author = getAuthor();
        const own = strokes.filter(x => x.author === author);
        for (const x of own) await eraseStroke(x);
        return;
      }
      try {
        const res = await serial(() => send(strokesClearAll(), { method: 'DELETE' }));
        if (!res.ok) throw new Error('DELETE strokes ' + res.status);
        strokes = [];
        redrawAll();
      } catch (err) {
        console.error('Failed to clear strokes:', err);
        figToast('Drawings could not be cleared. Please try again.');
      }
    });
    picker.appendChild(clearBtn);
  }

  // ── Load strokes on page load, then keep them in sync ──
  // Strokes still being saved (no server id yet) stay on screen across refreshes.
  async function refreshStrokes() {
    const res = await fetch(strokesGet(), { cache: 'no-store' });
    if (!res.ok) throw new Error('GET strokes ' + res.status);
    const list = await res.json();
    if (!Array.isArray(list) || drawing) return;
    // Still-saving strokes stay, unless the server already has them (same id).
    const pending = strokes.filter(x => !x.id && !list.some(l => l.id === x.clientId));
    const before = strokes.map(x => x.id).join();
    strokes = list.filter(x => !erasing.has(x.id) && !clearedHere(x)).concat(pending);
    if (strokes.map(x => x.id).join() !== before) redrawAll();
  }
  async function loadStrokes() {
    try { await refreshStrokes(); }
    catch (err) { console.error('Failed to load strokes:', err); }
  }

  // ── Load + live sync ──
  // What a browser shows = the server's list, with this browser's own
  // unacknowledged writes laid on top (pending creates added, pending edits
  // applied, pending deletes removed). Nothing else from local storage is ever
  // shown while the server is reachable, so stale copies can't resurrect.
  function viewFromServer(serverList) {
    var pendingPosts = lsGet(LS_QUEUE_POST);
    var patches = new Map(lsGet(LS_QUEUE_PATCH).map(function(p) { return [p.id, p]; }));
    var deleted = new Set(lsGet(LS_QUEUE_DELETE).map(function(d) { return d.id; }));
    var view = serverList.map(function(c) {
      var p = patches.get(c.id);
      if (!p) return c;
      var merged = Object.assign({}, c);
      ['x', 'y', 'text', 'status', 'diagnosis'].forEach(function(k) { if (p[k] != null) merged[k] = p[k]; });
      return merged;
    });
    var have = new Set(view.map(function(c) { return c.id; }));
    pendingPosts.forEach(function(c) { if (!have.has(c.id)) view.push(c); });
    return view
      .filter(function(c) { return !deleted.has(c.id) && !clearedHere(c); })
      .sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
  }

  function fingerprint(c) {
    return JSON.stringify([c.x, c.y, c.text, c.status, c.diagnosis, c.anchor, c.replies || []]);
  }
  function removeRendered(id) {
    unwrapSuggestion(id);
    document.querySelectorAll('.comment-pin[data-comment-id="' + id + '"]').forEach(function(p) { p.remove(); });
  }
  function renderOne(c) {
    if (c.kind === 'suggest') renderSuggestion(c);
    else renderPin(c, 0);
  }
  // Bring the page in line with `next`: remove what's gone, re-render what
  // changed, add what's new. Pins are renumbered at the end.
  function reconcile(next) {
    var nextById = new Map(next.map(function(c) { return [c.id, c]; }));
    var curById = new Map(comments.map(function(c) { return [c.id, c]; }));
    comments.forEach(function(c) { if (!nextById.has(c.id)) removeRendered(c.id); });
    next.forEach(function(c) {
      var cur = curById.get(c.id);
      if (!cur) { renderOne(c); return; }
      if (fingerprint(cur) !== fingerprint(c)) { removeRendered(c.id); renderOne(c); }
    });
    comments = next;
    backupToLocal();
    renumberPins();
  }

  async function fetchServerComments() {
    var res = await fetch(apiGet(), { cache: 'no-store' });
    if (!res.ok) throw new Error('GET comments ' + res.status);
    var list = await res.json();
    if (!Array.isArray(list)) throw new Error('GET comments: not a list');
    return list;
  }

  async function loadComments() {
    try {
      reconcile(viewFromServer(await fetchServerComments()));
    } catch (err) {
      // Offline or server error: show this browser's last known state until the next sync.
      console.error('Failed to load comments from API:', err);
      reconcile(mergeById(restoreFromLocal(), lsGet(LS_QUEUE_POST)).filter(function(c) {
        return !lsGet(LS_QUEUE_DELETE).some(function(d) { return d.id === c.id; });
      }));
    }
    flushQueues();
  }

  // Never redraw under someone mid-action: an open box, a pin or stroke being
  // dragged, or a text selection in progress. The next tick picks it up.
  function busy() {
    return !!(document.querySelector('.comment-popover, .comment-detail, .author-overlay') ||
      dragState || drawing || dragSel);
  }
  var syncing = false;
  async function refresh() {
    if (syncing || document.hidden || busy()) return;
    syncing = true;
    try {
      await flushQueues();
      if (pendingClears().length) await runPendingClears();
      var serverComments = await fetchServerComments();
      if (!busy()) reconcile(viewFromServer(serverComments));
      await refreshStrokes();
    } catch (err) {
      console.warn('fig sync:', err.message || err);
    } finally {
      syncing = false;
    }
  }
  setInterval(refresh, 8000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', function() { if (!document.hidden) refresh(); });

  // ── Delete own markings only (team pages: body[data-fig-clear="mine"]) ──
  // One reviewer must not be able to wipe everyone's feedback: the trash
  // button on multi-reviewer pages clears only the clicker's comments,
  // suggestions, and strokes (matched by their stored author name).
  // ── Trash: delete everything this reviewer posted, on every page of the site ──
  // One server request clears it all in a single commit (api/clear). The
  // request is remembered in localStorage until the server confirms, so a
  // refresh, a closed tab, or a dropped connection can't leave half of it
  // behind: every page load hides those items and sends the request again.
  var LS_PENDING_CLEAR = 'fig-pending-clear';
  var CLEAR_API = API.replace(/comments$/, 'clear');
  function pendingClears() { return lsGet(LS_PENDING_CLEAR); }
  function clearedHere(x) {
    return pendingClears().some(function(pc) {
      return pc.author === x.author && pc.versions.indexOf(VERSION) >= 0 && (Number(x.timestamp) || 0) <= pc.before;
    });
  }
  var clearing = false;
  async function runPendingClears() {
    if (clearing) return;
    clearing = true;
    try {
      var list = pendingClears();
      for (var i = 0; i < list.length; i++) {
        var pc = list[i];
        var res = await serial(function() {
          return send(CLEAR_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ author: pc.author, versions: pc.versions, before: pc.before })
          });
        });
        if (res.ok) {
          lsSet(LS_PENDING_CLEAR, pendingClears().filter(function(x) { return x.id !== pc.id; }));
        }
      }
    } catch (err) {
      console.warn('fig clear:', err.message || err);
    } finally {
      clearing = false;
    }
  }

  async function clearMine() {
    var author = getAuthor();
    if (!author) { alert('No feedback of yours on this site yet.'); return; }
    var siteVersions = (document.body.getAttribute('data-fig-site') || '')
      .split(',').map(function(v) { return v.trim(); })
      .filter(function(v) { return v && v !== VERSION; });
    var versions = [VERSION].concat(siteVersions);
    if (!confirm('Deletes all of your feedback (comments, suggestions and drawings) on '
      + (siteVersions.length ? 'every page of this site' : 'this page') + '. Are you sure?')) return;

    // Remember the request first, so nothing below can be lost to a refresh.
    // `before` allows for clock differences between this computer and the server.
    var pc = { id: genId(), author: author, versions: versions, before: Date.now() + 15000 };
    lsSet(LS_PENDING_CLEAR, pendingClears().concat([pc]));

    // Unsent writes of mine, on every page, are cancelled outright.
    versions.forEach(function(v) {
      var notMine = function(x) { return x.author !== author; };
      lsSet('fig-queue-post-' + v, lsGet('fig-queue-post-' + v).filter(notMine));
      lsSet('fig-cache-' + v, lsGet('fig-cache-' + v).filter(notMine));
      if (v !== VERSION) lsSet('fig-queue-patch-' + v, []);
    });

    // Everything of mine leaves this screen at once.
    closeAllPopovers();
    reconcile(comments.filter(function(c) { return !clearedHere(c); }));
    strokes = strokes.filter(function(x) { return !clearedHere(x) && !(x.author === author && !x.id); });
    hoveredStroke = null;
    redrawAll();

    await runPendingClears();
    if (pendingClears().some(function(x) { return x.id === pc.id; })) {
      figToast('Still deleting your feedback. It is hidden now and will finish automatically.');
    }
    refresh();
  }

  // ── Delete all comments (with confirmation) ──
  async function clearAllComments() {
    if (document.body.getAttribute('data-fig-clear') === 'mine') { clearMine(); return; }
    var count = comments.length;
    if (count === 0) {
      alert('No comments to delete.');
      return;
    }
    var confirmed = confirm('Delete all ' + count + ' comment' + (count === 1 ? '' : 's') + '?\n\nThis cannot be undone.');
    if (!confirmed) return;

    // Clear locally first
    document.querySelectorAll('.comment-pin').forEach(function(p) { p.remove(); });
    document.querySelectorAll('mark.fig-suggest').forEach(unwrapMark);
    closeAllPopovers();
    comments = [];
    backupToLocal();
    lsSet(LS_QUEUE_POST, []);
    lsSet(LS_QUEUE_PATCH, []);
    lsSet(LS_QUEUE_DELETE, []);

    // Then sync to server (after any writes still in flight)
    try {
      const res = await serial(() => send(apiClearAll(), { method: 'DELETE' }));
      if (!res.ok) throw new Error('DELETE all ' + res.status);
    } catch (err) {
      console.warn('Server clear-all failed:', err);
      figToast('Comments could not be cleared on the server. Please try again.');
    }
  }

  // ══════════════════════════════════════════════
  //  First-visit onboarding (Loqumen-styled card)
  // ══════════════════════════════════════════════
  function initOnboarding() {
    if (!document.getElementById('fig-font')) {
      var l = document.createElement('link');
      l.id = 'fig-font'; l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap';
      document.head.appendChild(l);
    }
    var pop = document.createElement('div');
    pop.className = 'fig-onboard'; pop.id = 'figOnboard';
    pop.innerHTML =
      '<div class="fig-onboard-head"><h3>How to leave feedback</h3>' +
      '<button class="fig-onboard-x" id="figOnboardX" aria-label="Close">&times;</button></div>' +
      '<p class="fig-onboard-sub">Use the tools in the bottom-right corner of the page.</p>' +
      '<div class="fig-onboard-rows"></div>' +
      '<button class="fig-onboard-done" id="figOnboardDone">Got it</button>';
    document.body.appendChild(pop);

    var rows = pop.querySelector('.fig-onboard-rows');
    function addRow(btnId, name, desc) {
      var btn = document.getElementById(btnId);
      var svg = btn ? btn.querySelector('svg') : null;
      var row = document.createElement('div'); row.className = 'fig-onboard-row';
      var ico = document.createElement('span'); ico.className = 'fig-onboard-icon';
      if (svg) ico.appendChild(svg.cloneNode(true));
      var txt = document.createElement('div'); txt.className = 'fig-onboard-text';
      txt.innerHTML = '<span class="fig-onboard-name">' + name + '</span>' +
                      '<span class="fig-onboard-desc">' + desc + '</span>';
      row.appendChild(ico); row.appendChild(txt); rows.appendChild(row);
    }
    addRow('drawToggle',       'Draw',    'Sketch freehand anywhere on the page. The palette has color, size, an Erase toggle (click one stroke to remove it), and Clear (removes all).');
    addRow('commentToggle',    'Comment', 'Pin design or layout feedback to a spot.');
    addRow('suggestToggle',    'Suggest', 'Select text to flag an inaccuracy or propose a change.');
    addRow('clearAllComments', 'Clear',   'Remove every comment on this page.');

    function hide() { pop.classList.remove('visible'); localStorage.setItem('fig-onboarded', '1'); }
    pop.querySelector('#figOnboardX').addEventListener('click', hide);
    pop.querySelector('#figOnboardDone').addEventListener('click', hide);
    var help = document.getElementById('figHelp');
    if (help) help.addEventListener('click', function() { pop.classList.add('visible'); });
    if (localStorage.getItem('fig-onboarded') !== '1') {
      setTimeout(function() { pop.classList.add('visible'); }, 450);
    }
  }

  // ── Init ──
  initCanvas();
  initColorPicker();
  initOnboarding();

  document.addEventListener('mousedown', onCanvasDown);
  document.addEventListener('mousemove', onCanvasMove);
  document.addEventListener('mouseup', onCanvasUp);

  loadComments();
  loadStrokes();
  if (pendingClears().length) runPendingClears().then(refresh);
})();
