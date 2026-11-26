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
    API_BASE_URL: 'https://integrate.api.nvidia.com/v1',

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
        // Bare text right after the input: <input> Paris <br>
        const parts2 = [];
        for (let n = el.nextSibling; n; n = n.nextSibling) {
          if (n.nodeType === 3) { if (norm(n.nodeValue)) { parts2.push(n.nodeValue); nodes.push(n); } continue; }
          if (n.nodeType !== 1) continue;
          if (n.tagName === 'BR' || n.tagName === 'HR') break;
          if (allControlSet.has(n) || Array.from(allControlSet).some(c => n.contains(c))) break;
          const inline = /^(SPAN|B|I|U|EM|STRONG|CODE|SUB|SUP|SMALL|MARK|KBD|VAR|SAMP|Q|ABBR|FONT|A)$/.test(n.tagName);
          const t = textOf(n);
          if (inline) { if (t) { parts2.push(t); nodes.push(n); } continue; }
          if (!parts2.some(p => norm(p)) && t) { parts2.push(t); nodes.push(n); }
          break;
        }
        text = norm(parts2.join(' '));
      }
      if (!text && el.parentElement) {
        const p = el.parentElement;
        const ctrls = Array.from(allControlSet).filter(c => c !== el && p.contains(c));
        if (!ctrls.length && p.tagName !== 'FORM' && p.tagName !== 'BODY') { const t = textOf(p, new Set([el])); if (t && t.length < 300) { text = t; nodes.push(p); } }
      }
      if (!text && el.value && el.value !== 'on') text = norm(el.value);
      if (!text && el.title) text = norm(el.title);
    } else { // aria-radio / aria-checkbox
      const r = textOfIdRefs(el, 'aria-labelledby');
      if (r.text) { text = r.text; nodes.push(...r.nodes); }
      if (!text && el.getAttribute('aria-label')) text = norm(el.getAttribute('aria-label'));
      if (!text) text = textOf(el);
      if (!text && el.getAttribute('data-value')) text = norm(el.getAttribute('data-value'));
      nodes.push(el);
    }
    return { text, nodes };
  }

  function fieldLabel(el) {
    const nodes = [];
    const parts = [];
    if (el.labels) for (const l of el.labels) { const t = textOf(l, new Set([el])); if (t) { parts.push(t); nodes.push(l); } }
    const r = textOfIdRefs(el, 'aria-labelledby'); if (r.text) { parts.push(r.text); nodes.push(...r.nodes); }
    if (!parts.length && el.getAttribute('aria-label')) parts.push(norm(el.getAttribute('aria-label')));
    if (!parts.length && el.title) parts.push(norm(el.title));
    return { text: norm(parts.join(' ')), nodes, placeholder: norm(el.getAttribute('placeholder') || '') };
  }

  /**
   * Builds an ordered list of tokens over `scope`: question controls, option-label regions and
   * free text. Used to find the text that precedes a group when the layout is flat.
   */
  function buildTokens(scope, controlToKey, optionNodeToKey) {
    const tokens = [];
    const rec = (n, depth) => {
      if (depth > 200) return;
      for (const c of childrenForWalk(n)) {
        if (c.nodeType === 3) {
          if (optionNodeToKey.has(c)) tokens.push({ key: optionNodeToKey.get(c) });
          else { const t = norm(c.nodeValue); if (t) tokens.push({ text: t }); }
          continue;
        }
        if (c.nodeType !== 1) continue;
        if (controlToKey.has(c)) { tokens.push({ key: controlToKey.get(c) }); continue; }
        if (optionNodeToKey.has(c)) { tokens.push({ key: optionNodeToKey.get(c) }); continue; }
        if (c.tagName === 'HR') { tokens.push({ boundary: true }); continue; }
        if (SKIP_TEXT_TAGS.has(c.tagName)) continue;
        if (!isDisplayed(c)) continue;
        rec(c, depth + 1);
      }
    };
    rec(scope, 0);
    return tokens;
  }

  function precedingText(tokens, key) {
    const idx = tokens.findIndex(t => t.key === key);
    if (idx < 0) return '';
    const parts = [];
    let len = 0;
    for (let i = idx - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.key !== undefined || t.boundary) break;
      parts.unshift(t.text);
      len += t.text.length;
      if (len > 1200) break;
    }
    return norm(parts.join(' '));
  }

  /** Splits a set of loose controls into runs separated by non-option text (= a new question). */
  function splitByInterveningText(container, items, labelNodes) {
    if (items.length < 2) return [items];
    const ctrlKey = new Map(items.map((it, i) => [it.el, 'c' + i]));
    const optKey = new Map();
    items.forEach((it, i) => labelNodes.get(it.el).forEach(n => optKey.set(n, 'c' + i)));
    const tokens = buildTokens(container, ctrlKey, optKey);
    const runs = [];
    let current = [];
    let textSince = '';
    const seenKeys = new Set();
    for (const t of tokens) {
      if (t.key !== undefined) {
        if (seenKeys.has(t.key)) continue;
        seenKeys.add(t.key);
        if (current.length && textSince.length >= 3) { runs.push(current); current = []; }
        current.push(items[Number(t.key.slice(1))]);
        textSince = '';
      } else if (t.text) textSince += t.text;
      else if (t.boundary && current.length) { runs.push(current); current = []; textSince = ''; }
    }
    if (current.length) runs.push(current);
    // safety: any item not seen in tokens becomes its own run
    items.forEach((it, i) => { if (!seenKeys.has('c' + i)) runs.push([it]); });
    return runs;
  }

  function detectQuestions() {
    const { docs, crossOrigin } = collectDocuments();
    const controls = collectControls(docs);
    const allControlSet = new Set(controls.map(c => c.el));
    const labelNodes = new Map();
    const labelText = new Map();
    for (const c of controls) {
      if (c.kind === 'radio' || c.kind === 'checkbox' || c.kind === 'aria-radio' || c.kind === 'aria-checkbox') {
        const l = optionLabel(c.el, c.kind, allControlSet);
        labelNodes.set(c.el, l.nodes);
        labelText.set(c.el, l.text);
      }
    }

    // ---- grouping ----
    const groups = [];
    const byKey = new Map();
    const loose = { radio: [], checkbox: [], 'aria-radio': [], 'aria-checkbox': [] };
    const nameCounts = new Map();
    for (const c of controls) {
      if ((c.kind === 'radio' || c.kind === 'checkbox') && c.el.name) {
        const k = c.kind + '|' + objId(c.el.form || c.el.getRootNode()) + '|' + c.el.name;
        nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
      }
    }
    for (const c of controls) {
      if (c.kind === 'text' || c.kind === 'textarea' || c.kind === 'select') { groups.push({ kind: c.kind, items: [c] }); continue; }
      if ((c.kind === 'radio' || c.kind === 'checkbox') && c.el.name) {
        const k = c.kind + '|' + objId(c.el.form || c.el.getRootNode()) + '|' + c.el.name;
        if (c.kind === 'radio' || nameCounts.get(k) > 1) {
          if (!byKey.has(k)) { const g = { kind: c.kind, items: [] }; byKey.set(k, g); groups.push(g); }
          byKey.get(k).items.push(c);
          continue;
        }
      }
      if (c.kind === 'aria-radio') {
        const rg = closestDeep(getParent(c.el), '[role="radiogroup"]');
        if (rg) {
          const k = 'arg|' + objId(rg);
          if (!byKey.has(k)) { const g = { kind: c.kind, items: [], groupEl: rg }; byKey.set(k, g); groups.push(g); }
          byKey.get(k).items.push(c);
          continue;
        }
      }
      loose[c.kind].push(c);
    }
    // loose controls: cluster by container, then split by intervening question text
    for (const kind of Object.keys(loose)) {
      const list = loose[kind];
      if (!list.length) continue;
      const containers = new Map();
      for (const c of list) {
        let container = closestDeep(getParent(c.el), 'fieldset, [role="group"], [role="radiogroup"]');
        if (!container || list.filter(o => containsDeep(container, o.el)).length < 2) {
          container = null;
          for (let a = getParent(c.el); a; a = getParent(a)) {
            if (list.filter(o => containsDeep(a, o.el)).length >= 2) { container = a; break; }
          }
        }
        const k = container ? objId(container) : 'solo' + objId(c.el);
        if (!containers.has(k)) containers.set(k, { container, items: [] });
        containers.get(k).items.push(c);
      }
      for (const { container, items } of containers.values()) {
        const runs = container ? splitByInterveningText(container, items, labelNodes) : [items];
        runs.forEach(run => groups.push({ kind, items: run }));
      }
    }

    // ---- dedupe: a control may only belong to one group ----
    const claimed = new Set();
    const uniqueGroups = [];
    for (const g of groups) {
      g.items = g.items.filter(it => !claimed.has(it.el));
      g.items.forEach(it => claimed.add(it.el));
      if (g.items.length) uniqueGroups.push(g);
    }
    // document order
    uniqueGroups.sort((a, b) => {
      const x = a.items[0].el, y = b.items[0].el;
      if (x.ownerDocument !== y.ownerDocument) return docs.indexOf(x.ownerDocument) - docs.indexOf(y.ownerDocument);
      const pos = x.compareDocumentPosition(y);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : pos & Node.DOCUMENT_POSITION_PRECEDING ? 1 : 0;
    });

    // ---- token maps for flat layouts ----
    const controlToKey = new Map();
    const optionNodeToKey = new Map();
    uniqueGroups.forEach((g, gi) => {
      g.key = 'g' + gi;
      g.items.forEach(it => {
        controlToKey.set(it.el, g.key);
        (labelNodes.get(it.el) || []).forEach(n => optionNodeToKey.set(n, g.key));
      });
    });
    const tokenCache = new Map();
    const tokensFor = (scope) => { if (!tokenCache.has(scope)) tokenCache.set(scope, buildTokens(scope, controlToKey, optionNodeToKey)); return tokenCache.get(scope); };
    const otherControlsInside = (container, own) => controls.some(c => !own.has(c.el) && containsDeep(container, c.el));

    // ---- build question objects ----
    const questions = [];
    const skipped = [];
    const fingerprints = new Set();
    uniqueGroups.forEach((g) => {
      const els = g.items.map(i => i.el);
      const own = new Set(els);
      const exclude = new Set(els);
      els.forEach(e => (labelNodes.get(e) || []).forEach(n => exclude.add(n)));
      const isChoice = g.kind !== 'text' && g.kind !== 'textarea' && g.kind !== 'select';
      const first = els[0];
      const sources = [];

      // a) fieldset legend (only if the fieldset is exclusive to this question)
      const fs = closestDeep(getParent(first), 'fieldset');
      if (fs && els.every(e => containsDeep(fs, e)) && !otherControlsInside(fs, own)) {
        const lg = Array.from(fs.children).find(ch => ch.tagName === 'LEGEND');
        if (lg && textOf(lg)) { sources.push(textOf(lg)); exclude.add(lg); }
      }
      // b) ARIA group label
      const grp = g.groupEl || closestDeep(getParent(first), '[role="radiogroup"],[role="group"]');
      if (grp && els.every(e => containsDeep(grp, e)) && !otherControlsInside(grp, own)) {
        const r = textOfIdRefs(grp, 'aria-labelledby');
        if (r.text) { sources.push(r.text); r.nodes.forEach(n => exclude.add(n)); }
        else if (grp.getAttribute('aria-label')) sources.push(norm(grp.getAttribute('aria-label')));
      }
      // c) field label for text/select
      let fl = null;
      if (!isChoice) {
        fl = fieldLabel(first);
        if (fl.text) sources.push(fl.text);
        fl.nodes.forEach(n => exclude.add(n));
      }
      // d) exclusive container text (nested layouts)
      let container = els.length > 1 ? lowestCommonAncestor(els) : getParent(first);
      let containerText = '';
      if (container && !otherControlsInside(container, own)) {
        for (let p = getParent(container); p && p.nodeType === 1; p = getParent(p)) {
          if (/^(BODY|HTML|FORM|MAIN)$/.test(p.tagName) || otherControlsInside(p, own)) break;
          if (textOf(p, exclude).length > 2500) break;
          container = p;
        }
        containerText = textOf(container, exclude);
      }
      // e) preceding text in document order (flat layouts)
      let before = '';
      if (containerText.length < 15) {
        const scope = closestDeep(first, 'form') || first.ownerDocument.body;
        if (scope) before = precedingText(tokensFor(scope), g.key);
      }

      const pieces = [];
      const add = (s) => { s = norm(s); if (s && !pieces.some(p => p.includes(s))) { for (let i = pieces.length - 1; i >= 0; i--) if (s.includes(pieces[i])) pieces.splice(i, 1); pieces.push(s); } };
      add(before); sources.forEach(add); add(containerText);
      let qText = norm(pieces.join(' \u2014 '));
      if (!qText && fl && fl.placeholder) qText = fl.placeholder;
      qText = truncate(qText, 1500);

      const base = { group: g, els, kind: g.kind, doc: first.ownerDocument };

      if (!isChoice && (PERSONAL_ATTR.test(first.name || '') || PERSONAL_ATTR.test(first.id || '') ||
        PERSONAL_AUTOCOMPLETE.test(first.getAttribute('autocomplete') || '') || PERSONAL_LABEL.test((fl && fl.text) || qText))) {
        skipped.push({ ...base, text: qText || '(unlabelled field)', reason: 'Looks like a personal-information field (name/email/ID); left for you to fill.' });
        return;
      }
      if (!qText) {
        skipped.push({ ...base, text: '(no question text found)', reason: 'Could not find question text for this field; refusing to guess.' });
        return;
      }

      let options = [];
      let type;
      if (g.kind === 'select') {
        const sel = first;
        type = sel.multiple ? 'multiple_select' : 'dropdown';
        const real = Array.from(sel.options).filter((o, i) => {
          const t = norm(o.text);
          if (!t) return false;
          if (o.disabled) return false;
          if (o.value === '' && (i === 0 || /^(-+|select|choose|pick|please)/i.test(t))) return false;
          if (/^[-\u2013\u2014\s]*(select|choose|pick)\b.*[-\u2013\u2014\s]*$/i.test(t) && i === 0) return false;
          return true;
        });
        options = real.map((o, i) => ({ id: optionIdFor(i), text: norm(o.text), optionEl: o }));
        if (options.length < 2) { skipped.push({ ...base, text: qText, reason: 'Dropdown has fewer than 2 real options.' }); return; }
      } else if (isChoice) {
        const multiple = g.kind === 'checkbox' || g.kind === 'aria-checkbox';
        type = multiple ? 'multiple_choice' : 'single_choice';
        options = g.items.map((it, i) => ({ id: optionIdFor(i), text: labelText.get(it.el) || '', el: it.el }));
        if (options.some(o => !o.text)) { skipped.push({ ...base, text: qText, reason: 'At least one option has no readable label; refusing to guess.' }); return; }
        if (options.length < 2) { skipped.push({ ...base, text: qText, reason: multiple ? 'Standalone checkbox (likely a consent/toggle), not a quiz question.' : 'Only one radio option found.' }); return; }
      } else {
        type = g.kind === 'textarea' ? 'long_text' : (first.type === 'number' ? 'number' : 'short_text');
      }

      const fp = lower(qText) + '||' + options.map(o => lower(o.text)).join('|') + '||' + objId(first.ownerDocument);
      if (fingerprints.has(fp) && isChoice) {
        // identical question repeated: keep both, but note it (different fields)
        debug('Duplicate-looking question text:', truncate(qText, 80));
      }
      fingerprints.add(fp);
      questions.push({ ...base, type, text: qText, options, fingerprint: fp });
    });

    questions.forEach((q, i) => { q.id = 'q' + (i + 1); });
    return { questions, skipped, docs, crossOrigin, controlsFound: controls.length };
  }

  async function detectWithWaiting() {
    let det = detectQuestions();
    if (det.questions.length || det.skipped.length) return det;
    log(`No questions yet. Watching for dynamically rendered content (up to ${Math.round(CONFIG.WAIT_FOR_QUESTIONS_MS / 1000)}s)...`);
    det = await new Promise((resolve) => {
      let debounce = null;
      let finished = false;
      const finish = (d) => { if (finished) return; finished = true; obs.disconnect(); clearTimeout(debounce); clearTimeout(max); resolve(d); };
      const obs = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { if (state.aborted) { finish(detectQuestions()); return; } const d = detectQuestions(); if (d.questions.length) finish(d); }, CONFIG.DOM_QUIET_PERIOD_MS);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      const max = setTimeout(() => finish(detectQuestions()), CONFIG.WAIT_FOR_QUESTIONS_MS);
    });
    return det;
  }

  /* =========================================================================
   * 8. CURRENT STATE OF A QUESTION
   * ======================================================================= */
  const isAriaChecked = (el) => el.getAttribute('aria-checked') === 'true';
  function currentSelection(q) {
    switch (q.kind) {
      case 'radio': case 'checkbox': return q.options.filter(o => o.el.checked).map(o => o.id);
      case 'aria-radio': case 'aria-checkbox': return q.options.filter(o => isAriaChecked(o.el)).map(o => o.id);
      case 'select': return q.options.filter(o => o.optionEl.selected).map(o => o.id);
      default: return [];
    }
  }
  function isAlreadyAnswered(q) {
    if (q.kind === 'text' || q.kind === 'textarea') return norm(q.els[0].value) !== '';
    if (q.kind === 'select' && !q.els[0].multiple) {
      const sel = q.els[0];
      const so = sel.options[sel.selectedIndex];
      if (!so || !q.options.some(o => o.optionEl === so)) return false; // placeholder or nothing selected
      if (so.defaultSelected) return false;                           // preset by the page, not by you
      return sel.selectedIndex !== 0;                                 // index 0 = browser default
    }
    return currentSelection(q).length > 0;
  }

  /* =========================================================================
   * 9. NVIDIA API CLIENT
   * ======================================================================= */
  class ApiError extends Error {
    constructor(kind, message, status, retryAfterMs) { super(message); this.name = 'ApiError'; this.kind = kind; this.status = status || 0; this.retryAfterMs = retryAfterMs || 0; }
  }
  const baseUrl = () => CONFIG.API_BASE_URL.replace(/\/+$/, '');

  async function apiFetch(path, options, apiKey) {
    checkAbort();
    const ctl = new AbortController();
    state.controllers.add(ctl);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, CONFIG.REQUEST_TIMEOUT_MS);
    let cspViolation = null;
    const onCsp = (e) => { if (String(e.blockedURI || '').includes(new URL(baseUrl()).host)) cspViolation = e.violatedDirective; };
    document.addEventListener('securitypolicyviolation', onCsp);
    try {
      const res = await fetch(baseUrl() + path, {
        ...options,
        signal: ctl.signal,
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + apiKey, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      });
      const raw = await res.text();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      if (!res.ok) {
        const detail = scrub(truncate((body && (body.detail || (body.error && (body.error.message || body.error)) || body.message || body.title)) ? safeStringify(body.detail || (body.error && (body.error.message || body.error)) || body.message || body.title) : raw || res.statusText, 300));
        const ra = res.headers.get('retry-after');
        const raMs = ra ? (isNaN(Number(ra)) ? Math.max(0, Date.parse(ra) - Date.now()) : Number(ra) * 1000) : 0;
        if (res.status === 401 || res.status === 403) throw new ApiError('auth', `HTTP ${res.status}: the API key was rejected or lacks access (${detail}).`, res.status);
        if (res.status === 429) throw new ApiError('rate', `HTTP 429: rate limited (${detail}).`, 429, raMs);
        if (res.status === 404 || res.status === 422 || (res.status === 400 && /model|not found|unknown|unsupported|does not exist/i.test(detail))) throw new ApiError('model', `HTTP ${res.status}: ${detail}`, res.status);
        if (res.status >= 500) throw new ApiError('server', `HTTP ${res.status}: NVIDIA server error (${detail}).`, res.status, raMs);
        throw new ApiError('bad_request', `HTTP ${res.status}: ${detail}`, res.status);
      }
      if (body === null) throw new ApiError('server', 'The API returned a non-JSON response.', res.status);
      return body;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (state.aborted) throw new AbortedError();
      if (timedOut) throw new ApiError('timeout', `Request timed out after ${Math.round(CONFIG.REQUEST_TIMEOUT_MS / 1000)}s.`);
      if (cspViolation) throw new ApiError('blocked', `This page's Content-Security-Policy (${cspViolation}) blocks requests to ${new URL(baseUrl()).host}. QuizPilot cannot call NVIDIA from this page.`);
      throw new ApiError('network', 'The request failed before a response arrived. Likely causes: the page\'s Content-Security-Policy, the API not allowing browser (CORS) requests from this origin, an extension/firewall block, or no network. If this repeats, run quizpilot-proxy.js and set API_BASE_URL to http://127.0.0.1:8787/v1 (see the README).');
    } finally {
      clearTimeout(timer);
      state.controllers.delete(ctl);
      document.removeEventListener('securitypolicyviolation', onCsp);
    }
  }

  const NON_CHAT_RE = /(embed|rerank|retriev|guard|safety|reward|shield|clip|parse|ocr|asr|whisper|tts|speech|audio|riva|flux|sdxl|stable-diffusion|diffusion|cosmos|paligemma|kosmos|deplot|neva|vila\b|fuyu|detector|segment|pii|moderation|bge|e5-|arctic-embed|grounding|coder|starcoder|codegemma|codellama|code-llama|usdcode|bert|gliner|topic-control|content-safety|translate|fastpitch|tacotron|nemoretriever|streampetr|bevformer|sparsedrive|genmol|molmim|diffdock|esm|alphafold|openfold|proteinmpnn|rfdiffusion|evo2|msa-search|vista|maisi|trellis|edify|getty|shutterstock|ising|calibrat)/i;
  function rankModels(ids) {
    const pref = CONFIG.PREFERRED_MODELS.map(m => m.toLowerCase());
    const scored = ids.filter(id => !NON_CHAT_RE.test(id)).map(id => {
      const l = id.toLowerCase();
      let s = 0;
      const pi = pref.indexOf(l);
      if (pi >= 0) s += 1000 - pi * 10;
      if (/instruct|chat|-it\b|nemotron/.test(l)) s += 50;
      const m = l.match(/(\d+(?:\.\d+)?)b\b/);
      if (m) { const b = parseFloat(m[1]); s += Math.min(b, 80) / 2; if (b < 3) s -= 30; if (b > 300) s -= 15; }
      if (/\br1\b|-r1|reason|think|qwq/.test(l)) s -= 40;   // slow and verbose
      if (/vision|-vl\b|vl-|multimodal/.test(l)) s -= 30;
      if (/base\b|-base/.test(l) && !/instruct/.test(l)) s -= 60;
      return { id, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.id);
  }

  async function discoverModels(apiKey) {
    const manual = norm(CONFIG.MODEL);
    if (manual && CONFIG.STRICT_MODEL) return { models: [manual], source: 'manual (strict)' };
    let discovered = [];
    let source = 'model list';
    try {
      const body = await apiFetch('/models', { method: 'GET' }, apiKey);
      const data = Array.isArray(body && body.data) ? body.data : Array.isArray(body) ? body : [];
      discovered = rankModels(data.map(m => (m && (m.id || m.name)) || '').filter(Boolean));
      if (!discovered.length) { warn('The model list returned no chat models; using the built-in preferred list.'); source = 'built-in list'; }
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      if (e.kind === 'auth') throw new StopError(e.message + ' Check NVIDIA_API_KEY.');
      if (e.kind === 'network' || e.kind === 'blocked') throw new StopError('Connecting to NVIDIA failed. ' + e.message);
      warn('Model discovery failed (' + e.message + '). Using the built-in preferred list.');
      source = 'built-in list';
    }
    if (!discovered.length) discovered = CONFIG.PREFERRED_MODELS.slice();
    let models = discovered;
    if (manual) models = [manual, ...discovered.filter(m => m !== manual)];
    return { models: models.slice(0, Math.max(1, CONFIG.MAX_MODELS_TO_TRY + (manual ? 1 : 0))), source: manual ? 'manual + ' + source : source };
  }

  /* =========================================================================
   * 10. PROMPT + RESPONSE PARSING
   * ======================================================================= */
  const SYSTEM_PROMPT = [
    'You answer questions from a practice quiz. Input is JSON with a "questions" array.',
    'Each question has: "question_id", "type" (single_choice | multiple_choice | dropdown | multiple_select | short_text | long_text | number), "question" text, and for choice types an "options" array of {"id","text"}.',
    'Option "id" values (A, B, C, ...) are assigned by the system in display order. The option "text" may contain the page\'s own numbering such as "a)" or "1." - never confuse that with the id.',
    'Rules:',
    '1. Read the whole question and evaluate every option before answering.',
    '2. single_choice and dropdown: exactly one option id. multiple_choice and multiple_select: every correct option id (one or more).',
    '3. "answer" holds option ids; "answer_text" holds the EXACT option text for each id, copied verbatim, in the same order.',
    '4. short_text / long_text / number: "answer" is [] and "answer_text" holds exactly one string (a number only, for type number). Keep short_text brief.',
    '5. "confidence" is a number from 0 to 1. If unsure, the question is ambiguous, or information is missing, set "uncertain": true and confidence below 0.6. Do not pretend certainty.',
    '6. "explanation": one or two short sentences.',
    '7. Include every question_id exactly once.',
    'Respond with ONLY a JSON object, no markdown, no prose, using this schema:',
    '{"answers":[{"question_id":"q1","answer":["B"],"answer_text":["exact option text"],"confidence":0.9,"uncertain":false,"explanation":"..."}]}',
  ].join('\n');

  function questionPayload(q) {
    const p = { question_id: q.id, type: q.type, question: q.text };
    if (q.options.length) p.options = q.options.map(o => ({ id: o.id, text: truncate(o.text, 400) }));
    if (q.type === 'number') {
      const el = q.els[0];
      if (el.min !== '') p.min = el.min;
      if (el.max !== '') p.max = el.max;
    }
    if ((q.type === 'short_text' || q.type === 'long_text') && q.els[0].maxLength > 0) p.max_length = q.els[0].maxLength;
    return p;
  }

  function extractJson(text) {
    let t = String(text || '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    if (/<\/think>/i.test(t)) t = t.slice(t.search(/<\/think>/i) + 8);
    const candidates = [];
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidates.push(fence[1]);
    candidates.push(t);
    for (const c of candidates) {
      for (const opener of ['{', '[']) {
        const start = c.indexOf(opener);
        if (start < 0) continue;
        const slice = balancedSlice(c, start);
        if (!slice) continue;
        const attempts = [slice, slice.replace(/,\s*([}\]])/g, '$1'), slice.replace(/[\u201C\u201D]/g, '"').replace(/,\s*([}\]])/g, '$1')];
        for (const a of attempts) {
          try {
            const v = JSON.parse(a);
            if (Array.isArray(v)) return { answers: v };
            if (v && typeof v === 'object') return v;
          } catch (_) { /* try next */ }
        }
      }
    }
    return null;
  }
  function balancedSlice(s, start) {
    const open = s[start], close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;
  }

  /** Validates the model output against the questions that were asked. */
  function validateAnswers(parsed, batch) {
    const problems = [];
    const result = new Map();
    const ids = new Map(batch.map(q => [q.id.toLowerCase(), q]));
    const list = parsed && Array.isArray(parsed.answers) ? parsed.answers : null;
    if (!list) return { result, problems: ['Response JSON has no "answers" array.'], valid: false };
    const conflicts = new Set();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') { problems.push('Non-object entry ignored.'); continue; }
      const qid = String(raw.question_id == null ? raw.id || '' : raw.question_id).trim().toLowerCase();
      const q = ids.get(qid);
      if (!q) { problems.push(`Unknown question_id "${truncate(qid, 20)}" ignored.`); continue; }
      const toArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(x => (typeof x === 'string' || typeof x === 'number' ? String(x) : '')).filter(x => x !== '');
      let conf = Number(raw.confidence);
      if (!isFinite(conf)) conf = NaN;
      else if (conf > 1 && conf <= 100) conf = conf / 100;
      const a = {
        question_id: q.id,
        answer: toArr(raw.answer),
        answer_text: toArr(raw.answer_text),
        confidence: isFinite(conf) ? clamp(conf, 0, 1) : 0,
        uncertain: raw.uncertain === true || raw.uncertain === 'true' || !isFinite(conf),
        explanation: truncate(norm(typeof raw.explanation === 'string' ? raw.explanation : ''), 400),
      };
      if (result.has(q.id)) {
        const prev = result.get(q.id);
        const same = safeStringify(prev.answer.map(normId).sort()) === safeStringify(a.answer.map(normId).sort()) && lower(prev.answer_text.join('|')) === lower(a.answer_text.join('|'));
        if (!same) { conflicts.add(q.id); problems.push(`Conflicting duplicate answers for ${q.id}.`); }
        continue;
      }
      result.set(q.id, a);
    }
    conflicts.forEach(id => { const a = result.get(id); a.conflict = true; });
    const missing = batch.filter(q => !result.has(q.id)).map(q => q.id);
    if (missing.length) problems.push(`Missing answers for: ${missing.join(', ')}.`);
    return { result, problems, missing, valid: true };
  }

  /* =========================================================================
   * 11. CALLING THE MODEL WITH RETRIES, FALLBACK AND BATCH SPLITTING
   * ======================================================================= */
  async function chatCompletion(model, batch, apiKey, extraNote) {
    const user = JSON.stringify({ questions: batch.map(questionPayload) });
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: (extraNote ? extraNote + '\n' : '') + user }];
    const body = await apiFetch('/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model, messages, temperature: CONFIG.TEMPERATURE, top_p: 0.9, max_tokens: CONFIG.MAX_TOKENS, stream: false }),
    }, apiKey);
    const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
    const content = choice && choice.message ? (typeof choice.message.content === 'string' ? choice.message.content : Array.isArray(choice.message.content) ? choice.message.content.map(p => p.text || '').join('') : '') : '';
    return { content: content || '', finish: choice ? choice.finish_reason : null };
  }

  const backoffMs = (attempt, hint) => Math.min(30000, Math.max(hint || 0, 1000 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400));

  /** Tries one model for a batch. Returns validated answers or throws ApiError. */
  async function answerWithModel(model, batch, apiKey) {
    let note = '';
    let jsonFailures = 0;
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES_PER_MODEL; attempt++) {
      checkAbort();
      try {
        const { content, finish } = await chatCompletion(model, batch, apiKey, note);
        const parsed = extractJson(content);
        if (!parsed) {
          if (finish === 'length') throw new ApiError('truncated', 'Response was cut off by the token limit.');
          jsonFailures++;
          debug(`Model ${model} returned non-JSON:`, truncate(content, 200));
          if (jsonFailures >= 2) throw new ApiError('model', 'Model repeatedly returned invalid JSON.');
          note = 'IMPORTANT: your previous reply was not valid JSON. Reply with ONLY the JSON object.';
          continue;
        }
        const v = validateAnswers(parsed, batch);
        if (!v.valid) {
          jsonFailures++;
          if (jsonFailures >= 2) throw new ApiError('model', 'Model repeatedly returned JSON without an "answers" array.');
          note = 'IMPORTANT: reply with a JSON object of the form {"answers":[...]} only.';
          continue;
        }
        v.problems.forEach(p => debug(p));
        return v;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.kind === 'auth' || e.kind === 'network' || e.kind === 'blocked' || e.kind === 'model' || e.kind === 'truncated' || e.kind === 'bad_request') throw e;
        if (attempt >= CONFIG.MAX_RETRIES_PER_MODEL) throw e;
        const wait = backoffMs(attempt, e.retryAfterMs);
        warn(`${e.message} Retrying ${model} in ${(wait / 1000).toFixed(1)}s (attempt ${attempt + 2}/${CONFIG.MAX_RETRIES_PER_MODEL + 1})...`);
        await sleep(wait);
      }
    }
    throw new ApiError('model', 'No usable response.');
  }

  /** Answers a batch, falling back across models and splitting the batch if output is truncated. */
  async function answerBatch(batch, ctx, apiKey) {
    const order = [ctx.models[ctx.current], ...ctx.models.filter((_, i) => i !== ctx.current)].filter((m) => !ctx.dead.has(m));
    let lastErr = null;
    for (const model of order) {
      checkAbort();
      try {
        const v = await answerWithModel(model, batch, apiKey);
        if (ctx.models[ctx.current] !== model) {
          ctx.current = ctx.models.indexOf(model);
          log('Selected model: ' + model + ' (fallback)');
        }
        return v;
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        lastErr = e;
        if (e.kind === 'auth') throw new StopError(e.message);
        if (e.kind === 'network' || e.kind === 'blocked') throw new StopError(e.message);
        if (e.kind === 'truncated' && batch.length > 1) {
          warn(`Output was truncated; splitting a batch of ${batch.length} questions.`);
          const mid = Math.ceil(batch.length / 2);
          const a = await answerBatch(batch.slice(0, mid), ctx, apiKey);
          const b = await answerBatch(batch.slice(mid), ctx, apiKey);
          b.result.forEach((v, k) => a.result.set(k, v));
          return { result: a.result, problems: a.problems.concat(b.problems), missing: (a.missing || []).concat(b.missing || []), valid: true };
        }
        warn(`Model ${model} failed: ${e.message}`);
        if (e.kind === 'model' || e.kind === 'bad_request') ctx.dead.add(model);
      }
    }
    throw new StopError('All candidate models failed. Last error: ' + (lastErr ? lastErr.message : 'unknown'));
  }

  async function getAllAnswers(questions, ctx, apiKey) {
    const answers = new Map();
    const size = Math.max(1, CONFIG.QUESTIONS_PER_REQUEST);
    const batches = [];
    for (let i = 0; i < questions.length; i += size) batches.push(questions.slice(i, i + size));
    for (let bi = 0; bi < batches.length; bi++) {
      checkAbort();
      if (batches.length > 1) log(`Analyzing batch ${bi + 1}/${batches.length} (${batches[bi].length} questions)...`);
      try {
        const v = await answerBatch(batches[bi], ctx, apiKey);
        v.result.forEach((a, k) => answers.set(k, a));
      } catch (e) {
        if (e instanceof AbortedError || !answers.size) throw e;
        warn(`Stopping AI requests early (${e.message}). Keeping the ${answers.size} answer(s) already received.`);
        return answers;
      }
    }
    // one follow-up request for anything missing
    const missing = questions.filter(q => !answers.has(q.id));
    if (missing.length) {
      warn(`The model skipped ${missing.length} question(s); asking once more for: ${missing.map(q => q.id).join(', ')}`);
      try {
        const v = await answerBatch(missing, ctx, apiKey);
        v.result.forEach((a, k) => answers.set(k, a));
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        warn('Follow-up request failed: ' + e.message);
      }
    }
    return answers;
  }

  /* =========================================================================
   * 12. CONSERVATIVE ANSWER -> FIELD MAPPING
   * ======================================================================= */
  const MARKER_RE = /^\s*(?:\(\s*(?:[a-z]|\d{1,2}|[ivx]{1,4})\s*\)|\[\s*(?:[a-z]|\d{1,2})\s*\]|(?:[a-z]|\d{1,2}|[ivx]{1,4})\s*[).:\]-])\s*/i;
  const optKey = (s) => lower(s).replace(MARKER_RE, '').replace(/[\s.,;:!?]+$/, '').trim();
  const tokens = (s) => lower(s).replace(MARKER_RE, '').split(/[^a-z0-9\u00C0-\uFFFF]+/i).filter(Boolean);
  function textScore(a, b) {
    const ka = optKey(a), kb = optKey(b);
    if (!ka || !kb) return 0;
    if (ka === kb || lower(a) === lower(b)) return 1;
    const short = ka.length < kb.length ? ka : kb, long = ka.length < kb.length ? kb : ka;
    if (short.length >= 4 && long.includes(short) && short.length / long.length >= 0.8) return 0.9;
    const ta = new Set(tokens(a)), tb = new Set(tokens(b));
    if (!ta.size || !tb.size) return 0;
    let inter = 0; ta.forEach(t => { if (tb.has(t)) inter++; });
    return inter / (ta.size + tb.size - inter);
  }
  const MATCH_THRESHOLD = 0.85;

  /** Decides what (if anything) to fill. Returns {action:'fill'|'hold', status, reason, targetIds|value}. */
  function decide(q, a) {
    if (!a) return { action: 'hold', status: 'FAILED', reason: 'The model returned no answer for this question.' };
    if (a.conflict) return { action: 'hold', status: 'UNCERTAIN', reason: 'The model returned conflicting answers for this question.' };
    const lowConf = a.uncertain || a.confidence < CONFIG.MIN_CONFIDENCE_TO_FILL;
    if (q.options.length) {
      const ids = Array.from(new Set(a.answer.map(normId).filter(Boolean)));
      if (!ids.length) return { action: 'hold', status: a.uncertain ? 'UNCERTAIN' : 'FAILED', reason: 'No option was chosen.' };
      const invalid = ids.filter(id => !q.options.some(o => o.id === id));
      if (invalid.length) return { action: 'hold', status: 'UNCERTAIN', reason: `Model chose option id(s) that do not exist: ${invalid.join(', ')}.` };
      const single = q.type === 'single_choice' || q.type === 'dropdown';
      if (single && ids.length !== 1) return { action: 'hold', status: 'UNCERTAIN', reason: `Single-answer question but ${ids.length} options were chosen.` };
      if (!a.answer_text.length) return { action: 'hold', status: 'UNCERTAIN', reason: 'Model gave option ids without option text; cannot cross-check the mapping.' };
      // Each chosen id must be confirmed by a returned text that matches THAT option best (no ties).
      const usedTexts = new Set();
      for (const id of ids) {
        const opt = q.options.find(o => o.id === id);
        const dup = q.options.filter(o => o !== opt && optKey(o.text) === optKey(opt.text));
        if (dup.length) return { action: 'hold', status: 'UNCERTAIN', reason: `Option ${id} has the same text as another option; mapping is ambiguous.` };
        let confirmed = false;
        for (let ti = 0; ti < a.answer_text.length; ti++) {
          if (usedTexts.has(ti)) continue;
          const t = a.answer_text[ti];
          const s = textScore(t, opt.text);
          if (s < MATCH_THRESHOLD) continue;
          const better = q.options.some(o => o !== opt && textScore(t, o.text) >= s);
          if (better) continue;
          usedTexts.add(ti); confirmed = true; break;
        }
        if (!confirmed) {
          const best = a.answer_text.map(t => { const ranked = q.options.map(o => ({ o, s: textScore(t, o.text) })).sort((x, y) => y.s - x.s); return ranked[0]; }).filter(Boolean);
          const hint = best.length && best[0].s >= MATCH_THRESHOLD ? ` (the returned text matches option ${best[0].o.id} instead)` : '';
          return { action: 'hold', status: 'UNCERTAIN', reason: `Letter/text mismatch: option ${id} is "${truncate(opt.text, 60)}" but the model's text was "${truncate(a.answer_text.join(' | '), 80)}"${hint}. Not filled.` };
        }
      }
      if (usedTexts.size < a.answer_text.length) return { action: 'hold', status: 'UNCERTAIN', reason: 'The model returned option text that does not correspond to its chosen ids.' };
      if (lowConf) return { action: 'hold', status: 'UNCERTAIN', reason: `Low confidence (${a.confidence.toFixed(2)}${a.uncertain ? ', flagged uncertain' : ''}).`, targetIds: ids };
      return { action: 'fill', targetIds: ids };
    }
    // text-like
    let value = a.answer_text[0] != null ? a.answer_text[0] : (a.answer[0] != null ? a.answer[0] : '');
    value = String(value).replace(/\r\n/g, '\n').trim();
    if (!value) return { action: 'hold', status: a.uncertain ? 'UNCERTAIN' : 'FAILED', reason: 'Empty text answer.' };
    if (q.type === 'number') {
      const m = value.replace(/,/g, '').match(/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i);
      if (!m) return { action: 'hold', status: 'UNCERTAIN', reason: `Number field but the answer "${truncate(value, 40)}" is not a plain number.` };
      value = m[0];
    }
    if (q.type === 'short_text' && value.includes('\n')) value = value.replace(/\s*\n\s*/g, ' ');
    const max = q.els[0].maxLength;
    if (max > 0 && value.length > max) return { action: 'hold', status: 'UNCERTAIN', reason: `Answer is longer than the field allows (${value.length} > ${max}).`, value };
    if (lowConf) return { action: 'hold', status: 'UNCERTAIN', reason: `Low confidence (${a.confidence.toFixed(2)}${a.uncertain ? ', flagged uncertain' : ''}).`, value };
    return { action: 'fill', value };
  }

  /* =========================================================================
   * 13. FILLING + VERIFICATION
   * ======================================================================= */
  function dispatch(el, type, init) {
    const win = winOf(el);
    let ev;
    try {
      if (type === 'input' && typeof win.InputEvent === 'function') ev = new win.InputEvent('input', { bubbles: true, composed: true, ...(init || {}) });
      else if (/^(pointer)/.test(type) && typeof win.PointerEvent === 'function') ev = new win.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, view: win });
      else if (/^(mouse|click)/.test(type)) ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: win });
      else if (/^key/.test(type)) ev = new win.KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, ...(init || {}) });
      else ev = new win.Event(type, { bubbles: true, cancelable: false, composed: true });
    } catch (_) { ev = new win.Event(type, { bubbles: true }); }
    el.dispatchEvent(ev);
  }
  function nativeSetter(el, prop) {
    const win = winOf(el);
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    return d && d.set ? (v) => d.set.call(el, v) : (v) => { el[prop] = v; };
  }

  async function setNativeChecked(el, want) {
    const win = winOf(el);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (el.checked === want) return true;
      if (attempt === 0 || attempt === 2) el.click();               // the most framework-compatible path
      else { nativeSetter(el, 'checked')(want); dispatch(el, 'input'); dispatch(el, 'change'); }
      await settle(win);
    }
    return el.checked === want;
  }

  async function setAriaChecked(el, want) {
    const win = winOf(el);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (isAriaChecked(el) === want) return true;
      if (attempt === 0) el.click();
      else if (attempt === 1) { ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t => dispatch(el, t)); }
      else { try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ } dispatch(el, 'keydown', { key: ' ', code: 'Space' }); dispatch(el, 'keyup', { key: ' ', code: 'Space' }); }
      await settle(win);
    }
    return isAriaChecked(el) === want;
  }

  async function setTextValue(el, value) {
    const win = winOf(el);
    const same = () => (el.type === 'number' ? Number(el.value) === Number(value) && el.value !== '' : el.value === value);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (same()) return true;
      try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      nativeSetter(el, 'value')(value);
      dispatch(el, 'input', { inputType: 'insertText', data: value });
      dispatch(el, 'change');
      try { el.blur(); } catch (_) { /* ignore */ }
      await settle(win);
    }
    return same();
  }

  async function setSelect(q, ids) {
    const sel = q.els[0];
    const win = winOf(sel);
    const targets = q.options.filter(o => ids.includes(o.id)).map(o => o.optionEl);
    const ok = () => (sel.multiple
      ? Array.from(sel.options).every(o => (targets.includes(o) ? o.selected : !o.selected || !q.options.some(x => x.optionEl === o)))
      : sel.selectedIndex === targets[0].index);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (ok()) return true;
      if (sel.multiple) q.options.forEach(o => { o.optionEl.selected = targets.includes(o.optionEl); });
      else { nativeSetter(sel, 'value')(targets[0].value); if (sel.selectedIndex !== targets[0].index) sel.selectedIndex = targets[0].index; }
      dispatch(sel, 'input');
      dispatch(sel, 'change');
      await settle(win);
    }
    return ok();
  }

  /** Re-checks that the question still looks the same as when it was detected (page may re-render). */
  function stillMatches(q) {
    if (!q.els.every(e => e.isConnected)) return false;
    if (q.kind === 'select') return q.options.every(o => o.optionEl.isConnected && norm(o.optionEl.text) === o.text);
    if (q.options.length) {
      const all = new Set(collectControls([q.doc]).map(c => c.el));
      return q.options.every(o => norm(optionLabel(o.el, q.kind, all).text) === o.text);
    }
    return true;
  }

  async function fillQuestion(q, d) {
    if (q.options.length) {
      const want = new Set(d.targetIds);
      if (q.kind === 'select') {
        const ok = await setSelect(q, d.targetIds);
        return ok ? { ok: true } : { ok: false, reason: 'Dropdown value did not stick (the page may control this field differently).' };
      }
      const isRadio = q.kind === 'radio' || q.kind === 'aria-radio';
      const setFn = q.kind.startsWith('aria-') ? setAriaChecked : setNativeChecked;
      const read = q.kind.startsWith('aria-') ? isAriaChecked : (el) => el.checked;
      for (const o of q.options) {
        checkAbort();
        if (want.has(o.id)) { if (!(await setFn(o.el, true))) return { ok: false, reason: `Option ${o.id} could not be selected.` }; }
        else if (!isRadio && CONFIG.CLEAR_UNSELECTED_CHECKBOXES && read(o.el)) {
          if (!(await setFn(o.el, false))) return { ok: false, reason: `Option ${o.id} could not be cleared.` };
        }
      }
      await settle(winOf(q.els[0]));
      const now = q.options.filter(o => read(o.el)).map(o => o.id);
      const exact = isRadio || CONFIG.CLEAR_UNSELECTED_CHECKBOXES;
      const verified = exact ? now.length === want.size && now.every(id => want.has(id)) : [...want].every(id => now.includes(id));
      return verified ? { ok: true } : { ok: false, reason: `Verification failed: selected [${now.join(', ') || 'none'}], expected [${[...want].join(', ')}].` };
    }
    const ok = await setTextValue(q.els[0], d.value);
    return ok ? { ok: true } : { ok: false, reason: 'The text did not stick (the field may be controlled by the page in an unusual way).' };
  }

  /** Blocks form submission (event and programmatic) while QuizPilot is changing fields. */
  function installSubmitGuard(docs) {
    const restores = [];
    const onSubmit = (e) => { e.preventDefault(); e.stopImmediatePropagation(); warn('Blocked a form submission that was triggered while filling. QuizPilot never submits forms.'); };
    for (const d of docs) {
      d.addEventListener('submit', onSubmit, true);
      restores.push(() => d.removeEventListener('submit', onSubmit, true));
      const win = d.defaultView;
      if (win && win.HTMLFormElement) {
        const proto = win.HTMLFormElement.prototype;
        const origSubmit = proto.submit;
        const origRequest = proto.requestSubmit;
        proto.submit = function () { warn('Blocked form.submit() during filling.'); };
        if (origRequest) proto.requestSubmit = function () { warn('Blocked form.requestSubmit() during filling.'); };
        restores.push(() => { proto.submit = origSubmit; if (origRequest) proto.requestSubmit = origRequest; });
      }
    }
    return () => restores.forEach(r => { try { r(); } catch (_) { /* ignore */ } });
  }

  /* =========================================================================
   * 14. REPORTING
   * ======================================================================= */
  function describeAnswer(q, a) {
    if (!a) return '';
    if (q.options.length) return a.answer.map(normId).map(id => { const o = q.options.find(x => x.id === id); return o ? `${id}) ${truncate(o.text, 50)}` : id; }).join(' + ');
    return truncate(a.answer_text[0] || '', 80);
  }

  function printReport(rows, extra) {
    const count = (s) => rows.filter(r => r.status === s).length;
    console.groupCollapsed(`${TAG} Detailed results (${rows.length})`);
    for (const r of rows) {
      const head = `${r.id} [${r.status}] ${truncate(r.question, 90)}`;
      console.groupCollapsed(head);
      if (r.options && r.options.length) console.log('Options:', r.options.map(o => `${o.id}) ${o.text}`).join('  |  '));
      if (r.answer) console.log('Answer:', r.answer);
      if (r.confidence !== '') console.log('Confidence:', r.confidence);
      if (r.explanation) console.log('Explanation:', r.explanation);
      if (r.note) console.log('Note:', r.note);
      console.groupEnd();
    }
    console.groupEnd();
    try {
      console.table(rows.map(r => ({ id: r.id, status: r.status, answer: truncate(r.answer || '', 60), confidence: r.confidence, question: truncate(r.question, 70), note: truncate(r.note || '', 80) })));
    } catch (_) { /* console.table not available */ }
    log('Verified: ' + count('VERIFIED') + (count('ALREADY SET') ? ` (+${count('ALREADY SET')} already correct)` : ''));
    if (count('SUGGESTED')) log('Suggested (auto-fill off): ' + count('SUGGESTED'));
    log('Uncertain: ' + count('UNCERTAIN'));
    log('Failed: ' + count('FAILED'));
    log('Skipped: ' + (count('SKIPPED') + count('ANSWERED BY YOU')));
    if (extra) log(extra);
  }

  /* =========================================================================
   * 15. MAIN
   * ======================================================================= */
  async function main() {
    log('Initializing...');
    console.info(TAG, 'Security note: your API key is held in this page\'s memory and sent in request headers. Page scripts, extensions and anyone with DevTools access can read it. Use a dedicated key and revoke it after testing.');

    // --- API key ---
    let apiKey = norm((CONFIG.NVIDIA_API_KEY === 'PASTE_YOUR_NVIDIA_KEY_HERE' ? '' : CONFIG.NVIDIA_API_KEY) || (typeof W.QUIZPILOT_NVIDIA_KEY === 'string' ? W.QUIZPILOT_NVIDIA_KEY : ''));
    let localProxy = false;
    try { localProxy = /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(new URL(baseUrl()).hostname); } catch (_) { throw new StopError('CONFIG.API_BASE_URL is not a valid URL.'); }
    if (!apiKey && localProxy) { apiKey = 'proxy-managed'; log('Using the local proxy at ' + baseUrl() + ' (the proxy supplies the API key).'); }
    if (!apiKey) {
      try { apiKey = norm(W.prompt('QuizPilot: paste your NVIDIA API key (nvapi-...). It is kept only in memory for this run.') || ''); } catch (_) { apiKey = ''; }
    }
    if (!apiKey) throw new StopError('No NVIDIA API key provided. Set CONFIG.NVIDIA_API_KEY or window.QUIZPILOT_NVIDIA_KEY, or enter it at the prompt.');
    if (/\s/.test(apiKey)) throw new StopError('The API key contains whitespace; please re-copy it.');
    SECRET = apiKey;
    if (!localProxy && !/^nvapi-/.test(apiKey)) warn('The key does not start with "nvapi-". Continuing, but check it if requests are rejected.');

    // --- readiness ---
    await waitForReady(document, CONFIG.DOM_STABLE_TIMEOUT_MS);
    log('Detecting questions...');
    const stable = await waitForDomStable(document, CONFIG.DOM_QUIET_PERIOD_MS, CONFIG.DOM_STABLE_TIMEOUT_MS);
    if (!stable) warn('The page kept changing; detecting with the current content.');
    checkAbort();

    let det = await detectWithWaiting();
    checkAbort();

    const signals = proctoringSignals(det.docs);
    if (signals.length) {
      throw new StopError('This page shows signs of a proctored or locked-down assessment (' + signals.join('; ') + '). QuizPilot runs only on permitted practice quizzes and will not continue here.');
    }
    environmentReport(det.docs, det.crossOrigin).forEach(n => warn('Compatibility: ' + n));

    if (!det.questions.length) {
      const why = det.skipped.length ? det.skipped.map(s => `- ${truncate(s.text, 60)}: ${s.reason}`).join('\n') : (det.controlsFound ? 'Form controls were found but none could be mapped to a question.' : 'No supported form controls (radio, checkbox, select, text input, textarea) were found in the accessible page.');
      throw new StopError('No answerable questions detected. Nothing was changed.\n' + why);
    }
    log(`Found ${det.questions.length} question${det.questions.length === 1 ? '' : 's'}.` + (det.skipped.length ? ` (${det.skipped.length} field(s) skipped)` : ''));
    try {
      console.table(det.questions.map(q => ({ id: q.id, type: q.type, options: q.options.length || '', question: truncate(q.text, 90) })));
    } catch (_) { /* ignore */ }

    // --- what to ask ---
    const rows = new Map();
    const toAsk = [];
    for (const q of det.questions) {
      if ((q.type === 'short_text' || q.type === 'long_text' || q.type === 'number') && !CONFIG.FILL_TEXT_FIELDS) {
        rows.set(q.id, { id: q.id, status: 'SKIPPED', question: q.text, options: q.options, answer: '', confidence: '', note: 'Text fields disabled in CONFIG.' });
        continue;
      }
      if (!CONFIG.OVERWRITE_EXISTING_ANSWERS && isAlreadyAnswered(q)) {
        rows.set(q.id, { id: q.id, status: 'ANSWERED BY YOU', question: q.text, options: q.options, answer: '', confidence: '', note: 'Already has an answer; left unchanged (OVERWRITE_EXISTING_ANSWERS=false).' });
        continue;
      }
      toAsk.push(q);
    }
    if (!toAsk.length) {
      printReport(det.questions.map(q => rows.get(q.id)));
      log('Completed. (Nothing left to answer.)');
      return;
    }

    // --- models ---
    log('Connecting to NVIDIA...');
    const disc = await discoverModels(apiKey);
    debug('Candidate models:', disc.models.join(', '));
    const ctx = { models: disc.models, current: 0, dead: new Set() };
    log(`Selected model: ${ctx.models[0]} (${disc.source}; ${ctx.models.length - 1} fallback${ctx.models.length === 2 ? '' : 's'})`);

    // --- ask ---
    log(`Analyzing ${toAsk.length} question${toAsk.length === 1 ? '' : 's'}...`);
    const answers = await getAllAnswers(toAsk, ctx, apiKey);
    checkAbort();
    log('Answers received.');

    // --- decide + fill ---
    const decisions = new Map(toAsk.map(q => [q.id, decide(q, answers.get(q.id))]));
    let restoreGuard = null;
    if (CONFIG.AUTO_FILL && [...decisions.values()].some(d => d.action === 'fill')) {
      log('Filling permitted practice fields...');
      restoreGuard = installSubmitGuard(det.docs);
    }
    try {
      for (const q of toAsk) {
        const a = answers.get(q.id);
        const d = decisions.get(q.id);
        const row = { id: q.id, question: q.text, options: q.options, answer: describeAnswer(q, a), confidence: a ? a.confidence.toFixed(2) : '', explanation: a ? a.explanation : '', status: '', note: '' };
        rows.set(q.id, row);
        if (d.action !== 'fill') { row.status = d.status; row.note = d.reason + (row.answer ? ' Suggested answer shown above; not filled.' : ''); continue; }
        if (!CONFIG.AUTO_FILL) { row.status = 'SUGGESTED'; row.note = 'AUTO_FILL is off.'; continue; }
        if (state.aborted) { row.status = 'SKIPPED'; row.note = 'Aborted before filling.'; continue; }

        let target = q;
        if (!stillMatches(q)) {
          // The page re-rendered while we waited. Re-detect and re-map by exact fingerprint only.
          const fresh = detectQuestions().questions.filter(x => x.fingerprint === q.fingerprint);
          if (fresh.length !== 1) { row.status = 'FAILED'; row.note = 'The question changed or disappeared while waiting for the AI; not filled.'; continue; }
          target = fresh[0];
          target.id = q.id;
        }
        if (!CONFIG.OVERWRITE_EXISTING_ANSWERS && isAlreadyAnswered(target)) {
          const cur = currentSelection(target);
          if (q.options.length && cur.length === d.targetIds.length && cur.every(id => d.targetIds.includes(id))) { row.status = 'ALREADY SET'; row.note = 'The field already had this answer.'; continue; }
          row.status = 'SKIPPED'; row.note = 'You answered this while the AI was working; left unchanged.'; continue;
        }
        try {
          const r = await fillQuestion(target, d);
          row.status = r.ok ? 'VERIFIED' : 'FAILED';
          if (!r.ok) row.note = r.reason;
        } catch (e) {
          if (e instanceof AbortedError) { row.status = 'SKIPPED'; row.note = 'Aborted.'; continue; }
          row.status = 'FAILED'; row.note = 'Error while filling: ' + scrub(e);
        }
      }
    } finally {
      if (restoreGuard) restoreGuard();
    }

    for (const s of det.skipped) {
      const id = 'skip' + (det.skipped.indexOf(s) + 1);
      rows.set(id, { id, status: 'SKIPPED', question: s.text, options: [], answer: '', confidence: '', note: s.reason });
    }
    const ordered = [...det.questions.map(q => rows.get(q.id)), ...[...rows.values()].filter(r => r.id.startsWith('skip'))].filter(Boolean);
    W.QuizPilot.lastReport = { at: new Date().toISOString(), url: location.href, model: ctx.models[ctx.current], results: ordered.map(r => ({ ...r, options: (r.options || []).map(o => ({ id: o.id, text: o.text })) })) };
    printReport(ordered, 'The form was NOT submitted. Review the answers, then submit yourself if you wish.');
    log('Completed.');
  }

  try {
    await main();
  } catch (e) {
    if (e instanceof AbortedError) warn('Stopped: aborted by user. Fields already verified stay as they are; nothing was submitted.');
    else if (e instanceof StopError) error('Stopped: ' + e.message);
    else error('Unexpected error (stopped safely, nothing submitted): ' + scrub(e) + (e && e.stack && CONFIG.VERBOSE ? '\n' + scrub(e.stack) : ''));
  } finally {
    state.running = false;
    state.controllers.forEach(c => { try { c.abort(); } catch (_) { /* ignore */ } });
    state.controllers.clear();
    SECRET = '';
  }
})();
