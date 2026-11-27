/*!
 * QuizPilot Console AI  v1.0.0
 * ---------------------------------------------------------------------------
 * A console-only AI assistant for PERMITTED PRACTICE quizzes and forms.
 * Paste this whole file into the browser DevTools Console on the quiz page.
 *
 * What it does:
 *   detect questions -> ask an NVIDIA-hosted chat model -> validate the JSON
 *   -> fill fields (never submits) -> verify every field -> print a report.
 *
 * SECURITY WARNING ABOUT THE API KEY
 *   This runs inside the web page. While it runs, your NVIDIA API key sits in
 *   page memory and in the Authorization header of each request. Anyone who
 *   can inspect this script, the page's own JavaScript, browser extensions,
 *   and anyone with access to DevTools/network logs can read it. Use a
 *   dedicated, low-limit key and revoke it when you are done testing.
 *
 * Usage limits it enforces:
 *   - Never submits a form (and blocks submissions while it is filling).
 *   - Stops on pages that show proctoring / lockdown-browser signals.
 *   - Does not bypass logins, CAPTCHAs, access controls or monitoring.
 *
 * Helpers available after a run:  QuizPilot.abort()  QuizPilot.lastReport
 * ---------------------------------------------------------------------------
 */
void (async function QuizPilotConsoleAI() {
  'use strict';

  /* =========================================================================
   * 1. CONFIGURATION  (edit these values)
   * ======================================================================= */
  const CONFIG = {
    // Leave empty to be asked with a browser prompt, or set
    // window.QUIZPILOT_NVIDIA_KEY = 'nvapi-...' in the console before pasting.
    NVIDIA_API_KEY: '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',   // <-- put your nvapi-... key between the quotes

    // OpenAI-compatible NVIDIA endpoint. If the console reports that the request
    // failed before a response arrived (CORS), run quizpilot-proxy.js and use
    // 'http://127.0.0.1:8787/v1' here, leaving NVIDIA_API_KEY empty.
API_BASE_URL: 'https://quizpilot-relay.github1428.workers.dev/v1',
    // Manual model, e.g. 'meta/llama-3.3-70b-instruct'. Empty = auto-discover.
    MODEL: '',
    // true = use ONLY the manual MODEL; false = fall back to other models if it fails.
    STRICT_MODEL: false,

    // Tried first (in this order) when they are available on your account.
    PREFERRED_MODELS: [
      'meta/llama-3.3-70b-instruct',
      'meta/llama-3.1-70b-instruct',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'qwen/qwen2.5-72b-instruct',
      'mistralai/mistral-large-2-instruct',
      'meta/llama-3.1-405b-instruct',
      'meta/llama-3.1-8b-instruct',
    ],

    AUTO_FILL: true,                  // false = only print suggested answers
    MIN_CONFIDENCE_TO_FILL: 0.7,      // answers below this are reported, not filled
    OVERWRITE_EXISTING_ANSWERS: false,// false = leave questions you already answered alone
    CLEAR_UNSELECTED_CHECKBOXES: true,// make checkbox groups match the answer exactly
    FILL_TEXT_FIELDS: true,           // text inputs and textareas

    QUESTIONS_PER_REQUEST: 12,
    REQUEST_TIMEOUT_MS: 90000,
    MAX_RETRIES_PER_MODEL: 2,         // retries for 429 / 5xx / timeouts per model
    MAX_MODELS_TO_TRY: 4,
    MAX_TOKENS: 4096,
    TEMPERATURE: 0.1,

    DOM_QUIET_PERIOD_MS: 500,         // "page is stable" = no DOM changes for this long
    DOM_STABLE_TIMEOUT_MS: 8000,      // stop waiting for stability after this
    WAIT_FOR_QUESTIONS_MS: 10000,     // watch for dynamically rendered questions

    VERBOSE: false,                   // extra diagnostic logging (never logs secrets)
  };

  /* =========================================================================
   * 2. LOGGING (secrets are scrubbed from every message)
   * ======================================================================= */
  const TAG = '[QuizPilot]';
  const STYLE = 'color:#76b900;font-weight:bold';
  let SECRET = '';
  const scrub = (v) => {
    let s = typeof v === 'string' ? v : (v instanceof Error ? (v.message || String(v)) : safeStringify(v));
    if (SECRET && s.includes(SECRET)) s = s.split(SECRET).join('[REDACTED]');
    return s.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]').replace(/nvapi-[A-Za-z0-9_\-]{8,}/g, 'nvapi-[REDACTED]');
  };
  function safeStringify(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch (_) { return String(v); } }
  const log = (...a) => console.log('%c' + TAG, STYLE, ...a.map(x => (typeof x === 'string' ? scrub(x) : x)));
  const warn = (...a) => console.warn(TAG, ...a.map(x => (typeof x === 'string' ? scrub(x) : x)));
  const error = (...a) => console.error(TAG, ...a.map(x => (typeof x === 'string' ? scrub(x) : x)));
  const debug = (...a) => { if (CONFIG.VERBOSE) console.debug(TAG, ...a.map(x => (typeof x === 'string' ? scrub(x) : x))); };

  /* =========================================================================
   * 3. DUPLICATE-EXECUTION GUARD + PUBLIC HANDLE
   * ======================================================================= */
  const W = window;
  if (W.__QuizPilotState && W.__QuizPilotState.running) {
    warn('Already running in this tab. Wait for it to finish, or run QuizPilot.abort() first.');
    return;
  }
  const state = { running: true, aborted: false, controllers: new Set(), startedAt: Date.now() };
  W.__QuizPilotState = state;
  const prevHandle = W.QuizPilot && typeof W.QuizPilot === 'object' ? W.QuizPilot : {};
  W.QuizPilot = {
    version: '1.0.0',
    lastReport: prevHandle.lastReport || null,
    abort() {
      if (!state.running) { log('Nothing is running.'); return; }
      state.aborted = true;
      state.controllers.forEach(c => { try { c.abort(); } catch (_) { /* ignore */ } });
      warn('Abort requested. Stopping at the next safe point (no further fields will be changed).');
    },
  };

  class StopError extends Error { constructor(msg) { super(msg); this.name = 'StopError'; } }
  class AbortedError extends Error { constructor() { super('Aborted by user.'); this.name = 'AbortedError'; } }
  const checkAbort = () => { if (state.aborted) throw new AbortedError(); };

  /* =========================================================================
   * 4. GENERIC HELPERS
   * ======================================================================= */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"').replace(/[\u00A0\s]+/g, ' ').trim();
  const lower = (s) => norm(s).toLowerCase();
  const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);
  const optionIdFor = (i) => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  const normId = (v) => String(v == null ? '' : v).toUpperCase().replace(/^OPTION\s*/, '').replace(/[^A-Z0-9]/g, '');

  /** Waits for the next paint (with a fallback for background tabs where rAF is paused). */
  function settle(win) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; Promise.resolve().then(resolve); } };
      try { win.requestAnimationFrame(() => win.requestAnimationFrame(finish)); } catch (_) { /* ignore */ }
      setTimeout(finish, 120);
    });
  }

  function waitForReady(doc, timeoutMs) {
    if (doc.readyState === 'complete') return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => { cleanup(); resolve(doc.readyState !== 'loading'); }, timeoutMs);
      const onChange = () => { if (doc.readyState === 'complete') { cleanup(); resolve(true); } };
      function cleanup() { clearTimeout(t); doc.removeEventListener('readystatechange', onChange); }
      doc.addEventListener('readystatechange', onChange);
    });
  }

  /** Resolves once the DOM has had no structural changes for quietMs (or maxMs elapsed). */
  function waitForDomStable(doc, quietMs, maxMs) {
    return new Promise((resolve) => {
      const root = doc.documentElement;
      if (!root) { resolve(false); return; }
      let quietTimer = null;
      const obs = new MutationObserver(() => { clearTimeout(quietTimer); quietTimer = setTimeout(done.bind(null, true), quietMs); });
      const maxTimer = setTimeout(done.bind(null, false), maxMs);
      function done(stable) { clearTimeout(quietTimer); clearTimeout(maxTimer); obs.disconnect(); resolve(stable); }
      obs.observe(root, { childList: true, subtree: true, characterData: true });
      quietTimer = setTimeout(done.bind(null, true), quietMs);
    });
  }

  /* =========================================================================
   * 5. DOM UTILITIES (shadow-DOM and iframe aware)
   * ======================================================================= */
  const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'OPTION', 'DATALIST', 'svg', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD', 'META', 'LINK', 'TITLE']);
  const winOf = (node) => (node.ownerDocument || node).defaultView || W;

  function getParent(node) {
    if (!node) return null;
    if (node.assignedSlot) return node.assignedSlot;
    const p = node.parentNode;
    if (!p) return null;
    if (p.nodeType === 11 && p.host) return p.host; // shadow root -> host
    if (p.nodeType === 9) return null;               // document
    return p;
  }
  function containsDeep(anc, node) {
    for (let n = node; n; n = getParent(n)) if (n === anc) return true;
    return false;
  }
  function ancestors(node) { const out = []; for (let n = node; n; n = getParent(n)) out.push(n); return out; }
  function lowestCommonAncestor(nodes) {
    if (!nodes.length) return null;
    const chain = ancestors(nodes[0]);
    const sets = nodes.slice(1).map(n => new Set(ancestors(n)));
    for (const a of chain) if (sets.every(s => s.has(a))) return a;
    return null;
  }
  function closestDeep(el, selector) {
    for (let n = el; n; n = getParent(n)) if (n.nodeType === 1 && n.matches && n.matches(selector)) return n;
    return null;
  }

  /** querySelectorAll that also descends into OPEN shadow roots. */
  function deepQueryAll(root, selector) {
    const out = [];
    const visit = (r) => {
      r.querySelectorAll(selector).forEach(e => out.push(e));
      r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) visit(e.shadowRoot); });
    };
    visit(root);
    return out;
  }

  function isDisplayed(el) {
    try {
      const cs = winOf(el).getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse';
    } catch (_) { return true; }
  }
  function isRendered(el) {
    if (!el || !el.isConnected) return false;
    if (el.getClientRects().length === 0) return false;
    return isDisplayed(el);
  }

  function childrenForWalk(n) {
    if (n.nodeType === 1) {
      if (n.shadowRoot) return n.shadowRoot.childNodes;
      if (n.tagName === 'SLOT' && typeof n.assignedNodes === 'function') {
        const a = n.assignedNodes({ flatten: true });
        if (a.length) return a;
      }
    }
    return n.childNodes;
  }

  /** Depth-first walk over rendered content. onElement returns false to skip a subtree. */
  function walkRendered(root, onText, onElement) {
    const rec = (n, depth) => {
      if (depth > 200) return;
      for (const c of childrenForWalk(n)) {
        if (c.nodeType === 3) { onText(c); continue; }
        if (c.nodeType !== 1) continue;
        if (SKIP_TEXT_TAGS.has(c.tagName)) continue;
        if (!isDisplayed(c)) continue;
        if (onElement && onElement(c) === false) continue;
        rec(c, depth + 1);
      }
    };
    rec(root, 0);
  }

  /** Visible text of el, excluding any nodes (elements or text nodes) in `exclude`. */
  function textOf(el, exclude) {
    if (!el) return '';
    if (el.nodeType === 3) return norm(el.nodeValue);
    const parts = [];
    walkRendered(el, (t) => { if (!(exclude && exclude.has(t))) parts.push(t.nodeValue); },
      (c) => !(exclude && exclude.has(c)));
    return norm(parts.join(' '));
  }

  function textOfIdRefs(el, attr) {
    const ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    if (!ids.length) return { text: '', nodes: [] };
    const root = el.getRootNode();
    const nodes = ids.map(id => (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id)).filter(Boolean);
    return { text: norm(nodes.map(n => textOf(n) || norm(n.textContent)).join(' ')), nodes };
  }

  /* =========================================================================
   * 6. ENVIRONMENT / COMPATIBILITY CHECKS
   * ======================================================================= */
  function collectDocuments() {
    const docs = [document];
    const crossOrigin = [];
    const visit = (doc, depth) => {
      if (depth > 3) return;
      deepQueryAll(doc, 'iframe, frame').forEach(fr => {
        let child = null;
        try { child = fr.contentDocument; } catch (_) { child = null; }
        const visible = isRendered(fr);
        if (child && child.documentElement) { docs.push(child); visit(child, depth + 1); }
        else if (visible) crossOrigin.push(fr.src || fr.getAttribute('src') || '(no src)');
      });
    };
    visit(document, 0);
    return { docs, crossOrigin };
  }

  const PROCTOR_RE = /\b(proctor(?:ed|ing|io|u)?|lockdown browser|respondus|honorlock|examity|safe exam browser|examsoft|mettl proctor)\b/i;
  function proctoringSignals(docs) {
    const hits = [];
    for (const d of docs) {
      const scripts = Array.from(d.scripts || []).map(s => s.src || '').join(' ');
      const m1 = scripts.match(PROCTOR_RE);
      if (m1) hits.push('script: ' + m1[0]);
      const txt = ((d.title || '') + ' ' + (d.body ? (d.body.innerText || '').slice(0, 30000) : ''));
      const m2 = txt.match(PROCTOR_RE);
      if (m2) hits.push('page text: "' + m2[0] + '"');
    }
    return Array.from(new Set(hits));
  }

  function environmentReport(docs, crossOrigin) {
    const notes = [];
    if (crossOrigin.length) notes.push(`${crossOrigin.length} cross-origin iframe(s) cannot be read from here: ${crossOrigin.slice(0, 3).join(', ')}${crossOrigin.length > 3 ? ', \u2026' : ''}. If the quiz is inside one, open that iframe URL in its own tab and run QuizPilot there.`);
    let bigCanvas = 0, closedHosts = 0, editables = 0, customSelects = 0, unsupportedInputs = 0;
    for (const d of docs) {
      deepQueryAll(d, 'canvas').forEach(c => { const r = c.getBoundingClientRect(); if (r.width * r.height > 60000 && isRendered(c)) bigCanvas++; });
      deepQueryAll(d, '*').forEach(e => { if (e.tagName.includes('-') && !e.shadowRoot && e.childElementCount === 0 && !norm(e.textContent) && isRendered(e) && e.getBoundingClientRect().height > 20) closedHosts++; });
      deepQueryAll(d, '[contenteditable=""],[contenteditable="true"],[role="textbox"]:not(input):not(textarea)').forEach(e => { if (isRendered(e)) editables++; });
      deepQueryAll(d, '[role="listbox"],[role="combobox"]:not(input):not(select)').forEach(e => { if (isRendered(e)) customSelects++; });
      deepQueryAll(d, 'input[type="date"],input[type="time"],input[type="datetime-local"],input[type="range"],input[type="color"],input[type="file"],input[type="month"],input[type="week"]').forEach(e => { if (isRendered(e)) unsupportedInputs++; });
    }
    if (bigCanvas) notes.push(`${bigCanvas} large <canvas> element(s): any questions drawn on a canvas cannot be read.`);
    if (closedHosts) notes.push(`${closedHosts} custom element(s) with no readable content (possibly closed shadow DOM): their contents cannot be accessed.`);
    if (editables) notes.push(`${editables} rich-text/contenteditable field(s) are not supported and will be left alone.`);
    if (customSelects) notes.push(`${customSelects} custom listbox/combobox control(s) are not supported and will be left alone.`);
    if (unsupportedInputs) notes.push(`${unsupportedInputs} date/time/range/color/file input(s) are not supported and will be left alone.`);
    return notes;
  }

  /* =========================================================================
   * 7. QUESTION DETECTION
   * ======================================================================= */
  const TEXT_TYPES = new Set(['', 'text', 'search', 'number']);
  const PERSONAL_AUTOCOMPLETE = /\b(name|given-name|family-name|email|tel|street-address|address-line|postal-code|bday|username|organization|cc-)/i;
  const PERSONAL_ATTR = /^(full_?name|first_?name|last_?name|name|email|e-?mail|phone|mobile|roll_?(no|number)?|student_?id|usn|address|username)$/i;
  const PERSONAL_LABEL = /^\s*(your\s+)?(full\s+|first\s+|last\s+|student\s+)?(name|e-?mail(\s+address)?|phone(\s+number)?|mobile(\s+number)?|roll\s*(no\.?|number)|student\s*id|registration\s*(no\.?|number)|address|username)\s*[:*]?\s*$/i;

  let objCounter = 0;
  const objIds = new WeakMap();
  const objId = (o) => { if (!objIds.has(o)) objIds.set(o, ++objCounter); return objIds.get(o); };

  function classifyControl(el) {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'radio') return 'radio';
      if (t === 'checkbox') return 'checkbox';
      if (TEXT_TYPES.has(t)) return 'text';
      return null;
    }
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'radio') return 'aria-radio';
    if (role === 'checkbox') return 'aria-checkbox';
    return null;
  }

  function isUsable(el, kind) {
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return false;
    if ((kind === 'text' || kind === 'textarea') && el.readOnly) return false;
    if (el.type === 'hidden' || el.hidden) return false;
    if (isRendered(el)) return true;
    // Native radios/checkboxes are often visually hidden behind a styled label.
    if ((kind === 'radio' || kind === 'checkbox') && el.labels) return Array.from(el.labels).some(isRendered);
    return false;
  }

  function collectControls(docs) {
    const out = [];
    const seen = new Set();
    for (const d of docs) {
      deepQueryAll(d, 'input, textarea, select, [role="radio"], [role="checkbox"]').forEach(el => {
        if (seen.has(el)) return;
        seen.add(el);
        const kind = classifyControl(el);
        if (!kind) return;
        if (kind.startsWith('aria-')) {
          const nativeType = kind === 'aria-radio' ? 'radio' : 'checkbox';
          if (el.querySelector(`input[type="${nativeType}"]`)) return; // prefer the native input inside
        }
        if (!isUsable(el, kind)) return;
        out.push({ el, kind, doc: d });
      });
    }
    return out;
  }

  /** Label text + the DOM nodes that make up the label (so they can be excluded from question text). */
  function optionLabel(el, kind, allControlSet) {
    const nodes = [];
    let text = '';
    if (kind === 'radio' || kind === 'checkbox') {
      const labels = el.labels ? Array.from(el.labels) : [];
      const parts = [];
      for (const l of labels) { const t = textOf(l, new Set([el])); if (t) { parts.push(t); nodes.push(l); } }
      text = norm(parts.join(' '));
      if (!text) { const r = textOfIdRefs(el, 'aria-labelledby'); if (r.text) { text = r.text; nodes.push(...r.nodes); } }
      if (!text && el.getAttribute('aria-label')) text = norm(el.getAttribute('aria-label'));
      if (!text) {
        // Bare text right after the input: <i