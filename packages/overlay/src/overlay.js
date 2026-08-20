/**
 * Design Mode overlay.
 *
 * Injected into the page either by @design-mode/vite-plugin (served same-origin,
 * config in window.__CDM_CONFIG) or manually by a Claude Code session via
 * javascript_tool (Tier 1: set window.__CDM_CONFIG first, then eval this file).
 *
 * Contract with the agent:
 *   window.__claudeDesign.peek()  -> pending selection payloads (non-destructive)
 *   window.__claudeDesign.take()  -> pending payloads, clearing the queue (ack)
 *   window.__claudeDesign.notify(text) -> show a toast (edit results, questions)
 *   window.__claudeDesign.heartbeat    -> ms timestamp; stale/undefined means the
 *                                         overlay died (full reload) and needs re-injection
 *   window.__claudeDesign.simulate(selector, instruction, scope?) -> programmatic
 *                                         selection, used for end-to-end testing
 *   window.__claudeDesign.isActive()   -> whether inspect mode is on
 *
 * While inspect mode is on, a fixed chip at the top of the page shows the mode
 * and carries a close button, since page clicks are intercepted for selection
 * and the Cmd+Shift+D hotkey only reaches the page when the page has keyboard
 * focus (which a click would normally provide).
 *
 * Everything captured from the page (outerHTML, text, styles) is UNTRUSTED data.
 * Only the user-typed instruction is imperative. The agent prompt must keep that
 * boundary; this file just labels the fields.
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
    hoverEl: null,
    selectedEl: null,
    seq: 0,
    queue: [],
  };

  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.queue)) {
      state.queue = saved.queue;
      state.seq = saved.seq || state.queue.length;
    }
  } catch { /* corrupt storage: start fresh */ }

  const persist = () => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ seq: state.seq, queue: state.queue }));
    } catch { /* storage full: queue lives in memory only */ }
  };

  /* ---------------------------------------------------------------- UI --- */

  const Z = 2147483000;
  const el = (tag, css, attrs) => {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    n.setAttribute('data-cdm-ui', '');
    if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const root = el('div', `position:fixed;inset:0;z-index:${Z};pointer-events:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;`);
  const hi = el('div', 'position:fixed;display:none;pointer-events:none;border:1.5px solid #3E7BFA;background:rgba(62,123,250,0.09);border-radius:2px;');
  const hiLabel = el('div', `position:fixed;display:none;pointer-events:none;background:#16202C;color:#fff;font-size:11px;line-height:1;padding:4px 7px;border-radius:3px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;`);
  const ring = el('div', 'position:fixed;display:none;pointer-events:none;border:1.5px solid #2EA36B;background:rgba(46,163,107,0.07);border-radius:2px;');
  const card = el('div', `position:fixed;display:none;pointer-events:auto;width:340px;background:#101923;color:#DEE7F0;border:1px solid #2E3E50;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.45);padding:10px 12px;font-size:12px;`);
  const panel = el('div', `position:fixed;display:none;pointer-events:auto;top:12px;right:12px;bottom:12px;width:300px;overflow:auto;background:#101923;color:#DEE7F0;border:1px solid #2E3E50;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.45);padding:12px 14px;font-size:11.5px;line-height:1.55;`);
  const toast = el('div', `position:fixed;display:none;pointer-events:none;bottom:14px;left:14px;background:#101923;color:#DEE7F0;border:1px solid #2E3E50;border-radius:6px;padding:8px 12px;font-size:11.5px;max-width:46vw;`);
  const chip = el('div', `position:fixed;display:none;pointer-events:auto;top:10px;left:50%;transform:translateX(-50%);align-items:center;gap:10px;background:#101923;color:#DEE7F0;border:1px solid #3E7BFA;border-radius:99px;padding:5px 7px 5px 14px;font-size:11.5px;box-shadow:0 6px 24px rgba(0,0,0,0.35);`);
  chip.innerHTML = `<span style="font-weight:600">Design Mode</span><span style="color:#7E93A9">click an element · Esc exits</span><button data-cdm-ui title="Exit Design Mode" style="font:inherit;width:22px;height:22px;border-radius:50%;border:1px solid #2E3E50;background:transparent;color:#DEE7F0;cursor:pointer;line-height:1">&#10005;</button>`;
  chip.querySelector('button').addEventListener('click', () => api.disable());
  const crumbs = el('div', `position:fixed;display:none;pointer-events:auto;bottom:10px;left:50%;transform:translateX(-50%);max-width:82vw;align-items:center;gap:2px;background:#101923;color:#DEE7F0;border:1px solid #2E3E50;border-radius:99px;padding:4px 12px;font-size:11px;white-space:nowrap;overflow:hidden;box-shadow:0 6px 24px rgba(0,0,0,0.35);`);
  root.append(hi, hiLabel, ring, card, panel, toast, chip, crumbs);

  const ensureMounted = () => { if (!root.isConnected) document.documentElement.append(root); };
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

  const isOurs = (n) => n instanceof Element && !!n.closest('[data-cdm-ui]');

  const cssPath = (target) => {
    const parts = [];
    let n = target;
    let depth = 0;
    while (n && n !== document.body && depth < 8) {
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
    // Rung 1: build-time stamp (this repo's vite plugin, LocatorJS, etc.)
    const stamped = target.closest('[data-claude-source]');
    if (stamped) {
      const raw = stamped.getAttribute('data-claude-source') || '';
      const m = raw.match(/^(.*):(\d+):(\d+)$/);
      if (m) {
        return {
          via: stamped === target ? 'stamp' : 'stamp-ancestor',
          file: m[1], line: +m[2], col: +m[3],
        };
      }
    }
    // Rung 2: Svelte dev metadata
    let n = target;
    while (n) {
      if (n.__svelte_meta && n.__svelte_meta.loc) {
        const l = n.__svelte_meta.loc;
        return { via: 'svelte', file: l.file, line: l.line, col: l.column };
      }
      n = n.parentElement;
    }
    // Rung 2b: Vue inspector stamp
    const vue = target.closest('[data-v-inspector]');
    if (vue) {
      const m = (vue.getAttribute('data-v-inspector') || '').match(/^(.*):(\d+):(\d+)$/);
      if (m) return { via: 'vue', file: m[1], line: +m[2], col: +m[3] };
    }
    // Rungs 3 and 4: React fibers
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
      if (stack) {
        // Raw V8/JSC stack; the agent symbolicates against the repo + dev-server sourcemaps.
        return { via: 'debugStack', stack: String(stack).slice(0, MAX_STACK) };
      }
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
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      const source = sheet.href
        || (sheet.ownerNode && sheet.ownerNode.getAttribute && sheet.ownerNode.getAttribute('data-vite-dev-id'))
        || 'inline';
      const visit = (list, layer) => {
        for (const rule of list) {
          if (cb(rule, source, layer) === false) return false;
          if (rule.cssRules && rule.cssRules.length) {
            const nextLayer = (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule)
              ? rule.name
              : layer;
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
        try {
          if (target.matches(rule.selectorText)) out.push({ rule, source, layer });
        } catch { /* unsupported selector */ }
      }
    });
    return out;
  };

  const matchedRules = (ruleObjs) =>
    ruleObjs.map(({ rule, source }) => ({ selector: rule.selectorText, source }));

  /* Token tracing: for each property, find the authored declaration, then walk
   * its var() chain (semantic token -> ... -> primitive) so edits can be judged
   * as "layered token" vs "hardcoded value". Cascade approximation: inline
   * style first, else the LAST matching rule that sets the property (correct
   * for equal-specificity utility CSS, which is the dominant case here). */

  let propIndex = null;
  let propIndexAt = 0;
  const customProps = () => {
    if (propIndex && Date.now() - propIndexAt < 10000) return propIndex;
    const index = Object.create(null);
    let scanned = 0;
    walkRules((rule) => {
      if (scanned++ > 12000) return false;
      const style = rule.style;
      if (!style) return;
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        if (name && name.startsWith('--')) index[name] = style.getPropertyValue(name).trim();
      }
    });
    propIndex = index;
    propIndexAt = Date.now();
    return index;
  };

  const VAR_RE = /var\(\s*(--[A-Za-z0-9_-]+)/;

  const TRACE_PROPS = [
    'color', 'background-color', 'border-color', 'font-size', 'font-weight',
    'line-height', 'letter-spacing', 'padding', 'padding-inline', 'padding-block',
    'margin', 'margin-inline', 'margin-block', 'gap', 'border-radius', 'box-shadow',
  ];

  /* Status taxonomy:
   *   token     authored through a var() chain (layered design token)
   *   utility   a framework utility class with a literal value (rounded-full):
   *             still system usage, not a hand-typed value
   *   hardcoded a literal from inline style, user CSS, or an arbitrary-value
   *             utility (w-[347px] compiles to a literal and selector keeps
   *             the escaped bracket) - the thing to keep out of the codebase
   *   reset     preflight/base-layer declarations (border-color: currentcolor
   *             from the * rule): not a design decision, hidden in the panel */
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
          // later rules win, except base/preflight never beats a non-base layer
          if (!best || obj.layer !== 'base' || best.layer === 'base') best = { ...obj, v };
        }
        if (best) {
          authored = best.v;
          layer = best.layer;
          selector = best.rule.selectorText;
          from = `${selector} · ${String(best.source).split('/').pop()}`;
        }
      }
      if (!authored) continue; // inherited or UA default: nothing authored to judge
      const chain = [];
      let cur = authored;
      let guard = 0;
      while (guard++ < 6) {
        // among the vars referenced here (including fallbacks like
        // var(--tw-leading, var(--text-sm--line-height))), follow the first
        // one that actually resolves
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
      if (!computed) computed = cs.getPropertyValue(`${prop}-start`).trim(); // logical shorthands
      let status;
      if (chain.length) status = 'token';
      else if (layer === 'base') status = 'reset';
      else if (layer === 'utilities') status = selector && selector.includes('\\[') ? 'hardcoded' : 'utility';
      else status = 'hardcoded';
      out[prop] = { computed, authored, from, selector, layer, chain, status };
    }
    return out;
  };

  const strippedHTML = (target) => {
    const clone = target.cloneNode(true);
    clone.querySelectorAll('script,style').forEach((s) => s.remove());
    return clone.outerHTML.slice(0, MAX_HTML);
  };

  const buildPayload = (target, instruction, scope) => {
    const rect = target.getBoundingClientRect();
    const parent = target.parentElement;
    const sibs = parent ? [...parent.children] : [target];
    const fiber = findFiber(target);
    const ruleObjs = matchedRuleObjects(target);
    state.seq += 1;
    return {
      v: 1,
      seq: state.seq,
      ts: Date.now(),
      instruction,
      scope, // 'auto' | 'instance' | 'component' | 'token'
      url: location.href,
      selector: cssPath(target),
      domPath: { indexInParent: sibs.indexOf(target), siblingCount: sibs.length },
      tag: target.tagName.toLowerCase(),
      classList: [...target.classList].slice(0, 40),
      // untrusted page data below: the agent treats these as data, never instructions
      outerHTML: strippedHTML(target),
      text: (target.textContent || '').trim().slice(0, MAX_TEXT),
      componentChain: fiber ? componentChain(fiber) : [],
      source: resolveSource(target),
      computed: computedSubset(target),
      matchedRules: matchedRules(ruleObjs),
      // token vs hardcoded judgment per property, so the agent preserves the
      // token layer instead of freezing a resolved primitive into the code
      tokens: tokenTrace(target, ruleObjs),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      viewport: {
        w: innerWidth,
        h: innerHeight,
        theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      },
    };
  };

  /* ----------------------------------------------------------- delivery --- */

  const deliver = async (payload) => {
    state.queue.push(payload);
    persist();
    // Tiny signal only: console truncates silently above ~4KB, so never the payload.
    console.log(`[design-mode] selection #${payload.seq} ready (source via ${payload.source.via})`);
    if (cfg.endpoint) {
      try {
        const res = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-design-mode-token': cfg.token || '',
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          payload.delivered = true;
          persist();
          showToast(`#${payload.seq} sent to Claude`);
          return;
        }
      } catch { /* dev server gone: payload stays queued in-page */ }
    }
    if (cfg.wakeUrl) {
      // Fire-and-forget ping at a session-armed wake listener (Tier 1).
      try { fetch(`${cfg.wakeUrl}?token=${encodeURIComponent(cfg.token || '')}`, { mode: 'no-cors' }); } catch { /* not armed */ }
    }
    showToast(`#${payload.seq} queued for Claude`);
  };

  /* ------------------------------------------------------- prompt + panel --- */

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SECTION = 'color:#7E93A9;text-transform:uppercase;font-size:9.5px;letter-spacing:0.08em;margin:12px 0 3px;border-top:1px solid #1D2836;padding-top:9px';

  const isColorish = (v) => /^(#|rgb|oklch|hsl|color\()/i.test(v);
  const swatch = (v) => isColorish(v)
    ? `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;border:1px solid #2E3E50;background:${esc(v)};margin-right:4px"></span>`
    : '';

  // The panel shows the semantic layer first (token or utility name) with the
  // primitive resolved beside it; the full chain and source rule live in the
  // row's tooltip. Reset-layer rows are hidden as noise.
  const semanticName = (t) => {
    if (t.chain.length) return t.chain[0].name.replace(/^--/, '');
    if (t.status === 'utility' && t.selector) {
      return t.selector.split(',')[0].trim().replace(/^\./, '').replace(/\\/g, '').replace(/:.*$/, '');
    }
    return null;
  };

  const pretty = (v) => (v.includes('infinity') || v.includes('1.67772e+07')) ? 'full' : v;

  const vrow = (label, t) => {
    if (!t || t.status === 'reset') return '';
    const sem = semanticName(t);
    const prim = pretty(t.chain.length ? t.chain[t.chain.length - 1].value : (t.computed || t.authored));
    const dot = t.status === 'hardcoded'
      ? '<span style="flex:none;display:inline-block;width:6px;height:6px;border-radius:50%;background:#E8963C;margin-left:5px"></span>'
      : '';
    const tip = `${t.authored}${t.from ? ' · ' + t.from : ''}${t.chain.length ? ' · ' + t.chain.map((c) => c.name).join(' → ') + ' → ' + prim : ''}${t.status === 'hardcoded' ? ' · HARDCODED' : ''}`;
    // the semantic name never clips; the primitive tail ellipsizes
    const value = sem
      ? `<span style="flex:none">${esc(sem)}</span><span style="color:#7E93A9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:5px">· ${swatch(prim)}${esc(prim)}</span>`
      : `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${swatch(prim)}${esc(prim)}</span>`;
    return `<div title="${esc(tip)}" style="display:flex;justify-content:space-between;gap:10px;padding:2.5px 0;align-items:center">
      <span style="color:#7E93A9;flex:none">${esc(label)}</span>
      <span style="display:flex;align-items:center;justify-content:flex-end;min-width:0">${value}${dot}</span>
    </div>`;
  };

  const crow = (label, value) => !value ? '' :
    `<div style="display:flex;justify-content:space-between;gap:10px;padding:2.5px 0"><span style="color:#7E93A9">${esc(label)}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(value)}</span></div>`;

  const section = (title, rows) => rows.trim() ? `<div style="${SECTION}">${title}</div>${rows}` : '';

  const renderPanel = (target) => {
    const fiber = findFiber(target);
    const chain = fiber ? componentChain(fiber) : [];
    const src = resolveSource(target);
    const ruleObjs = matchedRuleObjects(target);
    const t = tokenTrace(target, ruleObjs);
    const cs = getComputedStyle(target);
    const r = target.getBoundingClientRect();
    const hardcoded = Object.values(t).filter((x) => x.status === 'hardcoded').length;
    const srcLine = src.file ? `${src.file}:${src.line}:${src.col} (${src.via})`
      : src.via === 'debugStack' ? 'React 19 stack captured (agent symbolicates)'
      : 'unresolved (agent will search the repo)';
    const disp = cs.display;
    const layout = [
      crow('display', disp),
      disp.includes('flex') ? crow('direction', cs.flexDirection) : '',
      (disp.includes('flex') || disp.includes('grid')) ? crow('align', `${cs.alignItems} / ${cs.justifyContent}`) : '',
      vrow('gap', t['gap']),
    ].join('');
    const spacing = [
      vrow('pad x', t['padding-inline']),
      vrow('pad y', t['padding-block']),
      vrow('padding', t['padding']),
      vrow('margin', t['margin']),
      vrow('margin x', t['margin-inline']),
      vrow('margin y', t['margin-block']),
    ].join('');
    const size = crow('size', `${Math.round(r.width)} × ${Math.round(r.height)}`);
    const typography = [
      vrow('size', t['font-size']),
      vrow('weight', t['font-weight']),
      vrow('leading', t['line-height']),
      vrow('tracking', t['letter-spacing']),
      t['color'] ? vrow('color', t['color']) : crow('color', cs.color),
    ].join('');
    const appearance = [
      vrow('fill', t['background-color']),
      vrow('radius', t['border-radius']),
      vrow('border', t['border-color']),
      vrow('shadow', t['box-shadow']),
    ].join('');
    panel.innerHTML = `
      <div style="font-weight:600;font-size:12px;margin-bottom:2px">${esc(chain[0] || target.tagName.toLowerCase())} <span style="color:#7E93A9;font-weight:400">&lt;${esc(target.tagName.toLowerCase())}&gt;</span></div>
      <div style="color:#8FB2FF;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(chain.join(' ← '))}">${esc(chain.slice(1).join(' ← ') || '')}</div>
      ${hardcoded ? `<div style="color:#E8963C;margin-top:4px">&#9679; ${hardcoded} hardcoded value${hardcoded > 1 ? 's' : ''}</div>` : ''}
      <div style="${SECTION}">Source</div>
      <div style="word-break:break-all">${esc(srcLine)}</div>
      <div style="color:#7E93A9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px" title="${esc([...target.classList].join(' '))}">${esc([...target.classList].join(' ') || '')}</div>
      ${section('Layout', layout)}
      ${section('Spacing', spacing)}
      ${section('Size', size)}
      ${section('Typography', typography)}
      ${section('Appearance', appearance)}
    `;
    panel.style.display = 'block';
    renderCrumbs(target);
  };

  const renderCrumbs = (target) => {
    const path = [];
    let n = target;
    while (n && n !== document.body && path.length < 12) { path.push(n); n = n.parentElement; }
    path.reverse();
    const shown = path.length > 6 ? [path[0], null, ...path.slice(-4)] : path;
    crumbs.innerHTML = '';
    let prevComp = null;
    shown.forEach((node, i) => {
      if (i) {
        const sep = el('span', 'color:#7E93A9;padding:0 2px');
        sep.textContent = '›';
        crumbs.append(sep);
      }
      if (!node) {
        const dots = el('span', 'color:#7E93A9');
        dots.textContent = '…';
        crumbs.append(dots);
        return;
      }
      const f = ownFiber(node);
      const comp = f ? componentChain(f)[0] : null;
      const label = (comp && comp !== prevComp)
        ? comp
        : node.tagName.toLowerCase() + (node.classList[0] ? '.' + node.classList[0] : '');
      if (comp) prevComp = comp;
      const b = el('button', `font:inherit;background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:4px;color:${node === target ? '#8FB2FF' : '#DEE7F0'};${node === target ? 'font-weight:600;' : ''}`);
      b.textContent = label.slice(0, 22);
      b.title = label;
      b.addEventListener('click', () => openPrompt(node));
      crumbs.append(b);
    });
    crumbs.style.display = 'flex';
  };

  const closePrompt = () => {
    state.promptOpen = false;
    state.selectedEl = null;
    card.style.display = 'none';
    panel.style.display = 'none';
    ring.style.display = 'none';
    crumbs.style.display = 'none';
  };

  const openPrompt = (target) => {
    state.selectedEl = target;
    state.promptOpen = true;
    hi.style.display = 'none';
    hiLabel.style.display = 'none';
    const r = box(target, ring, 1);
    renderPanel(target);

    const fiber = findFiber(target);
    const chain = fiber ? componentChain(fiber) : [];
    const scopeChoices = ['auto', 'instance', 'component', 'token'];
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-weight:600">${esc(chain[0] || target.tagName.toLowerCase())}</span>
        <span style="color:#7E93A9;font-size:10.5px">&lt;${esc(target.tagName.toLowerCase())}&gt; · ${Math.round(r.width)}×${Math.round(r.height)}</span>
      </div>
      <textarea data-cdm-ui rows="2" placeholder="Describe the change…" style="width:100%;box-sizing:border-box;background:#0A0F16;color:#DEE7F0;border:1px solid #2E3E50;border-radius:5px;padding:7px 9px;font:inherit;resize:vertical;outline:none"></textarea>
      <div data-cdm-ui style="display:flex;gap:5px;margin-top:7px;flex-wrap:wrap">
        ${scopeChoices.map((s, i) => `<button data-cdm-ui data-scope="${s}" style="font:inherit;font-size:10.5px;padding:3px 9px;border-radius:99px;border:1px solid ${i === 0 ? '#3E7BFA' : '#2E3E50'};background:${i === 0 ? '#16253C' : 'transparent'};color:#DEE7F0;cursor:pointer">${s}</button>`).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
        <span style="color:#7E93A9;font-size:10px">Enter to send · Esc to cancel · ⌥click parent</span>
        <button data-cdm-ui data-send style="font:inherit;font-size:11px;padding:5px 12px;border-radius:5px;border:none;background:#3E7BFA;color:#fff;cursor:pointer">Send to Claude</button>
      </div>
    `;
    // position: below the element, flipped above if it would overflow
    card.style.display = 'block';
    const cw = 340;
    const ch = card.offsetHeight || 150;
    let left = Math.min(Math.max(8, r.left), innerWidth - cw - 320);
    let top = r.bottom + 8;
    if (top + ch > innerHeight - 48) top = Math.max(8, r.top - ch - 8); // keep clear of the crumb bar
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;

    let scope = 'auto';
    card.querySelectorAll('[data-scope]').forEach((b) => {
      b.addEventListener('click', () => {
        scope = b.getAttribute('data-scope');
        card.querySelectorAll('[data-scope]').forEach((x) => {
          const on = x === b;
          x.style.borderColor = on ? '#3E7BFA' : '#2E3E50';
          x.style.background = on ? '#16253C' : 'transparent';
        });
      });
    });
    const ta = card.querySelector('textarea');
    const send = () => {
      const instruction = ta.value.trim();
      if (!instruction) { ta.focus(); return; }
      const payload = buildPayload(target, instruction, scope);
      closePrompt();
      deliver(payload);
    };
    card.querySelector('[data-send]').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      e.stopPropagation();
    });
    setTimeout(() => ta.focus(), 0);
  };

  /* ------------------------------------------------------------- events --- */

  const onMove = (e) => {
    if (!state.active || state.promptOpen) return;
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
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    let t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t || isOurs(t)) return;
    if (e.altKey) {
      const base = state.selectedEl || state.hoverEl || t;
      t = base.parentElement && base.parentElement !== document.body ? base.parentElement : base;
    }
    openPrompt(t);
  };

  const onKey = (e) => {
    if (cfg.hotkey && (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      api.toggle();
      return;
    }
    if (!state.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (state.promptOpen) closePrompt();
      else api.disable();
    }
  };

  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  for (const type of SUPPRESSED) document.addEventListener(type, onSuppressed, { capture: true });
  document.addEventListener('keydown', onKey, { capture: true });

  /* ---------------------------------------------------------------- api --- */

  const api = {
    version: '0.2.0',
    config: cfg,
    heartbeat: Date.now(),
    enable() {
      ensureMounted();
      state.active = true;
      chip.style.display = 'flex';
      showToast('Design Mode on. Click an element; Esc to exit.');
    },
    disable() {
      state.active = false;
      state.hoverEl = null;
      closePrompt();
      hi.style.display = 'none';
      hiLabel.style.display = 'none';
      chip.style.display = 'none';
      showToast('Design Mode off.');
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
    notify(text) { showToast(String(text).slice(0, 300), 6000); },
    select(target) { if (target instanceof Element) { api.enable(); openPrompt(target); } },
    simulate(selector, instruction, scope = 'auto') {
      const t = document.querySelector(selector);
      if (!t) return { error: `no element matches ${selector}` };
      const payload = buildPayload(t, instruction, scope);
      deliver(payload);
      return { seq: payload.seq, source: payload.source };
    },
  };

  setInterval(() => { api.heartbeat = Date.now(); }, 1000);
  window.__claudeDesign = api;
  console.log('[design-mode] overlay ready', cfg.endpoint ? '(plugin endpoint)' : '(session mode)');
})();
