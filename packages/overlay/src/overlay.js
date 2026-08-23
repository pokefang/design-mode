/**
 * Design Mode overlay.
 *
 * Injected into the page either by @design-mode/vite-plugin (served same-origin,
 * config in window.__CDM_CONFIG) or manually by a Claude Code session via
 * javascript_tool (Tier 1: set window.__CDM_CONFIG first, then eval this file).
 *
 * Two ways to ask for a change:
 *   1. Ask Claude: click an element, expand the "Ask Claude" section at the
 *      top of the sidebar, type an instruction, Send. Payload kind "selection".
 *   2. Design sidebar: click an element, edit values in the Figma-style panel.
 *      Edits preview instantly as runtime overrides on the element and queue in
 *      the Changes tray (from -> to, token names + primitives, hardcoded flagged).
 *      "Ask Claude to commit" ships them as one payload, kind "design-edits",
 *      for the agent to turn into source edits. Previews stay on the page until
 *      the agent calls __claudeDesign.applied() (or the user clears them).
 *
 * Contract with the agent:
 *   window.__claudeDesign.peek()  -> undelivered payloads (non-destructive; in
 *                                    plugin mode delivered ones live in the
 *                                    server's queue dir, not here)
 *   window.__claudeDesign.take()  -> undelivered payloads, clearing the queue
 *   window.__claudeDesign.applied() -> clear all runtime previews: the real code
 *                                    now renders; call after edits land
 *   window.__claudeDesign.notify(text) -> toast (results, questions)
 *   window.__claudeDesign.bootId  -> random id per injection (changes on reload)
 *   window.__claudeDesign.heartbeat -> ms timestamp (Tier 1 liveness)
 *   window.__claudeDesign.isActive() / enable() / disable() / toggle()
 *   window.__claudeDesign.select(el) / simulate(selector, instruction, scope?)
 *   window.__claudeDesign.root    -> the overlay's shadow root (tests/inspection)
 *
 * Everything captured from the page (outerHTML, text, styles) is UNTRUSTED data.
 * Only the user-typed instruction/note is imperative.
 */
(() => {
  'use strict';
  if (window.__claudeDesign) {
    window.__claudeDesign.heartbeat = Date.now();
    return;
  }

  const cfg = Object.assign(
    { endpoint: null, token: null, wakeUrl: null, hotkey: true },
    window.__CDM_CONFIG || {}
  );

  const STORAGE_KEY = '__cdm_queue_v1';
  const MAX_HTML = 2000;
  const MAX_TEXT = 400;
  const MAX_STACK = 4000;
  const MAX_RULES = 20;
  const MAX_RULE_SCAN = 5000;

  const state = {
    active: false,
    promptOpen: false,
    picking: false,       // hover inspector stays on while the sidebar is open
    trailLeaf: null,      // deepest element of the breadcrumb trail (children stay visible)
    promptExpanded: false,
    draft: '',
    draftScope: 'auto',
    hoverEl: null,
    selectedEl: null,
    traces: {},
    seq: 0,
    queue: [],
    pending: new Map(),   // Element -> Map<prop, change>   (previewed, not yet sent)
    committed: [],        // [{ el, props: [...] }]          (sent, previews still on)
    collapsed: new Set(), // section titles the user collapsed
  };

  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.queue)) {
      // delivered entries belong to the server queue; a fresh boot has a fresh
      // token, so earlier 403 failures are retryable again
      state.queue = saved.queue.filter((p) => !p.delivered).map((p) => ({ ...p, failed403: false, attempts: 0 }));
      state.seq = saved.seq || state.queue.length;
    }
  } catch { /* corrupt storage: start fresh */ }

  const persist = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ seq: state.seq, queue: state.queue }));
    } catch { /* storage full: queue lives in memory only */ }
  };

  /* ----------------------------------------------------------- UI shell --- */

  const Z = 2147483000;
  const host = document.createElement('div');
  host.setAttribute('data-cdm-ui', '');
  host.style.cssText = `position:fixed;inset:0;z-index:${Z};pointer-events:none;`;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .ui { font: 11.5px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif; color: #E8E8E8; -webkit-font-smoothing: antialiased; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { font: inherit; white-space: nowrap; cursor: pointer; }
    .hi { position: fixed; display: none; pointer-events: none; border: 1.5px solid #0C8CE9; background: rgba(12,140,233,0.08); border-radius: 2px; }
    .hi-label { position: fixed; display: none; pointer-events: none; background: #0C8CE9; color: #fff; font-size: 10.5px; line-height: 1; padding: 4px 7px; border-radius: 3px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .ring { position: fixed; display: none; pointer-events: none; border: 1.5px solid #0C8CE9; box-shadow: 0 0 0 3px rgba(12,140,233,0.18); border-radius: 2px; }
    .ta { display: block; width: 100%; background: #2B2B2B; color: #E8E8E8; border: 1px solid transparent; border-radius: 6px; padding: 7px 9px; font: inherit; resize: vertical; outline: none; min-height: 54px; }
    .ta:focus { border-color: #0C8CE9; }
    .sec-h .kbd { color: #9B9B9B; font-weight: 400; font-size: 10px; margin-left: auto; margin-right: 8px; }
    .scopes { display: flex; gap: 5px; margin-top: 8px; flex-wrap: wrap; }
    .scope { font-size: 10.5px; padding: 3px 9px; border-radius: 99px; border: 1px solid #3A3A3A; background: transparent; color: #E8E8E8; }
    .scope.on { border-color: #0C8CE9; background: rgba(12,140,233,0.18); }
    .card-foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 8px; min-width: 0; }
    .hint { color: #9B9B9B; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .btn { height: 28px; padding: 0 12px; border-radius: 6px; border: 1px solid #3A3A3A; background: #2B2B2B; color: #E8E8E8; flex: none; }
    .btn:hover { border-color: #4A4A4A; }
    .btn.primary { background: #0C8CE9; border-color: #0C8CE9; color: #fff; }
    .btn.primary:hover { background: #1D97F0; }
    .btn.ghost { background: transparent; }
    .btn.sm { height: 22px; padding: 0 8px; font-size: 10.5px; }
    .btn.full { width: 100%; margin-top: 8px; }
    .panel { position: fixed; top: 12px; right: 12px; bottom: 12px; width: 284px; display: none; flex-direction: column; pointer-events: auto; background: #1E1E1E; border: 1px solid #333; border-radius: 10px; box-shadow: 0 16px 48px rgba(0,0,0,0.5); overflow: hidden; }
    .panel-scroll { flex: 1; overflow: auto; padding: 12px 12px 10px; }
    .p-title { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px; min-width: 0; }
    .p-title .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .p-title .tag { color: #9B9B9B; font-weight: 400; font-size: 11px; }
    .p-sub { color: #8FB2FF; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .p-src { color: #9B9B9B; font-size: 10.5px; margin-top: 6px; word-break: break-all; }
    .p-classes { color: #9B9B9B; font-size: 10.5px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .flag { color: #E8963C; font-size: 10.5px; margin-top: 5px; }
    .sec { border-top: 1px solid #2C2C2C; margin-top: 10px; padding-top: 8px; }
    .sec-h { display: flex; align-items: center; justify-content: space-between; font-weight: 600; font-size: 11.5px; margin-bottom: 6px; cursor: pointer; user-select: none; }
    .sec-h .chev { color: #9B9B9B; font-size: 10px; transition: transform .12s; }
    .sec.closed .chev { transform: rotate(-90deg); }
    .sec.closed .sec-body { display: none; }
    .row { display: grid; grid-template-columns: 62px 1fr; gap: 6px; align-items: center; padding: 2.5px 0; min-width: 0; }
    .lbl { color: #9B9B9B; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 5px; }
    .ctl { height: 26px; width: 100%; min-width: 0; background: #2B2B2B; border: 1px solid transparent; border-radius: 6px; color: #E8E8E8; font: inherit; padding: 0 8px; outline: none; }
    .ctl:hover { border-color: #3A3A3A; }
    .ctl:focus { border-color: #0C8CE9; }
    .ctl[disabled] { color: #9B9B9B; }
    select.ctl { appearance: none; -webkit-appearance: none; background-image: linear-gradient(45deg, transparent 50%, #9B9B9B 50%), linear-gradient(135deg, #9B9B9B 50%, transparent 50%); background-position: calc(100% - 12px) 11px, calc(100% - 8px) 11px; background-size: 4px 4px; background-repeat: no-repeat; padding-right: 20px; }
    input[type=number].ctl { -moz-appearance: textfield; }
    input[type=number].ctl::-webkit-inner-spin-button { opacity: 0.6; }
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; min-width: 0; }
    .unit { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 4px; min-width: 0; }
    .unit .u { color: #9B9B9B; font-size: 10px; white-space: nowrap; }
    .swatched { display: grid; grid-template-columns: auto 1fr; gap: 6px; align-items: center; min-width: 0; }
    .sw { width: 16px; height: 16px; border-radius: 4px; border: 1px solid #3A3A3A; }
    .prim { color: #9B9B9B; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; grid-column: 2; margin-top: -1px; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #E8963C; display: inline-block; flex: none; }
    .tray { border-top: 1px solid #333; background: #232323; padding: 10px 12px; }
    .tray-h { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-weight: 600; min-width: 0; }
    .tray-h .count { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .tray-actions { display: flex; gap: 6px; flex: none; }
    .modal-bg { position: fixed; inset: 0; z-index: 3; pointer-events: auto; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
    .modal { width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: #1E1E1E; border: 1px solid #333; border-radius: 10px; box-shadow: 0 24px 64px rgba(0,0,0,0.6); overflow: hidden; }
    .modal-h { padding: 12px 14px 10px; font-weight: 600; font-size: 13px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .modal-h .muted { color: #9B9B9B; font-weight: 400; font-size: 11px; }
    .modal-list { overflow: auto; padding: 0 14px; max-height: 42vh; }
    .modal-list .chg { padding: 5px 0; }
    .modal-body { padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 8px; border-top: 1px solid #2C2C2C; }
    .modal-foot { display: flex; align-items: center; gap: 8px; }
    .modal-foot select.ctl { width: auto; flex: 1; min-width: 0; }
    .modal-empty { color: #9B9B9B; padding: 8px 0 12px; }
    .tray-h .muted { color: #9B9B9B; font-weight: 400; font-size: 10.5px; }
    .chg { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; padding: 3px 0; border-bottom: 1px solid #2C2C2C; min-width: 0; }
    .chg:last-of-type { border-bottom: none; }
    .chg .what { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chg .what b { font-weight: 600; }
    .chg .who { color: #9B9B9B; font-size: 10px; }
    .chg .arrow { color: #9B9B9B; margin: 0 4px; }
    .x { background: none; border: none; color: #9B9B9B; padding: 0 4px; font-size: 12px; }
    .x:hover { color: #E8E8E8; }
    .tray-note { width: 100%; margin-top: 8px; }
    .tray-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
    .tray-foot select.ctl { width: auto; height: 26px; flex: 1; min-width: 0; }
    .tray-status { color: #9B9B9B; font-size: 10.5px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .tray-status button { background: none; border: none; color: #8FB2FF; padding: 0; font-size: 10.5px; }
    .toast { position: fixed; display: none; pointer-events: none; bottom: 14px; left: 14px; background: #1E1E1E; border: 1px solid #333; border-radius: 8px; padding: 8px 12px; max-width: 46vw; }
    .pill { position: fixed; display: none; pointer-events: auto; top: 12px; right: 12px; align-items: center; gap: 10px; background: #1E1E1E; border: 1px solid #333; border-radius: 99px; padding: 5px 6px 5px 12px; box-shadow: 0 6px 24px rgba(0,0,0,0.35); font-weight: 600; }
    .pill .muted { color: #9B9B9B; font-weight: 400; }
    .hdr-btns { margin-left: auto; display: flex; align-items: center; gap: 4px; flex: none; }
    .kbtn { flex: none; height: 20px; display: inline-flex; align-items: center; font: 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.02em; padding: 0 6px; border-radius: 4px; border: 1px solid #3A3A3A; border-bottom-width: 2px; background: #2B2B2B; color: #9B9B9B; }
    .kbtn:hover { color: #E8E8E8; border-color: #4A4A4A; }
    .kbtn svg { width: 12px; height: 12px; display: block; }
    .kbtn.on { color: #0C8CE9; border-color: #0C8CE9; background: rgba(12,140,233,0.15); }
    .crumbs { display: none; align-items: center; gap: 1px; border-top: 1px solid #333; background: #232323; padding: 7px 10px; white-space: nowrap; overflow-x: auto; overflow-y: hidden; font-size: 11px; scrollbar-width: none; flex: none; }
    .crumbs::-webkit-scrollbar { display: none; }
    .crumbs { position: relative; cursor: grab; }
    .crumbs.dragging { cursor: grabbing; user-select: none; }
    .crumbs.dragging button { pointer-events: none; }
    .crumbs button.kids { color: #9B9B9B; padding: 2px 6px; }
    .crumbs button.kids:hover, .crumbs button.kids.on { color: #E8E8E8; background: #2B2B2B; }
    .menu { position: absolute; right: 8px; z-index: 2; background: #2B2B2B; border: 1px solid #3A3A3A; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); padding: 4px; min-width: 170px; max-width: 250px; max-height: 45%; overflow: auto; }
    .menu .mh { color: #9B9B9B; font-size: 10px; padding: 3px 8px 5px; }
    .menu button { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 8px; border: none; background: none; color: #E8E8E8; border-radius: 5px; text-align: left; min-width: 0; }
    .menu button:hover { background: #3A3A3A; }
    .menu .ml { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .menu .mc { color: #9B9B9B; font-size: 10px; flex: none; }
    .menu .more { color: #9B9B9B; font-size: 10px; padding: 4px 8px; }
    .crumbs .sep, .crumbs .dots { color: #9B9B9B; padding: 0 2px; flex: none; }
    .crumbs button { background: none; border: none; padding: 2px 5px; border-radius: 4px; color: #E8E8E8; flex: none; }
    .crumbs button.cur { color: #0C8CE9; font-weight: 600; }
    .crumbs button:hover { background: #2B2B2B; }
  `;
  shadow.append(style);

  const mk = (cls, tag = 'div') => { const n = document.createElement(tag); n.className = cls; return n; };
  const hi = mk('hi');
  const hiLabel = mk('hi-label ui');
  const ring = mk('ring');
  const panel = mk('panel ui');
  const panelScroll = mk('panel-scroll');
  const tray = mk('tray');
  const crumbs = mk('crumbs ui');
  panel.append(panelScroll, crumbs, tray);
  const toast = mk('toast ui');
  const pill = mk('pill ui');
  pill.innerHTML = '<span>Design Mode</span><span class="muted">click an element</span>';
  const pillEsc = mk('kbtn', 'button');
  pillEsc.textContent = 'esc';
  pillEsc.title = 'Exit Design Mode (Esc)';
  pillEsc.addEventListener('click', () => api.disable());
  pill.append(pillEsc);
  const syncPill = () => { pill.style.display = state.active && !state.promptOpen ? 'flex' : 'none'; };
  shadow.append(hi, hiLabel, ring, panel, toast, pill);

  const ensureMounted = () => { if (!host.isConnected) document.documentElement.append(host); };
  ensureMounted();

  let toastTimer = null;
  const showToast = (text, ms = 3500) => {
    ensureMounted();
    toast.textContent = text;
    toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.display = 'none'; }, ms);
  };

  const box = (target, node, pad = 0) => {
    const r = target.getBoundingClientRect();
    node.style.display = 'block';
    node.style.left = `${r.left - pad}px`;
    node.style.top = `${r.top - pad}px`;
    node.style.width = `${r.width + pad * 2}px`;
    node.style.height = `${r.height + pad * 2}px`;
    return r;
  };

  /* ------------------------------------------------------ introspection --- */

  const isOurs = (n) => n instanceof Element && (n === host || !!n.closest('[data-cdm-ui]'));

  const cssPath = (target) => {
    const parts = [];
    let n = target;
    let depth = 0;
    while (n && n !== document.body && depth < 24) {
      if (n.id) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      const tag = n.tagName.toLowerCase();
      const sibs = n.parentElement ? [...n.parentElement.children].filter((s) => s.tagName === n.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(n) + 1})` : tag);
      n = n.parentElement;
      depth++;
    }
    return parts.join(' > ');
  };

  const ownFiber = (n) => {
    for (const k of Object.keys(n)) {
      if (k.startsWith('__reactFiber$')) return n[k];
    }
    return null;
  };

  const findFiber = (target) => {
    let n = target;
    while (n) {
      const f = ownFiber(n);
      if (f) return f;
      n = n.parentElement;
    }
    return null;
  };

  const fiberName = (f) => {
    const t = f && f.type;
    if (typeof t === 'function') return t.displayName || t.name || null;
    if (t && typeof t === 'object') {
      return t.displayName || (t.render && (t.render.displayName || t.render.name)) || null;
    }
    return null;
  };

  const componentChain = (fiber) => {
    const names = [];
    let f = fiber;
    let hops = 0;
    while (f && hops < 50 && names.length < 8) {
      const n = fiberName(f);
      if (n && names[names.length - 1] !== n) names.push(n);
      f = f._debugOwner || f.return;
      hops++;
    }
    return names;
  };

  const resolveSource = (target) => {
    const stamped = target.closest('[data-claude-source]');
    if (stamped) {
      const m = (stamped.getAttribute('data-claude-source') || '').match(/^(.*):(\d+):(\d+)$/);
      if (m) return { via: stamped === target ? 'stamp' : 'stamp-ancestor', file: m[1], line: +m[2], col: +m[3] };
    }
    let n = target;
    while (n) {
      if (n.__svelte_meta && n.__svelte_meta.loc) {
        const l = n.__svelte_meta.loc;
        return { via: 'svelte', file: l.file, line: l.line, col: l.column };
      }
      n = n.parentElement;
    }
    const vue = target.closest('[data-v-inspector]');
    if (vue) {
      const m = (vue.getAttribute('data-v-inspector') || '').match(/^(.*):(\d+):(\d+)$/);
      if (m) return { via: 'vue', file: m[1], line: +m[2], col: +m[3] };
    }
    const fiber = findFiber(target);
    if (fiber) {
      let f = fiber;
      let hops = 0;
      while (f && hops < 10) {
        if (f._debugSource) {
          const s = f._debugSource;
          return { via: 'debugSource', file: s.fileName, line: s.lineNumber, col: s.columnNumber || 1 };
        }
        f = f.return;
        hops++;
      }
      const stack = fiber._debugStack && (fiber._debugStack.stack || String(fiber._debugStack));
      if (stack) return { via: 'debugStack', stack: String(stack).slice(0, MAX_STACK) };
    }
    return { via: 'none' };
  };

  const COMPUTED_PROPS = [
    'display', 'position', 'width', 'height', 'margin', 'padding', 'gap',
    'flexDirection', 'alignItems', 'justifyContent', 'gridTemplateColumns',
    'fontSize', 'fontWeight', 'fontFamily', 'lineHeight', 'letterSpacing', 'textAlign',
    'color', 'backgroundColor', 'borderRadius', 'border', 'boxShadow',
    'opacity', 'overflow', 'zIndex', 'transform',
  ];
  const computedSubset = (target) => {
    const cs = getComputedStyle(target);
    const out = {};
    for (const p of COMPUTED_PROPS) out[p] = cs[p];
    return out;
  };

  const walkRules = (cb) => {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const source = sheet.href
        || (sheet.ownerNode && sheet.ownerNode.getAttribute && sheet.ownerNode.getAttribute('data-vite-dev-id'))
        || 'inline';
      const visit = (list, layer) => {
        for (const rule of list) {
          if (cb(rule, source, layer) === false) return false;
          if (rule.cssRules && rule.cssRules.length) {
            const nextLayer = (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) ? rule.name : layer;
            if (visit(rule.cssRules, nextLayer) === false) return false;
          }
        }
        return true;
      };
      if (visit(rules, null) === false) return;
    }
  };

  const matchedRuleObjects = (target) => {
    const out = [];
    let scanned = 0;
    walkRules((rule, source, layer) => {
      if (scanned++ > MAX_RULE_SCAN || out.length >= MAX_RULES) return false;
      if (rule.selectorText) {
        try { if (target.matches(rule.selectorText)) out.push({ rule, source, layer }); } catch { /* unsupported selector */ }
      }
    });
    return out;
  };
  const matchedRules = (ruleObjs) => ruleObjs.map(({ rule, source }) => ({ selector: rule.selectorText, source }));

  let propIndex = null;
  let propIndexAt = 0;
  let propIndexSheets = 0;
  const customProps = () => {
    if (propIndex && Date.now() - propIndexAt < 10000 && propIndexSheets === document.styleSheets.length) return propIndex;
    const index = Object.create(null);
    let scanned = 0;
    walkRules((rule) => {
      if (scanned++ > 12000) return false;
      const s = rule.style;
      if (!s) return;
      for (let i = 0; i < s.length; i++) {
        const name = s[i];
        if (name && name.startsWith('--')) index[name] = s.getPropertyValue(name).trim();
      }
    });
    propIndex = index;
    propIndexAt = Date.now();
    propIndexSheets = document.styleSheets.length;
    return index;
  };

  const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/;
  const TRACE_PROPS = [
    'color', 'background-color', 'border-color', 'font-family', 'font-size', 'font-weight',
    'line-height', 'letter-spacing', 'text-align', 'padding', 'padding-inline', 'padding-block',
    'margin', 'margin-inline', 'margin-block', 'gap', 'border-radius', 'box-shadow', 'opacity',
  ];

  /* token: var() chain · utility: framework class with a literal (rounded-full)
   * hardcoded: inline/user literal or arbitrary-value utility · reset: preflight */
  const tokenTrace = (target, ruleObjs) => {
    const cs = getComputedStyle(target);
    const index = customProps();
    const out = {};
    for (const prop of TRACE_PROPS) {
      let authored = target.style.getPropertyValue(prop).trim();
      let from = authored ? 'inline style' : null;
      let layer = authored ? 'inline' : null;
      let selector = null;
      if (!authored) {
        let best = null;
        for (const obj of ruleObjs) {
          const v = obj.rule.style && obj.rule.style.getPropertyValue(prop).trim();
          if (!v) continue;
          if (!best || obj.layer !== 'base' || best.layer === 'base') best = { ...obj, v };
        }
        if (best) {
          authored = best.v;
          layer = best.layer;
          selector = best.rule.selectorText;
          from = `${selector} · ${String(best.source).split('/').pop()}`;
        }
      }
      if (!authored) continue;
      const chain = [];
      let cur = authored;
      let guard = 0;
      while (guard++ < 6) {
        const names = [...cur.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((m) => m[1]);
        if (!names.length) break;
        let picked = names[0];
        let def = '';
        let resolved = '';
        for (const name of names) {
          const d = index[name] || '';
          const rv = cs.getPropertyValue(name).trim();
          if (d || rv) { picked = name; def = d; resolved = rv; break; }
        }
        chain.push({ name: picked, value: def || resolved || '(unset)' });
        if (!def || !VAR_RE.test(def)) break;
        cur = def;
      }
      let computed = cs.getPropertyValue(prop).trim();
      if (!computed) computed = cs.getPropertyValue(`${prop}-start`).trim();
      let status;
      if (chain.length) status = 'token';
      else if (layer === 'base') status = 'reset';
      else if (layer === 'utilities') status = selector && selector.includes('\\[') ? 'hardcoded' : 'utility';
      else status = 'hardcoded';
      out[prop] = { computed, authored, from, selector, layer, chain, status };
    }
    return out;
  };

  const semanticName = (t) => {
    if (!t) return null;
    if (t.chain.length) return t.chain[0].name.replace(/^--/, '');
    if (t.status === 'utility' && t.selector) {
      return t.selector.split(',')[0].trim().replace(/^\./, '').replace(/\\/g, '').replace(/:.*$/, '');
    }
    return null;
  };
  const primitiveOf = (t, fallback = '') => t ? (t.chain.length ? t.chain[t.chain.length - 1].value : (t.computed || t.authored)) : fallback;

  // Token catalog for the pickers: whatever the page's CSS defines.
  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  let catalogCache = null;
  let catalogAt = 0;
  const tokenCatalog = () => {
    if (catalogCache && Date.now() - catalogAt < 10000) return catalogCache;
    const idx = customProps();
    const names = Object.keys(idx);
    const pick = (re) => names.filter((n) => re.test(n)).sort(natural);
    catalogCache = {
      color: pick(/^--color-/),
      fontFamily: pick(/^--font-(?!weight-)[a-z]/),
      fontWeight: pick(/^--font-weight-/),
      fontSize: pick(/^--text-(?!.*--)/),
      lineHeight: pick(/^--leading-/),
      tracking: pick(/^--tracking-/),
      radius: pick(/^--radius-/),
      shadow: pick(/^--shadow-/),
      spacingBase: idx['--spacing'] || '0.25rem',
    };
    catalogAt = Date.now();
    return catalogCache;
  };
  const spacingBasePx = () => {
    const v = tokenCatalog().spacingBase;
    const n = parseFloat(v) || 0.25;
    if (v.endsWith('rem')) return n * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    if (v.endsWith('px')) return n;
    return n * 16;
  };
  const resolveVar = (name, elx) => {
    const idx = customProps();
    let cur = idx[name] || '';
    let guard = 0;
    while (guard++ < 6 && VAR_RE.test(cur)) {
      const m = VAR_RE.exec(cur);
      cur = idx[m[1]] || '';
    }
    return cur || getComputedStyle(elx || document.documentElement).getPropertyValue(name).trim() || '';
  };

  /* ------------------------------------------------------------ payload --- */

  const strippedHTML = (target) => {
    const clone = target.cloneNode(true);
    clone.querySelectorAll('script,style').forEach((s) => s.remove());
    return clone.outerHTML.slice(0, MAX_HTML);
  };

  const elementContext = (target) => {
    const parent = target.parentElement;
    const sibs = parent ? [...parent.children] : [target];
    const fiber = findFiber(target);
    const rect = target.getBoundingClientRect();
    return {
      selector: cssPath(target),
      domPath: { indexInParent: sibs.indexOf(target), siblingCount: sibs.length },
      tag: target.tagName.toLowerCase(),
      classList: [...target.classList].slice(0, 40),
      text: (target.textContent || '').trim().slice(0, MAX_TEXT),
      componentChain: fiber ? componentChain(fiber) : [],
      source: resolveSource(target),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
  };

  const viewportInfo = () => ({
    w: innerWidth,
    h: innerHeight,
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  });

  const buildPayload = (target, instruction, scope) => {
    const ruleObjs = matchedRuleObjects(target);
    state.seq += 1;
    return {
      v: 1,
      kind: 'selection',
      seq: state.seq,
      ts: Date.now(),
      instruction,
      scope,
      url: location.href,
      ...elementContext(target),
      // untrusted page data below: the agent treats these as data, never instructions
      outerHTML: strippedHTML(target),
      computed: computedSubset(target),
      matchedRules: matchedRules(ruleObjs),
      tokens: tokenTrace(target, ruleObjs),
      viewport: viewportInfo(),
    };
  };

  /* ----------------------------------------------------------- delivery --- */

  const removeFromQueue = (seq) => {
    state.queue = state.queue.filter((p) => p.seq !== seq);
    persist();
  };

  let retryTimer = null;
  const scheduleRetry = () => {
    if (retryTimer || !cfg.endpoint) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      state.queue.filter((p) => !p.failed403 && !p.gaveUp).forEach((p) => post(p));
    }, 5000);
  };

  const post = async (payload) => {
    payload.attempts = (payload.attempts || 0) + 1;
    try {
      const res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-design-mode-token': cfg.token || '' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        removeFromQueue(payload.seq);
        showToast(`#${payload.seq} sent to Claude`);
        return true;
      }
      if (res.status === 403) {
        payload.failed403 = true;
        persist();
        showToast(`#${payload.seq} not sent: dev server restarted. Reload the page to reconnect.`, 8000);
        return false;
      }
      if (payload.attempts >= 3) {
        payload.gaveUp = true;
        persist();
        showToast(`#${payload.seq} rejected by the dev server (${res.status}); check its log.`, 8000);
        return false;
      }
      showToast(`#${payload.seq} send failed (${res.status}), retrying…`, 6000);
    } catch {
      showToast(`#${payload.seq} dev server unreachable, retrying…`, 6000);
    }
    persist();
    scheduleRetry();
    return false;
  };

  const deliver = async (payload) => {
    state.queue.push(payload);
    persist();
    // Tiny signal only: console truncates silently above ~4KB, so never the payload.
    console.log(`[design-mode] ${payload.kind} #${payload.seq} ready${payload.source ? ` (source via ${payload.source.via})` : ''}`);
    if (cfg.endpoint) { await post(payload); return; }
    if (cfg.wakeUrl) {
      try { fetch(`${cfg.wakeUrl}?token=${encodeURIComponent(cfg.token || '')}`, { mode: 'no-cors' }); } catch { /* not armed */ }
    }
    showToast(`#${payload.seq} queued for Claude`);
  };

  /* ------------------------------------------------------ live previews --- */

  const pendingFor = (elx) => {
    if (!state.pending.has(elx)) state.pending.set(elx, new Map());
    return state.pending.get(elx);
  };
  const pendingCount = () => [...state.pending.values()].reduce((n, m) => n + m.size, 0);

  const labelFor = (side) => side.label || (side.token ? side.token.replace(/^--/, '') : (side.primitive || side.css || ''));

  const SPACING_RE = /calc\(\s*var\(--spacing\)\s*\*\s*(-?[\d.]+)\s*\)/;
  const fromLabel = (t) => {
    if (!t) return null;
    const m = t.authored && SPACING_RE.exec(t.authored);
    if (m) return `spacing × ${m[1]}`;
    if (!t.chain.length && /^[a-z-]+$/.test(t.authored)) return t.authored; // transparent, none, inherit
    return t.chain.length ? null : semanticName(t);
  };

  // Apply a runtime override and record it. meta: { token?, primitive?, label?, system? }
  // system=true means the value maps to a framework utility (display:flex, spacing units),
  // so it is not a hardcoded literal even though it carries no token.
  const applyPreview = (prop, css, meta = {}) => {
    const elx = state.selectedEl;
    if (!elx) return;
    const t = state.traces[prop];
    const map = pendingFor(elx);
    const existing = map.get(prop);
    const from = existing ? existing.from : {
      inline: elx.style.getPropertyValue(prop),
      authored: t ? t.authored : null,
      token: t && t.chain.length ? t.chain[0].name : null,
      label: fromLabel(t),
      primitive: primitiveOf(t, getComputedStyle(elx).getPropertyValue(prop).trim()),
    };
    if (existing) (existing.companions || []).forEach((c) => c.before ? elx.style.setProperty(c.prop, c.before) : elx.style.removeProperty(c.prop));
    elx.style.setProperty(prop, css);
    const companions = [];
    if (prop === 'font-size' && meta.token && customProps()[`${meta.token}--line-height`] !== undefined) {
      const before = existing && existing.companions && existing.companions[0] ? existing.companions[0].before : elx.style.getPropertyValue('line-height');
      companions.push({ prop: 'line-height', before, css: `var(${meta.token}--line-height)` });
      elx.style.setProperty('line-height', `var(${meta.token}--line-height)`);
    }
    map.set(prop, {
      prop,
      from,
      to: { css, token: meta.token || null, label: meta.label || null, primitive: meta.primitive || css, hardcoded: !meta.token && !meta.system },
      companions,
    });
    renderTray();
  };

  const liftOverride = (elx, c) => {
    c.from.inline ? elx.style.setProperty(c.prop, c.from.inline) : elx.style.removeProperty(c.prop);
    (c.companions || []).forEach((cp) => cp.before ? elx.style.setProperty(cp.prop, cp.before) : elx.style.removeProperty(cp.prop));
  };

  const revertChange = (elx, prop) => {
    const map = state.pending.get(elx);
    if (!map || !map.has(prop)) return;
    liftOverride(elx, map.get(prop));
    map.delete(prop);
    if (!map.size) state.pending.delete(elx);
    renderTray();
    if (elx === state.selectedEl) renderPanel(elx, true);
  };

  const discardAll = () => {
    for (const [elx, map] of state.pending) for (const c of map.values()) liftOverride(elx, c);
    state.pending = new Map();
    renderTray();
    if (state.selectedEl) renderPanel(state.selectedEl, true);
  };

  const clearPreviews = () => {
    discardAll();
    for (const { el: elx, changes } of state.committed) for (const c of changes) liftOverride(elx, c);
    state.committed = [];
    renderTray();
    if (state.selectedEl) renderPanel(state.selectedEl, true);
  };

  const commitChanges = (note, scope) => {
    const targets = [];
    for (const [elx, map] of state.pending) {
      if (!map.size || !elx.isConnected) continue;
      targets.push({
        ...elementContext(elx),
        edits: [...map.values()].map((c) => ({
          prop: c.prop,
          from: { authored: c.from.authored, token: c.from.token, label: c.from.label, primitive: c.from.primitive },
          to: { css: c.to.css, token: c.to.token, label: c.to.label, primitive: c.to.primitive, hardcoded: c.to.hardcoded },
        })),
      });
      state.committed.push({ el: elx, changes: [...map.values()] });
    }
    if (!targets.length) return;
    const summary = targets.map((tg) => `${tg.componentChain[0] || tg.tag}: ${tg.edits.map((e) => `${e.prop} ${labelFor(e.from)} → ${labelFor(e.to)}`).join(', ')}`).join('; ');
    state.seq += 1;
    const payload = {
      v: 1,
      kind: 'design-edits',
      seq: state.seq,
      ts: Date.now(),
      instruction: note ? `${note} (design edits: ${summary})` : `Apply these design edits to the source: ${summary}`,
      note,
      scope,
      url: location.href,
      viewport: viewportInfo(),
      targets,
    };
    state.pending = new Map();
    renderTray();
    deliver(payload);
  };

  /* ------------------------------------------------------------ tray UI --- */

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const elLabel = (elx) => {
    const f = findFiber(elx);
    const chain = f ? componentChain(f) : [];
    return chain[0] || elx.tagName.toLowerCase();
  };

  let trayNoteValue = '';
  let trayScopeValue = 'auto';

  const changeRow = (elx, c, onRevert) => {
    const row = mk('chg');
    const what = mk('what');
    what.innerHTML = `<span class="who">${esc(elLabel(elx))}</span> <b>${esc(c.prop)}</b> ${esc(labelFor(c.from))}<span class="arrow">→</span>${esc(labelFor(c.to))}${c.to.hardcoded ? ' <span class="dot" title="hardcoded value"></span>' : ''}`;
    what.title = `${c.from.primitive} → ${c.to.primitive}${c.to.hardcoded ? ' (hardcoded)' : ''}`;
    const x = mk('x', 'button');
    x.textContent = '✕';
    x.title = 'Revert this change';
    x.addEventListener('click', onRevert);
    row.append(what, x);
    return row;
  };

  // Compact footer: a change total plus actions. The list lives in the confirm modal.
  const renderTray = () => {
    const n = pendingCount();
    const committed = state.committed.reduce((k, c) => k + c.changes.length, 0);
    if (!n && !committed) { tray.style.display = 'none'; return; }
    tray.style.display = 'block';
    tray.innerHTML = '';
    if (n) {
      const hard = [...state.pending.values()].reduce((k, m) => k + [...m.values()].filter((c) => c.to.hardcoded).length, 0);
      const h = mk('tray-h');
      const count = mk('count', 'span');
      count.innerHTML = `${n} change${n > 1 ? 's' : ''}${hard ? ` <span class="dot" title="hardcoded values"></span>` : ''}`;
      count.title = hard ? `${hard} hardcoded value${hard > 1 ? 's' : ''}` : 'previewing on the page';
      const discard = mk('btn sm ghost', 'button');
      discard.textContent = 'Discard';
      discard.addEventListener('click', discardAll);
      h.append(count, discard);
      const commit = mk('btn primary full', 'button');
      commit.textContent = 'Ask Claude to commit';
      commit.addEventListener('click', openCommitModal);
      tray.append(h, commit);
    }
    if (committed) {
      const st = mk('tray-status');
      st.innerHTML = `<span title="Previews stay on the page until Claude applies the edits">${committed} sent · previewing</span>`;
      const clear = document.createElement('button');
      clear.textContent = 'Clear previews';
      clear.addEventListener('click', clearPreviews);
      st.append(clear);
      if (n) st.style.marginTop = '8px';
      tray.append(st);
    }
  };

  let modal = null;
  const closeCommitModal = () => { if (modal) { modal.remove(); modal = null; } };
  const openCommitModal = () => {
    closeCommitModal();
    const bg = mk('modal-bg ui');
    const box_ = mk('modal');
    const render = () => {
      const n = pendingCount();
      box_.innerHTML = '';
      const h = mk('modal-h');
      h.innerHTML = `<span>Ask Claude to commit <span class="muted">· ${n} change${n === 1 ? '' : 's'}</span></span>`;
      const close = mk('kbtn', 'button');
      close.textContent = 'esc';
      close.title = 'Cancel (Esc)';
      close.addEventListener('click', closeCommitModal);
      h.append(close);
      box_.append(h);
      const list = mk('modal-list');
      if (!n) { const e = mk('modal-empty'); e.textContent = 'Nothing left to commit.'; list.append(e); }
      for (const [elx, map] of state.pending) {
        for (const c of map.values()) list.append(changeRow(elx, c, () => { revertChange(elx, c.prop); pendingCount() ? render() : closeCommitModal(); }));
      }
      box_.append(list);
      const body = mk('modal-body');
      const note = mk('ctl', 'input');
      note.type = 'text';
      note.placeholder = 'Note for Claude (optional): intent, constraints, anything the values do not say';
      note.value = trayNoteValue;
      note.setAttribute('data-cdm-field', '');
      note.addEventListener('input', () => { trayNoteValue = note.value; });
      note.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); confirm.click(); }
        if (e.key === 'Escape') { e.preventDefault(); closeCommitModal(); }
      });
      const foot = mk('modal-foot');
      const scope = mk('ctl', 'select');
      scope.setAttribute('data-cdm-field', '');
      [['auto', 'Scope: auto'], ['instance', 'This instance'], ['component', 'All instances'], ['token', 'The token']].forEach(([v, l]) => {
        const o = document.createElement('option'); o.value = v; o.textContent = l; scope.append(o);
      });
      scope.value = trayScopeValue;
      scope.addEventListener('change', () => { trayScopeValue = scope.value; });
      scope.addEventListener('keydown', (e) => e.stopPropagation());
      const cancel = mk('btn ghost', 'button');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', closeCommitModal);
      const confirm = mk('btn primary', 'button');
      confirm.textContent = 'Send to Claude';
      confirm.disabled = !n;
      confirm.addEventListener('click', () => {
        if (!pendingCount()) return;
        commitChanges(trayNoteValue.trim(), trayScopeValue);
        trayNoteValue = '';
        closeCommitModal();
      });
      foot.append(scope, cancel, confirm);
      body.append(note, foot);
      box_.append(body);
      setTimeout(() => note.focus(), 0);
    };
    render();
    bg.addEventListener('click', (e) => { if (e.target === bg) closeCommitModal(); });
    bg.append(box_);
    shadow.append(bg);
    modal = bg;
  };

  /* ----------------------------------------------------------- controls --- */

  const datalists = new Map();
  const datalistFor = (key, names) => {
    const id = `cdm-dl-${key}`;
    let dl = datalists.get(key);
    if (!dl) { dl = document.createElement('datalist'); dl.id = id; shadow.append(dl); datalists.set(key, dl); }
    if (dl.dataset.n !== String(names.length)) {
      dl.innerHTML = '';
      for (const nme of names) { const o = document.createElement('option'); o.value = nme.replace(/^--/, ''); dl.append(o); }
      dl.dataset.n = String(names.length);
    }
    return id;
  };

  const row = (label, control, opts = {}) => {
    const r = mk('row');
    const l = mk('lbl');
    l.textContent = label;
    if (opts.hardcoded) { const d = mk('dot', 'span'); d.title = 'hardcoded value'; l.append(d); }
    if (opts.tip) r.title = opts.tip;
    r.append(l, control);
    return r;
  };

  const fieldKeys = (inp, reset) => {
    inp.setAttribute('data-cdm-field', '');
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); reset(); inp.blur(); }
    });
  };

  const tipFor = (t) => t ? `${t.authored}${t.from ? ' · ' + t.from : ''}${t.chain.length ? ' · ' + t.chain.map((c) => c.name).join(' → ') + ' → ' + primitiveOf(t) : ''}` : 'not authored (inherited or default)';

  // Token picker: a datalist-backed input listing the page's tokens of one family.
  // Typing a token name previews var(--token); typing anything else previews the
  // literal and flags it hardcoded.
  const tokenInput = ({ prop, family, key, swatch, special }) => {
    const t = state.traces[prop];
    const cat = tokenCatalog();
    const names = cat[key] || [];
    const cs = getComputedStyle(state.selectedEl);
    const current = semanticName(t) || (t ? t.authored : '') || cs.getPropertyValue(prop).trim();
    const wrap = mk(swatch ? 'swatched' : '');
    let sw = null;
    if (swatch) { sw = mk('sw', 'span'); sw.style.background = cs.getPropertyValue(prop); wrap.append(sw); }
    const inp = mk('ctl', 'input');
    inp.type = 'text';
    inp.setAttribute('list', datalistFor(key, names));
    inp.value = current;
    inp.title = tipFor(t);
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    fieldKeys(inp, () => { inp.value = current; });
    inp.addEventListener('change', () => {
      const raw = inp.value.trim();
      if (!raw || raw === current) return;
      const name = raw.startsWith('--') ? raw : `--${raw}`;
      const idx = customProps();
      if (idx[name] !== undefined && family.test(name)) {
        const prim = resolveVar(name, state.selectedEl);
        applyPreview(prop, `var(${name})`, { token: name, primitive: prim });
        if (sw) sw.style.background = prim;
      } else if (special && special[raw]) {
        applyPreview(prop, special[raw].css, { label: raw, primitive: special[raw].css, system: true });
      } else {
        applyPreview(prop, raw, { primitive: raw });
        if (sw) sw.style.background = raw;
      }
    });
    wrap.append(inp);
    if (swatch) {
      const prim = mk('prim');
      prim.textContent = primitiveOf(t, cs.getPropertyValue(prop).trim());
      wrap.append(prim);
    }
    return { node: wrap, hardcoded: !!t && t.status === 'hardcoded', tip: tipFor(t) };
  };

  const selectInput = ({ prop, options, current, system = true }) => {
    const sel = mk('ctl', 'select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o; opt.textContent = o; sel.append(opt);
    }
    if (!options.includes(current)) { const opt = document.createElement('option'); opt.value = current; opt.textContent = current; sel.prepend(opt); }
    sel.value = current;
    sel.setAttribute('data-cdm-field', '');
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    sel.addEventListener('change', () => applyPreview(prop, sel.value, { label: sel.value, primitive: sel.value, system }));
    return sel;
  };

  // Spacing in framework units (multiples of --spacing), shown with the px it resolves to.
  const spacingInput = ({ prop }) => {
    const cs = getComputedStyle(state.selectedEl);
    const base = spacingBasePx();
    const raw = cs.getPropertyValue(`${prop}-start`) || cs.getPropertyValue(prop) || '0';
    const px = parseFloat(raw) || 0;
    const units = Math.round((px / base) * 4) / 4;
    const wrap = mk('unit');
    const inp = mk('ctl', 'input');
    inp.type = 'number';
    inp.step = '0.5';
    inp.min = '0';
    inp.value = String(units);
    const u = mk('u', 'span');
    u.textContent = `${Math.round(px)}px`;
    fieldKeys(inp, () => { inp.value = String(units); });
    inp.addEventListener('change', () => {
      const n = Math.max(0, parseFloat(inp.value) || 0);
      applyPreview(prop, `calc(var(--spacing) * ${n})`, { label: `spacing × ${n}`, primitive: `${n * base}px`, system: true });
      u.textContent = `${Math.round(n * base)}px`;
    });
    wrap.append(inp, u);
    const t = state.traces[prop];
    return { node: wrap, hardcoded: !!t && t.status === 'hardcoded', tip: tipFor(t) };
  };

  const pair = (a, b) => { const p = mk('pair'); p.append(a, b); return p; };

  const section = (title, rows) => {
    const s = mk('sec' + (state.collapsed.has(title) ? ' closed' : ''));
    const h = mk('sec-h');
    h.innerHTML = `<span>${esc(title)}</span><span class="chev">&#9660;</span>`;
    h.addEventListener('click', () => {
      s.classList.toggle('closed');
      if (s.classList.contains('closed')) state.collapsed.add(title); else state.collapsed.delete(title);
    });
    const body = mk('sec-body');
    rows.filter(Boolean).forEach((r) => body.append(r));
    s.append(h, body);
    return s;
  };

  /* ------------------------------------------------------- ask claude --- */

  const liveTarget = () => {
    const target = state.selectedEl;
    if (!target) return null;
    if (target.isConnected) return target;
    const stampSel = target.getAttribute('data-claude-source');
    const text = (target.textContent || '').trim();
    return stampSel
      ? [...document.querySelectorAll(`[data-claude-source="${CSS.escape(stampSel)}"]`)].find((c) => (c.textContent || '').trim() === text) || null
      : null;
  };

  const sendPrompt = () => {
    const instruction = state.draft.trim();
    if (!instruction) { if (state.promptFocus) state.promptFocus(); return; }
    const live = liveTarget();
    if (!live) { closePrompt(); showToast('The page updated under that selection; select it again.', 5000); return; }
    const payload = buildPayload(live, instruction, state.draftScope);
    state.draft = '';
    if (state.promptReset) state.promptReset();
    deliver(payload);
  };

  // Collapsed by default; Enter (with nothing focused) or a click on the header opens it.
  const promptSection = () => {
    const s = mk('sec prompt' + (state.promptExpanded ? '' : ' closed'));
    const h = mk('sec-h');
    h.innerHTML = '<span>Ask Claude</span><span class="kbd">&#8629; to open</span><span class="chev">&#9660;</span>';
    const body = mk('sec-body');
    const ta = mk('ta', 'textarea');
    ta.rows = 2;
    ta.placeholder = 'Describe the change…';
    ta.value = state.draft;
    ta.setAttribute('data-cdm-field', '');
    ta.addEventListener('input', () => { state.draft = ta.value; });
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
      if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
    });
    const scopes = mk('scopes');
    ['auto', 'instance', 'component', 'token'].forEach((sc) => {
      const b = mk('scope' + (sc === state.draftScope ? ' on' : ''), 'button');
      b.textContent = sc;
      b.addEventListener('click', () => {
        state.draftScope = sc;
        scopes.querySelectorAll('.scope').forEach((x) => x.classList.toggle('on', x === b));
      });
      scopes.append(b);
    });
    const foot = mk('card-foot');
    const hint = mk('hint', 'span');
    hint.textContent = 'Enter to send · Shift+Enter newline';
    const send = mk('btn primary', 'button');
    send.textContent = 'Send to Claude';
    send.addEventListener('click', sendPrompt);
    foot.append(hint, send);
    body.append(ta, scopes, foot);
    const setOpen = (open) => {
      state.promptExpanded = open;
      s.classList.toggle('closed', !open);
      h.querySelector('.kbd').style.display = open ? 'none' : '';
      if (open) setTimeout(() => ta.focus(), 0);
    };
    h.addEventListener('click', () => setOpen(!state.promptExpanded));
    h.querySelector('.kbd').style.display = state.promptExpanded ? 'none' : '';
    state.promptOpenSection = () => setOpen(true);
    state.promptFocus = () => { setOpen(true); };
    state.promptReset = () => { ta.value = ''; };
    s.append(h, body);
    return s;
  };

  /* -------------------------------------------------------------- panel --- */

  const PICK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2.5H3a.5.5 0 0 0-.5.5v3M10 2.5h3a.5.5 0 0 1 .5.5v3M6 13.5H3a.5.5 0 0 1-.5-.5v-3"/><path d="M8 8l5.5 2-2.4 1.1L10 13.5z" fill="currentColor" stroke="none"/></svg>';

  // The hover inspector normally rests once something is selected; picking keeps it on
  // so the user can re-target the open sidebar with another click.
  const setPicking = (on) => {
    state.picking = on;
    if (state.pickBtn) {
      state.pickBtn.classList.toggle('on', on);
      state.pickBtn.setAttribute('aria-pressed', String(on));
    }
    if (!on) {
      hi.style.display = 'none';
      hiLabel.style.display = 'none';
      state.hoverEl = null;
    }
  };

  const renderPanel = (target, keepScroll = false) => {
    const scrollTop = keepScroll ? panelScroll.scrollTop : 0;
    const fiber = findFiber(target);
    const chain = fiber ? componentChain(fiber) : [];
    const src = resolveSource(target);
    const ruleObjs = matchedRuleObjects(target);
    state.traces = tokenTrace(target, ruleObjs);
    const T = state.traces;
    const cs = getComputedStyle(target);
    const r = target.getBoundingClientRect();
    const hardcoded = Object.values(T).filter((x) => x.status === 'hardcoded').length;
    const srcLine = src.file ? `${src.file}:${src.line}:${src.col}`
      : src.via === 'debugStack' ? 'React 19 stack captured (agent symbolicates)'
      : 'unresolved (agent will search the repo)';

    panelScroll.innerHTML = '';
    const title = mk('p-title');
    title.innerHTML = `<span class="name">${esc(chain[0] || target.tagName.toLowerCase())}</span><span class="tag">&lt;${esc(target.tagName.toLowerCase())}&gt;</span>`;
    const btns = mk('hdr-btns');
    const pickBtn = mk('kbtn' + (state.picking ? ' on' : ''), 'button');
    pickBtn.innerHTML = PICK_ICON;
    pickBtn.title = 'Inspect: highlight elements on hover and click to select another (sidebar stays open)';
    pickBtn.setAttribute('aria-pressed', String(state.picking));
    pickBtn.addEventListener('click', () => setPicking(!state.picking));
    state.pickBtn = pickBtn;
    const escBtn = mk('kbtn', 'button');
    escBtn.textContent = 'esc';
    escBtn.title = 'Close (Esc)';
    escBtn.addEventListener('click', () => closePrompt());
    btns.append(pickBtn, escBtn);
    title.append(btns);
    const sub = mk('p-sub');
    sub.textContent = chain.slice(1).join(' ← ');
    sub.title = chain.join(' ← ');
    const srcEl = mk('p-src mono');
    srcEl.textContent = srcLine;
    const classes = mk('p-classes');
    classes.textContent = [...target.classList].join(' ');
    classes.title = classes.textContent;
    panelScroll.append(title, sub, srcEl, classes);
    if (hardcoded) {
      const f = mk('flag');
      f.textContent = `● ${hardcoded} hardcoded value${hardcoded > 1 ? 's' : ''} on this element`;
      panelScroll.append(f);
    }

    panelScroll.append(promptSection());

    const tk = (label, opts) => { const c = tokenInput(opts); return row(label, c.node, { hardcoded: c.hardcoded, tip: c.tip }); };
    const sp = (label, a, b) => {
      const A = spacingInput({ prop: a });
      const B = spacingInput({ prop: b });
      return row(label, pair(A.node, B.node), { hardcoded: A.hardcoded || B.hardcoded, tip: `${a}: ${A.tip}\n${b}: ${B.tip}` });
    };

    const disp = cs.display;
    const isFlex = disp.includes('flex');
    const isGrid = disp.includes('grid');
    const layout = [
      row('Display', selectInput({ prop: 'display', options: ['block', 'inline-block', 'flex', 'inline-flex', 'grid', 'none'], current: disp })),
      isFlex ? row('Direction', selectInput({ prop: 'flex-direction', options: ['row', 'column'], current: cs.flexDirection })) : null,
      (isFlex || isGrid) ? row('Align', selectInput({ prop: 'align-items', options: ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'], current: cs.alignItems })) : null,
      (isFlex || isGrid) ? row('Justify', selectInput({ prop: 'justify-content', options: ['flex-start', 'center', 'flex-end', 'space-between', 'space-around'], current: cs.justifyContent })) : null,
      (isFlex || isGrid) ? (() => { const g = spacingInput({ prop: 'gap' }); return row('Gap', g.node, { hardcoded: g.hardcoded, tip: g.tip }); })() : null,
    ];
    const spacing = [
      sp('Padding', 'padding-inline', 'padding-block'),
      sp('Margin', 'margin-inline', 'margin-block'),
    ];
    const w = mk('ctl', 'input'); w.value = `W ${Math.round(r.width)}`; w.disabled = true;
    const h = mk('ctl', 'input'); h.value = `H ${Math.round(r.height)}`; h.disabled = true;
    const size = [row('Box', pair(w, h))];
    const typography = [
      tk('Font', { prop: 'font-family', family: /^--font-(?!weight-)/, key: 'fontFamily' }),
      tk('Size', { prop: 'font-size', family: /^--text-(?!.*--)/, key: 'fontSize' }),
      tk('Weight', { prop: 'font-weight', family: /^--font-weight-/, key: 'fontWeight' }),
      tk('Leading', { prop: 'line-height', family: /^--leading-|^--text-.*--line-height$/, key: 'lineHeight' }),
      tk('Tracking', { prop: 'letter-spacing', family: /^--tracking-/, key: 'tracking' }),
      tk('Color', { prop: 'color', family: /^--color-/, key: 'color', swatch: true }),
      row('Align', selectInput({ prop: 'text-align', options: ['start', 'left', 'center', 'right', 'justify'], current: cs.textAlign })),
    ];
    const opacityIn = mk('ctl', 'input');
    opacityIn.type = 'number'; opacityIn.min = '0'; opacityIn.max = '100'; opacityIn.step = '5';
    opacityIn.value = String(Math.round(parseFloat(cs.opacity) * 100));
    fieldKeys(opacityIn, () => { opacityIn.value = String(Math.round(parseFloat(cs.opacity) * 100)); });
    opacityIn.addEventListener('change', () => {
      const v = Math.min(100, Math.max(0, parseFloat(opacityIn.value) || 0));
      applyPreview('opacity', String(v / 100), { label: `${v}%`, primitive: String(v / 100), system: true });
    });
    const opWrap = mk('unit'); const pct = mk('u', 'span'); pct.textContent = '%'; opWrap.append(opacityIn, pct);
    const appearance = [
      tk('Fill', { prop: 'background-color', family: /^--color-/, key: 'color', swatch: true }),
      tk('Radius', { prop: 'border-radius', family: /^--radius-/, key: 'radius', special: { full: { css: 'calc(infinity * 1px)' }, none: { css: '0px' } } }),
      tk('Border', { prop: 'border-color', family: /^--color-/, key: 'color', swatch: true }),
      tk('Shadow', { prop: 'box-shadow', family: /^--shadow-/, key: 'shadow', special: { none: { css: 'none' } } }),
      row('Opacity', opWrap),
    ];

    panelScroll.append(
      section('Layout', layout),
      section('Spacing', spacing),
      section('Size', size),
      section('Typography', typography),
      section('Appearance', appearance),
    );
    panel.style.display = 'flex';
    panelScroll.scrollTop = scrollTop;
    renderTray();
    renderCrumbs(target);
  };

  const childrenOf = (node) => [...node.children].filter((c) => !isOurs(c) && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE');
  const nodeLabel = (node, prevComp) => {
    const f = ownFiber(node);
    const comp = f ? componentChain(f)[0] : null;
    const label = (comp && comp !== prevComp) ? comp : node.tagName.toLowerCase() + (node.classList[0] ? '.' + node.classList[0] : '');
    return { label, comp };
  };

  let childMenu = null;
  let childMenuAnchor = null;
  const closeChildMenu = () => {
    if (childMenu) { childMenu.remove(); childMenu = null; }
    if (childMenuAnchor) childMenuAnchor.classList.remove('on');
  };
  const openChildMenu = (leaf) => {
    closeChildMenu();
    const kids = childrenOf(leaf);
    if (!kids.length) return;
    childMenu = mk('menu ui');
    const head = mk('mh');
    head.textContent = `${kids.length} child element${kids.length > 1 ? 's' : ''} of ${nodeLabel(leaf, null).label}`;
    childMenu.append(head);
    const { comp: leafComp } = nodeLabel(leaf, null);
    kids.slice(0, 14).forEach((k) => {
      const b = document.createElement('button');
      const { label } = nodeLabel(k, leafComp);
      const n = childrenOf(k).length;
      b.innerHTML = `<span class="ml">${esc(label)}</span>${n ? `<span class="mc">${n} inside</span>` : ''}`;
      b.title = (k.textContent || '').trim().slice(0, 80) || label;
      b.addEventListener('click', () => { closeChildMenu(); openPrompt(k); });
      childMenu.append(b);
    });
    if (kids.length > 14) { const more = mk('more'); more.textContent = `+${kids.length - 14} more (click one to descend, then open its children)`; childMenu.append(more); }
    panel.append(childMenu);
    const pr = panel.getBoundingClientRect();
    const cr = crumbs.getBoundingClientRect();
    childMenu.style.bottom = `${pr.bottom - cr.top + 4}px`;
    if (childMenuAnchor) childMenuAnchor.classList.add('on');
  };
  // click-and-drag scrolls the strip; a real drag swallows the click that follows
  let crumbDrag = null;
  let swallowCrumbClick = false;
  crumbs.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    crumbDrag = { x: e.clientX, left: crumbs.scrollLeft, moved: false, id: e.pointerId };
  });
  crumbs.addEventListener('pointermove', (e) => {
    if (!crumbDrag || e.pointerId !== crumbDrag.id) return;
    const dx = e.clientX - crumbDrag.x;
    if (!crumbDrag.moved && Math.abs(dx) > 4) {
      crumbDrag.moved = true;
      crumbs.classList.add('dragging');
      try { crumbs.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    }
    if (crumbDrag.moved) crumbs.scrollLeft = crumbDrag.left - dx;
  });
  const endCrumbDrag = (e) => {
    if (!crumbDrag || (e && e.pointerId !== crumbDrag.id)) return;
    const moved = crumbDrag.moved;
    crumbDrag = null;
    crumbs.classList.remove('dragging');
    if (moved) { swallowCrumbClick = true; setTimeout(() => { swallowCrumbClick = false; }, 0); }
  };
  crumbs.addEventListener('pointerup', endCrumbDrag);
  crumbs.addEventListener('pointercancel', endCrumbDrag);
  crumbs.addEventListener('click', (e) => { if (swallowCrumbClick) { e.stopPropagation(); e.preventDefault(); } }, true);

  // any click outside the menu (and not on its anchor) closes it
  shadow.addEventListener('click', (e) => {
    if (!childMenu) return;
    const path = e.composedPath();
    if (!path.includes(childMenu) && !path.includes(childMenuAnchor)) closeChildMenu();
  }, true);

  // The trail runs from the app root down to the deepest element reached, so
  // stepping up to a parent keeps the children visible; the current element is
  // highlighted wherever it sits and carries a picker listing all its children.
  const renderCrumbs = (target) => {
    closeChildMenu();
    if (!(state.trailLeaf && state.trailLeaf.isConnected && target.contains(state.trailLeaf))) state.trailLeaf = target;
    const leaf = state.trailLeaf;
    const path = [];
    let n = leaf;
    while (n && n !== document.body && path.length < 16) { path.push(n); n = n.parentElement; }
    path.reverse();
    crumbs.innerHTML = '';
    let prevComp = null;
    let cur = null;
    path.forEach((node, i) => {
      if (i) { const sep = mk('sep', 'span'); sep.textContent = '›'; crumbs.append(sep); }
      const { label, comp } = nodeLabel(node, prevComp);
      if (comp) prevComp = comp;
      const b = document.createElement('button');
      if (node === target) { b.className = 'cur'; cur = b; }
      b.textContent = label.slice(0, 22);
      b.title = label;
      b.addEventListener('click', () => openPrompt(node));
      crumbs.append(b);
      if (node === target) {
        const kids = childrenOf(node);
        childMenuAnchor = null;
        if (kids.length) {
          const more = mk('kids', 'button');
          more.textContent = '▾';
          more.title = `${kids.length} child element${kids.length > 1 ? 's' : ''} of ${label}: pick one to go deeper`;
          more.addEventListener('click', () => (childMenu ? closeChildMenu() : openChildMenu(node)));
          childMenuAnchor = more;
          crumbs.append(more);
        }
      }
    });
    crumbs.style.display = 'flex';
    if (cur) crumbs.scrollLeft = Math.max(0, cur.offsetLeft - crumbs.clientWidth / 2 + cur.offsetWidth / 2);
    else crumbs.scrollLeft = crumbs.scrollWidth;
  };

  /* ---------------------------------------------------------- selection --- */

  const closePrompt = () => {
    closeCommitModal();
    closeChildMenu();
    state.promptOpen = false;
    state.picking = false;
    state.selectedEl = null;
    state.trailLeaf = null;
    panel.style.display = 'none';
    syncPill();
    ring.style.display = 'none';
    crumbs.style.display = 'none';
  };

  const openPrompt = (target) => {
    state.selectedEl = target;
    state.promptOpen = true;
    state.hoverEl = null;
    hi.style.display = 'none';
    hiLabel.style.display = 'none';
    box(target, ring, 1);
    renderPanel(target);
    syncPill();
  };

  // Keep the ring and hover box glued to their elements while the page scrolls or resizes.
  let rafPending = false;
  const reposition = () => {
    rafPending = false;
    if (state.promptOpen && state.selectedEl && state.selectedEl.isConnected) box(state.selectedEl, ring, 1);
    if (state.active && (!state.promptOpen || state.picking) && state.hoverEl && state.hoverEl.isConnected) {
      const r = box(state.hoverEl, hi);
      hiLabel.style.left = `${Math.max(4, r.left)}px`;
      hiLabel.style.top = `${Math.max(4, r.top - 24)}px`;
    }
  };
  const onScrollOrResize = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(reposition);
  };
  window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
  window.addEventListener('resize', onScrollOrResize);

  /* ------------------------------------------------------------- events --- */

  const onMove = (e) => {
    if (!state.active || (state.promptOpen && !state.picking)) return;
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || isOurs(t) || t === document.documentElement || t === document.body) {
      hi.style.display = 'none';
      hiLabel.style.display = 'none';
      state.hoverEl = null;
      return;
    }
    if (t === state.hoverEl) return;
    state.hoverEl = t;
    const r = box(t, hi);
    const fiber = findFiber(t);
    const chain = fiber ? componentChain(fiber) : [];
    hiLabel.textContent = `${chain[0] ? chain[0] + ' · ' : ''}${t.tagName.toLowerCase()}${t.classList[0] ? '.' + t.classList[0] : ''} · ${Math.round(r.width)}×${Math.round(r.height)}`;
    hiLabel.style.display = 'block';
    hiLabel.style.left = `${Math.max(4, r.left)}px`;
    hiLabel.style.top = `${Math.max(4, r.top - 24)}px`;
  };

  const SUPPRESSED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const onSuppressed = (e) => {
    if (!state.active) return;
    if (isOurs(e.target)) return; // our own UI stays interactive
    if (e.type === 'click' && childMenu) closeChildMenu();
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    let t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || isOurs(t) || t === document.body || t === document.documentElement) return;
    if (e.altKey) {
      const base = state.selectedEl || state.hoverEl || t;
      t = base.parentElement && base.parentElement !== document.body ? base.parentElement : base;
    }
    openPrompt(t);
  };

  const onKey = (e) => {
    if (cfg.hotkey && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyD') {
      e.preventDefault();
      api.toggle();
      return;
    }
    if (!state.active) return;
    const origin = e.composedPath ? e.composedPath()[0] : e.target;
    if (origin && origin.hasAttribute && origin.hasAttribute('data-cdm-field')) return; // panel fields handle their own keys
    if (e.key === 'Enter' && state.promptOpen && state.promptOpenSection && !e.isComposing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      state.promptOpenSection();
      return;
    }
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (modal) closeCommitModal();
      else if (childMenu) closeChildMenu();
      else if (state.promptOpen) closePrompt();
      else api.disable();
    }
  };

  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  for (const type of SUPPRESSED) document.addEventListener(type, onSuppressed, { capture: true });
  document.addEventListener('keydown', onKey, { capture: true });

  /* ---------------------------------------------------------------- api --- */

  const api = {
    version: '0.3.0',
    bootId: Math.random().toString(36).slice(2, 10),
    config: cfg,
    heartbeat: Date.now(),
    root: shadow,
    enable() {
      ensureMounted();
      state.active = true;
      syncPill();
    },
    disable() {
      state.active = false;
      state.picking = false;
      state.hoverEl = null;
      closePrompt();
      hi.style.display = 'none';
      hiLabel.style.display = 'none';
      syncPill();
    },
    toggle() { state.active ? api.disable() : api.enable(); },
    isActive() { return state.active; },
    peek() { return state.queue.slice(); },
    take() {
      const q = state.queue.slice();
      state.queue = [];
      persist();
      return q;
    },
    applied() {
      clearPreviews();
      showToast('Previews cleared; the page now shows the committed code.');
    },
    pendingChanges() {
      return [...state.pending.entries()].map(([elx, m]) => ({ element: elLabel(elx), edits: [...m.values()].map((c) => ({ prop: c.prop, from: labelFor(c.from), to: labelFor(c.to), hardcoded: c.to.hardcoded })) }));
    },
    notify(text) { showToast(String(text).slice(0, 300), 6000); },
    select(target) { if (target instanceof Element) { api.enable(); openPrompt(target); } },
    simulate(selector, instruction, scope = 'auto') {
      let t;
      try { t = document.querySelector(selector); } catch (err) { return { error: `invalid selector ${selector}: ${err.message}` }; }
      if (!t) return { error: `no element matches ${selector}` };
      const payload = buildPayload(t, instruction, scope);
      deliver(payload);
      return { seq: payload.seq, source: payload.source };
    },
  };

  setInterval(() => { api.heartbeat = Date.now(); }, 1000);
  window.__claudeDesign = api;
  if (cfg.endpoint && state.queue.length) scheduleRetry();
  console.log('[design-mode] overlay ready', cfg.endpoint ? '(plugin endpoint)' : '(session mode)');
})();
