/*!
 * QuizPilot 3  v3.1.0  - console / bookmarklet AI assistant for practice quizzes and forms
 * ---------------------------------------------------------------------------
 * Paste your API key(s) below. The provider (NVIDIA, OpenAI, Anthropic, Gemini,
 * Groq, OpenRouter, Mistral, DeepSeek, xAI, Cerebras, Together, Fireworks,
 * Hugging Face, Perplexity) is detected from the key automatically.
 *
 * What it does:
 *   detect questions (ads, search boxes, login/newsletter forms ignored)
 *   -> ask the fastest suitable model (parallel requests, answer cache)
 *   -> validate the JSON -> fill fields -> verify -> report
 *   -> keep WATCHING: questions that appear later (one-by-one quizzes) are
 *      answered as soon as they show up.
 *
 * It never clicks Submit or Next, stops on proctored / locked-down pages, and
 * leaves personal and opinion questions for you.
 *
 * Commands:  qp.stop()  qp.rescan()  qp.lastReport  qp.clearCache()  qp.logs.on/off(...)
 *
 * WARNING: keys in this file are readable by anyone who can open the file,
 * by the page you run it on, and by browser extensions.
 * ---------------------------------------------------------------------------
 */
void (async function QuizPilot3() {
  'use strict';

  /* =========================================================================
   * 1. CONFIGURATION
   * ======================================================================= */
  const CONFIG = {
    // Your NVIDIA key (nvapi-...). Other services' keys also work; extra keys are backups.
    API_KEYS: ['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'],

    // Your Cloudflare relay (use the v3 relay code for zero red errors).
    RELAY_URL: 'https://quizpilot-relay2.github1428.workers.dev',

    MODE: 'accurate',                     // 'fast' or 'accurate' (stronger, adds explanations)
    SOLVE_IMAGES: true,               // questions/options with pictures go to an image-capable AI

    WATCH: true,                      // keep answering questions that appear later
    WATCH_MINUTES: 120,

    AUTO_FILL: true,                  // false = only show suggested answers
    MIN_CONFIDENCE_TO_FILL: 0.7,      // less sure than this = shown, not filled
    OVERWRITE_EXISTING_ANSWERS: false,
    CLEAR_UNSELECTED_CHECKBOXES: true,
    FILL_TEXT_FIELDS: true,
    CACHE_ANSWERS: true,

    QUESTIONS_PER_REQUEST: 4,
    PARALLEL_REQUESTS: 3,             // NVIDIA's free tier is rate-limited: 3 at a time is the sweet spot
    HEDGE_AFTER_MS: 8000,             // if an answer is slow, ask a backup AI in parallel (skipped while the AI is busy)
    MAX_REQUEST_MS: 40000,            // one request may take this long
    BATCH_PATIENCE_MS: 120000,        // keep retrying a group of questions this long before giving up
    SECOND_OPINION: true,             // re-ask uncertain questions with a different AI model
    MAX_TOKENS: 4096,

    DOM_QUIET_MS: 150,
    DOM_STABLE_TIMEOUT_MS: 4000,
    WAIT_FOR_QUESTIONS_MS: 10000,

    VERBOSE: false,                   // true = also turns on the 'debug' and 'ai' logs
  };

  /* =========================================================================
   * LOGGER  (self-contained: copy this whole block into any project)
   * -------------------------------------------------------------------------
   * Every message QuizPilot prints goes through here. Turn each kind on/off:
   *   - edit LOGS below, or
   *   - in the Console:  qp.logs.off('table')   qp.logs.on('ai')
   *                      qp.logs.off('all')     qp.logs.on('all')    qp.logs.show()
   * Console changes are remembered on that website.
   * ======================================================================= */
  const LOGS = {
    progress: true,    // "Detecting questions...", "AI ready", "Done in 3.2s"
    results: true,     // one line per answered question (watch mode) + summary counts
    table: true,       // the tables of questions / results
    details: true,     // the collapsible "Detailed results" group
    warnings: true,    // problems that were handled (key rejected, picture unreadable, ...)
    errors: true,      // why it stopped (keep this on)
    ai: false,         // AI activity: retries, backups, second opinions, timings
    debug: false,      // everything else, for troubleshooting
  };
  const Logger = (() => {
    const TAG = '[QuizPilot]';
    const STYLE = 'color:#76b900;font-weight:bold';
    const STORE = 'quizpilot3:logs';
    try { const saved = JSON.parse(localStorage.getItem(STORE) || 'null'); if (saved && typeof saved === 'object') Object.keys(LOGS).forEach(k => { if (typeof saved[k] === 'boolean') LOGS[k] = saved[k]; }); } catch (_) { /* ignore */ }
    let scrubber = (x) => x;
    const fmt = (a) => a.map(x => (typeof x === 'string' ? scrubber(x) : x));
    const enabled = (kind) => !!LOGS[kind];
    const persist = () => { try { localStorage.setItem(STORE, JSON.stringify(LOGS)); } catch (_) { /* ignore */ } };
    const setAll = (v, kinds) => { (kinds.length && kinds[0] !== 'all' ? kinds : Object.keys(LOGS)).forEach(k => { if (k in LOGS) LOGS[k] = v; }); persist(); };
    return {
      setScrubber(fn) { scrubber = fn; },
      enabled,
      print(kind, ...a) { if (enabled(kind)) console.log('%c' + TAG, STYLE, ...fmt(a)); },
      warn(kind, ...a) { if (enabled(kind)) console.warn(TAG, ...fmt(a)); },
      error(...a) { if (enabled('errors')) console.error(TAG, ...fmt(a)); },
      table(rows) { if (enabled('table')) { try { console.table(rows); } catch (_) { /* ignore */ } } },
      group(title, fn) { if (!enabled('details')) return; console.groupCollapsed(TAG + ' ' + scrubber(title)); try { fn(); } finally { console.groupEnd(); } },
      controls: {
        on(...kinds) { setAll(true, kinds); this.show(); },
        off(...kinds) { setAll(false, kinds); this.show(); },
        show() { console.log(TAG, 'Logs:', Object.keys(LOGS).map(k => `${k}: ${LOGS[k] ? 'on' : 'off'}`).join(' | ')); },
        reset() { try { localStorage.removeItem(STORE); } catch (_) { /* ignore */ } console.log(TAG, 'Log settings reset; reload the script to apply defaults.'); },
      },
    };
  })();
  /* ========================= END OF LOGGER ============================== */

  const FAST = CONFIG.MODE !== 'accurate';
  const EXPLAIN = !FAST;

  /* =========================================================================
   * 2. LOGGING (keys are scrubbed from every message)
   * ======================================================================= */
  const SECRETS = [];
  const KEY_PATTERNS = /(nvapi-|sk-ant-|sk-or-|sk-proj-|sk-|gsk_|xai-|csk-|pplx-|hf_|fw_|tgp_v1_|AIza)[A-Za-z0-9_\-]{8,}/g;
  function safeStringify(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch (_) { return String(v); } }
  const scrub = (v) => {
    let s = typeof v === 'string' ? v : (v instanceof Error ? (v.message || String(v)) : safeStringify(v));
    for (const k of SECRETS) if (k && k.length > 6 && s.includes(k)) s = s.split(k).join('[REDACTED]');
    return s.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]').replace(KEY_PATTERNS, '$1[REDACTED]');
  };
  Logger.setScrubber(scrub);
  if (CONFIG.VERBOSE) { LOGS.debug = true; LOGS.ai = true; }
  const log = (...a) => Logger.print('progress', ...a);
  const warn = (...a) => Logger.warn('warnings', ...a);
  const error = (...a) => Logger.error(...a);
  const debug = (...a) => Logger.print('debug', ...a);
  const aiLog = (...a) => Logger.print('ai', ...a);
  const resultLog = (...a) => Logger.print('results', ...a);

  /* =========================================================================
   * 3. SINGLE INSTANCE + PUBLIC HANDLE
   * ======================================================================= */
  const W = window;
  const prev = W.__QuizPilot3;
  if (prev && prev.running) {
    if (prev.watching && typeof prev.rescan === 'function') { log('Already running and watching - rescanning now. (qp.stop() to stop.)'); prev.rescan(); }
    else warn('Already running in this tab. Wait for it to finish, or run QuizPilot.stop().');
    return;
  }
  const state = {
    running: true, aborted: false, watching: false, controllers: new Set(),
    seen: new WeakMap(),            // first control element -> fingerprint already handled
    counter: 0, rows: [], cleanup: [], rescan: null,
  };
  W.__QuizPilot3 = state;
  const answerCache = (W.__QuizPilot3Cache instanceof Map) ? W.__QuizPilot3Cache : (W.__QuizPilot3Cache = new Map());
  W.QuizPilot = {
    version: '3.1.0',
    lastReport: null,
    stop() {
      if (!state.running) { log('Not running.'); return; }
      state.aborted = true;
      state.controllers.forEach(c => { try { c.abort(); } catch (_) { /* ignore */ } });
      shutdown('Stopped by you.');
    },
    abort() { this.stop(); },
    rescan() { if (state.rescan) state.rescan(); else log('Nothing to rescan.'); },
    clearCache() { answerCache.clear(); try { Object.keys(localStorage).filter(k => k.startsWith('quizpilot3:') && k !== 'quizpilot3:logs').forEach(k => localStorage.removeItem(k)); } catch (_) { /* ignore */ } log('Answer and AI caches cleared.'); },
    logs: Logger.controls,
  };
  W.qp = W.QuizPilot;
  function shutdown(reason) {
    state.cleanup.splice(0).forEach(fn => { try { fn(); } catch (_) { /* ignore */ } });
    if (state.watching) log('Watching stopped. ' + (reason || ''));
    state.watching = false;
    state.running = false;
    state.rescan = null;
  }

  class StopError extends Error { constructor(msg) { super(msg); this.name = 'StopError'; } }
  class AbortedError extends Error { constructor() { super('Stopped by user.'); this.name = 'AbortedError'; } }
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
   * 6. ENVIRONMENT CHECKS + NOISE FILTERS (ads, menus, comments, chat, cart...)
   * ======================================================================= */
  // ---- noise filters: ads, cookie banners, navigation, search, login/newsletter forms ----
  const AD_RE = /(^|[\s_\-])(ads?|adv|advert\w*|sponsor\w*|promo(tion|ted)?s?|banner\w*|adsbygoogle|ad-?slot|ad-?unit|ad-?container|ad-?wrap\w*|dfp|gpt-ad|taboola|outbrain|mgid|revcontent|carbonads?|cookie\w*|consent\w*|gdpr|cmp|newsletter|subscribe\w*|signup|sign-up|popup-?ad|interstitial|comments?|comment-\w+|reply|chat\w*|cart|checkout|coupon|pagination|share\w*|social\w*|sidebar|related|recommend\w*|trending|captcha|recaptcha|lang-?switch\w*|language-?\w*|currency\w*)([\s_\-]|$)/i;
  const AD_HOST_RE = /(doubleclick|googlesyndication|googleadservices|adservice|amazon-adsystem|adnxs|taboola|outbrain|criteo|pubmatic|rubiconproject|openx|mgid|media\.net|adsrvr|moatads|zedo)/i;
  function attrBlob(el) { return ((el.id || '') + ' ' + (el.getAttribute && (el.getAttribute('class') || '')) + ' ' + (el.getAttribute && (el.getAttribute('data-ad') !== null ? 'ad' : ''))).trim(); }
  function isAdFrame(fr) {
    const src = fr.getAttribute('src') || '';
    return AD_HOST_RE.test(src) || AD_RE.test(attrBlob(fr)) || AD_RE.test(fr.getAttribute('name') || '');
  }
  function isNoiseControl(el) {
    for (let n = el, depth = 0; n && depth < 40; n = getParent(n), depth++) {
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BODY' || tag === 'HTML') break;
      if (tag === 'NAV' || tag === 'INS' || tag === 'ASIDE') return true;
      const role = (n.getAttribute('role') || '').toLowerCase();
      if (role === 'navigation' || role === 'search' || role === 'banner' || role === 'contentinfo' || role === 'complementary') return true;
      if ((tag === 'HEADER' || tag === 'FOOTER') && n.parentElement && n.parentElement.tagName === 'BODY') return true;
      if (tag === 'FORM' && (n.querySelector('input[type="password"]') || n.getAttribute('role') === 'search' || /search|login|signin|sign-in|newsletter|subscribe/i.test(attrBlob(n) + ' ' + (n.getAttribute('action') || '')))) return true;
      if (AD_RE.test(attrBlob(n)) || /advert|sponsor/i.test(n.getAttribute('aria-label') || '')) return true;
    }
    return false;
  }

  function optionImage(el, nodes) {
    const pick = (root) => { if (!root || root.nodeType !== 1) return null; const im = root.tagName === 'IMG' ? root : root.querySelector('img'); return im && isRendered(im) ? im : null; };
    for (const n of (nodes || [])) { const im = pick(n); if (im) return im; }
    if (el.labels) for (const l of Array.from(el.labels)) { const im = pick(l); if (im) return im; }
    return el.getAttribute && el.getAttribute('role') ? pick(el) : null;
  }
  const NOISE_FIELD_RE = /(search|coupon|promo|voucher|comment|reply|newsletter|subscribe|captcha|sort|filter|language|\blang\b|currency|country|region|per.?page|items per|results per|theme|font.?size|zoom|quantity|qty)/i;
  function isNoiseField(el, kind) {
    if (kind !== 'select' && kind !== 'text' && kind !== 'textarea') return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'search') return true;
    const labels = el.labels ? Array.from(el.labels).map(l => norm(l.textContent)).filter(t => t.length < 30) : [];
    const blob = [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.title, ...labels].filter(Boolean).join(' ');
    return NOISE_FIELD_RE.test(blob);
  }

  function collectDocuments() {
    const docs = [document];
    const crossOrigin = [];
    const visit = (doc, depth) => {
      if (depth > 3) return;
      deepQueryAll(doc, 'iframe, frame').forEach(fr => {
        if (isAdFrame(fr)) return;
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

  // Exam check: see the EXAM GUARD block near the bottom of this file.

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
  const PERSONAL_QUESTION = /\byour\s+(full\s+|first\s+|last\s+|middle\s+|current\s+|home\s+|permanent\s+)?(name|gender|sex|age|e-?mail|phone|mobile|contact|address|date\s+of\s+birth|dob|birthday|nationality|religion|caste|income|salary|marital\s+status|signature|roll\s*(no|number)|student\s*id|employee\s*id|enrol?ment|registration|department|branch|semester|batch|college|school|university|company|city|country|pin\s*code|zip|aadhaa?r|pan\b|password|otp)\b|^\s*(\d+[.)]\s*)?(gender|sex|age(\s+group)?|date\s+of\s+birth|nationality|religion|caste|marital\s+status)\s*[:?*]?\s*$/i;
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
        if (isNoiseControl(el) || isNoiseField(el, kind)) return;
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
      let qContainer = null;
      if (container && !otherControlsInside(container, own)) {
        for (let p = getParent(container); p && p.nodeType === 1; p = getParent(p)) {
          if (/^(BODY|HTML|FORM|MAIN)$/.test(p.tagName) || otherControlsInside(p, own)) break;
          if (textOf(p, exclude).length > 2500) break;
          container = p;
        }
        containerText = textOf(container, exclude);
        qContainer = container;
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
      if (qText && PERSONAL_QUESTION.test(qText)) {
        skipped.push({ ...base, text: qText, reason: 'Asks for your own details; left for you to fill.' });
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
        options.forEach(o => {
          const im = optionImage(o.el, labelNodes.get(o.el));
          if (im) { o.img = im; if (!o.text) o.text = norm(im.getAttribute('alt') || im.title || '') || ('picture ' + o.id); }
        });
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
      const images = [];
      if (CONFIG.SOLVE_IMAGES) {
        options.forEach(o => { if (o.img) images.push({ el: o.img, opt: o.id }); });
        if (qContainer) {
          const inOption = (im) => options.some(o => o.el && ((o.el.labels && Array.from(o.el.labels).some(l => l.contains(im))) || (o.el.contains && o.el.contains(im))));
          for (const im of Array.from(qContainer.querySelectorAll('img'))) {
            if (images.length >= 4) break;
            if (images.some(x => x.el === im) || inOption(im) || !isRendered(im)) continue;
            const r = im.getBoundingClientRect();
            if (r.width < 40 || r.height < 30) continue;   // icons, bullets
            images.push({ el: im, opt: null });
          }
        }
      }
      const imgSig = images.map(x => (x.el.currentSrc || x.el.src || '').slice(-80)).join('|');
      const cacheKey = lower(qText) + '||' + type + '||' + options.map(o => lower(o.text)).join('|') + (imgSig ? '||' + imgSig : '');
      questions.push({ ...base, type, text: qText, options, fingerprint: fp + (imgSig ? '||' + imgSig : ''), cacheKey, images });
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
   * 9. PROVIDERS (detected from the key)
   * ======================================================================= */
  // kind 'openai' = OpenAI-compatible chat API; 'anthropic' = Anthropic Messages API.
  const PROVIDERS = {
    nvidia:      { name: 'NVIDIA',       base: 'https://integrate.api.nvidia.com/v1', kind: 'openai', json: false, alwaysDiscover: true,
                   fast: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct'],
                   accurate: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', 'qwen/qwen2.5-72b-instruct', 'meta/llama-3.1-405b-instruct'] },
    openai:      { name: 'OpenAI',       base: 'https://api.openai.com/v1', kind: 'openai', json: true,
                   fast: ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4.1-nano'], accurate: ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini'] },
    anthropic:   { name: 'Anthropic',    base: 'https://api.anthropic.com/v1', kind: 'anthropic', json: false,
                   fast: ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-3-5-haiku-latest'], accurate: ['claude-sonnet-5-5', 'claude-sonnet-4-5', 'claude-sonnet-4-0'] },
    gemini:      { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai', json: true, noThink: true,
                   fast: ['gemini-2.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'], accurate: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest'] },
    groq:        { name: 'Groq',         base: 'https://api.groq.com/openai/v1', kind: 'openai', json: true,
                   fast: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], accurate: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct'] },
    cerebras:    { name: 'Cerebras',     base: 'https://api.cerebras.ai/v1', kind: 'openai', json: true,
                   fast: ['llama-3.3-70b', 'gpt-oss-120b', 'llama3.1-8b'], accurate: ['gpt-oss-120b', 'qwen-3-235b-a22b-instruct-2507', 'llama-3.3-70b'] },
    openrouter:  { name: 'OpenRouter',   base: 'https://openrouter.ai/api/v1', kind: 'openai', json: true,
                   fast: ['google/gemini-2.5-flash-lite', 'openai/gpt-4.1-mini', 'meta-llama/llama-3.3-70b-instruct'], accurate: ['openai/gpt-4.1', 'google/gemini-2.5-flash', 'anthropic/claude-sonnet-4.5'] },
    mistral:     { name: 'Mistral',      base: 'https://api.mistral.ai/v1', kind: 'openai', json: true,
                   fast: ['mistral-small-latest'], accurate: ['mistral-large-latest', 'mistral-medium-latest'] },
    deepseek:    { name: 'DeepSeek',     base: 'https://api.deepseek.com/v1', kind: 'openai', json: true,
                   fast: ['deepseek-chat'], accurate: ['deepseek-chat'] },
    xai:         { name: 'xAI',          base: 'https://api.x.ai/v1', kind: 'openai', json: true,
                   fast: ['grok-4-fast-non-reasoning', 'grok-3-mini'], accurate: ['grok-4', 'grok-3'] },
    together:    { name: 'Together',     base: 'https://api.together.xyz/v1', kind: 'openai', json: false,
                   fast: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'], accurate: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'] },
    fireworks:   { name: 'Fireworks',    base: 'https://api.fireworks.ai/inference/v1', kind: 'openai', json: false,
                   fast: ['accounts/fireworks/models/llama-v3p3-70b-instruct'], accurate: ['accounts/fireworks/models/llama-v3p3-70b-instruct'] },
    huggingface: { name: 'Hugging Face', base: 'https://router.huggingface.co/v1', kind: 'openai', json: false,
                   fast: ['meta-llama/Llama-3.3-70B-Instruct'], accurate: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'] },
    perplexity:  { name: 'Perplexity',   base: 'https://api.perplexity.ai', kind: 'openai', json: false, noModels: true,
                   fast: ['sonar'], accurate: ['sonar-pro', 'sonar'] },
  };

  /** Returns candidate provider ids for a key, most likely first. */
  function guessProviders(rawKey) {
    const m = rawKey.match(/^([a-z]+):(.+)$/);
    if (m && PROVIDERS[m[1]]) return { key: m[2], candidates: [m[1]], forced: true };
    const k = rawKey;
    const one = (p) => ({ key: k, candidates: [p], forced: false });
    if (/^nvapi-/.test(k)) return one('nvidia');
    if (/^sk-ant-/.test(k)) return one('anthropic');
    if (/^sk-or-/.test(k)) return one('openrouter');
    if (/^gsk_/.test(k)) return one('groq');
    if (/^AIza/.test(k)) return one('gemini');
    if (/^xai-/.test(k)) return one('xai');
    if (/^csk-/.test(k)) return one('cerebras');
    if (/^pplx-/.test(k)) return one('perplexity');
    if (/^hf_/.test(k)) return one('huggingface');
    if (/^fw_/.test(k)) return one('fireworks');
    if (/^tgp_/.test(k)) return one('together');
    if (/^sk-(proj|svcacct|admin)-/.test(k)) return one('openai');
    if (/^sk-[a-f0-9]{32}$/.test(k)) return { key: k, candidates: ['deepseek', 'openai'], forced: false };
    if (/^sk-/.test(k)) return { key: k, candidates: ['openai', 'deepseek'], forced: false };
    if (/^[a-f0-9]{64}$/i.test(k)) return { key: k, candidates: ['together', 'mistral'], forced: false };
    if (/^[A-Za-z0-9]{32}$/.test(k)) return { key: k, candidates: ['mistral', 'together', 'deepseek'], forced: false };
    return { key: k, candidates: ['openai', 'mistral', 'deepseek', 'together', 'openrouter', 'groq', 'fireworks'], forced: false };
  }


  /* =========================================================================
   * 10. HTTP CLIENT (relay envelope = no red console errors, timeouts, cancel)
   * ======================================================================= */
  class ApiError extends Error {
    constructor(kind, message, status, retryAfterMs) { super(message); this.name = 'ApiError'; this.kind = kind; this.status = status || 0; this.retryAfterMs = retryAfterMs || 0; }
  }
  const relay = () => norm(CONFIG.RELAY_URL).replace(/\/+$/, '');
  const net = { envelope: true, envelopeWorked: false };
  function urlFor(provider, path) { return relay() ? `${relay()}/${provider}${path}` : PROVIDERS[provider].base + path; }
  function headersFor(provider, key, hasBody) {
    const h = { Accept: 'application/json' };
    if (hasBody) h['Content-Type'] = 'application/json';
    if (PROVIDERS[provider].kind === 'anthropic') {
      h['x-api-key'] = key; h['anthropic-version'] = '2023-06-01';
      if (!relay()) h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else h.Authorization = 'Bearer ' + key;
    if (relay() && net.envelope) h['x-qp-envelope'] = '1';
    return h;
  }
  function classify(status, detail, raMs) {
    if (status === 401 || status === 403) return new ApiError('auth', `HTTP ${status}: key rejected (${detail})`, status);
    if (status === 402 || /insufficient|quota|credit|billing|exceeded your current/i.test(detail)) return new ApiError('quota', `HTTP ${status}: out of credits/quota (${detail})`, status);
    if (status === 429) return new ApiError('rate', `HTTP 429: busy (${detail})`, 429, raMs);
    if (status === 404 && /QuizPilot relay: (Not allowed|unknown provider)/i.test(detail)) return new ApiError('relay', 'Your relay is outdated. Paste the latest relay code into Cloudflare and Deploy.', 404);
    if (status === 404 || status === 410) return new ApiError('model', `HTTP ${status}: not available (${detail})`, status);
    if (status === 400 || status === 422) return new ApiError('bad_request', `HTTP ${status}: ${detail}`, status);
    if (status === 504 || status === 408) return new ApiError('timeout', `HTTP ${status}: timed out`, status);
    if (status >= 500) return new ApiError('server', `HTTP ${status}: server error (${detail})`, status, raMs);
    return new ApiError('bad_request', `HTTP ${status}: ${detail}`, status);
  }

  async function httpJson(provider, key, path, method, bodyObj, opts) {
    checkAbort();
    opts = opts || {};
    const url = urlFor(provider, path);
    const ctl = new AbortController();
    state.controllers.add(ctl);
    let timedOut = false, cancelled = false;
    const timeoutMs = opts.timeoutMs || CONFIG.MAX_REQUEST_MS;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const onExtAbort = () => { cancelled = true; ctl.abort(); };
    if (opts.signal) { if (opts.signal.aborted) onExtAbort(); else opts.signal.addEventListener('abort', onExtAbort, { once: true }); }
    let csp = null;
    const host = (() => { try { return new URL(url).host; } catch (_) { return ''; } })();
    const onCsp = (e) => { if (host && String(e.blockedURI || '').includes(host)) csp = e.violatedDirective; };
    document.addEventListener('securitypolicyviolation', onCsp);
    const usedEnvelope = !!(relay() && net.envelope);
    try {
      const res = await fetch(url, {
        method, signal: ctl.signal, credentials: 'omit', mode: 'cors', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: headersFor(provider, key, !!bodyObj), body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      });
      const raw = await res.text();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      let status = res.status;
      let raHeader = res.headers.get('retry-after');
      if (usedEnvelope && body && body.qp && typeof body.qp.status === 'number') {
        net.envelopeWorked = true;
        status = body.qp.status; raHeader = body.qp.retryAfter || raHeader; body = body.data;
      }
      if (status < 200 || status >= 300) {
        const msgObj = body && (body.error || body.detail || body.message || body.title);
        const detail = scrub(truncate(msgObj ? (typeof msgObj === 'string' ? msgObj : (msgObj.message || safeStringify(msgObj))) : (raw || String(status)), 300));
        const raMs = raHeader ? (isNaN(Number(raHeader)) ? Math.max(0, Date.parse(raHeader) - Date.now()) : Number(raHeader) * 1000) : 0;
        throw classify(status, detail, raMs);
      }
      if (body === null) throw new ApiError('server', 'Empty or non-JSON response.', status);
      return body;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (state.aborted) throw new AbortedError();
      if (cancelled) throw new ApiError('cancelled', 'cancelled');
      if (timedOut) throw new ApiError('timeout', `No reply within ${Math.round(timeoutMs / 1000)}s.`);
      if (csp) throw new ApiError('blocked', `This page's security policy blocks ${host}; the AI can't be reached from this page.`);
      // An older relay rejects the envelope header in the CORS preflight: retry once without it.
      if (usedEnvelope && !net.envelopeWorked) { net.envelope = false; debug('Relay has no envelope support; continuing without it.'); return httpJson(provider, key, path, method, bodyObj, opts); }
      throw new ApiError('network', relay()
        ? `Could not reach the relay (${host}). Check RELAY_URL and that the Cloudflare worker is deployed.`
        : 'The request was blocked before a response arrived (CORS). Set RELAY_URL to your Cloudflare relay.');
    } finally {
      clearTimeout(timer);
      state.controllers.delete(ctl);
      if (opts.signal) opts.signal.removeEventListener('abort', onExtAbort);
      document.removeEventListener('securitypolicyviolation', onCsp);
    }
  }

  /* =========================================================================
   * 11. MODEL SCOUT: find the models that actually work fast for this key
   * ======================================================================= */
  const NON_CHAT_RE = /(embed|rerank|retriev|guard|safety|reward|shield|clip\b|parse|ocr|asr|whisper|tts|speech|audio|realtime|transcri|riva|flux|sdxl|stable-diffusion|diffusion|dall-e|imagen|veo|video|cosmos|paligemma|kosmos|deplot|neva|vila\b|fuyu|detector|segment|pii|moderation|bge|e5-|arctic-embed|grounding|coder|codestral|starcoder|codegemma|codellama|code-llama|usdcode|bert|gliner|topic-control|content-safety|translate|search-preview|computer-use|babbage|davinci|aqa|learnlm|genmol|molmim|diffdock|esm|alphafold|openfold|proteinmpnn|rfdiffusion|evo2|maisi|trellis|edify|ising|deep-research|-tts|native-audio|\blive\b|image-gen|nemoretriever|calibrat|streampetr|bevformer|sparsedrive|vista|fourcastnet|corrdiff|-base$|reward)/i;
  const VISION_RE = /(vision|-vl\b|vl-|\bvl\b|multimodal|omni|llama-4|gemma-3|pixtral|phi-4-multimodal|phi-3\.5-vision|nemotron.*vl|qwen.*vl|llava|molmo|gpt-4o|gpt-4\.1|gemini|claude)/i;
  const THINK_RE = /(\br1\b|-r1|reason|think|qwq|\bo1\b|\bo3\b|\bo4\b|^o\d|magistral|deepseek-v3\.1-terminus|kimi-k2-thinking|-thinking|nemotron.*ultra|nemotron.*super)/i;

  function sizeOf(id) { const m = String(id).toLowerCase().match(/(\d+(?:\.\d+)?)b\b/); return m ? parseFloat(m[1]) : 0; }
  function rankModels(provider, ids, vision) {
    const p = PROVIDERS[provider];
    const pref = (FAST ? p.fast : p.accurate).map(x => x.toLowerCase());
    return ids.map(id => String(id).replace(/^models\//, '')).filter((id, i, a) => id && a.indexOf(id) === i && !NON_CHAT_RE.test(id))
      .filter(id => (vision ? VISION_RE.test(id) : true))
      .map(id => {
        const l = id.toLowerCase();
        let s = 0;
        const pi = pref.indexOf(l);
        if (pi >= 0) s += 300 - pi * 10;
        if (/instruct|chat|-it\b|turbo|versatile/.test(l)) s += 40;
        if (THINK_RE.test(l)) s -= 120;
        if (/flash|lite|mini|nano|instant|fast/.test(l) && !/minimax/.test(l)) s += FAST ? 10 : -10;
        const b = sizeOf(l);
        if (b) { s += Math.min(b, 120) / 2; if (b < 7) s -= 40; if (b > 300) s -= 30; }
        if (/llama-3\.3-70b|llama-3\.1-70b|llama-4-maverick|qwen2\.5-72b|qwen3-.*-instruct|mistral-large|mixtral|gemma-3-27b|deepseek-v3|kimi-k2-instruct|gpt-oss-120b/.test(l)) s += 60;
        if (!vision && VISION_RE.test(l) && !/llama-4|gemma-3|gpt|gemini|claude/.test(l)) s -= 40;
        if (/preview|exp\b|experimental|beta/.test(l)) s -= 15;
        return { id, s };
      }).sort((a, b) => b.s - a.s).map(x => x.id);
  }

  async function listModels(provider, key) {
    const body = await httpJson(provider, key, '/models', 'GET', null, { timeoutMs: 15000 });
    const data = Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.models) ? body.models : Array.isArray(body) ? body : [];
    return data.map(m => (m && (m.id || m.name)) || '').filter(Boolean);
  }

  async function resolveKeys(keys) {
    const resolved = [];
    for (let i = 0; i < keys.length; i++) {
      const g = guessProviders(keys[i]);
      SECRETS.push(g.key);
      let provider = null, discovered = null;
      if (g.candidates.length === 1) provider = g.candidates[0];
      else {
        for (const c of g.candidates) {
          try { discovered = await listModels(c, g.key); provider = c; break; }
          catch (e) {
            if (e instanceof AbortedError) throw e;
            if (e.kind === 'network' || e.kind === 'blocked' || e.kind === 'relay') throw new StopError(e.message);
          }
        }
        if (!provider) { warn(`Key ${i + 1} doesn't match any supported AI service. Skipping it.`); continue; }
      }
      resolved.push({ index: i + 1, provider, key: g.key, discovered });
    }
    return resolved;
  }

  // Remember which models worked well on this site for a few hours.
  const SCOUT_CACHE_MS = 6 * 3600 * 1000;
  function cacheKeyFor(entry, vision) { return 'quizpilot3:' + entry.provider + ':' + (vision ? 'v' : 't') + ':' + entry.key.slice(-6); }
  function loadScout(entry, vision) {
    try { const v = JSON.parse(localStorage.getItem(cacheKeyFor(entry, vision)) || 'null'); if (v && Date.now() - v.at < SCOUT_CACHE_MS && Array.isArray(v.models) && v.models.length) return v.models; } catch (_) { /* ignore */ }
    return null;
  }
  function saveScout(entry, vision, models) { try { localStorage.setItem(cacheKeyFor(entry, vision), JSON.stringify({ at: Date.now(), models })); } catch (_) { /* ignore */ } }

  /** Sends a tiny test question to a model. Resolves with latency (ms) or null. */
  async function probe(entry, model) {
    const t0 = performance.now();
    const p = PROVIDERS[entry.provider];
    const prompt = 'Reply with ONLY this JSON, filling in the number: {"ok":true,"sum":<2+3>}';
    try {
      let content = '';
      if (p.kind === 'anthropic') {
        const r = await httpJson(entry.provider, entry.key, '/messages', 'POST', { model, max_tokens: 30, messages: [{ role: 'user', content: prompt }] }, { timeoutMs: 12000 });
        content = Array.isArray(r && r.content) ? r.content.map(c => c.text || '').join('') : '';
      } else {
        const r = await httpJson(entry.provider, entry.key, '/chat/completions', 'POST', { model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 40, stream: false }, { timeoutMs: 12000 });
        const ch = r && r.choices && r.choices[0];
        content = ch && ch.message && typeof ch.message.content === 'string' ? ch.message.content : '';
      }
      const j = extractJson(content);
      if (j && (Number(j.sum) === 5 || j.ok === true)) return performance.now() - t0;
      return null;
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      if (e.kind === 'auth' || e.kind === 'quota' || e.kind === 'network' || e.kind === 'blocked' || e.kind === 'relay') throw e;
      return null;
    }
  }

  /**
   * Returns working models for one key, fastest-and-strongest first.
   * Tests up to 8 candidates in parallel with a tiny question; slow "thinking"
   * models, retired models and models your account can't use drop out here.
   */
  async function scout(entry, vision) {
    const cached = loadScout(entry, vision);
    if (cached) return cached;
    const p = PROVIDERS[entry.provider];
    let ids = entry.discovered;
    if (!ids && (p.alwaysDiscover || !p.noModels)) {
      try { ids = await listModels(entry.provider, entry.key); entry.discovered = ids; }
      catch (e) { if (e instanceof AbortedError) throw e; if (['auth', 'quota', 'network', 'blocked', 'relay'].includes(e.kind)) throw e; ids = null; }
    }
    const ranked = rankModels(entry.provider, (ids && ids.length ? ids : (FAST ? p.fast : p.accurate)).concat(ids ? [] : []), vision);
    const pool = ranked.slice(0, vision ? 4 : 6);
    if (!pool.length) return [];
    // Finish early: once 2 models passed, give the rest only a short grace period.
    const results = await new Promise((resolve, reject) => {
      const out = [];
      let ok = 0, settled = 0, done = false, grace = null;
      const finish = () => { if (!done) { done = true; clearTimeout(grace); resolve(out.slice()); } };
      pool.forEach(m => probe(entry, m).then(ms => {
        out.push({ m, ms }); settled++;
        if (ms !== null && ++ok === 2) grace = setTimeout(finish, 1500);
        if (settled === pool.length) finish();
      }, e => { if (!done) { done = true; clearTimeout(grace); reject(e); } }));
    });
    const working = results.filter(r => r.ms !== null)
      .map(r => ({ m: r.m, score: r.ms - Math.min(sizeOf(r.m) || 30, 120) * (FAST ? 40 : 70) + pool.indexOf(r.m) * 150 }))
      .sort((a, b) => a.score - b.score).map(r => r.m);
    debug(`Scout (${vision ? 'vision' : 'text'}): ${working.length}/${pool.length} usable`);
    if (working.length) saveScout(entry, vision, working);
    return working.length ? working : (vision ? [] : ranked.slice(0, 4)); // if every probe was unlucky, still try the best-ranked
  }

  /* =========================================================================
   * 13. PROMPT + RESPONSE PARSING
   * ======================================================================= */
  const SYSTEM_PROMPT = [
    'You answer questions from a practice quiz or form. Input is JSON with a "questions" array.',
    'Each question has "question_id", "type" (single_choice | multiple_choice | dropdown | multiple_select | short_text | long_text | number), "question", and for choice types "options" [{"id","text"}].',
    'Option ids (A, B, C...) are assigned by the system in display order. Option text may contain the page\'s own numbering like "a)" or "1." - never confuse that with the id.',
    'Rules:',
    '1. Evaluate every option. single_choice/dropdown: exactly one id. multiple_choice/multiple_select: every correct id.',
    '2. "answer" = option ids; "answer_text" = the EXACT option text for each id, same order.',
    '3. Text types: "answer" = [], "answer_text" = [one string] (digits only for number). Keep short_text brief.',
    '4. "confidence" 0..1. If unsure, ambiguous or missing information: "uncertain": true and confidence below 0.6.',
    '5. If a question asks about the respondent themself (their details, opinions, feelings, preferences, experiences, ratings, feedback) it has no correct answer: set "personal": true, "answer": [], "answer_text": [], confidence 0.',
    EXPLAIN ? '6. "explanation": one short sentence.' : '6. Do not include explanations.',
    '7. Include every question_id exactly once.',
    '8. Some questions or options refer to attached images by name (e.g. "img1"). Look at those images carefully; if an image you need is missing or unreadable, set "uncertain": true.',
    'Reply with ONLY a JSON object:',
    EXPLAIN
      ? '{"answers":[{"question_id":"q1","answer":["B"],"answer_text":["exact option text"],"confidence":0.9,"uncertain":false,"personal":false,"explanation":"..."}]}'
      : '{"answers":[{"question_id":"q1","answer":["B"],"answer_text":["exact option text"],"confidence":0.9,"uncertain":false,"personal":false}]}',
  ].join('\n');

  function questionPayload(q) {
    const p = { question_id: q.id, type: q.type, question: q.text };
    if (q.options.length) p.options = q.options.map(o => (o.imageRef ? { id: o.id, text: truncate(o.text, 400), image: o.imageRef } : { id: o.id, text: truncate(o.text, 400) }));
    if (q.imageRefs && q.imageRefs.length) p.images = q.imageRefs.slice();
    if (q.type === 'number') { const el = q.els[0]; if (el.min !== '') p.min = el.min; if (el.max !== '') p.max = el.max; }
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
        personal: raw.personal === true || raw.personal === 'true',
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
   * 14. ASKING THE AI: adaptive requests, backup requests, splitting, recovery
   * ======================================================================= */
  const paramFlags = new Map();   // provider|model -> { noTemp, maxField, noJson, noThink, imgInline }

  function buildUserContent(cand, text, images, f) {
    const p = PROVIDERS[cand.provider];
    if (!images.length) return text;
    if (p.kind === 'anthropic') {
      const parts = [{ type: 'text', text }];
      for (const im of images) {
        const m = im.data.match(/^data:([^;]+);base64,(.*)$/);
        if (!m) continue;
        parts.push({ type: 'text', text: `Image ${im.ref}:` }, { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
      return parts;
    }
    if (f.imgInline) return text + images.map(im => `\nImage ${im.ref}: <img src="${im.data}" />`).join('');
    const parts = [{ type: 'text', text }];
    for (const im of images) parts.push({ type: 'text', text: `Image ${im.ref}:` }, { type: 'image_url', image_url: { url: im.data } });
    return parts;
  }

  async function callModel(cand, batch, note, signal, images) {
    const p = PROVIDERS[cand.provider];
    const fk = cand.provider + '|' + cand.model;
    const f = paramFlags.get(fk) || {};
    paramFlags.set(fk, f);
    const text = (note ? note + '\n' : '') + JSON.stringify({ questions: batch.map(questionPayload) });
    const maxTokens = Math.min(CONFIG.MAX_TOKENS, 400 + batch.length * (EXPLAIN ? 170 : 100));
    const timeoutMs = Math.min(CONFIG.MAX_REQUEST_MS, 15000 + batch.length * 2500 + images.length * 6000);
    for (let fix = 0; fix < 6; fix++) {
      try {
        const content = buildUserContent(cand, text, images, f);
        if (p.kind === 'anthropic') {
          const body = { model: cand.model, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
          if (!f.noTemp) body.temperature = 0;
          const r = await httpJson(cand.provider, cand.key, '/messages', 'POST', body, { signal, timeoutMs });
          const out = Array.isArray(r && r.content) ? r.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('') : '';
          return { content: out, finish: r && r.stop_reason === 'max_tokens' ? 'length' : (r && r.stop_reason) };
        }
        const body = { model: cand.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }], stream: false };
        if (!f.noTemp) body.temperature = 0;
        body[f.maxField || 'max_tokens'] = maxTokens;
        if (p.json && !f.noJson && !images.length) body.response_format = { type: 'json_object' };
        if (p.noThink && FAST && !f.noThink) body.reasoning_effort = 'none';
        const r = await httpJson(cand.provider, cand.key, '/chat/completions', 'POST', body, { signal, timeoutMs });
        const ch = r && Array.isArray(r.choices) ? r.choices[0] : null;
        const msg = ch && ch.message;
        const out = msg ? (typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(x => x.text || '').join('') : '') : '';
        return { content: out || '', finish: ch ? ch.finish_reason : null };
      } catch (e) {
        if (!(e instanceof ApiError) || e.kind !== 'bad_request') throw e;
        const m = e.message;
        let changed = false;
        if (/max_tokens/.test(m) && /max_completion_tokens/.test(m) && f.maxField !== 'max_completion_tokens') { f.maxField = 'max_completion_tokens'; changed = true; }
        else if (/temperature/i.test(m) && !f.noTemp) { f.noTemp = true; changed = true; }
        else if (/response_format|json_object|json mode|json_schema/i.test(m) && !f.noJson && p.json) { f.noJson = true; changed = true; }
        else if (/reasoning/i.test(m) && !f.noThink && p.noThink) { f.noThink = true; changed = true; }
        else if (images.length && !f.imgInline && p.kind !== 'anthropic' && /image|content|array|string|multimodal|type/i.test(m)) { f.imgInline = true; changed = true; }
        if (!changed) throw e;
        debug('Adjusting request format: ' + m);
      }
    }
    throw new ApiError('bad_request', 'Request format not accepted.');
  }

  async function answerWithCandidate(cand, batch, signal, images) {
    let note = '';
    let bad = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      checkAbort();
      const { content, finish } = await callModel(cand, batch, note, signal, images);
      const parsed = extractJson(content);
      if (!parsed) {
        if (finish === 'length') throw new ApiError('truncated', 'Reply was cut off.');
        if (++bad >= 2) throw new ApiError('model', 'Kept replying without valid JSON.');
        note = 'IMPORTANT: your previous reply was not valid JSON. Reply with ONLY the JSON object.';
        continue;
      }
      const v = validateAnswers(parsed, batch);
      if (!v.valid) {
        if (++bad >= 2) throw new ApiError('model', 'Kept replying without an "answers" list.');
        note = 'IMPORTANT: reply with a JSON object {"answers":[...]} only.';
        continue;
      }
      v.problems.forEach(pr => debug(pr));
      return v;
    }
    throw new ApiError('model', 'No usable reply.');
  }

  /** Marks what a failure means for that model/key. Returns 'split' when the batch should be split. */
  function noteFailure(ctx, cand, e, batchLen) {
    if (!(e instanceof ApiError)) throw e;
    if (e.kind === 'cancelled') return null;
    if (['network', 'blocked', 'relay'].includes(e.kind)) throw new StopError(e.message);
    debug(`AI attempt failed (${e.kind}): ${e.message}`);
    if (e.kind === 'auth' || e.kind === 'quota') {
      if (!ctx.deadKeys.has(cand.key)) warn(`Key ${cand.keyIndex} was rejected or is out of credits; using your other key(s) if any.`);
      ctx.deadKeys.add(cand.key);
      return null;
    }
    if (e.kind === 'model' || e.kind === 'bad_request') { cand.dead = true; return null; }
    if (e.kind === 'truncated') { if (batchLen > 1) return 'split'; cand.dead = true; return null; }
    if (e.kind === 'timeout') {
      cand.slow = (cand.slow || 0) + 1;
      if (cand.slow >= 2) cand.dead = true;
      [ctx.cands, ctx.vision].forEach(pool => { const i = pool.indexOf(cand); if (i >= 0) { pool.splice(i, 1); pool.push(cand); } });
      return batchLen > 2 ? 'split' : null;
    }
    if (e.kind === 'rate' || e.kind === 'server') { cand.coolUntil = Date.now() + Math.max(3000, Math.min(e.retryAfterMs || 0, 20000)); return null; }
    return null;
  }

  function promote(pool, cand) {
    const i = pool.indexOf(cand);
    if (i > 0) { pool.splice(i, 1); pool.unshift(cand); }
  }

  function makeSemaphore(n) {
    let active = 0;
    const waiting = [];
    return {
      async acquire() { if (active < n) { active++; return; } await new Promise(r => waiting.push(r)); active++; },
      release() { active--; const next = waiting.shift(); if (next) next(); },
    };
  }
  const aliasOf = (ctx, cand) => { if (!ctx.aliases) ctx.aliases = new Map(); if (!ctx.aliases.has(cand)) ctx.aliases.set(cand, 'AI #' + (ctx.aliases.size + 1)); return ctx.aliases.get(cand); };
  const rangeOf = (b) => (b.length === 1 ? b[0].id : `${b[0].id}-${b[b.length - 1].id}`);

  /**
   * Answers one group of questions. Never gives up quickly: keeps trying working
   * models with pauses for up to BATCH_PATIENCE_MS. If an answer is slow, a backup
   * model is asked in parallel (not while the AI says it is busy).
   */
  async function answerBatch(batch, ctx, kind, opts) {
    opts = opts || {};
    if (!ctx.sem) ctx.sem = makeSemaphore(Math.max(1, CONFIG.PARALLEL_REQUESTS) + 1);
    const started = Date.now();
    const patience = opts.patienceMs || CONFIG.BATCH_PATIENCE_MS;
    const imagesFor = (b) => (kind === 'vision' ? b.flatMap(q => ctx.images.get(q.id) || []) : []);
    let attempt = 0;
    while (Date.now() - started < patience) {
      checkAbort();
      const pool = kind === 'vision' ? ctx.vision : ctx.cands;
      const now = Date.now();
      let usable = pool.filter(c => !c.dead && !ctx.deadKeys.has(c.key) && !(c.coolUntil > now));
      if (opts.avoid) { const alt = usable.filter(c => c !== opts.avoid); if (alt.length) usable = alt; }
      if (!usable.length) {
        const alive = pool.filter(c => !c.dead && !ctx.deadKeys.has(c.key));
        if (alive.length) {
          const wait = clamp(Math.min(...alive.map(c => (c.coolUntil || 0) - now)), 600, 10000);
          aiLog(`${rangeOf(batch)}: AI is busy, waiting ${(wait / 1000).toFixed(1)}s...`);
          await sleep(wait);
          continue;
        }
        if (await ctx.rescout(kind)) continue;
        break;
      }
      attempt++;
      const images = imagesFor(batch);
      const [primary, backupCand] = usable;
      const canHedge = !!backupCand && !(ctx.busyUntil > now);
      const ac1 = new AbortController(), ac2 = new AbortController();
      const run = async (cand, ac) => {
        await ctx.sem.acquire();
        const t0 = performance.now();
        try {
          if (ac.signal.aborted) return { ok: false, e: new ApiError('cancelled', 'cancelled'), cand };
          const v = await answerWithCandidate(cand, batch, ac.signal, images);
          return { ok: true, v, cand, ms: performance.now() - t0 };
        } catch (e) { return { ok: false, e, cand, ms: performance.now() - t0 }; }
        finally { ctx.sem.release(); }
      };
      aiLog(`${rangeOf(batch)}: asking ${aliasOf(ctx, primary)}${attempt > 1 ? ` (try ${attempt})` : ''}`);
      const p1 = run(primary, ac1);
      let hedgeTimer = null;
      const hedge = canHedge ? new Promise(res => { hedgeTimer = setTimeout(() => res('hedge'), CONFIG.HEDGE_AFTER_MS); }) : new Promise(() => {});
      let first = await Promise.race([p1, hedge]);
      clearTimeout(hedgeTimer);
      const failures = [];
      if (first === 'hedge') {
        aiLog(`${rangeOf(batch)}: slow reply, also asking ${aliasOf(ctx, backupCand)}`);
        const p2 = run(backupCand, ac2);
        first = await Promise.race([p1, p2]);
        if (!first.ok) { failures.push(first); first = await (first.cand === primary ? p2 : p1); }
      }
      if (first.ok) {
        ac1.abort(); ac2.abort();
        promote(pool, first.cand);
        if (!ctx.announced) { ctx.announced = true; log('AI connected.'); }
        aiLog(`${rangeOf(batch)}: answered by ${aliasOf(ctx, first.cand)} in ${(first.ms / 1000).toFixed(1)}s`);
        first.v.cand = first.cand;
        return first.v;
      }
      failures.push(first);
      let split = false;
      for (const f of failures) {
        if (f.e && f.e.kind === 'cancelled') continue;
        aiLog(`${rangeOf(batch)}: ${aliasOf(ctx, f.cand)} failed (${f.e && f.e.kind}: ${truncate(String(f.e && f.e.message), 90)})`);
        if (f.e && f.e.kind === 'rate') ctx.busyUntil = Date.now() + Math.max(4000, Math.min(f.e.retryAfterMs || 0, 20000));
        if (noteFailure(ctx, f.cand, f.e, batch.length) === 'split') split = true;
      }
      if (split && batch.length > 1) return splitAndAnswer(batch, ctx, kind, opts);
      await sleep(Math.min(400 * attempt, 3000));
    }
    throw new StopError(kind === 'vision' ? 'No image-capable AI answered in time.' : 'The AI did not answer in time (NVIDIA may be overloaded). Try again in a minute, or add a second key.');
  }

  async function splitAndAnswer(batch, ctx, kind, opts) {
    const mid = Math.ceil(batch.length / 2);
    aiLog(`${rangeOf(batch)}: splitting into smaller groups`);
    const [a, b] = await Promise.all([answerBatch(batch.slice(0, mid), ctx, kind, opts), answerBatch(batch.slice(mid), ctx, kind, opts)]);
    b.result.forEach((val, k) => a.result.set(k, val));
    return { result: a.result, problems: [], missing: [], valid: true };
  }

  /** Sends batches in parallel; onAnswer(q, answer) runs as soon as each answer arrives. */
  async function runBatches(questions, ctx, kind, onAnswer) {
    const size = kind === 'vision' ? 2 : Math.max(1, CONFIG.QUESTIONS_PER_REQUEST);
    const queue = [];
    for (let i = 0; i < questions.length; i += size) queue.push(questions.slice(i, i + size));
    const got = new Map();
    let fatal = null;
    const deliver = async (list, v) => { for (const q of list) if (v.result.has(q.id) && !got.has(q.id)) { got.set(q.id, v.result.get(q.id)); if (v.cand) ctx.answeredBy.set(q.id, v.cand); await onAnswer(q, v.result.get(q.id)); } };
    const worker = async () => {
      while (queue.length && !state.aborted) {
        const batch = queue.shift();
        try { await deliver(batch, await answerBatch(batch, ctx, kind)); }
        catch (e) { if (e instanceof AbortedError) { fatal = e; return; } fatal = e instanceof StopError ? e : new StopError(scrub(e)); if (/relay|reach/i.test(fatal.message)) return; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, CONFIG.PARALLEL_REQUESTS), queue.length) }, worker));
    if (fatal instanceof AbortedError) throw fatal;
    // Second chance for anything still unanswered (one by one, any working model)
    const missing = questions.filter(q => !got.has(q.id));
    for (const q of missing) {
      if (state.aborted) break;
      try { await deliver([q], await answerBatch([q], ctx, kind)); fatal = null; }
      catch (e) { if (e instanceof AbortedError) throw e; fatal = e instanceof StopError ? e : new StopError(scrub(e)); if (/relay|reach/i.test(fatal.message)) break; }
    }
    return { got, fatal };
  }

  /* =========================================================================
   * 14b. IMAGES (for questions with pictures)
   * ======================================================================= */
  async function imageToDataUrl(img) {
    try {
      if (!img.complete) await new Promise(r => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 4000); });
    } catch (_) { /* ignore */ }
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 896 / Math.max(w, h));
    const draw = (src) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(src, 0, 0, c.width, c.height);
      let q = 0.85, d = c.toDataURL('image/jpeg', q);
      while (d.length > 170000 && q > 0.35) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
      return d;
    };
    try { return draw(img); } catch (_) { /* cross-site image: try fetching it */ }
    try {
      const r = await fetch(img.currentSrc || img.src, { mode: 'cors', credentials: 'omit' });
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      return draw(bmp);
    } catch (_) { return null; }
  }

  /** Reads the pictures of the given questions. Returns how many could not be read. */
  async function prepareImages(qs, ctx) {
    let unreadable = 0;
    let n = ctx.imgCounter || 0;
    await Promise.all(qs.map(async (q) => {
      const list = [];
      q.imageRefs = [];
      for (const im of q.images) {
        const data = await imageToDataUrl(im.el);
        if (!data) { unreadable++; continue; }
        const ref = 'img' + (++n);
        list.push({ ref, data });
        if (im.opt) { const o = q.options.find(x => x.id === im.opt); if (o) o.imageRef = ref; }
        else q.imageRefs.push(ref);
      }
      ctx.images.set(q.id, list);
      q.imagesOk = list.length === q.images.length;
    }));
    ctx.imgCounter = n;
    return unreadable;
  }

  /* =========================================================================
   * 14. CONSERVATIVE ANSWER -> FIELD MAPPING
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
    if (a.personal) return { action: 'hold', status: 'YOURS', reason: 'Asks about you (details/opinion), so there is no correct answer to fill; left for you.' };
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
   * 15. FILLING + VERIFICATION
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
   * 16. REPORTING
   * ======================================================================= */
  function describeAnswer(q, a) {
    if (!a) return '';
    if (q.options.length) return a.answer.map(normId).map(id => { const o = q.options.find(x => x.id === id); return o ? `${id}) ${truncate(o.text, 50)}` : id; }).join(' + ');
    return truncate(a.answer_text[0] || '', 80);
  }
  const ICON = { VERIFIED: '\u2714', UNCERTAIN: '?', FAILED: '\u2716', YOURS: '\u263A', SKIPPED: '-', 'ANSWERED BY YOU': '\u2713', 'ALREADY SET': '\u2713', SUGGESTED: '\u2192' };

  function printFullReport(rows, extra) {
    const count = (s) => rows.filter(r => r.status === s).length;
    Logger.group(`Detailed results (${rows.length})`, () => {
      for (const r of rows) {
        console.groupCollapsed(`${r.id} [${r.status}] ${truncate(r.question, 90)}`);
        if (r.options && r.options.length) console.log('Options:', r.options.map(o => `${o.id}) ${o.text}`).join('  |  '));
        if (r.answer) console.log('Answer:', r.answer);
        if (r.confidence !== '') console.log('Confidence:', r.confidence);
        if (r.explanation) console.log('Explanation:', r.explanation);
        if (r.note) console.log('Note:', r.note);
        console.groupEnd();
      }
    });
    Logger.table(rows.map(r => ({ id: r.id, status: r.status, answer: truncate(r.answer || '', 60), confidence: r.confidence, question: truncate(r.question, 70), note: truncate(r.note || '', 70) })));
    resultLog('Verified: ' + count('VERIFIED') + (count('ALREADY SET') ? ` (+${count('ALREADY SET')} already correct)` : ''));
    if (count('SUGGESTED')) resultLog('Suggested (auto-fill off): ' + count('SUGGESTED'));
    resultLog('Uncertain: ' + count('UNCERTAIN'));
    resultLog('Failed: ' + count('FAILED'));
    const yours = count('YOURS') + count('ANSWERED BY YOU') + count('SKIPPED');
    if (yours) resultLog('Left for you / skipped: ' + yours);
    if (extra) log(extra);
  }
  function printLine(r) {
    const line = `${ICON[r.status] || ''} ${r.id} ${r.status}${r.answer ? '  ' + r.answer : ''}${r.confidence !== '' ? '  (' + r.confidence + ')' : ''}  \u00B7 ${truncate(r.question, 70)}${r.note && r.status !== 'VERIFIED' ? '  \u2014 ' + truncate(r.note, 90) : ''}`;
    if (r.status === 'FAILED') Logger.warn('results', line); else resultLog(line);
  }
  function publishReport() {
    W.QuizPilot.lastReport = { at: new Date().toISOString(), url: location.href, results: state.rows.map(r => ({ ...r, options: (r.options || []).map(o => ({ id: o.id, text: o.text })) })) };
  }

  /* =========================================================================
   * 17. ONE DETECTION PASS: cache -> AI (parallel) -> fill as answers arrive
   * ======================================================================= */
  async function fillOne(q, a, row, det) {
    const d = decide(q, a);
    if (d.action !== 'fill') { row.status = d.status; row.note = d.reason; return; }
    if (!CONFIG.AUTO_FILL) { row.status = 'SUGGESTED'; row.note = 'AUTO_FILL is off.'; return; }
    if (state.aborted) { row.status = 'SKIPPED'; row.note = 'Stopped before filling.'; return; }
    let target = q;
    if (!stillMatches(q)) {
      const fresh = detectQuestions().questions.filter(x => x.fingerprint === q.fingerprint);
      if (fresh.length !== 1) { row.status = 'FAILED'; row.note = 'The question changed or disappeared before it could be filled.'; return; }
      target = fresh[0];
      target.id = q.id;
      state.seen.set(target.els[0], target.fingerprint);
    }
    if (!CONFIG.OVERWRITE_EXISTING_ANSWERS && isAlreadyAnswered(target)) {
      const cur = currentSelection(target);
      if (q.options.length && cur.length === d.targetIds.length && cur.every(id => d.targetIds.includes(id))) { row.status = 'ALREADY SET'; row.note = 'Already had this answer.'; return; }
      row.status = 'SKIPPED'; row.note = 'You answered this while the AI was working; left unchanged.'; return;
    }
    try {
      const r = await fillQuestion(target, d);
      row.status = r.ok ? 'VERIFIED' : 'FAILED';
      if (!r.ok) row.note = r.reason;
    } catch (e) {
      if (e instanceof AbortedError) { row.status = 'SKIPPED'; row.note = 'Stopped.'; return; }
      row.status = 'FAILED'; row.note = 'Error while filling: ' + scrub(e);
    }
  }

  async function runPass(det, ctx, first) {
    const t0 = performance.now();
    const fresh = [];
    for (const q of det.questions) {
      const el0 = q.els[0];
      if (state.seen.get(el0) === q.fingerprint) continue;
      state.seen.set(el0, q.fingerprint);
      fresh.push(q);
    }
    const freshSkipped = det.skipped.filter(s => { const k = 'skip:' + s.text; if (state.seen.get(s.els[0]) === k) return false; state.seen.set(s.els[0], k); return true; });
    if (!fresh.length) {
      if (first && freshSkipped.length) freshSkipped.forEach(s => debug('Skipped: ' + truncate(s.text, 60) + ' - ' + s.reason));
      return 0;
    }
    fresh.forEach(q => { q.id = 'q' + (++state.counter); });
    if (first) {
      log(`Found ${fresh.length} question${fresh.length === 1 ? '' : 's'}.` + (freshSkipped.length ? ` (${freshSkipped.length} personal/unsupported field(s) left for you)` : ''));
      Logger.table(fresh.map(q => ({ id: q.id, type: q.type, options: q.options.length || '', question: truncate(q.text, 90) })));
    } else log(`New question${fresh.length === 1 ? '' : 's'} detected: ${fresh.map(q => q.id).join(', ')}`);

    const rows = new Map();
    const mkRow = (q, a) => ({ id: q.id, question: q.text, options: q.options, answer: describeAnswer(q, a), confidence: a ? a.confidence.toFixed(2) : '', explanation: a ? a.explanation : '', status: '', note: '' });
    const done = (row) => { if (!first) printLine(row); };
    const toAsk = [];
    const restoreGuard = installSubmitGuard(det.docs);
    try {
      const cachedFills = [];
      for (const q of fresh) {
        if ((q.type === 'short_text' || q.type === 'long_text' || q.type === 'number') && !CONFIG.FILL_TEXT_FIELDS) {
          const row = { ...mkRow(q), status: 'SKIPPED', note: 'Text fields disabled in CONFIG.' }; rows.set(q.id, row); done(row); continue;
        }
        if (!CONFIG.OVERWRITE_EXISTING_ANSWERS && isAlreadyAnswered(q)) {
          const row = { ...mkRow(q), status: 'ANSWERED BY YOU', note: 'Already answered; left unchanged.' }; rows.set(q.id, row); done(row); continue;
        }
        if (CONFIG.CACHE_ANSWERS && answerCache.has(q.cacheKey)) {
          const a = { ...answerCache.get(q.cacheKey), question_id: q.id };
          const row = mkRow(q, a); rows.set(q.id, row);
          cachedFills.push(fillOne(q, a, row, det).then(() => { row.note = (row.note ? row.note + ' ' : '') + '(cached)'; done(row); }));
          continue;
        }
        toAsk.push(q);
      }
      await Promise.all(cachedFills);

      if (toAsk.length) {
        if (first) log(`Analyzing ${toAsk.length} question${toAsk.length === 1 ? '' : 's'}...`);
        const picMissing = (q) => q.images && q.images.length && !q.imagesOk;
        const onAnswer = async (q, a) => {
          if (picMissing(q) && !a.personal) { a.uncertain = true; a.confidence = Math.min(a.confidence, 0.5); }
          if (CONFIG.CACHE_ANSWERS && !a.conflict && !picMissing(q)) answerCache.set(q.cacheKey, a);
          const row = mkRow(q, a); rows.set(q.id, row);
          await fillOne(q, a, row, det);
          if (picMissing(q) && row.status === 'UNCERTAIN') row.note = 'The picture could not be read, so this was not filled. ' + row.note;
          done(row);
        };
        const imgQs = CONFIG.SOLVE_IMAGES ? toAsk.filter(q => q.images && q.images.length) : [];
        const textQs = toAsk.filter(q => !imgQs.includes(q));
        const got = new Map();
        let fatal = null;
        const jobs = [];
        if (textQs.length) jobs.push(runBatches(textQs, ctx, 'text', onAnswer).then(r => { r.got.forEach((v, k) => got.set(k, v)); fatal = fatal || r.fatal; }));
        if (imgQs.length) jobs.push((async () => {
          const unreadable = await prepareImages(imgQs, ctx);
          if (unreadable) warn(`${unreadable} picture(s) could not be read (the site blocks it); those questions will be shown, not filled.`);
          const vision = await ctx.ensureVision();
          const r = await runBatches(imgQs, ctx, vision ? 'vision' : 'text', async (q, a) => {
            if (!vision && !a.personal) { q.imagesOk = false; }
            await onAnswer(q, a);
          });
          r.got.forEach((v, k) => got.set(k, v)); fatal = fatal || r.fatal;
        })());
        await Promise.all(jobs);

        // Second opinion: re-ask uncertain questions with a DIFFERENT model; fill if it is confident.
        if (CONFIG.SECOND_OPINION && !state.aborted) {
          const unsure = textQs.filter(q => { const r = rows.get(q.id); const a = got.get(q.id); return r && a && r.status === 'UNCERTAIN' && !a.personal; });
          if (unsure.length && ctx.cands.filter(c => !c.dead && !ctx.deadKeys.has(c.key)).length > 1) {
            aiLog(`Second opinion for ${unsure.length} uncertain question(s)...`);
            const size = Math.max(1, CONFIG.QUESTIONS_PER_REQUEST);
            const groups = [];
            for (let i = 0; i < unsure.length; i += size) groups.push(unsure.slice(i, i + size));
            await Promise.all(groups.map(async (grp) => {
              try {
                const v = await answerBatch(grp, ctx, 'text', { avoid: ctx.answeredBy.get(grp[0].id), patienceMs: 60000 });
                for (const q of grp) {
                  const a2 = v.result.get(q.id);
                  if (!a2 || a2.personal || decide(q, a2).action !== 'fill') continue;
                  const row = rows.get(q.id);
                  Object.assign(row, mkRow(q, a2), { status: '', note: '' });
                  await fillOne(q, a2, row, det);
                  if (row.status === 'VERIFIED') { row.note = 'Second opinion.'; if (CONFIG.CACHE_ANSWERS) answerCache.set(q.cacheKey, a2); }
                  done(row);
                }
              } catch (e) {
                if (e instanceof AbortedError) throw e;
                aiLog('Second opinion skipped: ' + e.message);
              }
            }));
          }
        }
        for (const q of toAsk) {
          if (got.has(q.id)) continue;
          const row = { ...mkRow(q), status: 'FAILED', note: fatal ? fatal.message : 'The AI returned no answer.' };
          rows.set(q.id, row); done(row);
        }
        if (fatal && !got.size) {
          if (first) throw fatal;
          warn(fatal.message);
        } else if (fatal) warn('Some questions were not answered: ' + fatal.message);
      }
    } finally {
      restoreGuard();
    }

    const ordered = fresh.map(q => rows.get(q.id)).filter(Boolean);
    for (const s of freshSkipped) ordered.push({ id: 'skip', status: 'YOURS', question: s.text, options: [], answer: '', confidence: '', note: s.reason });
    state.rows.push(...ordered);
    publishReport();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (first) printFullReport(ordered, `Done in ${secs}s. Nothing was submitted - check the answers, then submit yourself.`);
    else log(`Answered in ${secs}s.`);
    return fresh.length;
  }

  /* =========================================================================
   * 18. WATCH MODE (questions that appear later / one at a time)
   * ======================================================================= */
  const CTRL_SEL = 'input, select, textarea, [role="radio"], [role="checkbox"]';
  function nearControls(node) {
    for (let n = node && node.nodeType === 1 ? node : node && node.parentElement, d = 0; n && d < 6; n = n.parentElement, d++) {
      if (n.matches && n.matches(CTRL_SEL)) return true;
      if (n.querySelector && n.querySelector(CTRL_SEL)) return true;
    }
    return false;
  }
  function relevant(records) {
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) if (n.nodeType === 1 ? (n.matches(CTRL_SEL) || n.querySelector(CTRL_SEL)) : nearControls(r.target)) return true;
        for (const n of r.removedNodes) if (n.nodeType === 1 && (n.matches(CTRL_SEL) || n.querySelector(CTRL_SEL))) return true;
      } else if (r.type === 'characterData') { if (nearControls(r.target)) return true; }
      else if (r.type === 'attributes') {
        const t = r.target;
        if (t.nodeType === 1 && (r.attributeName === 'aria-checked' || r.attributeName === 'checked')) continue;
        if (t.nodeType === 1 && (t.matches(CTRL_SEL) || t.querySelector(CTRL_SEL))) return true;
      }
    }
    return false;
  }

  function startWatching(ctx) {
    state.watching = true;
    let timer = null, maxTimer = null, busy = false, pending = false;
    const observers = new Map();
    const fire = async () => {
      clearTimeout(timer); clearTimeout(maxTimer); timer = maxTimer = null;
      if (!state.watching || state.aborted) return;
      if (busy) { pending = true; return; }
      busy = true;
      try {
        const det = detectQuestions();
        observeDocs(det.docs);
        if (proctoringSignals(det.docs).length) { warn('Proctoring/lockdown signals appeared on this page. Stopping.'); shutdown(); return; }
        await runPass(det, ctx, false);
      } catch (e) {
        if (!(e instanceof AbortedError)) warn('Watch error (still watching): ' + scrub(e));
      } finally {
        busy = false;
        if (pending && state.watching) { pending = false; schedule(); }
      }
    };
    const schedule = (now) => {
      clearTimeout(timer);
      timer = setTimeout(fire, now ? 0 : CONFIG.DOM_QUIET_MS);
      if (!maxTimer) maxTimer = setTimeout(fire, Math.max(600, CONFIG.DOM_QUIET_MS * 4));
    };
    function observeDocs(docs) {
      for (const d of docs) {
        if (observers.has(d) || !d.documentElement) continue;
        const mo = new MutationObserver((recs) => { if (relevant(recs)) schedule(); });
        mo.observe(d.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'] });
        observers.set(d, mo);
      }
    }
    observeDocs(collectDocuments().docs);
    const poll = setInterval(() => { if (document.visibilityState === 'visible') schedule(); }, 1500);
    const limit = setTimeout(() => shutdown(`Reached WATCH_MINUTES (${CONFIG.WATCH_MINUTES}).`), CONFIG.WATCH_MINUTES * 60000);
    const onHide = () => shutdown('Page closed.');
    W.addEventListener('pagehide', onHide);
    state.rescan = () => schedule(true);
    state.cleanup.push(() => {
      observers.forEach(mo => mo.disconnect()); observers.clear();
      clearInterval(poll); clearTimeout(limit); clearTimeout(timer); clearTimeout(maxTimer);
      W.removeEventListener('pagehide', onHide);
    });
    log('Watching for new questions. Click Next yourself - new questions are answered as they appear. qp.stop() to stop.');
    schedule(true);   // catch anything that appeared while the first pass was running
  }

  /* =========================================================================
   * 19. MAIN
   * ======================================================================= */
  async function main() {
    CONFIG.DOM_QUIET_PERIOD_MS = CONFIG.DOM_QUIET_MS;
    log('Initializing...');
    let keys = (Array.isArray(CONFIG.API_KEYS) ? CONFIG.API_KEYS : [CONFIG.API_KEYS]).map(k => norm(k)).filter(k => k && !/PASTE_YOUR/i.test(k));
    for (const extra of [W.QUIZPILOT_KEYS, W.QUIZPILOT_KEY, W.QUIZPILOT_NVIDIA_KEY]) {
      if (Array.isArray(extra)) keys.push(...extra.map(norm).filter(Boolean));
      else if (typeof extra === 'string' && norm(extra)) keys.push(norm(extra));
    }
    if (!keys.length) {
      try { const k = norm(W.prompt('QuizPilot: paste your AI API key (NVIDIA, OpenAI, Claude, Gemini, Groq, OpenRouter, ...)') || ''); if (k) keys.push(k); } catch (_) { /* ignore */ }
    }
    keys = keys.filter((k, i) => keys.indexOf(k) === i);
    if (!keys.length) throw new StopError('No API key. Put one in CONFIG.API_KEYS.');
    keys.forEach(k => SECRETS.push(k.replace(/^[a-z]+:/, '')));

    // Prepare the AI (find which models work fast for this key) WHILE the page is scanned.
    const ctx = { entries: [], cands: [], vision: [], deadKeys: new Set(), images: new Map(), answeredBy: new Map(), announced: false, rescouted: {}, visionChecked: false };
    async function buildPool(vision, force) {
      const pool = [];
      for (const entry of ctx.entries) {
        if (ctx.deadKeys.has(entry.key)) continue;
        if (force) { try { localStorage.removeItem(cacheKeyFor(entry, vision)); } catch (_) { /* ignore */ } }
        let models = [];
        try { models = await scout(entry, vision); }
        catch (e) {
          if (e instanceof AbortedError) throw e;
          if (e.kind === 'auth' || e.kind === 'quota') { warn(`Key ${entry.index} was rejected or is out of credits.`); ctx.deadKeys.add(entry.key); continue; }
          if (['network', 'blocked', 'relay'].includes(e.kind)) throw new StopError(e.message);
          continue;
        }
        models.forEach(m => pool.push({ provider: entry.provider, key: entry.key, keyIndex: entry.index, model: m }));
      }
      if (vision) ctx.vision = pool; else ctx.cands = pool;
      return pool.length;
    }
    ctx.rescout = async (kind) => {
      if (ctx.rescouted[kind]) return false;
      ctx.rescouted[kind] = true;
      debug('Re-checking which AI models are available...');
      return (await buildPool(kind === 'vision', true)) > 0;
    };
    ctx.ensureVision = async () => {
      if (!ctx.visionChecked) {
        ctx.visionChecked = true;
        await buildPool(true, false);
        if (!ctx.vision.length) warn('No image-capable AI is available on your key right now; picture questions will be shown, not filled.');
      }
      return ctx.vision.some(c => !c.dead);
    };
    log('Connecting to AI...');
    const aiReady = resolveKeys(keys).then(async (r) => {
      ctx.entries = r;
      if (!r.length) throw new StopError('None of the API keys could be used.');
      await buildPool(false, false);
      if (!ctx.cands.length) throw new StopError('No working AI model was found for your key right now. Check the key on build.nvidia.com, then try again.');
    }).then(() => ({}), e => ({ e }));

    await waitForReady(document, CONFIG.DOM_STABLE_TIMEOUT_MS);
    await waitForDomStable(document, CONFIG.DOM_QUIET_MS, CONFIG.DOM_STABLE_TIMEOUT_MS);
    checkAbort();
    log('Detecting questions...');
    const det = CONFIG.WATCH ? detectQuestions() : await detectWithWaiting();
    const signals = proctoringSignals(det.docs);
    if (signals.length) throw new StopError('This page shows signs of a proctored or locked-down assessment (' + signals.join('; ') + '). QuizPilot only runs on practice quizzes and forms, so it will not continue here.');
    environmentReport(det.docs, det.crossOrigin).forEach(n => warn('Compatibility: ' + n));

    const ai = await aiReady;
    if (ai.e) throw ai.e;
    log(`AI ready (${ctx.entries.map(e => PROVIDERS[e.provider].name).filter((v, i, a) => a.indexOf(v) === i).join(', ')}, ${FAST ? 'fast' : 'accurate'} mode).`);

    if (det.questions.length || det.skipped.length) {
      await runPass(det, ctx, true);
    } else if (!CONFIG.WATCH) {
      throw new StopError('No answerable questions detected. Nothing was changed.');
    } else log('No questions on the page yet.');

    if (CONFIG.WATCH && !state.aborted) startWatching(ctx);
    else { log('Completed.'); shutdown(); }
  }

  /* =========================================================================
   * EXAM GUARD  (self-contained: copy this whole block into any project)
   * -------------------------------------------------------------------------
   * Decides whether a page looks like a real, monitored or graded exam.
   * Each clue adds points; at EXAM_THRESHOLD or more the page counts as an exam.
   *
   *   ExamGuard.check(doc)      -> { blocked, score, reasons }   for one document
   *   proctoringSignals(docs)   -> [] when fine, or a list of reasons to stop
   *
   * To make it stricter: add rules to RULES / hosts to HOSTS, or lower THRESHOLD.
   * Rule format: { re: /words/i, pts: number, why: 'label' }  (negative pts = practice clue)
   * ======================================================================= */
  const ExamGuard = (() => {
    const THRESHOLD = 6;

    // Proctoring / lockdown services: loading any of these is enough on its own.
    const HOSTS = /(proctorio|honorlock|respondus|examity|proctoru|examsoft|examplify|talview|mettl|proview|safeexambrowser|safe-exam-browser|inspera|wiseflow|autoproctor|proctortrack|verificient|meazure|proctor360|proctoredu|examus|smowl|constructor\.?proctor|testreach|eklavvya|mercer)/i;

    const RULES = [
      // strong: the page says it is proctored / locked down / monitored
      { re: /\b(proctor(ed|ing)?|invigilat(ed|ion|or)|lockdown browser|safe exam browser|respondus|honorlock|examity|proctorio|being (monitored|recorded|proctored)|remote(ly)? proctor|ai proctor|webcam (is )?(on|recording|monitor))/i, pts: -6, why: 'proctoring / monitoring words' },
      // the page talks about cheating rules or integrity declarations
      { re: /\b(academic (integrity|honesty) (pledge|declaration|statement)|honou?r code|i (will|shall) not (use|consult|receive)|malpractice|unfair means|cheating (is|will be) (detected|reported)|disqualif(y|ied|ication))\b/i, pts: -3, why: 'integrity / anti-cheating notice' },
      // monitoring of the browser itself
      { re: /\b(enter full ?screen|full ?screen (mode )?(is )?(required|mandatory)|exit(ing)? full ?screen|allow (camera|webcam|microphone)|share your (entire )?screen|tab[- ]switch(ing|es)?|switching tabs|leave (this|the) (page|tab|window)|copy[- ]paste (is )?(disabled|not allowed)|right[- ]click (is )?disabled)\b/i, pts: -3, why: 'fullscreen / camera / tab monitoring' },
      // graded, one-shot exam wording
      { re: /\b(final exam|mid-?term|end[- ]?sem(ester)?|semester exam|board exam|entrance exam|graded (exam|test|quiz|assessment)|summative|one attempt only|attempts? allowed:? ?1\b|no (ai|external|outside) (help|tools|resources)|closed[- ]book)\b/i, pts: -2, why: 'graded-exam wording' },
      // exam session details
      { re: /\b(hall ticket|admit card|candidate (id|number)|exam (code|session|id)|roll number)\b/i, pts: -2, why: 'exam session details' },
      // a running countdown
      { re: /\b(time (left|remaining)|remaining time|time limit)\s*:?\s*\d{1,2}:\d{2}/i, pts: -2, why: 'countdown timer' },
      // practice clues lower the score
      { re: /\b(practice (quiz|test|set|questions|paper)|sample (quiz|questions|paper)|mock (test|quiz|exam)|ungraded|self[- ](check|assessment)|for practice only|not graded)\b/i, pts: -3, why: 'practice wording' },
    ];


    // Exam-style addresses (Moodle, Canvas, Blackboard, common LMS patterns)
    const URLS = /\/(mod\/quiz\/attempt|quiz\/attempt|courses\/\d+\/quizzes\/\d+\/take|assessment\/take|exam\/(start|attempt|take)|test\/(start|attempt|take)|webapps\/assessment\/take)/i;

    function check(doc) {
      let score = 0;
      const reasons = [];
      const add = (pts, why) => { score += pts; reasons.push(`${pts > 0 ? '+' : ''}${pts} ${why}`); };
      try {
        // 1) scripts, frames (also other-site frames we cannot read), links, meta
        const srcs = Array.from(doc.querySelectorAll('script[src], iframe[src], frame[src], link[href], object[data], embed[src]'))
          .map(e => e.src || e.href || e.data || '').join(' ');
        const host = srcs.match(HOSTS);
        if (host) add(10, `proctoring service loaded (${host[0]})`);
        // 2) title + visible text
        const text = ((doc.title || '') + ' ' + (doc.body ? (doc.body.innerText || '') : '')).slice(0, 60000);
        for (const r of RULES) if (r.re.test(text)) add(r.pts, r.why);
        // 3) exam-style address
        if (doc.location && URLS.test(doc.location.pathname || '')) add(2, 'exam-style URL');
        // 4) lockdown environment hints
        if (/SEB\/|SafeExamBrowser|Respondus|LockDown/i.test(navigator.userAgent)) add(10, 'lockdown browser detected');
      } catch (_) { /* unreadable document: no points */ }
      return { blocked: score >= THRESHOLD, score, reasons };
    }

    /** Checks every document; returns [] when fine, or the reasons to stop. */
    function signals(docs) {
      let total = 0;
      const all = [];
      for (const d of docs) {
        const r = check(d);
        total = Math.max(total, r.score);
        r.reasons.forEach(x => { if (!all.includes(x)) all.push(x); });
        if (r.blocked) return r.reasons.concat(`score ${r.score} >= ${THRESHOLD}`);
      }
      if (all.length) console.debug('[ExamGuard] score ' + total + ': ' + all.join(', '));
      return [];
    }

    return { check, signals, THRESHOLD };
  })();
  function proctoringSignals(docs) { return ExamGuard.signals(docs); }
  /* ======================= END OF EXAM GUARD ============================ */

  try {
    await main();
  } catch (e) {
    if (e instanceof AbortedError) warn('Stopped. Fields already filled stay as they are; nothing was submitted.');
    else if (e instanceof StopError) error('Stopped: ' + e.message);
    else error('Unexpected error (stopped safely, nothing submitted): ' + scrub(e) + (e && e.stack && CONFIG.VERBOSE ? '\n' + scrub(e.stack) : ''));
    shutdown();
  }
})();
