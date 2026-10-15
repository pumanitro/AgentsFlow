window.__pfErrors = window.__pfErrors || []; (function () { var push = function (m) { try { window.__pfErrors.push(m); } catch (_) {} }; window.addEventListener('error', function (e) { if (e && e.target && e.target !== window && (e.target.src || e.target.href)) { push('failed to load ' + (e.target.src || e.target.href)); return; } push((e.message || 'error') + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0)); }, true); window.addEventListener('unhandledrejection', function (e) { var r = e && e.reason; push('unhandled rejection: ' + ((r && (r.message || r)) || '?') + ' @ ' + ((r && r.stack && String(r.stack).split('\n')[1]) || '?').trim() + ':0'); }); })();
/* shared/gallery.js — gallery chrome shared by every page (WP-01).
   The line above is the error trap: window.__pfErrors collects `${message} @ ${source}:${line}`
   for every uncaught error / unhandled rejection after this script loads (tools/shot.sh reads it).

   API (contract C6):
     PF.NAV                      the seven nav entries
     PF.renderNav(navEl)         auto for #pf-nav on DOMContentLoaded
     PF.installTooltips()        auto; any [data-tip] (HTML or SVG) gets a tooltip; tap toggles on touch
     PF.fitFrames()              auto on load/resize/DOM changes; scales each .pf-frame-wrap's .pf-frame
     PF.stepRail(el, { steps:[{label, caption, run}], reset, onStep })  -> { go(n), replay(), current() }
     PF.barChart(el, { title, unit, categories, series:[{name, color, values, unit?}], max })
     PF.theme = { set(mode|null), toggle(), get() }
     PF.embedMode                true when location.hash === '#embed'
*/
(function () {
  'use strict';
  var PF = window.PF = window.PF || {};
  var doc = document, root = doc.documentElement;
  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------------- theme (applied immediately, before first paint) ---------------- */
  var THEME_KEY = 'pf-gallery-theme';
  function sysDark() { try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) { return false; } }
  PF.theme = {
    get: function () { var t = root.getAttribute('data-theme'); return t === 'dark' || t === 'light' ? t : (sysDark() ? 'dark' : 'light'); },
    set: function (mode) {
      if (mode === 'dark' || mode === 'light') root.setAttribute('data-theme', mode); else root.removeAttribute('data-theme');
      try { if (mode === 'dark' || mode === 'light') localStorage.setItem(THEME_KEY, mode); else localStorage.removeItem(THEME_KEY); } catch (_) {}
      syncThemeButtons();
      try { doc.dispatchEvent(new CustomEvent('pf:theme', { detail: PF.theme.get() })); } catch (_) {}
    },
    toggle: function () { PF.theme.set(PF.theme.get() === 'dark' ? 'light' : 'dark'); }
  };
  try { var saved = localStorage.getItem(THEME_KEY); if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved); } catch (_) {}
  function syncThemeButtons() {
    var dark = PF.theme.get() === 'dark';
    var btns = doc.querySelectorAll('.g-theme-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].textContent = dark ? '☀' : '☾';
      btns[i].setAttribute('aria-label', dark ? 'Switch the page to light' : 'Switch the page to dark');
      btns[i].setAttribute('data-tip', dark ? 'Light page (the app mock-ups stay dark, like the real app)' : 'Dark page (the app mock-ups are always dark, like the real app)');
    }
  }

  /* ---------------- embed mode ---------------- */
  PF.embedMode = location.hash === '#embed';
  if (PF.embedMode) root.classList.add('pf-embed-root');
  function applyEmbed() {
    PF.embedMode = location.hash === '#embed';
    root.classList.toggle('pf-embed-root', PF.embedMode);
    if (doc.body) doc.body.classList.toggle('pf-embed', PF.embedMode);
    PF.fitFrames();
  }
  window.addEventListener('hashchange', applyEmbed);

  /* ---------------- nav ---------------- */
  PF.NAV = [
    { id: 'index', href: 'index.html', short: 'All six' },
    { id: '01', slug: '01-bell-drawer', short: 'Bell + drawer' },
    { id: '02', slug: '02-needs-you-dock', short: 'Needs-you pane' },
    { id: '03', slug: '03-needs-you-view', short: 'Needs-you tab + banner' },
    { id: '04', slug: '04-toast-cards', short: 'Toasts + sticky cards' },
    { id: '05', slug: '05-status-tray', short: 'Status-bar tray' },
    { id: '06', slug: '06-agent-asks-in-chat', short: 'Agent asks in chat' }
  ];
  // Where is this page relative to the gallery root? The root is the folder above shared/gallery.js.
  var scriptSrc = (doc.currentScript && doc.currentScript.src) || '';
  function pageLocation() {
    var rootUrl = scriptSrc ? scriptSrc.replace(/shared\/gallery\.js(\?.*)?$/, '') : '';
    var here = location.href.split('#')[0].split('?')[0];
    var dir = here.slice(0, here.lastIndexOf('/') + 1);
    if (rootUrl && dir === rootUrl) return 'root';
    if (rootUrl && dir === rootUrl + 'concepts/') return 'concepts';
    if (rootUrl && dir.indexOf(rootUrl) === 0) return 'sub';           // e.g. shared/
    return /\/concepts\/$/.test(dir) ? 'concepts' : 'root';
  }
  function navHref(item, where) {
    if (item.id === 'index') return where === 'root' ? 'index.html' : '../index.html';
    var file = item.slug + '.html';
    if (where === 'root') return 'concepts/' + file;
    if (where === 'concepts') return './' + file;
    return '../concepts/' + file;
  }
  PF.renderNav = function (navEl) {
    if (!navEl) return;
    var current = navEl.getAttribute('data-current') || '';
    var where = pageLocation();
    navEl.setAttribute('aria-label', 'Notification designs');
    navEl.innerHTML = '';
    var bar = doc.createElement('div'); bar.className = 'g-nav';
    var brand = doc.createElement('a'); brand.className = 'g-nav-brand';
    brand.href = navHref(PF.NAV[0], where);
    brand.innerHTML = '<span class="g-nav-brand-mark" aria-hidden="true"></span><span>Peers Flow · notifications</span>';
    var ul = doc.createElement('ul'); ul.className = 'g-nav-links';
    PF.NAV.forEach(function (item) {
      var li = doc.createElement('li');
      var a = doc.createElement('a'); a.className = 'g-nav-link'; a.href = navHref(item, where);
      if (item.id !== 'index') { var n = doc.createElement('span'); n.className = 'g-nav-num'; n.textContent = item.id; a.appendChild(n); }
      a.appendChild(doc.createTextNode(item.short));
      if (item.id === current) a.setAttribute('aria-current', 'page');
      li.appendChild(a); ul.appendChild(li);
    });
    var btn = doc.createElement('button'); btn.type = 'button'; btn.className = 'g-theme-btn';
    btn.addEventListener('click', function () { PF.theme.toggle(); });
    bar.appendChild(brand); bar.appendChild(ul); bar.appendChild(btn);
    navEl.appendChild(bar);
    syncThemeButtons();
    var cur = ul.querySelector('[aria-current="page"]');
    if (cur && ul.scrollWidth > ul.clientWidth) ul.scrollLeft = Math.max(0, cur.offsetLeft - 16);
  };

  /* ---------------- tooltips ---------------- */
  var tip = null, tipFor = null, tipsInstalled = false;
  function ensureTip() {
    if (tip && tip.isConnected) return tip;
    tip = doc.getElementById('pf-tip');
    if (!tip) { tip = doc.createElement('div'); tip.id = 'pf-tip'; tip.setAttribute('role', 'tooltip'); doc.body.appendChild(tip); }
    return tip;
  }
  function tipTarget(node) {
    while (node && node !== doc) { if (node.getAttribute && node.hasAttribute('data-tip') && node.getAttribute('data-tip')) return node; node = node.parentNode; }
    return null;
  }
  function placeTip(x, y) {
    var t = ensureTip(), M = 8, vw = root.clientWidth || window.innerWidth, vh = window.innerHeight;
    var w = t.offsetWidth, h = t.offsetHeight;
    var left = x + 12, top = y + 14;
    if (left + w > vw - M) left = x - w - 12;
    if (top + h > vh - M) top = y - h - 12;
    left = Math.max(M, Math.min(left, vw - w - M));
    top = Math.max(M, Math.min(top, vh - h - M));
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  function showTip(el, x, y) {
    var t = ensureTip();
    if (tipFor && tipFor !== el && tipFor.classList) tipFor.classList.remove('is-tip');
    tipFor = el; if (el.classList) el.classList.add('is-tip');
    t.textContent = el.getAttribute('data-tip');
    t.classList.add('is-on');
    if (x == null) { var r = el.getBoundingClientRect(); x = r.left + r.width / 2; y = r.bottom; }
    placeTip(x, y);
  }
  function hideTip() {
    if (tipFor && tipFor.classList) tipFor.classList.remove('is-tip');
    tipFor = null; if (tip) tip.classList.remove('is-on');
  }
  PF.installTooltips = function () {
    if (tipsInstalled) return; tipsInstalled = true;
    var touchLike = false;
    try { touchLike = window.matchMedia('(hover: none)').matches; } catch (_) {}
    doc.addEventListener('mouseover', function (e) { if (touchLike) return; var el = tipTarget(e.target); if (el) showTip(el, e.clientX, e.clientY); else if (tipFor) hideTip(); });
    doc.addEventListener('mousemove', function (e) { if (touchLike || !tipFor) return; var el = tipTarget(e.target); if (el === tipFor) placeTip(e.clientX, e.clientY); else if (el) showTip(el, e.clientX, e.clientY); else hideTip(); });
    doc.addEventListener('mouseleave', hideTip);
    // Touch: a tap toggles the tooltip of what was tapped; tapping elsewhere closes it.
    doc.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && !touchLike) return;
      var el = tipTarget(e.target);
      if (!el) { hideTip(); return; }
      if (el === tipFor) hideTip(); else showTip(el, e.clientX, e.clientY);
    }, { passive: true });
    if (touchLike) doc.addEventListener('click', function (e) { if (!tipTarget(e.target) && tipFor) hideTip(); });
    doc.addEventListener('focusin', function (e) { var el = tipTarget(e.target); if (el && e.target.matches && e.target.matches(':focus-visible')) showTip(el); });
    doc.addEventListener('focusout', function () { if (tipFor) hideTip(); });
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideTip(); });
    window.addEventListener('scroll', function () { if (touchLike) hideTip(); }, { passive: true });
  };

  /* ---------------- frame scaling ---------------- */
  var fitQueued = false;
  PF.fitFrames = function () {
    var wraps = doc.querySelectorAll('.pf-frame-wrap');
    for (var i = 0; i < wraps.length; i++) {
      var wrap = wraps[i];
      var frame = wrap.querySelector('.pf-frame');
      if (!frame) continue;
      var fw = frame.offsetWidth || parseFloat(getComputedStyle(root).getPropertyValue('--pf-frame-w')) || 1280;
      var fh = frame.offsetHeight || parseFloat(getComputedStyle(root).getPropertyValue('--pf-frame-h')) || 800;
      var ww = wrap.clientWidth; if (!ww) continue;
      var s = ww / fw;
      wrap.style.aspectRatio = fw + ' / ' + fh;
      wrap.style.height = Math.round(fh * s) + 'px';
      frame.style.transformOrigin = 'top left';
      frame.style.transform = 'scale(' + s + ')';
      wrap.setAttribute('data-scale', s.toFixed(3));
    }
  };
  function queueFit() { if (fitQueued) return; fitQueued = true; requestAnimationFrame(function () { fitQueued = false; PF.fitFrames(); }); }
  window.addEventListener('resize', queueFit);
  window.addEventListener('load', PF.fitFrames);

  /* ---------------- step rail ---------------- */
  function safeRun(fn, label) {
    try { if (typeof fn === 'function') fn(); }
    catch (err) { window.__pfErrors.push((err && err.message || err) + ' @ stepRail:' + label); if (window.console) console.error(err); }
  }
  PF.stepRail = function (el, opts) {
    opts = opts || {};
    var steps = opts.steps || [], cur = 0, timers = [];
    el.classList.add('g-step-rail');
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Walk through the steps');
    el.innerHTML = '';
    var btns = steps.map(function (st, i) {
      var b = doc.createElement('button'); b.type = 'button'; b.className = 'g-step';
      b.setAttribute('aria-pressed', 'false');
      if (st.caption) b.setAttribute('title', st.caption);
      b.innerHTML = '<span class="g-step-num" aria-hidden="true"></span><span class="g-step-label"></span>';
      b.firstChild.textContent = String(i + 1); b.lastChild.textContent = st.label;
      b.addEventListener('click', function () { stopReplay(); api.go(i + 1); });
      el.appendChild(b); return b;
    });
    var rb = doc.createElement('button'); rb.type = 'button'; rb.className = 'g-step g-step--replay';
    rb.textContent = '↺ Replay'; rb.setAttribute('title', 'Play all the steps again from the start');
    rb.addEventListener('click', function () { api.replay(); });
    el.appendChild(rb);
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault(); stopReplay();
      var n = e.key === 'ArrowRight' ? Math.min(steps.length, cur + 1) : e.key === 'ArrowLeft' ? Math.max(1, cur - 1) : e.key === 'Home' ? 1 : steps.length;
      api.go(n); if (btns[n - 1]) btns[n - 1].focus();
    });
    function mark(n) {
      cur = n;
      btns.forEach(function (b, i) { b.setAttribute('aria-pressed', i === n - 1 ? 'true' : 'false'); b.classList.toggle('is-done', i < n - 1); });
      if (typeof opts.onStep === 'function') safeRun(function () { opts.onStep(n, steps[n - 1] || null); }, 'onStep');
      queueFit();
    }
    function stopReplay() { timers.forEach(clearTimeout); timers = []; rb.removeAttribute('aria-busy'); }
    var api = {
      go: function (n) {
        n = Math.max(0, Math.min(steps.length, n | 0));
        safeRun(opts.reset, 'reset');
        for (var i = 0; i < n; i++) safeRun(steps[i].run, steps[i].label);
        mark(n);
      },
      replay: function (delay) {
        stopReplay(); delay = delay || 2200;
        safeRun(opts.reset, 'reset'); mark(0);
        rb.setAttribute('aria-busy', 'true');
        steps.forEach(function (st, i) {
          timers.push(setTimeout(function () { safeRun(st.run, st.label); mark(i + 1); if (i === steps.length - 1) rb.removeAttribute('aria-busy'); }, 400 + i * delay));
        });
      },
      current: function () { return cur; },
      stop: stopReplay,
      buttons: btns
    };
    return api;
  };

  /* ---------------- bar chart ---------------- */
  var DEFAULT_COLORS = ['#ff7847', '#3b82f6', '#14b8a6', '#a78bfa', '#fbbf24'];
  function svg(tag, attrs, parent) {
    var n = doc.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n); return n;
  }
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function fmt(v) { return v == null || isNaN(v) ? 'n/a' : (Math.round(v * 100) / 100).toLocaleString('en-US'); }
  PF.barChart = function (el, o) {
    o = o || {};
    var cats = o.categories || [], series = o.series || [];
    el.classList.add('g-chart');
    el.innerHTML = '';
    if (o.title) { var h = doc.createElement('p'); h.className = 'g-chart-title'; h.textContent = o.title; el.appendChild(h); }
    var leg = doc.createElement('ul'); leg.className = 'g-chart-legend';
    series.forEach(function (s, i) {
      var li = doc.createElement('li'), sw = doc.createElement('span');
      sw.className = 'g-chart-swatch'; sw.style.background = s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
      li.appendChild(sw); li.appendChild(doc.createTextNode(s.name)); leg.appendChild(li);
    });
    el.appendChild(leg);
    var host = doc.createElement('div'); el.appendChild(host);
    function unitOf(s) { return s.unit != null ? s.unit : (o.unit || ''); }
    function tipText(ci, s) { var v = s.values[ci]; return (cats[ci] + ' · ' + s.name + ': ' + fmt(v) + (unitOf(s) ? ' ' + unitOf(s) : '')).trim(); }
    var lastW = 0;
    function draw() {
      var W = Math.round(host.clientWidth || el.clientWidth || 640);
      if (W === lastW && host.firstChild) return; lastW = W;
      var narrow = W < 480, fs = narrow ? 11 : 12;
      var maxLabel = cats.reduce(function (m, c) { return Math.max(m, String(c).length); }, 0);
      var labelW = Math.min(Math.round(W * (narrow ? 0.38 : 0.3)), Math.max(48, maxLabel * fs * 0.58 + 10));
      var valueW = 44, plotW = Math.max(40, W - labelW - valueW);
      var barH = narrow ? 12 : 14, gap = 3, groupPad = narrow ? 12 : 14;
      var groupH = series.length * barH + (series.length - 1) * gap;
      var top = 4, axisH = 22, H = top + cats.length * (groupH + groupPad) + axisH;
      var all = []; series.forEach(function (s) { (s.values || []).forEach(function (v) { if (typeof v === 'number' && isFinite(v)) all.push(v); }); });
      var max = o.max != null ? o.max : niceMax(Math.max.apply(null, all.concat([0])));
      if (!(max > 0)) max = 1;
      host.innerHTML = '';
      var s0 = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': (o.title || 'Bar chart') + '. Hover or tap a bar for the exact number.' }, host);
      s0.style.width = '100%'; s0.style.height = 'auto';
      var x = function (v) { return labelW + Math.max(0, Math.min(1, v / max)) * plotW; };
      // grid + axis
      var grid = svg('g', { 'class': 'g-grid' }, s0), axis = svg('g', { 'class': 'g-axis' }, s0);
      var ticks = 5, yAxis = H - axisH;
      [1, 100].some(function (q) { return [5, 4, 2, 1].some(function (t) { var step = max / t * q; if (Math.abs(step - Math.round(step)) < 1e-6 && plotW / t >= 34) { ticks = t; return true; } return false; }); });
      for (var t = 0; t <= ticks; t++) {
        var tv = max * t / ticks, tx = x(tv);
        svg('line', { x1: tx, x2: tx, y1: top - 2, y2: yAxis, 'stroke-dasharray': t ? '2 3' : null }, grid);
        var tl = svg('text', { x: tx, y: yAxis + 15, 'text-anchor': t === 0 ? 'start' : t === ticks ? 'end' : 'middle' }, axis);
        tl.textContent = fmt(tv) + (t === ticks && o.unit ? ' ' + o.unit : '');
      }
      cats.forEach(function (c, ci) {
        var gy = top + ci * (groupH + groupPad);
        var all = series.map(function (s) { return tipText(ci, s); }).join('\n');
        svg('rect', { 'class': 'g-band', x: 0, y: gy - groupPad / 2 + 2, width: W, height: groupH + groupPad - 4, rx: 4, 'data-tip': all }, s0);
        var lab = svg('text', { x: labelW - 8, y: gy + groupH / 2 + fs * 0.35, 'text-anchor': 'end', 'font-size': fs, 'data-tip': all }, s0);
        var txt = String(c), maxChars = Math.floor((labelW - 10) / (fs * 0.56));
        lab.textContent = txt.length > maxChars ? txt.slice(0, Math.max(3, maxChars - 1)) + '…' : txt;
        series.forEach(function (s, si) {
          var v = s.values[ci], by = gy + si * (barH + gap), color = s.color || DEFAULT_COLORS[si % DEFAULT_COLORS.length];
          var tipS = tipText(ci, s);
          var w = typeof v === 'number' && isFinite(v) ? Math.max(v > 0 ? 2 : 0, x(v) - labelW) : 0;
          var r = svg('rect', { 'class': 'g-bar', x: labelW, y: by, width: w, height: barH, rx: 3, 'data-tip': tipS }, s0);
          r.style.fill = color;
          var vt = svg('text', { x: labelW + w + 5, y: by + barH / 2 + 4, 'font-size': 11, 'font-weight': 600, 'data-tip': tipS }, s0);
          vt.textContent = fmt(v);
        });
      });
    }
    draw();
    if (window.ResizeObserver) new ResizeObserver(function () { draw(); }).observe(host);
    else window.addEventListener('resize', draw);
    return { redraw: function () { lastW = 0; draw(); } };
  };

  /* ---------------- boot ---------------- */
  function boot() {
    if (doc.body) doc.body.classList.toggle('pf-embed', PF.embedMode);
    var nav = doc.getElementById('pf-nav'); if (nav) PF.renderNav(nav);
    PF.installTooltips();
    PF.fitFrames();
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(queueFit);
      var watch = function () { var w = doc.querySelectorAll('.pf-frame-wrap'); for (var i = 0; i < w.length; i++) if (!w[i].__pfObserved) { w[i].__pfObserved = true; ro.observe(w[i]); } };
      watch();
      new MutationObserver(function () { watch(); queueFit(); }).observe(doc.body, { childList: true, subtree: true });
    }
    try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButtons); } catch (_) {}
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})();
