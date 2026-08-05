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
  //  Sync layer — eventual consistency
  //  Comments are saved locally first, then synced to API.
  //  Failed syncs go to a retry queue and flush on every load + every 30s.
  //  IDs are client-generated so POSTs are idempotent (no duplicates on retry).
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

  // Sync individual operations (idempotent on the server)
  async function syncPost(comment) {
    try {
      var res = await fetch(API, {
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
  async function syncPatch(patch) {
    try {
      var res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, patch, { version: VERSION }))
      });
      if (res.ok) {
        queueRemove(LS_QUEUE_PATCH, patch.id);
        return true;
      }
    } catch (err) {}
    return false;
  }
  async function syncDelete(id) {
    try {
      var res = await fetch(apiDelete(id), { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        queueRemove(LS_QUEUE_DELETE, id);
        return true;
      }
    } catch (err) {}
    return false;
  }

  async function flushQueues() {
    var posts = lsGet(LS_QUEUE_POST);
    for (var i = 0; i < posts.length; i++) await syncPost(posts[i]);
    var patches = lsGet(LS_QUEUE_PATCH);
    for (var j = 0; j < patches.length; j++) await syncPatch(patches[j]);
    var deletes = lsGet(LS_QUEUE_DELETE);
    for (var k = 0; k < deletes.length; k++) await syncDelete(deletes[k].id);
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
  }

  // ══════════════════════════════════════════════
  //  Comment system
  // ══════════════════════════════════════════════

  // ── Place comment on click ──
  document.addEventListener('click', async (e) => {
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

    const textarea = popover.querySelector('textarea');
    textarea.focus();

    textarea.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Escape') {
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
  });

  // ══════════════════════════════════════════════
  //  Suggest mode — text-anchored accuracy feedback
  //  Reviewer drag-selects text → highlight + anchored note with a status
  //  (open → diagnosed → approved → applied). Anchors use a text-quote
  //  selector (quote + prefix/suffix) so they re-locate on reload.
  // ══════════════════════════════════════════════
  function getContentRoot() { return document.querySelector('main') || document.body; }

  function buildTextIndex() {
    var nodes = [], text = '';
    var tw = document.createTreeWalker(getContentRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && n.parentElement.closest(
          '.fig-toolbar,.comment-detail,.comment-popover,.comment-pin,.author-overlay,script,style'))
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
      var mid = s > 0 ? node.splitText(s) : node;
      if (e - s < mid.nodeValue.length) mid.splitText(e - s);
      var mark = document.createElement('mark');
      mark.className = 'fig-suggest'; mark.dataset.commentId = id; mark.dataset.status = status || 'open';
      mid.parentNode.insertBefore(mark, mid); mark.appendChild(mid);
      marks.push(mark);
    });
    return marks;
  }

  function unwrapSuggestion(id) {
    document.querySelectorAll('mark.fig-suggest[data-comment-id="' + id + '"]').forEach(function(m) {
      var p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize();
    });
  }

  function setStatus(comment, status) {
    comment.status = status; backupToLocal();
    var patch = { id: comment.id, status: status };
    queueAdd(LS_QUEUE_PATCH, patch); syncPatch(patch);
    document.querySelectorAll('mark.fig-suggest[data-comment-id="' + comment.id + '"]')
      .forEach(function(m) { m.dataset.status = status; });
  }

  function renderSuggestion(comment) {
    var range = comment.anchor ? locate(comment.anchor) : null;
    if (range) {
      var marks = wrapRange(range, comment.id, comment.status || 'open');
      marks.forEach(function(m) {
        m.addEventListener('click', function(ev) {
          if (suggestMode || drawMode) return;
          ev.stopPropagation(); showDetail(comment, m);
        });
      });
      if (marks.length) { comment._anchored = true; return; }
    }
    // Orphaned (text changed / not found): keep it visible as a pin so feedback isn't lost.
    comment._orphan = true;
    renderPin(comment, comments.indexOf(comment) + 1);
  }

  // Capture a text selection in suggest mode and open the anchored composer.
  document.addEventListener('mouseup', async function(e) {
    if (!suggestMode) return;
    if (e.target.closest && e.target.closest('.fig-toolbar,.comment-popover,.comment-detail,.author-overlay')) return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (range.collapsed || !range.toString().trim()) return;
    if (!getContentRoot().contains(range.commonAncestorContainer)) return;

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
    var ta = pop.querySelector('textarea'); ta.focus();
    ta.addEventListener('keydown', function(ev) {
      if (ev.key === 'Escape') { pop.remove(); return; }
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        var text = ta.value.trim(); if (!text) { pop.remove(); return; }
        var comment = {
          id: genId(), kind: 'suggest', status: 'open',
          x: pct.x, y: pct.y, text: text, author: author,
          anchor: anchor, timestamp: Date.now()
        };
        comments.push(comment); backupToLocal();
        if (sel) sel.removeAllRanges();
        renderSuggestion(comment);
        pop.remove();
        queueAdd(LS_QUEUE_POST, comment); syncPost(comment);
      }
    });
  });

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
      var patch = { id: comment.id, x: x, y: y };
      queueAdd(LS_QUEUE_PATCH, patch);
      syncPatch(patch);
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
      repliesHtml = '<div style="margin-top:10px;border-top:1px solid #333;padding-top:8px;">';
      comment.replies.forEach(r => {
        const rd = new Date(r.timestamp);
        const rt = rd.toLocaleDateString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
        repliesHtml += `<div style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:start;gap:8px;"><div><div style="color:#e0e0e0;font-size:13px;line-height:1.4;">${escapeHtml(r.text)}</div><div style="font-size:10px;color:#666;margin-top:2px;"><strong style="color:#999;">${escapeHtml(r.author)}</strong> · ${rt}</div></div><button class="reply-delete-btn" data-reply-id="${r.id}" style="background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;flex-shrink:0;" title="Delete reply">&times;</button></div>`;
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
        <textarea class="comment-popover-input" rows="1" placeholder="Reply..." style="font-size:12px;padding:6px 8px;"></textarea>
      </div>
      <div class="comment-detail-actions">
        <button class="comment-detail-edit" data-id="${comment.id}">Edit</button>
        <button class="comment-detail-delete" data-id="${comment.id}">Delete</button>
      </div>`;
    document.body.appendChild(detail);
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
          const res = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: replyText, author, parentId: comment.id, version: VERSION })
          });
          if (!res.ok) throw new Error('Reply failed');
          const reply = await res.json();
          if (!comment.replies) comment.replies = [];
          comment.replies.push(reply);
          detail.remove();
          openPopover = null;
          showDetail(comment, pin);
        } catch (err) {
          replyInput.style.borderColor = '#e06060';
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
          await fetch(apiDelete(replyId), { method: 'DELETE' });
          if (comment.replies) comment.replies = comment.replies.filter(r => r.id !== replyId);
          detail.remove();
          openPopover = null;
          showDetail(comment, pin);
        } catch (err) {
          console.error('Failed to delete reply:', err);
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
        var patch = { id: comment.id, text: newText };
        queueAdd(LS_QUEUE_PATCH, patch);
        syncPatch(patch);
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
        if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
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

  function renumberPins() {
    const pins = document.querySelectorAll('.comment-pin');
    pins.forEach((pin, i) => { pin.textContent = i + 1; });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Close popover on outside click ──
  document.addEventListener('click', (e) => {
    if (!openPopover) return;
    // If the clicked element was detached mid-handler (Edit/Approve/Reply rebuild
    // the popover's buttons via innerHTML, removing e.target), closest() returns
    // null and would falsely read as an outside click. Skip detached targets so
    // the popover doesn't vanish when its own buttons are used.
    if (!e.target.isConnected) return;
    if (!e.target.closest('.comment-detail, .comment-pin, mark.fig-suggest, .comment-popover')) {
      closeAllPopovers();
    }
  });

  // ── Close on Escape ──
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
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
  async function eraseStroke(s) {
    if (!s) return;
    const id = s.id;
    strokes = strokes.filter(x => x !== s);
    if (hoveredStroke === s) hoveredStroke = null;
    redrawAll();
    if (!id) return; // not yet saved server-side; local removal is enough
    try {
      await fetch(strokesDelete(id), { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete stroke:', err);
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
      points: currentStroke,
      color: drawColor,
      width: drawWidth,
      author
    };

    // Save to server
    try {
      const res = await fetch(STROKES_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...stroke, version: VERSION })
      });
      if (res.ok) {
        const saved = await res.json();
        strokes.push(saved);
      }
    } catch (err) {
      console.error('Failed to save stroke:', err);
    }

    currentStroke = [];
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
      try {
        await fetch(strokesClearAll(), { method: 'DELETE' });
        strokes = [];
        redrawAll();
      } catch (err) {
        console.error('Failed to clear strokes:', err);
      }
    });
    picker.appendChild(clearBtn);
  }

  // ── Load strokes on page load ──
  async function loadStrokes() {
    try {
      const res = await fetch(strokesGet());
      if (!res.ok) return;
      strokes = await res.json();
      redrawAll();
    } catch (err) {
      console.error('Failed to load strokes:', err);
    }
  }

  // ── Load comments on page load ──
  // Strategy: GET from API, MERGE with local cache + pending queue.
  // Never destructively replace — comments only get added to the union.
  async function loadComments() {
    var apiComments = [];
    try {
      var res = await fetch(apiGet());
      if (res.ok) apiComments = await res.json();
    } catch (err) {
      console.error('Failed to load comments from API:', err);
    }

    var localCache = restoreFromLocal();
    var pendingPosts = lsGet(LS_QUEUE_POST);
    var pendingDeletes = lsGet(LS_QUEUE_DELETE);

    // Merge API + local cache + pending posts (by id, idempotent)
    var merged = mergeById(apiComments, localCache);
    merged = mergeById(merged, pendingPosts);

    // Filter out anything in the delete queue
    var deleteSet = new Set(pendingDeletes.map(function(d) { return d.id; }));
    merged = merged.filter(function(c) { return !deleteSet.has(c.id); });

    comments = merged;
    backupToLocal();
    comments.forEach(function(c, i) {
      if (c.kind === 'suggest') renderSuggestion(c);
      else renderPin(c, i + 1);
    });

    // Flush any pending operations to the API now that we're loaded
    flushQueues();
  }

  // ── Delete own markings only (team pages: body[data-fig-clear="mine"]) ──
  // One reviewer must not be able to wipe everyone's feedback: the trash
  // button on multi-reviewer pages clears only the clicker's comments,
  // suggestions, and strokes (matched by their stored author name).
  async function clearMine() {
    var author = getAuthor();
    var own = comments.filter(function(c) { return c.author === author; });
    var ownStrokes = strokes.filter(function(s) { return s.author === author; });
    if (!author || (!own.length && !ownStrokes.length)) {
      alert('No feedback of yours on this page yet.');
      return;
    }
    if (!confirm('Deletes all of your feedback. Are you sure?')) return;
    own.forEach(function(c) {
      queueAdd(LS_QUEUE_DELETE, { id: c.id });
      queueRemove(LS_QUEUE_POST, c.id);
      queueRemove(LS_QUEUE_PATCH, c.id);
      syncDelete(c.id);
      if (c.kind === 'suggest') unwrapSuggestion(c.id);
      var pin = document.querySelector('.comment-pin[data-comment-id="' + c.id + '"]');
      if (pin) pin.remove();
    });
    comments = comments.filter(function(c) { return c.author !== author; });
    backupToLocal();
    renumberPins();
    closeAllPopovers();
    for (var i = ownStrokes.length - 1; i >= 0; i--) { await eraseStroke(ownStrokes[i]); }
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
    document.querySelectorAll('mark.fig-suggest').forEach(function(m) {
      var par = m.parentNode; while (m.firstChild) par.insertBefore(m.firstChild, m); par.removeChild(m); par.normalize();
    });
    closeAllPopovers();
    comments = [];
    backupToLocal();
    lsSet(LS_QUEUE_POST, []);
    lsSet(LS_QUEUE_PATCH, []);
    lsSet(LS_QUEUE_DELETE, []);

    // Then sync to server
    try {
      await fetch(apiClearAll(), { method: 'DELETE' });
    } catch (err) {
      console.warn('Server clear-all failed:', err);
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
})();
