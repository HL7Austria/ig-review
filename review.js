/* HL7 Austria IG review: mark text on a published IG page, comment on it, and read/answer the
   comments right where they were made. Every comment is a GitHub issue in the IG repository.

   Loaded by one script tag that tools/inject.py adds to every page of an IG Publisher build:
     <script src="https://fhir.hl7.at/ig-review/review.js" data-repo="HL7Austria/X"
             data-branch="main" data-commit="<sha>" defer></script>
   Branches whose name starts with "ballot" get the HL7 ballot form (A-S/A-T/A-Q/A-C/NEG).

   Anchors are stored as text quotes (exact text + context before/after) plus the position, the
   page, the commit and, where the IG Publisher provides one, the element path or heading. After a
   rebuild the quote is searched again, so markings survive layout changes.
   Source + docs: https://github.com/HL7Austria/ig-review */
(function () {
  "use strict";
  const ME = document.currentScript;
  if (!ME || !ME.dataset.repo) return;
  const CFG = {
    repo: ME.dataset.repo,
    branch: ME.dataset.branch || "main",
    commit: ME.dataset.commit || "",
    index: ME.dataset.index || "review-index.json",
    clientId: ME.dataset.clientId || "Iv23li4OcsdZoj3gsUeY",
    tokenUrl: ME.dataset.tokenUrl || "https://hl7at-ig-comparison-auth.p40984-15b.workers.dev/token",
    base: new URL(".", ME.src).href,
  };
  CFG.mode = ME.dataset.mode || (/^ballot/i.test(CFG.branch) ? "ballot" : "review");
  const PAGE = decodeURIComponent(location.pathname.split("/").pop() || "index.html");
  const API = "https://api.github.com";
  const TYPES = {
    review: [["question", "Question"], ["suggestion", "Suggestion"], ["typo", "Typo"], ["major", "Major issue"]],
    ballot: [["A-S", "A-S · Affirmative, suggestion"], ["A-T", "A-T · Affirmative, typo"], ["A-Q", "A-Q · Affirmative, question"],
             ["A-C", "A-C · Affirmative, comment"], ["NEG", "NEG · Negative"]],
  };
  const TYPE_LABEL = Object.fromEntries([...TYPES.review, ...TYPES.ballot]);
  const KEY = { auth: "igr-auth", state: "igr-state", ret: "igr-return", pending: "igr-pending" };

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
  const norm = s => String(s || "").replace(/\s+/g, " ");
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmt = iso => { try { return new Date(iso).toLocaleString(undefined, {dateStyle: "medium", timeStyle: "short"}); } catch (e) { return iso; } };

  let ROOT, ITEMS = [], USER = null, TOKEN = null, ACTIVE = null, LOCATED = new Map();
  let VIEW = "page", FILTER = {type: "", state: "open"};
  const pageName = it => it.meta.pageTitle || it.meta.page.replace(/\.html$/, "");

  /* ------------------------------------------------------------------ text index + anchoring */
  function textNodes(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest("script,style,noscript,.igr-ui")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }});
    const out = []; let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  }
  // whitespace-collapsed text of the content area + a map from every character to its DOM position
  function buildIndex() {
    const map = []; let text = "", space = true;
    for (const n of textNodes(ROOT)) {
      const s = n.nodeValue;
      for (let i = 0; i < s.length; i++) {
        const ws = /\s/.test(s[i]);
        if (ws && space) continue;
        text += ws ? " " : s[i]; map.push([n, i]); space = ws;
      }
    }
    return {text, map};
  }
  function firstTextAt(container, offset) {
    if (container.nodeType === 3) return [container, offset];
    const start = container.childNodes[offset] || null;
    const w = document.createTreeWalker(ROOT, NodeFilter.SHOW_TEXT);
    w.currentNode = start || container;
    if (start && start.nodeType === 3) return [start, 0];
    const t = start ? (start.nodeType === 3 ? start : w.nextNode()) : w.nextNode();
    return t ? [t, 0] : [container, 0];
  }
  function posOf(idx, container, offset, isEnd) {
    const [node, off] = firstTextAt(container, offset);
    let last = null, after = false;
    for (let i = 0; i < idx.map.length; i++) {
      const [n, o] = idx.map[i];
      if (n === node) { if (o >= off) return i; continue; }
      if (n !== last) { last = n; after = !!(node.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); }
      if (after) return i;
    }
    return isEnd ? idx.map.length : idx.map.length - 1;
  }
  function contextOf(range) {
    const start = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const ctx = {};
    const tr = start.closest("tr");
    if (tr) {
      const a = [...tr.querySelectorAll("a[href*='#']")].map(x => decodeURIComponent(x.getAttribute("href").split("#")[1] || ""))
        .find(h => /^[A-Z][A-Za-z]+(\.|$)/.test(h));
      if (a) ctx.element = a;
    }
    const hs = [...ROOT.querySelectorAll("h1,h2,h3,h4")];
    const prev = hs.filter(h => h.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
    if (prev) { ctx.heading = norm(prev.textContent).trim().slice(0, 120); if (prev.id) ctx.headingId = prev.id; }
    return ctx;
  }
  function anchorFromSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!ROOT.contains(r.commonAncestorContainer)) return null;
    const host = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentElement : r.commonAncestorContainer;
    if (host && host.closest(".igr-ui")) return null;
    const idx = buildIndex();
    let s = posOf(idx, r.startContainer, r.startOffset), e = posOf(idx, r.endContainer, r.endOffset, true);
    while (s < e && idx.text[s] === " ") s++;
    while (e > s && idx.text[e - 1] === " ") e--;
    if (e - s < 2 || e - s > 3000) return null;
    return {
      quote: {exact: idx.text.slice(s, e), prefix: idx.text.slice(Math.max(0, s - 48), s), suffix: idx.text.slice(e, e + 48)},
      position: {start: s, end: e}, context: contextOf(r),
    };
  }
  function overlap(a, b, fromEnd) {
    let n = 0;
    if (fromEnd) { while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; }
    else { while (n < a.length && n < b.length && a[n] === b[n]) n++; }
    return n;
  }
  function locate(idx, meta) {
    const q = meta.quote || {}, ex = norm(q.exact).trim();
    if (!ex) return null;
    const pre = norm(q.prefix), suf = norm(q.suffix), cands = [];
    for (let i = idx.text.indexOf(ex); i >= 0 && cands.length < 500; i = idx.text.indexOf(ex, i + 1)) cands.push(i);
    if (!cands.length) return null;
    const pos = (meta.position || {}).start;
    const score = c => overlap(idx.text.slice(Math.max(0, c - pre.length), c), pre, true)
      + overlap(idx.text.slice(c + ex.length, c + ex.length + suf.length), suf, false)
      - (pos != null ? Math.abs(c - pos) / 50000 : 0);
    const best = cands.reduce((a, b) => score(b) > score(a) ? b : a);
    return {start: best, end: best + ex.length};
  }
  function toRange(idx, span) {
    const a = idx.map[span.start], b = idx.map[span.end - 1];
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a[0], a[1]); r.setEnd(b[0], b[1] + 1);
    return r;
  }
  function wrap(range, item, temp) {
    const root = range.commonAncestorContainer.nodeType === 3 ? range.commonAncestorContainer.parentNode : range.commonAncestorContainer;
    const nodes = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let t;
    while ((t = w.nextNode())) if (range.intersectsNode(t) && !(t.parentElement && t.parentElement.closest(".igr-ui"))) nodes.push(t);
    const marks = [];
    for (let node of nodes) {
      let s = node === range.startContainer ? range.startOffset : 0;
      let e = node === range.endContainer ? range.endOffset : node.nodeValue.length;
      if (s >= e || !node.nodeValue.slice(s, e).trim()) continue;
      if (s > 0) { node = node.splitText(s); e -= s; }
      if (e < node.nodeValue.length) node.splitText(e);
      const m = document.createElement("mark");
      m.className = "igr-hl" + (temp ? " igr-temp" : "") + (item && item.state === "closed" ? " igr-closed" : "");
      if (item) { m.dataset.igr = item.number; m.title = "#" + item.number + " " + (item.title || ""); }
      node.parentNode.insertBefore(m, node); m.appendChild(node); marks.push(m);
    }
    if (marks.length && item) { const last = marks[marks.length - 1]; last.classList.add("igr-last"); last.dataset.n = "#" + item.number; }
    return marks;
  }
  function unwrap(sel) {
    document.querySelectorAll(sel).forEach(m => { const p = m.parentNode; while (m.firstChild) p.insertBefore(m.firstChild, m); p.removeChild(m); p.normalize(); });
  }
  function renderHighlights() {
    unwrap("mark.igr-hl");
    LOCATED = new Map();
    const idx = buildIndex();
    const ranges = [];
    for (const it of ITEMS.filter(i => i.meta.page === PAGE)) {
      const span = locate(idx, it.meta);
      const r = span && toRange(idx, span);
      if (r) ranges.push([it, r]);
    }
    for (const [it, r] of ranges) { const marks = wrap(r, it); if (marks.length) LOCATED.set(it.number, marks); }
    updateLauncher();
  }

  /* ------------------------------------------------------------------ data */
  function parseMeta(body) {
    const m = /<!--\s*ig-review\b[^\n]*\n([\s\S]*?)\n\s*-->/.exec(body || "");
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }
  function fromIssue(i) {
    const meta = parseMeta(i.body);
    if (!meta) return null;
    return {number: i.number, url: i.html_url, title: i.title, state: i.state, author: i.user.login,
      avatar: i.user.avatar_url, created: i.created_at, body_html: i.body_html || "", meta,
      labels: (i.labels || []).map(l => l.name), comments: null, commentCount: i.comments};
  }
  async function loadIndex() {
    try {
      const r = await fetch(CFG.index, {cache: "no-cache"});
      if (r.ok) { const d = await r.json(); ITEMS = d.items || []; CFG.indexAt = d.generated; }
    } catch (e) { /* no index yet */ }
  }
  async function gh(path, opts) {
    const h = {"Accept": "application/vnd.github.full+json", "X-GitHub-Api-Version": "2022-11-28"};
    if (TOKEN) h.Authorization = "Bearer " + TOKEN;
    const r = await fetch(API + path, Object.assign({headers: h}, opts || {}));
    if (!r.ok) { const e = new Error(r.status + " " + (await r.text()).slice(0, 200)); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  }
  // signed in: pick up issues changed after the index was built
  async function loadLive() {
    const since = CFG.indexAt ? "&since=" + encodeURIComponent(CFG.indexAt) : "";
    try {
      const list = await gh(`/repos/${CFG.repo}/issues?state=all&per_page=100&sort=updated${since}`);
      let changed = false;
      for (const i of list) {
        if (i.pull_request) continue;
        const it = fromIssue(i);
        if (!it || it.meta.branch !== CFG.branch) continue;
        const k = ITEMS.findIndex(x => x.number === it.number);
        if (k >= 0) { it.comments = ITEMS[k].comments; ITEMS[k] = it; } else ITEMS.push(it);
        changed = true;
      }
      if (changed) { renderHighlights(); renderPanel(); }
    } catch (e) { /* keep index data */ }
  }
  async function loadThread(it) {
    if (!TOKEN && it.comments) return;
    try {
      const cs = await gh(`/repos/${CFG.repo}/issues/${it.number}/comments?per_page=100`);
      it.comments = cs.map(c => ({author: c.user.login, avatar: c.user.avatar_url, created: c.created_at, url: c.html_url, body_html: c.body_html || ""}));
      if (ACTIVE === it.number) renderPanel();
    } catch (e) { if (!it.comments) it.comments = []; }
  }

  /* ------------------------------------------------------------------ auth */
  function session() { try { return JSON.parse(sessionStorage.getItem(KEY.auth) || "null"); } catch (e) { return null; } }
  async function refresh(s) {
    const r = await fetch(CFG.tokenUrl, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({refresh_token: s.refresh})});
    const t = await r.json();
    if (!r.ok || !t.access_token) throw new Error(t.error || "refresh failed");
    const n = {token: t.access_token, exp: Date.now() + ((t.expires_in || 28800) - 60) * 1000, refresh: t.refresh_token || null};
    sessionStorage.setItem(KEY.auth, JSON.stringify(n));
    return n;
  }
  async function initAuth() {
    let s = session();
    if (s && s.exp <= Date.now()) { try { s = s.refresh ? await refresh(s) : null; } catch (e) { s = null; } if (!s) sessionStorage.removeItem(KEY.auth); }
    if (!s) return;
    TOKEN = s.token;
    try { USER = await gh("/user"); } catch (e) { TOKEN = null; USER = null; sessionStorage.removeItem(KEY.auth); }
  }
  function signIn() {
    const state = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    sessionStorage.setItem(KEY.state, state);
    sessionStorage.setItem(KEY.ret, location.href);
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", CFG.clientId);
    u.searchParams.set("redirect_uri", CFG.base + "callback.html");
    u.searchParams.set("state", state);
    location.href = u.toString();
  }
  function signOut() { sessionStorage.removeItem(KEY.auth); TOKEN = null; USER = null; renderPanel(); updateLauncher(); }

  /* ------------------------------------------------------------------ UI */
  let launcher, panel, pop, draft = null;
  function buildUI() {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = CFG.base + "review.css";
    document.head.appendChild(css);
    launcher = el("button", "igr-ui igr-launcher");
    launcher.onclick = () => togglePanel();
    panel = el("aside", "igr-ui igr-panel");
    pop = el("button", "igr-ui igr-pop", "&#128172; Comment");
    pop.onmousedown = e => e.preventDefault();
    pop.onclick = () => { const a = anchorFromSelection(); hidePop(); if (a) startDraft(a); };
    document.body.append(launcher, panel, pop);
    document.addEventListener("mouseup", e => { if (e.target.closest && e.target.closest(".igr-ui")) return; setTimeout(showPop, 10); });
    document.addEventListener("keyup", e => { if (e.shiftKey) setTimeout(showPop, 10); });
    document.addEventListener("click", e => {
      const m = e.target.closest && e.target.closest("mark.igr-hl[data-igr]");
      if (m && !window.getSelection().toString()) { openItem(+m.dataset.igr); }
    });
    updateLauncher();
  }
  function showPop() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !ROOT.contains(sel.getRangeAt(0).commonAncestorContainer)) { hidePop(); return; }
    const host = sel.getRangeAt(0).commonAncestorContainer;
    if ((host.nodeType === 3 ? host.parentElement : host).closest(".igr-ui")) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) { hidePop(); return; }
    pop.style.top = (window.scrollY + rect.bottom + 6) + "px";
    pop.style.left = (window.scrollX + Math.min(rect.right, window.innerWidth - 140)) + "px";
    pop.classList.add("on");
  }
  function hidePop() { pop.classList.remove("on"); }
  function updateLauncher() {
    if (!launcher) return;
    const here = ITEMS.filter(i => i.meta.page === PAGE).length;
    launcher.innerHTML = "&#128172; " + (CFG.mode === "ballot" ? "Ballot" : "Review") + " &middot; " + here + " here &middot; " + ITEMS.length + " total";
    launcher.classList.toggle("ballot", CFG.mode === "ballot");
  }
  function togglePanel(force) {
    const on = force != null ? force : !panel.classList.contains("on");
    panel.classList.toggle("on", on);
    document.body.classList.toggle("igr-open", on);
    if (on) renderPanel();
  }
  function headHTML() {
    const who = USER ? '<img src="' + esc(USER.avatar_url) + '&s=40" alt=""><span>' + esc(USER.login) + '</span><button class="igr-link" data-act="out">Sign out</button>'
                     : '<button class="igr-btn sec" data-act="in">Sign in with GitHub</button>';
    return '<div class="igr-head"><div><b>' + (CFG.mode === "ballot" ? "Ballot comments" : "Review comments") + '</b>' +
      '<div class="igr-sub">' + esc(CFG.repo) + ' &middot; branch <code>' + esc(CFG.branch) + '</code></div></div>' +
      '<button class="igr-x" data-act="close" title="Close">&times;</button></div><div class="igr-who">' + who + '</div>';
  }
  function typeBadge(t) { return t ? '<span class="igr-type t-' + esc(t.toLowerCase()) + '">' + esc(t) + '</span>' : ""; }
  function renderPanel() {
    if (!panel || !panel.classList.contains("on")) return;
    let h = headHTML();
    if (draft) h += draftHTML();
    else if (ACTIVE != null) h += itemHTML(ITEMS.find(i => i.number === ACTIVE));
    else h += listHTML();
    panel.innerHTML = h;
    wirePanel();
  }
  function tabsHTML() {
    const here = ITEMS.filter(i => i.meta.page === PAGE).length;
    return '<div class="igr-tabs"><button class="igr-tab' + (VIEW === "page" ? " on" : "") + '" data-view="page">This page (' + here + ')</button>' +
      '<button class="igr-tab' + (VIEW === "all" ? " on" : "") + '" data-view="all">All pages (' + ITEMS.length + ')</button></div>';
  }
  function allHTML() {
    const types = [...new Set(ITEMS.map(i => i.meta.type).filter(Boolean))].sort();
    const vis = ITEMS.filter(i => (!FILTER.type || i.meta.type === FILTER.type) && (FILTER.state === "all" || i.state === FILTER.state));
    const groups = new Map();
    vis.slice().sort((a, b) => pageName(a).localeCompare(pageName(b)) || a.number - b.number).forEach(i => { const k = i.meta.page; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    let h = '<div class="igr-body">' + tabsHTML() +
      '<div class="igr-filter"><select id="igr-ftype"><option value="">all types</option>' + types.map(t => '<option' + (FILTER.type === t ? " selected" : "") + '>' + esc(t) + '</option>').join("") + '</select>' +
      '<select id="igr-fstate">' + [["open", "open"], ["closed", "closed"], ["all", "open + closed"]].map(([v, l]) => '<option value="' + v + '"' + (FILTER.state === v ? " selected" : "") + '>' + l + '</option>').join("") + '</select>' +
      '<span class="igr-muted">' + vis.length + ' of ' + ITEMS.length + '</span></div>';
    if (!vis.length) h += '<p class="igr-muted">No comments match.</p>';
    groups.forEach((items, page) => {
      h += '<div class="igr-page"><a class="igr-page-h" href="' + esc(page) + '">' + esc(pageName(items[0])) + '</a>' + (page === PAGE ? ' <span class="igr-muted">(this page)</span>' : "") + '</div>';
      h += items.map(i => '<a class="igr-card igr-mini' + (i.state === "closed" ? " closed" : "") + '" href="' + esc(page) + '#igr=' + i.number + '" data-goto="' + i.number + '" data-page="' + esc(page) + '">' +
        '<div class="igr-card-h">#' + i.number + ' ' + typeBadge(i.meta.type) + (i.state === "closed" ? ' <span class="igr-type">closed</span>' : "") +
        ((i.comments && i.comments.length) || i.commentCount ? ' <span class="igr-muted">&#128172; ' + ((i.comments && i.comments.length) || i.commentCount) + '</span>' : "") +
        '<span class="igr-by">' + esc(i.author) + '</span></div><div class="igr-q">' + esc(i.meta.quote.exact.slice(0, 100)) + (i.meta.quote.exact.length > 100 ? "&hellip;" : "") + '</div></a>').join("");
    });
    return h + '</div>';
  }
  function listHTML() {
    if (VIEW === "all") return allHTML();
    const here = ITEMS.filter(i => i.meta.page === PAGE).sort((a, b) => ((a.meta.position || {}).start || 0) - ((b.meta.position || {}).start || 0));
    const lost = here.filter(i => !LOCATED.has(i.number)), found = here.filter(i => LOCATED.has(i.number));
    const card = i => '<div class="igr-card' + (i.state === "closed" ? " closed" : "") + '" data-open="' + i.number + '"><div class="igr-card-h">#' + i.number + ' ' + typeBadge(i.meta.type) +
      (i.state === "closed" ? ' <span class="igr-type">closed</span>' : "") + '<span class="igr-by">' + esc(i.author) + '</span></div>' +
      '<div class="igr-q">' + esc(i.meta.quote.exact.slice(0, 140)) + (i.meta.quote.exact.length > 140 ? "&hellip;" : "") + '</div>' +
      '<div class="igr-t">' + esc(i.title.replace(/^\[[^\]]+\]\s*/, "")) + '</div></div>';
    let h = '<div class="igr-body">' + tabsHTML() + '<p class="igr-hint">Select text on the page and click <b>&#128172; Comment</b> to add a ' + (CFG.mode === "ballot" ? "ballot comment" : "comment") + '.</p>';
    h += found.length ? found.map(card).join("") : '<p class="igr-muted">No comments on this page yet.</p>';
    if (lost.length) h += '<div class="igr-h">Can no longer be located on this page</div>' + lost.map(card).join("");
    const other = ITEMS.length - here.length;
    if (other) h += '<p class="igr-muted"><button class="igr-link" data-view="all">' + other + ' more on other pages &rarr;</button></p>';
    return h + '</div>';
  }
  function itemHTML(it) {
    if (!it) { ACTIVE = null; return listHTML(); }
    const m = it.meta, ctx = m.context || {};
    if (!it.comments) loadThread(it);
    let h = '<div class="igr-body"><button class="igr-link" data-act="back">&larr; all comments</button>' +
      '<div class="igr-card-h big">#' + it.number + ' ' + typeBadge(m.type) + (m.inPerson ? ' <span class="igr-type">in person</span>' : "") +
      (it.state === "closed" ? ' <span class="igr-type">closed</span>' : "") + '</div>' +
      '<div class="igr-t">' + esc(it.title) + '</div>' +
      '<div class="igr-meta">' + esc(it.author) + ' &middot; ' + esc(fmt(it.created)) + (ctx.element ? ' &middot; <code>' + esc(ctx.element) + '</code>' : ctx.heading ? ' &middot; ' + esc(ctx.heading) : "") +
      (!LOCATED.has(it.number) ? ' &middot; <b>not located on this page</b>' : "") + '</div>' +
      '<div class="igr-issue">' + it.body_html + '</div>' +
      (it.labels || []).filter(l => l.startsWith("disposition:")).map(l => '<div class="igr-disp">Disposition: <b>' + esc(l.slice(12)) + '</b></div>').join("") +
      '<div class="igr-h">Discussion</div>';
    const cs = it.comments;
    h += cs == null ? '<p class="igr-muted">Loading&hellip;</p>' : cs.length ? cs.map(c => '<div class="igr-cmt"><div class="igr-cmt-h"><img src="' + esc(c.avatar) + '&s=40" alt=""><b>' + esc(c.author) + '</b> <a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(fmt(c.created)) + '</a></div><div class="igr-cmt-b">' + c.body_html + '</div></div>').join("") : '<p class="igr-muted">No replies yet.</p>';
    h += USER ? '<textarea class="igr-ta" id="igr-reply" placeholder="Reply as ' + esc(USER.login) + ' (Markdown)"></textarea><div class="igr-row"><button class="igr-btn" data-act="reply">Reply</button></div>'
              : '<div class="igr-row"><button class="igr-btn sec" data-act="in">Sign in with GitHub to reply</button></div>';
    return h + '<div class="igr-row"><a href="' + esc(it.url) + '" target="_blank" rel="noopener">Open issue #' + it.number + ' on GitHub &#8599;</a></div></div>';
  }
  function draftHTML() {
    const d = draft, opts = TYPES[CFG.mode].map(([v, l]) => '<option value="' + v + '"' + (d.type === v ? " selected" : "") + '>' + esc(l) + '</option>').join("");
    let h = '<div class="igr-body"><div class="igr-h">' + (CFG.mode === "ballot" ? "New ballot comment" : "New comment") + '</div>' +
      '<div class="igr-q">' + esc(d.anchor.quote.exact.slice(0, 400)) + (d.anchor.quote.exact.length > 400 ? "&hellip;" : "") + '</div>' +
      ((d.anchor.context || {}).element ? '<div class="igr-meta">on <code>' + esc(d.anchor.context.element) + '</code></div>' : "") +
      '<label>Type<select id="igr-type">' + opts + '</select></label>' +
      '<label>Comment<textarea class="igr-ta" id="igr-text" placeholder="What should change and why? (Markdown)">' + esc(d.text || "") + '</textarea></label>' +
      '<label>Proposed wording <span class="igr-muted">' + (CFG.mode === "ballot" ? "(required for NEG)" : "(optional)") + '</span><textarea class="igr-ta" id="igr-prop">' + esc(d.proposed || "") + '</textarea></label>';
    if (CFG.mode === "ballot") h += '<label class="igr-check"><input type="checkbox" id="igr-inperson"' + (d.inPerson ? " checked" : "") + '> Request discussion in person</label>';
    h += '<div class="igr-err" id="igr-err"></div><div class="igr-row">' +
      (USER ? '<button class="igr-btn" data-act="submit">Create ' + (CFG.mode === "ballot" ? "ballot comment" : "comment") + '</button>'
            : '<button class="igr-btn" data-act="submit">Sign in with GitHub and submit</button>') +
      '<button class="igr-link" data-act="cancel">Cancel</button></div>' +
      '<p class="igr-muted">Creates an issue in ' + esc(CFG.repo) + (USER ? ' as ' + esc(USER.login) : "") + '. Everything you write there is public.</p></div>';
    return h;
  }
  function readDraft() {
    if (!draft) return;
    const v = id => { const e = document.getElementById(id); return e ? (e.type === "checkbox" ? e.checked : e.value) : undefined; };
    draft.type = v("igr-type") || draft.type; draft.text = v("igr-text"); draft.proposed = v("igr-prop");
    if (CFG.mode === "ballot") draft.inPerson = v("igr-inperson");
  }
  function wirePanel() {
    panel.querySelectorAll("[data-act]").forEach(b => b.onclick = () => act(b.dataset.act));
    panel.querySelectorAll("[data-open]").forEach(c => c.onclick = () => openItem(+c.dataset.open));
    panel.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { VIEW = b.dataset.view; renderPanel(); });
    panel.querySelectorAll("[data-goto]").forEach(a => a.onclick = e => { if (a.dataset.page === PAGE) { e.preventDefault(); openItem(+a.dataset.goto); } });
    const ft = panel.querySelector("#igr-ftype"), fs = panel.querySelector("#igr-fstate");
    if (ft) ft.onchange = () => { FILTER.type = ft.value; renderPanel(); };
    if (fs) fs.onchange = () => { FILTER.state = fs.value; renderPanel(); };
  }
  async function act(a) {
    if (a === "close") { readDraft(); togglePanel(false); return; }
    if (a === "in") { readDraft(); if (draft) sessionStorage.setItem(KEY.pending, JSON.stringify(Object.assign({page: PAGE}, draft))); signIn(); return; }
    if (a === "out") { signOut(); return; }
    if (a === "back") { ACTIVE = null; setActive(null); renderPanel(); return; }
    if (a === "cancel") { draft = null; unwrap("mark.igr-temp"); renderPanel(); return; }
    if (a === "submit") { readDraft(); return submitDraft(); }
    if (a === "reply") return postReply();
  }
  function startDraft(anchor) {
    unwrap("mark.igr-temp");
    draft = {anchor, type: TYPES[CFG.mode][CFG.mode === "ballot" ? 0 : 1][0], text: "", proposed: "", inPerson: false};
    ACTIVE = null;
    const idx = buildIndex(), r = toRange(idx, anchor.position);
    if (r) wrap(r, null, true);
    window.getSelection().removeAllRanges();
    togglePanel(true);
    setTimeout(() => { const t = document.getElementById("igr-text"); if (t) t.focus(); }, 30);
  }
  function issueBody(d) {
    const meta = {v: 1, page: PAGE, pageTitle: (document.title || "").replace(/\s+-\s+v?[\d.]+.*$/, "").trim() || undefined, branch: CFG.branch, commit: CFG.commit, mode: CFG.mode, type: d.type,
      inPerson: CFG.mode === "ballot" ? !!d.inPerson : undefined, quote: d.anchor.quote, position: d.anchor.position,
      context: d.anchor.context, url: location.origin + location.pathname};
    const where = [ "`" + PAGE + "`", (d.anchor.context || {}).element ? "`" + d.anchor.context.element + "`" : (d.anchor.context || {}).heading ? "*" + d.anchor.context.heading + "*" : "" ].filter(Boolean).join(", ");
    let b = "> **" + (CFG.mode === "ballot" ? "Existing wording" : "Marked text") + "** ([" + where + "](" + meta.url + ")):\n> " + d.anchor.quote.exact.replace(/\n/g, "\n> ") + "\n\n";
    b += (CFG.mode === "ballot" ? "**" + TYPE_LABEL[d.type] + "**\n\n" : "") + d.text.trim() + "\n";
    if (d.proposed && d.proposed.trim()) b += "\n### Proposed wording\n" + d.proposed.trim() + "\n";
    if (CFG.mode === "ballot" && d.inPerson) b += "\n**Discussion in person requested.**\n";
    b += "\n<!-- ig-review: anchor of this comment on the published IG page (do not edit)\n" + JSON.stringify(meta, null, 1) + "\n-->\n";
    return b;
  }
  async function submitDraft() {
    const err = document.getElementById("igr-err"), d = draft;
    if (!d.text || !d.text.trim()) { err.textContent = "Please write a comment."; return; }
    if (CFG.mode === "ballot" && d.type === "NEG" && !(d.proposed || "").trim()) { err.textContent = "A negative vote needs proposed wording."; return; }
    if (!USER) { sessionStorage.setItem(KEY.pending, JSON.stringify(Object.assign({page: PAGE}, d))); signIn(); return; }
    const btn = panel.querySelector('[data-act="submit"]'); btn.disabled = true; btn.textContent = "Creating…";
    const title = "[" + d.type + "] " + PAGE.replace(/\.html$/, "") + ": " + norm(d.text).trim().slice(0, 70);
    try {
      const i = await gh(`/repos/${CFG.repo}/issues`, {method: "POST", headers: {"Accept": "application/vnd.github.full+json", "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        body: JSON.stringify({title, body: issueBody(d)})});
      const it = fromIssue(i); it.comments = [];
      ITEMS.push(it); draft = null; sessionStorage.removeItem(KEY.pending);
      unwrap("mark.igr-temp"); renderHighlights(); openItem(it.number);
    } catch (e) {
      btn.disabled = false; btn.textContent = "Try again";
      err.textContent = e.status === 401 ? "Your sign-in expired, please sign in again." : e.status === 403 || e.status === 404
        ? "GitHub refused the comment (" + e.status + "). The review app may not be installed on " + CFG.repo + "."
        : "Could not create the comment: " + e.message;
      if (e.status === 401) signOut();
    }
  }
  async function postReply() {
    const it = ITEMS.find(i => i.number === ACTIVE), ta = document.getElementById("igr-reply");
    if (!it || !ta.value.trim()) return;
    const btn = panel.querySelector('[data-act="reply"]'); btn.disabled = true;
    try {
      const c = await gh(`/repos/${CFG.repo}/issues/${it.number}/comments`, {method: "POST", headers: {"Accept": "application/vnd.github.full+json", "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}, body: JSON.stringify({body: ta.value})});
      (it.comments = it.comments || []).push({author: c.user.login, avatar: c.user.avatar_url, created: c.created_at, url: c.html_url, body_html: c.body_html || ""});
      renderPanel();
    } catch (e) { btn.disabled = false; alertBox("Could not post the reply: " + e.message); }
  }
  function alertBox(t) { const e = document.getElementById("igr-err") || el("div", "igr-err"); e.textContent = t; panel.querySelector(".igr-body").appendChild(e); }
  function setActive(n) {
    document.querySelectorAll("mark.igr-hl.igr-active").forEach(m => m.classList.remove("igr-active"));
    const marks = n != null && LOCATED.get(n);
    if (marks) { marks.forEach(m => m.classList.add("igr-active")); marks[0].scrollIntoView({block: "center", behavior: "smooth"}); }
  }
  function openItem(n) { draft = null; unwrap("mark.igr-temp"); ACTIVE = n; togglePanel(true); setActive(n); renderPanel(); }

  /* ------------------------------------------------------------------ start */
  async function start() {
    ROOT = document.getElementById("segment-content") || document.querySelector("main") || document.body;
    buildUI();
    await Promise.all([loadIndex(), initAuth()]);
    renderHighlights();
    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(KEY.pending) || "null"); } catch (e) {}
    if (pending && pending.page === PAGE) {
      sessionStorage.removeItem(KEY.pending);
      draft = pending; ACTIVE = null;
      const idx = buildIndex(), span = locate(idx, pending.anchor), r = span && toRange(idx, span);
      if (r) wrap(r, null, true);
      togglePanel(true);
    }
    const m = location.hash.match(/igr=(\d+)/);
    if (m) openItem(+m[1]);
    window.addEventListener("hashchange", () => { const h = location.hash.match(/igr=(\d+)/); if (h) openItem(+h[1]); });
    loadLive();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
