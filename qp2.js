/*!
 * QuizPilot 2  v2.0.0  - console / bookmarklet AI assistant for practice quizzes and forms
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
 * Commands:  qp.stop()   qp.scan()   qp.report()   qp.clear()
 *
 * WARNING: keys in this file are readable by anyone who can open the file,
 * by the page you run it on, and by browser extensions.
 * ---------------------------------------------------------------------------
 */
void (async function QuizPilot2() {
  'use strict';

  /* =========================================================================
   * 1. CONFIGURATION
   * ======================================================================= */
  const CONFIG = {
    // One or more keys from ANY supported provider. Extra keys are backups.
    // You can force a provider with a prefix, e.g. 'groq:gsk_...' or 'mistral:abc...'.
      API_KEYS: ['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'],

    // Your Cloudflare relay (handles CORS for every provider). '' = call providers directly.
    RELAY_URL: 'https://quizpilot-relay2.github1428.workers.dev',

    MODE: 'fast',                     // 'fast' = quickest models, no explanations; 'accurate' = stronger models
    MODEL: '',                        // optional exact model id for the FIRST key, e.g. 'llama-3.3-70b-versatile'

    WATCH: true,                      // keep answering questions that appear later (one-by-one quizzes)
    WATCH_MINUTES: 120,               // stop watching after this long

    AUTO_FILL: true,                  // false = only print suggested answers
    MIN_CONFIDENCE_TO_FILL: 0.7,      // answers below this are shown, not filled
    OVERWRITE_EXISTING_ANSWERS: false,// never change answers you already gave
    CLEAR_UNSELECTED_CHECKBOXES: true,
    FILL_TEXT_FIELDS: true,
    CACHE_ANSWERS: true,              // repeated / re-rendered questions are answered instantly

    QUESTIONS_PER_REQUEST: 8,         // small batches...
    PARALLEL_REQUESTS: 4,             // ...sent at the same time = faster
    REQUEST_TIMEOUT_MS: 60000,
    MAX_RETRIES: 2,
    MAX_MODELS_PER_KEY: 3,
    MAX_TOKENS: 4096,

    DOM_QUIET_MS: 150,                // "page settled" = no changes for this long
    DOM_STABLE_TIMEOUT_MS: 4000,
    WAIT_FOR_QUESTIONS_MS: 10000,

    VERBOSE: false,
  };
  const FAST = CONFIG.MODE !== 'accurate';
  const EXPLAIN = !FAST;

  /* =========================================================================
   * 2. LOGGING (keys are scrubbed from every message)
   * ======================================================================= */
  const TAG = '[QuizPilot]';
  const STYLE = 'color:#76b900;font-weight:bold';
  const SECRETS = [];
  const KEY_PATTERNS = /(nvapi-|sk-ant-|sk-or-|sk-proj-|sk-|gsk_|xai-|csk-|pplx-|hf_|fw_|tgp_v1_|AIza)[A-Za-z0-9_\-]{8,}/g;
  function safeStringify(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch (_) { return String(v); } }
  const scrub = (v) => {
    let s = typeof v === 'string' ? v : (v instanceof Error ? (v.message || String(v)) : safeStringify(v));
    for (const k of SECRETS) if (k && k.length > 6 && s.includes(k)) s = s.split(k).join('[REDACTED]');
    return s.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]').replace(KEY_PATTERNS, '$1[REDACTED]');
  };
  const fmt = (a) => a.map(x => (typeof x === 'string' ? scrub(x) : x));
  const log = (...a) => console.log('%c' + TAG, STYLE, ...fmt(a));
  const warn = (...a) => console.warn(TAG, ...fmt(a));
  const error = (...a) => console.error(TAG, ...fmt(a));
  const debug = (...a) => { if (CONFIG.VERBOSE) console.debug(TAG, ...fmt(a)); };

  /* =========================================================================
   * 3. SINGLE INSTANCE + PUBLIC HANDLE
   * ======================================================================= */
  const W = window;
  const prev = W.__QuizPilot2;
  if (prev && prev.running) {
    if (prev.watching && typeof prev.rescan === 'function') { log('Already running and watching - rescanning now. (qp.stop() to stop.)'); prev.rescan(); }
    else warn('Already running in this tab. Wait for it to finish, or run qp.stop().');
    return;
  }
  const state = {
    running: true, aborted: false, watching: false, controllers: new Set(),
    seen: new WeakMap(),            // first control element -> fingerprint already handled
    counter: 0, rows: [], cleanup: [], rescan: null,
  };
  W.__QuizPilot2 = state;
  const answerCache = (W.__QuizPilot2Cache instanceof Map) ? W.__QuizPilot2Cache : (W.__QuizPilot2Cache = new Map());
  W.QuizPilot = {
    version: '2.0.0',
    lastReport: null,
    stop() {
      if (!state.running) { log('Not running.'); return; }
      state.aborted = true;
      state.controllers.forEach(c => { try { c.abort(); } catch (_) { /* ignore */ } });
      shutdown('Stopped by you.');
    },
    abort() { this.stop(); },
    rescan() { if (state.rescan) state.rescan(); else log('Nothing to rescan.'); },
    clearCache() { answerCache.clear(); log('Answer cache cleared.'); },
    report() {
      const r = this.lastReport;
      if (!r || !r.results.length) { log('No results yet.'); return; }
      r.results.forEach(x => console.log(`${x.id} | ${x.status} | ${x.answer || '-'} | ${x.confidence || ''} | ${truncate(x.question || '', 70)}`));
    },
  };
  // Short aliases:  qp.stop()  qp.scan()  qp.report()  qp.clear()
  W.qp = { stop: () => W.QuizPilot.stop(), scan: () => W.QuizPilot.rescan(), report: () => W.QuizPilot.report(), clear: () => W.QuizPilot.clearCache() };
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
   * 6. ENVIRONMENT / COMPATIBILITY CHECKS + NOISE FILTERS
   * ======================================================================= */
  // ---- noise filters: ads, cookie banners, navigation, search, login/newsletter forms ----
  const AD_RE = /(^|[\s_\-])(ads?|adv|advert\w*|sponsor\w*|promo(tion|ted)?s?|banner\w*|adsbygoogle|ad-?slot|ad-?unit|ad-?container|ad-?wrap\w*|dfp|gpt-ad|taboola|outbrain|mgid|revcontent|carbonads?|cookie\w*|consent\w*|gdpr|cmp|newsletter|subscribe\w*|signup|sign-up|popup-?ad|interstitial)([\s_\-]|$)/i;
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
      if (tag === 'NAV' || tag === 'INS') return true;
      const role = (n.getAttribute('role') || '').toLowerCase();
      if (role === 'navigation' || role === 'search' || role === 'banner' || role === 'contentinfo') return true;
      if ((tag === 'HEADER' || tag === 'FOOTER') && n.parentElement && n.parentElement.tagName === 'BODY') return true;
      if (tag === 'FORM' && (n.querySelector('input[type="password"]') || n.getAttribute('role') === 'search' || /search|login|signin|sign-in|newsletter|subscribe/i.test(attrBlob(n) + ' ' + (n.getAttribute('action') || '')))) return true;
      if (AD_RE.test(attrBlob(n)) || /advert|sponsor/i.test(n.getAttribute('aria-label') || '')) return true;
    }
    return false;
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

  // (exam guard moved to the EXAM GUARD block near the bottom of this file)

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
        if (isNoiseControl(el)) return;
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
      const cacheKey = lower(qText) + '||' + type + '||' + options.map(o => lower(o.text)).join('|');
      questions.push({ ...base, type, text: qText, options, fingerprint: fp, cacheKey });
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
    nvidia:      { name: 'NVIDIA',       base: 'https://integrate.api.nvidia.com/v1', kind: 'openai', json: false,
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
   * 10. HTTP CLIENT (relay-aware, timeouts, clear errors)
   * ======================================================================= */
  class ApiError extends Error {
    constructor(kind, message, status, retryAfterMs) { super(message); this.name = 'ApiError'; this.kind = kind; this.status = status || 0; this.retryAfterMs = retryAfterMs || 0; }
  }
  const relay = () => norm(CONFIG.RELAY_URL).replace(/\/+$/, '');
  function urlFor(provider, path) {
    return relay() ? `${relay()}/${provider}${path}` : PROVIDERS[provider].base + path;
  }
  function headersFor(provider, key, hasBody) {
    const h = { Accept: 'application/json' };
    if (hasBody) h['Content-Type'] = 'application/json';
    if (PROVIDERS[provider].kind === 'anthropic') {
      h['x-api-key'] = key;
      h['anthropic-version'] = '2023-06-01';
      if (!relay()) h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else h.Authorization = 'Bearer ' + key;
    return h;
  }

  async function httpJson(provider, key, path, method, bodyObj) {
    checkAbort();
    const url = urlFor(provider, path);
    const ctl = new AbortController();
    state.controllers.add(ctl);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, CONFIG.REQUEST_TIMEOUT_MS);
    let csp = null;
    const host = (() => { try { return new URL(url).host; } catch (_) { return ''; } })();
    const onCsp = (e) => { if (host && String(e.blockedURI || '').includes(host)) csp = e.violatedDirective; };
    document.addEventListener('securitypolicyviolation', onCsp);
    try {
      const res = await fetch(url, {
        method, signal: ctl.signal, credentials: 'omit', mode: 'cors', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: headersFor(provider, key, !!bodyObj), body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      });
      const raw = await res.text();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      if (!res.ok) {
        const msgObj = body && (body.error || body.detail || body.message || body.title);
        const detail = scrub(truncate(msgObj ? (typeof msgObj === 'string' ? msgObj : (msgObj.message || safeStringify(msgObj))) : (raw || res.statusText), 300));
        const ra = res.headers.get('retry-after');
        const raMs = ra ? (isNaN(Number(ra)) ? Math.max(0, Date.parse(ra) - Date.now()) : Number(ra) * 1000) : 0;
        if (res.status === 401 || res.status === 403) throw new ApiError('auth', `HTTP ${res.status}: key rejected (${detail})`, res.status);
        if (res.status === 402 || /insufficient|quota|credit|billing|exceeded your current/i.test(detail)) throw new ApiError('quota', `HTTP ${res.status}: out of credits/quota (${detail})`, res.status);
        if (res.status === 429) throw new ApiError('rate', `HTTP 429: rate limited (${detail})`, 429, raMs);
        if (res.status === 404 && /QuizPilot relay|Not allowed|unknown provider/i.test(detail)) throw new ApiError('relay', `Relay refused the request (${detail}). Update your Cloudflare relay to the v2 code.`, 404);
        if (res.status === 400 || res.status === 422) throw new ApiError('bad_request', `HTTP ${res.status}: ${detail}`, res.status);
        if (res.status === 404) throw new ApiError('model', `HTTP 404: ${detail}`, 404);
        if (res.status >= 500) throw new ApiError('server', `HTTP ${res.status}: server error (${detail})`, res.status, raMs);
        throw new ApiError('bad_request', `HTTP ${res.status}: ${detail}`, res.status);
      }
      if (body === null) throw new ApiError('server', 'Non-JSON response.', res.status);
      return body;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (state.aborted) throw new AbortedError();
      if (timedOut) throw new ApiError('timeout', `Request timed out after ${Math.round(CONFIG.REQUEST_TIMEOUT_MS / 1000)}s.`);
      if (csp) throw new ApiError('blocked', `This page's Content-Security-Policy (${csp}) blocks ${host}. QuizPilot can't call the AI from this page.`);
      throw new ApiError('network', relay()
        ? `Could not reach the relay (${host}). Check RELAY_URL and that the Cloudflare worker is deployed.`
        : 'The request was blocked before a response arrived (usually CORS). Set RELAY_URL to your Cloudflare relay.');
    } finally {
      clearTimeout(timer);
      state.controllers.delete(ctl);
      document.removeEventListener('securitypolicyviolation', onCsp);
    }
  }

  /* =========================================================================
   * 11. MODEL SELECTION
   * ======================================================================= */
  const NON_CHAT_RE = /(embed|rerank|retriev|guard|safety|reward|shield|clip\b|parse|ocr|asr|whisper|tts|speech|audio|realtime|transcri|riva|flux|sdxl|stable-diffusion|diffusion|dall-e|image|imagen|veo|video|cosmos|paligemma|kosmos|deplot|neva|vila\b|fuyu|detector|segment|pii|moderation|bge|e5-|arctic-embed|grounding|coder|codestral|starcoder|codegemma|codellama|code-llama|usdcode|bert|gliner|topic-control|content-safety|translate|search-preview|computer-use|babbage|davinci|instruct-0914|aqa|learnlm|genmol|molmim|diffdock|esm|alphafold|openfold|proteinmpnn|rfdiffusion|evo2|maisi|trellis|edify|ising|deep-research|-tts|native-audio|live)/i;
  function rankModels(provider, ids) {
    const p = PROVIDERS[provider];
    const pref = (FAST ? p.fast : p.accurate).map(x => x.toLowerCase());
    return ids.map(id => String(id).replace(/^models\//, '')).filter((id, i, a) => id && a.indexOf(id) === i && !NON_CHAT_RE.test(id)).map(id => {
      const l = id.toLowerCase();
      let s = 0;
      const pi = pref.indexOf(l);
      if (pi >= 0) s += 1000 - pi * 10;
      if (/instruct|chat|-it\b|turbo|versatile|latest/.test(l)) s += 20;
      const thinking = /\br1\b|-r1|reason|thinking|qwq|\bo1\b|\bo3\b|\bo4\b|^o\d/.test(l);
      if (FAST) {
        if (/mini|flash|lite|instant|haiku|small|nano|fast|8b|turbo/.test(l)) s += 40;
        if (/pro\b|opus|large|405b|ultra/.test(l)) s -= 30;
        if (thinking) s -= 80;
      } else {
        if (/pro\b|sonnet|opus|large|70b|72b|120b|gpt-4\.1$|gpt-4o$/.test(l)) s += 40;
        if (thinking) s -= 20;
      }
      if (/preview|exp\b|experimental|\d{4}-\d{2}-\d{2}|-\d{4}$/.test(l)) s -= 10;
      if (/vision|-vl\b|vl-/.test(l)) s -= 20;
      return { id, s };
    }).sort((a, b) => b.s - a.s).map(x => x.id);
  }

  async function listModels(provider, key) {
    const body = await httpJson(provider, key, '/models', 'GET');
    const data = Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.models) ? body.models : Array.isArray(body) ? body : [];
    return data.map(m => (m && (m.id || m.name)) || '').filter(Boolean);
  }

  /**
   * Builds the ordered list of {provider, key, model} candidates.
   * Fast path: if the key's provider is certain, its preferred models are used without
   * a model-list round trip; the list is only fetched if those models fail.
   */
  async function resolveKeys(keys) {
    const resolved = [];
    for (let i = 0; i < keys.length; i++) {
      const g = guessProviders(keys[i]);
      SECRETS.push(g.key);
      let provider = null;
      let discovered = null;
      if (g.candidates.length === 1) provider = g.candidates[0];
      else {
        for (const c of g.candidates) {
          try { discovered = await listModels(c, g.key); provider = c; break; }
          catch (e) {
            if (e instanceof AbortedError) throw e;
            if (e.kind === 'network' || e.kind === 'blocked' || e.kind === 'relay') throw new StopError(e.message);
            debug(`Key ${i + 1} is not a ${PROVIDERS[c].name} key (${e.message})`);
          }
        }
        if (!provider) { warn(`Key ${i + 1}: could not match it to any provider. Prefix it like 'groq:...' to force one. Skipping it.`); continue; }
      }
      resolved.push({ index: i + 1, provider, key: g.key, discovered });
    }
    return resolved;
  }

  function candidatesFor(entry, isFirst) {
    const p = PROVIDERS[entry.provider];
    let models = entry.discovered ? rankModels(entry.provider, entry.discovered) : (FAST ? p.fast : p.accurate).slice();
    if (isFirst && norm(CONFIG.MODEL)) models = [norm(CONFIG.MODEL), ...models.filter(m => m !== norm(CONFIG.MODEL))];
    return models.slice(0, Math.max(1, CONFIG.MAX_MODELS_PER_KEY)).map(model => ({ provider: entry.provider, key: entry.key, keyIndex: entry.index, model, discoveredList: !!entry.discovered }));
  }

  /* =========================================================================
   * 12. PROMPT + RESPONSE PARSING
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
    'Reply with ONLY a JSON object:',
    EXPLAIN
      ? '{"answers":[{"question_id":"q1","answer":["B"],"answer_text":["exact option text"],"confidence":0.9,"uncertain":false,"personal":false,"explanation":"..."}]}'
      : '{"answers":[{"question_id":"q1","answer":["B"],"answer_text":["exact option text"],"confidence":0.9,"uncertain":false,"personal":false}]}',
  ].join('\n');

  function questionPayload(q) {
    const p = { question_id: q.id, type: q.type, question: q.text };
    if (q.options.length) p.options = q.options.map(o => ({ id: o.id, text: truncate(o.text, 400) }));
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
   * 13. CALLING MODELS: adaptive params, retries, key/model fallback, parallel batches
   * ======================================================================= */
  const paramFlags = new Map();   // provider|model -> { noTemp, maxField, noJson, noThink }

  async function callModel(cand, batch, note) {
    const p = PROVIDERS[cand.provider];
    const fk = cand.provider + '|' + cand.model;
    const f = paramFlags.get(fk) || {};
    paramFlags.set(fk, f);
    const user = (note ? note + '\n' : '') + JSON.stringify({ questions: batch.map(questionPayload) });
    const maxTokens = Math.min(CONFIG.MAX_TOKENS, 400 + batch.length * (EXPLAIN ? 170 : 100));
    for (let fix = 0; fix < 5; fix++) {
      try {
        if (p.kind === 'anthropic') {
          const body = { model: cand.model, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: user }] };
          if (!f.noTemp) body.temperature = 0;
          const r = await httpJson(cand.provider, cand.key, '/messages', 'POST', body);
          const content = Array.isArray(r && r.content) ? r.content.filter(c => c && c.type === 'text').map(c => c.text || '').join('') : '';
          return { content, finish: r && r.stop_reason === 'max_tokens' ? 'length' : (r && r.stop_reason) };
        }
        const body = { model: cand.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }], stream: false };
        if (!f.noTemp) body.temperature = 0;
        body[f.maxField || 'max_tokens'] = maxTokens;
        if (p.json && !f.noJson) body.response_format = { type: 'json_object' };
        if (p.noThink && FAST && !f.noThink) body.reasoning_effort = 'none';
        const r = await httpJson(cand.provider, cand.key, '/chat/completions', 'POST', body);
        const ch = r && Array.isArray(r.choices) ? r.choices[0] : null;
        const msg = ch && ch.message;
        const content = msg ? (typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(x => x.text || '').join('') : '') : '';
        return { content: content || '', finish: ch ? ch.finish_reason : null };
      } catch (e) {
        if (!(e instanceof ApiError) || e.kind !== 'bad_request') throw e;
        const m = e.message;
        let changed = false;
        if (/max_tokens/.test(m) && /max_completion_tokens/.test(m) && f.maxField !== 'max_completion_tokens') { f.maxField = 'max_completion_tokens'; changed = true; }
        else if (/temperature/i.test(m) && !f.noTemp) { f.noTemp = true; changed = true; }
        else if (/response_format|json_object|json mode|json_schema/i.test(m) && !f.noJson && p.json) { f.noJson = true; changed = true; }
        else if (/reasoning/i.test(m) && !f.noThink && p.noThink) { f.noThink = true; changed = true; }
        if (!changed) throw e;
        debug(`Adjusting request for ${cand.model}: ${m}`);
      }
    }
    throw new ApiError('bad_request', 'Request format not accepted by ' + cand.model);
  }

  const backoffMs = (attempt, hint) => Math.min(20000, Math.max(hint || 0, 700 * Math.pow(2, attempt)) + Math.floor(Math.random() * 300));

  async function answerWithCandidate(cand, batch) {
    let note = '';
    let bad = 0;
    for (let attempt = 0; attempt <= CONFIG.MAX_RETRIES; attempt++) {
      checkAbort();
      try {
        const { content, finish } = await callModel(cand, batch, note);
        const parsed = extractJson(content);
        if (!parsed) {
          if (finish === 'length') throw new ApiError('truncated', 'Reply was cut off by the token limit.');
          if (++bad >= 2) throw new ApiError('model', 'Model kept returning invalid JSON.');
          note = 'IMPORTANT: your previous reply was not valid JSON. Reply with ONLY the JSON object.';
          continue;
        }
        const v = validateAnswers(parsed, batch);
        if (!v.valid) {
          if (++bad >= 2) throw new ApiError('model', 'Model kept returning JSON without "answers".');
          note = 'IMPORTANT: reply with a JSON object {"answers":[...]} only.';
          continue;
        }
        v.problems.forEach(pr => debug(pr));
        return v;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (!['rate', 'server', 'timeout'].includes(e.kind)) throw e;
        if (attempt >= CONFIG.MAX_RETRIES) throw e;
        // a different key/model is usually faster than waiting out a long rate limit
        if (e.kind === 'rate' && e.retryAfterMs > 8000) throw e;
        const wait = backoffMs(attempt, e.retryAfterMs);
        debug(`${e.message} Retrying ${cand.model} in ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
      }
    }
    throw new ApiError('model', 'No usable response.');
  }

  const candLabel = (c) => `${PROVIDERS[c.provider].name} \u00B7 ${c.model}` + (c.keyIndex > 1 ? ` (key ${c.keyIndex})` : '');

  async function discoverFor(ctx, cand) {
    const dk = cand.provider + '|' + cand.key;
    if (ctx.discovered.has(dk) || PROVIDERS[cand.provider].noModels) return;
    ctx.discovered.add(dk);
    try {
      const ids = rankModels(cand.provider, await listModels(cand.provider, cand.key));
      const existing = new Set(ctx.cands.filter(c => c.key === cand.key).map(c => c.model));
      const extra = ids.filter(id => !existing.has(id)).slice(0, CONFIG.MAX_MODELS_PER_KEY + 1)
        .map(model => ({ provider: cand.provider, key: cand.key, keyIndex: cand.keyIndex, model, discoveredList: true }));
      const lastOfKey = ctx.cands.map(c => c.key).lastIndexOf(cand.key);
      ctx.cands.splice(lastOfKey + 1, 0, ...extra);
      if (extra.length) debug('Discovered models: ' + extra.map(c => c.model).join(', '));
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      debug('Model list failed: ' + e.message);
    }
  }

  async function answerBatch(batch, ctx) {
    let lastErr = null;
    for (let i = 0; i < ctx.cands.length; i++) {
      checkAbort();
      const cand = ctx.cands[(ctx.current + i) % ctx.cands.length];
      if (ctx.dead.has(cand) || ctx.deadKeys.has(cand.key)) continue;
      try {
        const v = await answerWithCandidate(cand, batch);
        const idx = ctx.cands.indexOf(cand);
        if (ctx.current !== idx || !ctx.announced) {
          ctx.current = idx;
          log((ctx.announced ? 'Switched to: ' : 'Using: ') + candLabel(cand));
          ctx.announced = true;
        }
        return v;
      } catch (e) {
        if (e instanceof AbortedError) throw e;
        if (!(e instanceof ApiError)) throw e;
        lastErr = e;
        if (e.kind === 'network' || e.kind === 'blocked' || e.kind === 'relay') throw new StopError(e.message);
        if (e.kind === 'truncated' && batch.length > 1) {
          const mid = Math.ceil(batch.length / 2);
          debug(`Reply truncated; splitting ${batch.length} questions.`);
          const a = await answerBatch(batch.slice(0, mid), ctx);
          const b = await answerBatch(batch.slice(mid), ctx);
          b.result.forEach((val, k) => a.result.set(k, val));
          return { result: a.result, problems: [], missing: [], valid: true };
        }
        if (e.kind === 'auth' || e.kind === 'quota') {
          if (!ctx.deadKeys.has(cand.key)) warn(`Key ${cand.keyIndex} (${PROVIDERS[cand.provider].name}): ${e.message} - trying the next key/model.`);
          ctx.deadKeys.add(cand.key);
          continue;
        }
        if (e.kind === 'model' || e.kind === 'bad_request') {
          ctx.dead.add(cand);
          debug(`${candLabel(cand)} failed: ${e.message}`);
          if (!cand.discoveredList) await discoverFor(ctx, cand);
          continue;
        }
        warn(`${candLabel(cand)}: ${e.message} - trying another model.`);
      }
    }
    throw new StopError('Every key/model failed. Last error: ' + (lastErr ? lastErr.message : 'none available'));
  }

  /** Sends batches in parallel; onAnswer(q, answer) is awaited for each answer as soon as its batch returns. */
  async function runBatches(questions, ctx, onAnswer) {
    const size = Math.max(1, CONFIG.QUESTIONS_PER_REQUEST);
    const queue = [];
    for (let i = 0; i < questions.length; i += size) queue.push(questions.slice(i, i + size));
    const got = new Map();
    let fatal = null;
    const worker = async () => {
      while (queue.length && !fatal && !state.aborted) {
        const batch = queue.shift();
        try {
          const v = await answerBatch(batch, ctx);
          for (const q of batch) if (v.result.has(q.id) && !got.has(q.id)) { got.set(q.id, v.result.get(q.id)); await onAnswer(q, v.result.get(q.id)); }
        } catch (e) {
          if (e instanceof AbortedError) { fatal = e; return; }
          fatal = e instanceof StopError ? e : new StopError(scrub(e));
        }
      }
    };
    const n = Math.min(Math.max(1, CONFIG.PARALLEL_REQUESTS), queue.length);
    await Promise.all(Array.from({ length: n }, worker));
    if (fatal instanceof AbortedError) throw fatal;
    // anything the model skipped gets one more (single) request
    const missing = questions.filter(q => !got.has(q.id));
    if (!fatal && missing.length) {
      try {
        const v = await answerBatch(missing, ctx);
        for (const q of missing) if (v.result.has(q.id) && !got.has(q.id)) { got.set(q.id, v.result.get(q.id)); await onAnswer(q, v.result.get(q.id)); }
      } catch (e) { if (e instanceof AbortedError) throw e; fatal = e; }
    }
    return { got, fatal };
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
    console.groupCollapsed(`${TAG} Detailed results (${rows.length})`);
    for (const r of rows) {
      console.groupCollapsed(`${r.id} [${r.status}] ${truncate(r.question, 90)}`);
      if (r.options && r.options.length) console.log('Options:', r.options.map(o => `${o.id}) ${o.text}`).join('  |  '));
      if (r.answer) console.log('Answer:', r.answer);
      if (r.confidence !== '') console.log('Confidence:', r.confidence);
      if (r.explanation) console.log('Explanation:', r.explanation);
      if (r.note) console.log('Note:', r.note);
      console.groupEnd();
    }
    console.groupEnd();
    try { console.table(rows.map(r => ({ id: r.id, status: r.status, answer: truncate(r.answer || '', 60), confidence: r.confidence, question: truncate(r.question, 70), note: truncate(r.note || '', 70) }))); } catch (_) { /* ignore */ }
    log('Verified: ' + count('VERIFIED') + (count('ALREADY SET') ? ` (+${count('ALREADY SET')} already correct)` : ''));
    if (count('SUGGESTED')) log('Suggested (auto-fill off): ' + count('SUGGESTED'));
    log('Uncertain: ' + count('UNCERTAIN'));
    log('Failed: ' + count('FAILED'));
    const yours = count('YOURS') + count('ANSWERED BY YOU') + count('SKIPPED');
    if (yours) log('Left for you / skipped: ' + yours);
    if (extra) log(extra);
  }
  function printLine(r) {
    const line = `${ICON[r.status] || ''} ${r.id} ${r.status}${r.answer ? '  ' + r.answer : ''}${r.confidence !== '' ? '  (' + r.confidence + ')' : ''}  \u00B7 ${truncate(r.question, 70)}${r.note && r.status !== 'VERIFIED' ? '  \u2014 ' + truncate(r.note, 90) : ''}`;
    if (r.status === 'FAILED') warn(line); else log(line);
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
      try { console.table(fresh.map(q => ({ id: q.id, type: q.type, options: q.options.length || '', question: truncate(q.text, 90) }))); } catch (_) { /* ignore */ }
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
        const { got, fatal } = await runBatches(toAsk, ctx, async (q, a) => {
          if (CONFIG.CACHE_ANSWERS && !a.conflict) answerCache.set(q.cacheKey, a);
          const row = mkRow(q, a); rows.set(q.id, row);
          await fillOne(q, a, row, det);
          done(row);
        });
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

    // Work out providers WHILE the page is being scanned (saves a round trip).
    const keysPromise = resolveKeys(keys).then(r => ({ r }), e => ({ e }));

    await waitForReady(document, CONFIG.DOM_STABLE_TIMEOUT_MS);
    await waitForDomStable(document, CONFIG.DOM_QUIET_MS, CONFIG.DOM_STABLE_TIMEOUT_MS);
    checkAbort();
    log('Detecting questions...');
    const det = CONFIG.WATCH ? detectQuestions() : await detectWithWaiting();
    const signals = proctoringSignals(det.docs);
    if (signals.length) throw new StopError('This page shows signs of a proctored or locked-down assessment (' + signals.join('; ') + '). QuizPilot only runs on practice quizzes and forms, so it will not continue here.');
    environmentReport(det.docs, det.crossOrigin).forEach(n => warn('Compatibility: ' + n));

    const kr = await keysPromise;
    if (kr.e) throw kr.e;
    if (!kr.r.length) throw new StopError('None of the API keys could be used.');
    const ctx = { cands: [], current: 0, dead: new Set(), deadKeys: new Set(), discovered: new Set(), announced: false };
    kr.r.forEach((entry, i) => ctx.cands.push(...candidatesFor(entry, i === 0)));
    log(`AI: ${kr.r.map(e => `${PROVIDERS[e.provider].name} (key ${e.index})`).join(', ')} \u00B7 ${FAST ? 'fast' : 'accurate'} mode`);

    if (det.questions.length || det.skipped.length) {
      await runPass(det, ctx, true);
    } else if (!CONFIG.WATCH) {
      throw new StopError('No answerable questions detected. Nothing was changed.');
    } else log('No questions on the page yet.');

    if (CONFIG.WATCH && !state.aborted) startWatching(ctx);
    else { log('Completed.'); shutdown(); }
  }


  try {
    await main();
  } catch (e) {
    if (e instanceof AbortedError) warn('Stopped. Fields already filled stay as they are; nothing was submitted.');
    else if (e instanceof StopError) error('Stopped: ' + e.message);
    else error('Unexpected error (stopped safely, nothing submitted): ' + scrub(e) + (e && e.stack && CONFIG.VERBOSE ? '\n' + scrub(e.stack) : ''));
    shutdown();
  }
})();
