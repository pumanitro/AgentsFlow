// shared/app-shell.js — the three real Peers Flow screens (home, routines, session) as plain DOM,
// plus a small kit of the app's own widgets. Loads after scenario.js. Dependency-free; every
// renderAppShell() call builds a fresh, independent frame, so a page may call it many times.
(function () {
  'use strict';
  var PF = window.PF = window.PF || {};

  /* ───────────── tiny DOM ───────────── */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SVG_TAGS = { svg: 1, path: 1, circle: 1, rect: 1, g: 1, line: 1, polyline: 1, polygon: 1, text: 1, ellipse: 1 };

  PF.el = function (tag, attrs, children) {
    attrs = attrs || {};
    var isSvg = !!SVG_TAGS[tag];
    var node = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') { node.setAttribute('class', v); }
      else if (k === 'text') { node.textContent = v; }
      else if (k === 'html') { node.innerHTML = v; }          // static markup only, never user data
      else if (k === 'style') { node.setAttribute('style', v); }
      else if (k === 'dataset') { Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; }); }
      else if (k === 'on') { Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); }); }
      else if (v === true) { node.setAttribute(k, ''); }
      else { node.setAttribute(k, String(v)); }
    });
    append(node, children);
    return node;
  };
  function append(node, children) {
    if (children === undefined || children === null || children === false) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c === undefined || c === null || c === false) return;
      if (Array.isArray(c)) { append(node, c); return; }
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  var el = PF.el;

  /* ───────────── icons ───────────── */
  var ICONS = {
    bell: 'M6 17v-6a6 6 0 0112 0v6l2 2H4z M10 21h4',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    file: 'M6 3h8l5 5v13H6z M14 3v5h5',
    mail: 'M3 6h18v12H3z M3 7l9 6 9-6',
    x: 'M6 6l12 12 M18 6L6 18',
    'chevron-right': 'M9 5l7 7-7 7',
    'chevron-down': 'M5 9l7 7 7-7',
    warning: 'M12 3l10 18H2z M12 10v5 M12 18h.01',
    info: 'M12 3a9 9 0 100 18 9 9 0 000-18z M12 11v6 M12 7.5h.01',
    dot: 'M12 8a4 4 0 100 8 4 4 0 000-8z',
    external: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
    send: 'M4 12l16-8-6 16-2.5-6.5z M11.5 13.5L20 4',
    clock: 'M12 3a9 9 0 100 18 9 9 0 000-18z M12 7v5l3 2',
    question: 'M12 3a9 9 0 100 18 9 9 0 000-18z M9.5 9.5a2.5 2.5 0 015 0c0 1.7-2.5 2-2.5 4 M12 17h.01',
    folder: 'M3 6h6l2 2h10v11H3z',
    pencil: 'M15 4l5 5L9 20H4v-5z'
  };
  // routine glyphs (components/routines/glyphs.tsx, verbatim for the four in the scenario)
  var GLYPHS = {
    reddit: 'M12 8c-4.4 0-8 2.2-8 5.5S7.6 19 12 19s8-2.2 8-5.5S16.4 8 12 8z M12 8l1.2-4 4 1 M8.5 13h.01 M15.5 13h.01 M9.5 16.2c1.5 1 3.5 1 5 0',
    mail: 'M3 6h18v12H3z M3 7l9 6 9-6',
    bug: 'M9 8a3 3 0 016 0v1H9z M7 9h10v6a5 5 0 01-10 0z M12 9v11 M4 12h3 M17 12h3 M5 19l2-2 M19 19l-2-2 M9 5L7.5 3 M15 5l1.5-2',
    coin: 'M12 3a9 9 0 100 18 9 9 0 000-18z M14.5 9.2C14 8.4 13.1 8 12 8c-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1.1 0-2-.4-2.5-1.2 M12 6.5V8 M12 16v1.5',
    bell: ICONS.bell, clock: ICONS.clock
  };
  function strokeSvg(d, size, cls) {
    return el('svg', { class: cls || null, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, [el('path', { d: d })]);
  }
  PF.icon = function (name, size) {
    size = size || 14;
    if (name === 'dot') return el('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [el('circle', { cx: 12, cy: 12, r: 5, fill: 'currentColor' })]);
    return strokeSvg(ICONS[name] || ICONS.info, size);
  };
  function glyph(name, size) { return strokeSvg(GLYPHS[name] || GLYPHS.clock, size || 16, 'pf-glyph'); }
  function gripSvg() {
    return el('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
      [[4, 4], [4, 8], [4, 12], [9, 4], [9, 8], [9, 12]].map(function (p) { return el('circle', { cx: p[0], cy: p[1], r: 1.4 }); }));
  }
  function pencilSvg() {
    return el('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' }, [el('path', { d: 'M11.207 2.5l2.293 2.293-8.5 8.5-2.293-.707-.707-2.293 8.5-8.5zm.707-.707l1-1a1 1 0 011.414 0l1.293 1.293a1 1 0 010 1.414l-1 1L11.914 1.793zM2 14h12v1H2v-1z' })]);
  }
  function doneSvg() {
    return el('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' }, [el('path', { d: 'M6.5 11.207L3.146 7.854l.708-.708L6.5 9.793l5.646-5.647.708.708L6.5 11.207z' })]);
  }
  function logoSvg() {   // renderer/pages/index.tsx:865-873
    return el('svg', { class: 'pf-logo', viewBox: '0 0 1024 1024', width: 20, height: 20, 'aria-hidden': 'true' }, [
      el('rect', { x: 0, y: 0, width: 1024, height: 1024, rx: 232, ry: 232, fill: '#181b25' }),
      el('circle', { cx: 282, cy: 372, r: 34, fill: '#ff7847' }),
      el('circle', { cx: 282, cy: 512, r: 34, fill: '#ff7847', 'fill-opacity': '0.78' }),
      el('circle', { cx: 282, cy: 652, r: 34, fill: '#ff7847', 'fill-opacity': '0.52' }),
      el('rect', { x: 350, y: 340, width: 394, height: 64, rx: 32, ry: 32, fill: '#ff7847' }),
      el('rect', { x: 350, y: 480, width: 310, height: 64, rx: 32, ry: 32, fill: '#ff7847', 'fill-opacity': '0.78' }),
      el('rect', { x: 350, y: 620, width: 226, height: 64, rx: 32, ry: 32, fill: '#ff7847', 'fill-opacity': '0.52' })
    ]);
  }
  function cadenceIcon(cadence) {   // components/routines/marks.tsx CadenceIcon (sun for daily, calendar otherwise)
    var common = { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 1, 'stroke-linecap': 'round', 'aria-hidden': 'true' };
    if (cadence === 'daily') return el('svg', common, [el('circle', { cx: 6, cy: 6, r: 1.9, fill: 'currentColor', stroke: 'none' }), el('path', { d: 'M6 .8v1.6 M6 9.6v1.6 M.8 6h1.6 M9.6 6h1.6 M2.3 2.3l1.1 1.1 M8.6 8.6l1.1 1.1 M9.7 2.3L8.6 3.4 M3.4 8.6L2.3 9.7' })]);
    return el('svg', common, [el('rect', { x: 1.5, y: 2.5, width: 9, height: 8, rx: 1 }), el('path', { d: 'M1.5 5h9 M4 1.2v2.2 M8 1.2v2.2' })]);
  }

  /* ───────────── time (wall-clock of the ISO string, timezone-independent) ───────────── */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function parts(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || ''); return m ? { y: +m[1], mo: +m[2], d: +m[3], h: m[4], mi: m[5] } : null; }
  PF.formatTime = function (iso) { var p = parts(iso); return p ? p.h + ':' + p.mi : ''; };
  PF.formatDay = function (iso) { var p = parts(iso); return p ? p.d + ' ' + MONTHS[p.mo - 1] : ''; };
  function dayKey(y, mo, d) { return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  function utcDate(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d)); }
  function keyOf(dt) { return dayKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()); }
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function cadenceLabel(r) {
    if (r.cadence === 'monthly' || r.cadence === 'twiceMonthly') return r.time + ' (' + (r.monthDays || []).map(ordinal).join(' and ') + ')';
    return r.time;
  }

  /* ───────────── kit widgets ───────────── */
  PF.button = function (label, opts) {
    opts = opts || {};
    var cls = 'pf-btn' + (opts.variant && opts.variant !== 'default' ? ' pf-btn--' + opts.variant : '') + (opts.small ? ' pf-btn--small' : '');
    return el('button', { type: 'button', class: cls, disabled: !!opts.disabled, title: opts.title || null, on: opts.on && typeof opts.on === 'function' ? { click: opts.on } : (opts.on || null) }, label);
  };
  PF.badge = function (text, variant) { return el('span', { class: 'pf-badge pf-badge--' + (variant || 'muted') }, text); };
  PF.dot = function (status, pulse) { return el('span', { class: 'pf-dot pf-dot--' + (status || 'muted') + (pulse ? ' pf-dot--pulse' : ''), 'aria-hidden': 'true' }); };

  PF.pane = function (o) {
    o = o || {};
    var open = o.open !== false;
    var caret = el('span', { class: 'pf-pane-caret' }, open ? '▼' : '▶');
    var body = el('div', { class: 'pf-pane-body' }, o.body || null);
    var header = el('div', { class: 'pf-pane-header', role: 'button', 'aria-expanded': String(open) }, [
      el('span', { class: 'pf-tick', style: 'background:' + (o.tick || 'var(--pf-accent)'), 'aria-hidden': 'true' }),
      caret,
      el('span', { class: 'pf-pane-title' }, o.title || ''),
      o.sub ? el('span', { class: 'pf-pane-sub' }, o.sub) : null,
      o.badge !== undefined && o.badge !== null && o.badge !== '' ? el('span', { class: 'pf-pane-badge', style: o.badgeColor ? 'color:' + o.badgeColor : null }, String(o.badge)) : null
    ]);
    var pane = el('div', { class: 'pf-pane' + (open ? '' : ' pf-pane--closed') }, [header, body]);
    header.addEventListener('click', function () {
      open = !open;
      pane.classList.toggle('pf-pane--closed', !open);
      caret.textContent = open ? '▼' : '▶';
      header.setAttribute('aria-expanded', String(open));
    });
    pane.header = header; pane.body = body;
    return pane;
  };

  PF.toast = function (frame, text, opts) {
    opts = opts || {};
    var level = opts.level || 'info';
    var ms = opts.ms === undefined ? 6000 : opts.ms;
    var host = (frame && frame.__pfOverlay) || frame || document.body;
    var prev = host.querySelector(':scope > .pf-toast-line');
    if (prev) prev.remove();
    var glyphName = level === 'ok' ? 'check' : level === 'warn' || level === 'err' ? 'warning' : 'info';
    var colour = { info: 'var(--pf-info)', ok: 'var(--pf-ok)', warn: 'var(--pf-warn)', err: 'var(--pf-err)', attention: 'var(--pf-attention)' }[level] || 'var(--pf-info)';
    var t = el('div', { class: 'pf-toast-line pf-toast-line--' + level, role: 'status' }, [el('span', { style: 'color:' + colour + ';display:flex' }, PF.icon(glyphName, 13)), el('span', {}, text)]);
    host.appendChild(t);
    if (ms > 0) {
      setTimeout(function () { t.classList.add('pf-toast-line--out'); }, ms);
      setTimeout(function () { t.remove(); }, ms + 320);
    }
    return t;
  };

  function basename(p) { return String(p || '').split('/').pop(); }
  PF.fileChip = function (file) {
    var label = file.label || basename(file.path);
    var chip = el('div', { class: 'pf-file-chip', title: file.path }, [
      el('span', { class: 'pf-fc-icon' }, '📄'),
      el('span', { class: 'pf-fc-label' }, label),
      el('span', { class: 'pf-fc-name' }, basename(file.path))
    ]);
    var btn = PF.button('Open ›', { small: true, title: 'Open ' + file.path });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      chip.classList.add('pf-file-chip--opened');
      PF.toast(chip.closest('.pf-frame'), 'Opened ' + label + ' in Preview', { level: 'ok' });
      chip.dispatchEvent(new CustomEvent('pf-open', { bubbles: true, detail: file }));
    });
    chip.appendChild(btn);
    chip.openButton = btn;
    return chip;
  };

  var qSeq = 0;
  PF.question = function (q, opts) {
    opts = opts || {};
    var value;
    var wrap = el('div', { class: 'pf-question', dataset: { qid: q.id } });
    var idx = (q.id || '').replace(/^q/, '');
    var mark = el('span', { class: 'pf-q-mark', title: 'Answered' }, PF.icon('check', 13));
    wrap.appendChild(el('div', { class: 'pf-q-text' }, [idx ? el('span', { class: 'pf-q-num' }, idx + '.') : null, el('span', {}, q.text), mark]));
    if (q.hint) wrap.appendChild(el('div', { class: 'pf-q-hint' }, q.hint));
    var controls = el('div', { class: 'pf-q-controls' });
    wrap.appendChild(controls);
    var render;
    function set(v, silent) {
      value = v;
      render(v);
      wrap.classList.toggle('pf-question--answered', answered());
      if (!silent && opts.onAnswer) opts.onAnswer(v, q);
    }
    function answered() { return value !== undefined && value !== null && String(value).trim() !== ''; }
    if (q.kind === 'yesno' || q.kind === 'choice') {
      var choices = q.kind === 'yesno' ? ['Yes', 'No'] : (q.choices || []);
      if (q.kind === 'yesno') {
        var btns = choices.map(function (c) {
          var b = PF.button(c, { small: true });
          b.setAttribute('aria-pressed', 'false');
          b.addEventListener('click', function (e) { e.stopPropagation(); set(c); });
          controls.appendChild(b);
          return b;
        });
        render = function (v) { btns.forEach(function (b, i) { var on = choices[i] === v; b.classList.toggle('pf-btn--on', on); b.setAttribute('aria-pressed', String(on)); }); };
      } else {
        var name = 'pfq-' + (q.id || 'q') + '-' + (++qSeq);
        var radios = choices.map(function (c) {
          var r = el('input', { type: 'radio', name: name, value: c });
          r.addEventListener('change', function () { if (r.checked) set(c); });
          controls.appendChild(el('label', { class: 'pf-q-choice', on: { click: function (e) { e.stopPropagation(); } } }, [r, c]));
          return r;
        });
        render = function (v) { radios.forEach(function (r) { r.checked = r.value === v; }); };
      }
    } else {
      var input = el('input', { class: 'pf-input', type: 'text', placeholder: 'Type your answer…', 'aria-label': q.text });
      input.addEventListener('input', function () { set(input.value); });
      input.addEventListener('click', function (e) { e.stopPropagation(); });
      controls.appendChild(input);
      render = function (v) { if (input.value !== v) input.value = v || ''; };
    }
    return { el: wrap, setAnswer: function (v) { set(v); }, answered: answered, value: function () { return value; }, question: q };
  };

  PF.todo = function (t, opts) {
    opts = opts || {};
    var box = el('input', { type: 'checkbox', class: 'pf-checkbox' });
    box.checked = !!t.done;
    var row = el('label', { class: 'pf-todo' + (t.done ? ' pf-todo--done' : '') }, [box, el('span', { class: 'pf-todo-text' }, t.text)]);
    row.addEventListener('click', function (e) { e.stopPropagation(); });
    box.addEventListener('change', function () {
      row.classList.toggle('pf-todo--done', box.checked);
      if (opts.onToggle) opts.onToggle(box.checked, t);
    });
    return { el: row, set: function (v) { if (box.checked !== !!v) { box.checked = !!v; box.dispatchEvent(new Event('change')); } }, done: function () { return box.checked; } };
  };

  // The whole "file · questions · to-do" block. Emits 'pf-change' on the root whenever anything changes.
  PF.checklist = function (n, opts) {
    opts = opts || {};
    var root = el('div', { class: 'pf-checklist' });
    var sentAt = null;
    function changed() {
      sendBtn.disabled = !questionsDone() || !!sentAt;
      sendBtn.title = sentAt ? 'Already sent' : questionsDone() ? 'Post the answers into the chat' : 'Answer every question first';
      counter.textContent = qs.filter(function (q) { return q.answered(); }).length + ' of ' + qs.length + ' answered';
      root.dispatchEvent(new CustomEvent('pf-change', { bubbles: true, detail: api }));
      if (opts.onChange) opts.onChange(api);
    }
    (n.files || []).forEach(function (f) { root.appendChild(PF.fileChip(f)); });
    var counter = el('span', {});
    var qs = (n.questions || []).map(function (q) { return PF.question(q, { onAnswer: changed }); });
    if (qs.length) {
      root.appendChild(el('div', { class: 'pf-checklist-label' }, [el('span', {}, 'Questions from the agent'), counter]));
      root.appendChild(el('div', {}, qs.map(function (q) { return q.el; })));
    }
    var todos = (n.todos || []).map(function (t) { return PF.todo(t, { onToggle: changed }); });
    if (todos.length) {
      root.appendChild(el('div', { class: 'pf-checklist-label' }, [el('span', {}, 'Yours to do by hand')]));
      todos.forEach(function (t) { root.appendChild(t.el); });
    }
    var sentNote = el('span', { class: 'pf-checklist-sent' });
    var sendBtn = PF.button('Send answers to the agent', { variant: 'primary', small: true });
    var fill = el('button', { type: 'button', class: 'pf-link-btn', on: { click: function (e) { e.stopPropagation(); api.fillSample(); } } }, 'Fill sample answers');
    sendBtn.addEventListener('click', function (e) { e.stopPropagation(); api.send(); });
    root.appendChild(el('div', { class: 'pf-checklist-actions' }, [sendBtn, fill, sentNote]));
    function questionsDone() { return qs.every(function (q) { return q.answered(); }); }
    var conv = ((window.PF_SCENARIO || {}).conversations || []).filter(function (c) { return c.id === (n.source || {}).conversationId; })[0];
    var api = {
      el: root, questions: qs, todos: todos, sendButton: sendBtn,
      questionsDone: questionsDone,
      todosDone: function () { return todos.every(function (t) { return t.done(); }); },
      sent: function () { return !!sentAt; },
      complete: function () { return questionsDone() && api.todosDone(); },
      missing: function () {
        var out = [];
        var left = qs.filter(function (q) { return !q.answered(); }).length;
        if (left) out.push(left + (left === 1 ? ' question' : ' questions') + ' unanswered');
        var td = todos.filter(function (t) { return !t.done(); }).length;
        if (td) out.push(td + ' to-do not ticked');
        return out;
      },
      summary: function () {
        var a = qs.map(function (q, i) { return (i + 1) + ') ' + (q.answered() ? q.value() : '—'); }).join('; ');
        return 'Answers to your questions: ' + a + (todos.length ? '; to-do ' + (api.todosDone() ? 'done' : 'not done') : '');
      },
      fillSample: function () { qs.forEach(function (q) { if (q.question.sampleAnswer !== undefined) q.setAnswer(q.question.sampleAnswer); }); },
      send: function () {
        if (!questionsDone() || sentAt) return false;
        sentAt = new Date().toISOString();
        sentNote.textContent = '✓ Sent to the chat ‘' + (conv ? conv.title : 'the chat') + '’';
        changed();
        return true;
      }
    };
    changed();
    return api;
  };

  /* ───────────── the shell ───────────── */
  function peerById(s, id) { return (s.peers || []).filter(function (p) { return p.id === id; })[0] || { name: id, path: '' }; }
  function routineById(s, id) { return (s.routines || []).filter(function (r) { return r.id === id; })[0]; }
  var STATE_DOT = { working: ['info', true], 'needs-input': ['warn', true], done: ['ok', false], failed: ['err', false] };

  function cssVarPx(name, fallback) {
    try { var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)); return isFinite(v) && v > 0 ? v : fallback; } catch (e) { return fallback; }
  }

  PF.renderAppShell = function (host, o) {
    o = o || {};
    var s = o.scenario || window.PF_SCENARIO;
    var view = o.view || 'home';
    var W = o.width || cssVarPx('--pf-frame-w', 1280);
    var H = o.height || cssVarPx('--pf-frame-h', 800);
    var selectedPeerId = o.selectedPeerId || s.selectedPeerId;
    if (host && host.__pfShell) host.__pfShell.destroy();

    var h = {
      frame: null, header: null, headerLeft: null, headerRight: null, pill: null, banner: null,
      sidebar: null, sidebarTop: null, dock: null, main: null, toolbar: null, chat: null,
      overlay: null, statusBar: null, composer: null,
      pinnedRows: new Map(), routineRows: new Map(), routineCards: new Map()
    };
    var frame = h.frame = el('div', { class: 'pf-frame pf-frame--' + view, style: 'width:' + W + 'px;height:' + H + 'px', dataset: { view: view } });

    /* header */
    frame.appendChild(el('div', { class: 'pf-traffic', 'aria-hidden': 'true' }, [el('i', { style: 'background:#ff5f57' }), el('i', { style: 'background:#febc2e' }), el('i', { style: 'background:#28c840' })]));
    if (view === 'session') {
      var conv = (s.conversations || []).filter(function (c) { return c.id === (o.conversationId || 'c-timesheet'); })[0] || {};
      var peer = peerById(s, conv.peerId);
      var cd = STATE_DOT[conv.state] || ['muted', false];
      h.headerLeft = el('div', { class: 'pf-header-left pf-session-title', style: 'padding-left:0' }, [
        el('button', { type: 'button', class: 'pf-back-btn', title: 'Back to home' }, '← Back'),
        PF.dot(cd[0], cd[1]),
        el('b', {}, peer.name),
        el('span', { class: 'pf-muted', style: 'font-size:12px' }, '·'),
        el('span', { class: 't' }, conv.title || '')
      ]);
      h.headerLeft.style.marginLeft = '96px';
      var filePill = el('div', { class: 'pf-pill', role: 'tablist' }, [
        el('button', { type: 'button', class: 'pf-pill-btn pf-pill-btn--on', role: 'tab', 'aria-selected': 'true' }, 'Chat'),
        el('button', { type: 'button', class: 'pf-pill-btn', role: 'tab', 'aria-selected': 'false' }, 'File')
      ]);
      h.headerRight = el('div', { class: 'pf-header-right pf-session-header-actions' }, [
        filePill,
        el('div', { class: 'pf-split' }, [el('button', { type: 'button', class: 'pf-hbtn' }, '⑂ Fork'), el('button', { type: 'button', class: 'pf-hbtn', 'aria-label': 'Fork options' }, '▾')]),
        el('button', { type: 'button', class: 'pf-hbtn' }, '+ Shell')
      ]);
      h.filePill = filePill;
      h.header = el('header', { class: 'pf-header pf-session-header' }, [h.headerLeft, h.headerRight]);
    } else {
      h.headerLeft = el('div', { class: 'pf-header-left' }, [logoSvg(), el('span', { class: 'pf-title' }, 'Peers Flow'), el('span', { class: 'pf-bridge-dot', title: 'Delegation bridge live' })]);
      h.pill = el('div', { class: 'pf-pill', role: 'tablist', 'aria-label': 'Main view' }, [
        el('button', { type: 'button', role: 'tab', class: 'pf-pill-btn' + (view === 'home' ? ' pf-pill-btn--on' : ''), 'aria-selected': String(view === 'home'), title: 'Pinned conversations' }, 'Chat'),
        el('button', { type: 'button', role: 'tab', class: 'pf-pill-btn' + (view === 'routines' ? ' pf-pill-btn--on' : ''), 'aria-selected': String(view === 'routines'), title: 'Chats that start themselves on a schedule' }, 'Routines')
      ]);
      h.headerRight = el('div', { class: 'pf-header-right' }, [
        h.pill,
        el('button', { type: 'button', class: 'pf-menu-btn', title: 'Menu', 'aria-label': 'Open menu' }, [el('span'), el('span'), el('span')]),
        el('span', { class: 'pf-perf-pill', title: 'CPU · main-loop lag' }, '12% · 4 ms'),
        el('button', { type: 'button', class: 'pf-help-btn', title: 'Shortcuts & info', 'aria-label': 'Open help' }, 'ⓘ')
      ]);
      h.header = el('header', { class: 'pf-header' }, [h.headerLeft, h.headerRight]);
    }
    frame.appendChild(h.header);
    h.banner = el('div', { class: 'pf-banner-slot' });
    frame.appendChild(h.banner);

    var body = el('div', { class: 'pf-body' });
    frame.appendChild(body);
    h.statusBar = el('div', { class: 'pf-statusbar-slot' });
    frame.appendChild(h.statusBar);
    h.overlay = el('div', { class: 'pf-overlay' });
    frame.appendChild(h.overlay);
    frame.__pfOverlay = h.overlay;

    if (view === 'home') buildHome(h, body, s, selectedPeerId);
    else if (view === 'routines') buildRoutines(h, body, s, o);
    else buildSession(h, body, s, o);

    /* API */
    h.setRunStatus = function (runId, status) {
      var card = h.routineCards.get(runId);
      if (card) {
        card.className = card.className.replace(/pf-card--\w+/g, '').trim() + ' pf-card--' + status;
        var r = routineById(s, card.dataset.routineId);
        var word = { running: 'running', attention: 'needs you', failed: 'failed', missed: 'missed' }[status];
        card.querySelector('span').textContent = card.dataset.time + (word ? ' · ' + word : '');
        card.setAttribute('aria-label', (r ? r.name : '') + ' · ' + card.dataset.time + ' · ' + status);
        var row = h.routineRows.get(card.dataset.routineId);
        if (row && row.dataset.latestRun === runId) setRowDot(row, status);
      }
    };
    h.setRowBadge = function (conversationId, text, variant) {
      var row = h.pinnedRows.get(conversationId);
      if (!row) return null;
      var cell = row.querySelector('.pf-row-actions');
      var old = cell.querySelector('.pf-row-badge');
      if (old) old.remove();
      if (text === null || text === undefined || text === '') return null;
      var b = PF.badge(text, variant || 'warn');
      b.classList.add('pf-row-badge');
      cell.insertBefore(b, cell.firstChild);
      return b;
    };
    h.destroy = function () {
      if (frame.parentNode) frame.parentNode.removeChild(frame);
      if (host && host.__pfShell === h) host.__pfShell = null;
    };
    if (host) { host.appendChild(frame); host.__pfShell = h; }
    return h;
  };

  var RUN_DOT = { success: 'ok', failed: 'err', attention: 'attention', running: 'info', missed: 'err', scheduled: 'muted' };
  function setRowDot(row, status) {
    var d = row.querySelector('.pf-dot');
    if (d) d.className = 'pf-dot pf-dot--' + (RUN_DOT[status] || 'muted') + (status === 'running' ? ' pf-dot--pulse' : '');
    if (d) d.title = status;
  }

  /* ── home ── */
  function buildDock(h, s, which) {
    var a = s.accounts, u = s.usage;
    function meter(label, pct, colour, note, extra) {
      return el('div', { class: 'pf-meter' + (extra ? ' ' + extra : '') }, [
        el('div', { class: 'pf-meter-top' }, [label, el('span', { class: 'pf-meter-pct', style: 'color:' + colour }, pct + '%')]),
        el('div', { class: 'pf-meter-bar' }, el('i', { style: 'width:' + pct + '%;background:' + colour })),
        note ? el('div', { class: 'pf-meter-note' }, note) : null
      ]);
    }
    function pctColour(p) { return p >= 90 ? 'var(--pf-err)' : p >= 70 ? 'var(--pf-warn)' : 'var(--pf-violet)'; }
    var dock = h.dock = el('div', { class: 'pf-dock' });
    if (which.indexOf('accounts') >= 0) {
      dock.appendChild(PF.pane({
        title: 'Accounts', tick: 'var(--pf-violet)', sub: '', body: [
          meter(el('span', { class: 'pf-meter-label' }, [el('span', { class: 'pf-blur' }, a.active), el('span', { class: 'pf-acct-active' }, 'active')]), a.activePct, pctColour(a.activePct), null, 'pf-acct--active'),
          a.others.map(function (x) { return meter(el('span', { class: 'pf-meter-label pf-blur' }, x.label), x.pct, pctColour(x.pct)); })
        ]
      }));
    }
    if (which.indexOf('usage') >= 0) {
      dock.appendChild(PF.pane({
        title: 'Usage', tick: 'var(--pf-info)', sub: u.plan, badge: u.weekly + '%', badgeColor: 'var(--pf-warn)', body: [
          meter(el('span', { class: 'pf-meter-label' }, 'Current session'), u.session, 'var(--pf-violet)'),
          meter(el('span', { class: 'pf-meter-label' }, 'Weekly · all models'), u.weekly, 'var(--pf-warn)')
        ]
      }));
    }
    if (which.indexOf('notes') >= 0) {
      dock.appendChild(PF.pane({ title: 'Global notes', tick: 'var(--pf-ok)', badge: '1', open: false, body: el('div', { class: 'pf-meter', style: 'font-size:13px' }, '📝 temp.md') }));
    }
    return dock;
  }

  function buildHome(h, body, s, selectedPeerId) {
    body.classList.add('pf-body--col');
    var row = el('div', { class: 'pf-body-row' });
    body.appendChild(row);
    // sidebar
    var top = h.sidebarTop = el('div', { class: 'pf-sidebar-top' }, [
      el('h2', { class: 'pf-section-label' }, [el('span', { class: 'pf-tick' }), 'Tracked Peers', el('span', { class: 'pf-grow' }), el('span', { class: 'pf-muted', style: 'font-size:14px' }, '+')]),
      el('input', { class: 'pf-search', placeholder: 'Search peers…', 'aria-label': 'Search tracked peers' }),
      el('div', { class: 'pf-peer-list' }, (s.peers || []).map(function (p) {
        return el('div', { class: 'pf-peer-card' + (p.id === selectedPeerId ? ' pf-peer-card--selected' : ''), dataset: { peerId: p.id } }, [
          el('div', { style: 'min-width:0;flex:1' }, [el('div', { class: 'pf-peer-name pf-truncate' }, p.name), el('div', { class: 'pf-peer-path pf-truncate' }, p.path)]),
          el('div', { class: 'pf-peer-actions', 'aria-hidden': 'true' }, [el('span', {}, '+'), el('span', {}, '⋯'), el('span', {}, '→')])
        ]);
      }))
    ]);
    h.sidebar = el('aside', { class: 'pf-sidebar' }, [top, buildDock(h, s, ['accounts', 'usage', 'notes'])]);
    row.appendChild(h.sidebar);
    // main list
    var list = el('div', { class: 'pf-list', role: 'list' }, [
      el('div', { class: 'pf-list-head' }, [el('span'), el('span', {}, 'Peer'), el('span', {}, 'Title'), el('span')])
    ]);
    (s.conversations || []).forEach(function (c) {
      if (c.kind === 'divider') {
        list.appendChild(el('div', { class: 'pf-divider-row', dataset: { dividerId: c.id } }, [
          el('span', { class: 'pf-grip' }, gripSvg()),
          el('span', { class: 'pf-line' }), el('span', { class: 'pf-divider-label' }, c.title), el('span', { class: 'pf-line' }),
          el('span', { class: 'pf-divider-tools', 'aria-hidden': 'true' }, [pencilSvg(), el('span', {}, '✕')])
        ]));
        return;
      }
      var peer = peerById(s, c.peerId);
      var st = STATE_DOT[c.state] || ['muted', false];
      var dot = PF.dot(st[0], st[1]); dot.classList.add('pf-row-dot'); dot.title = c.state;
      var r = el('div', { class: 'pf-row', role: 'listitem', dataset: { conversationId: c.id } }, [
        el('span', { class: 'pf-grip' }, gripSvg()),
        el('div', { class: 'pf-row-peer' }, [dot, el('b', {}, peer.name)]),
        el('div', { class: 'pf-row-title' }, [el('span', {}, c.title), el('span', { class: 'pf-pencil' }, pencilSvg())]),
        el('div', { class: 'pf-row-actions' }, [el('button', { type: 'button', class: 'pf-done-btn', title: 'Mark done' }, [doneSvg(), 'Done'])])
      ]);
      // the real .pf-row-actions holds badges then "✓ Done"; concepts insert before the Done button
      h.pinnedRows.set(c.id, r);
      list.appendChild(r);
    });
    var focusedRow = h.pinnedRows.get(s.chat && s.chat.conversationId);
    if (focusedRow) focusedRow.classList.add('pf-row--focused');
    var scroll = el('div', { class: 'pf-main-scroll' }, [
      el('div', { class: 'pf-main-head' }, [el('h2', {}, 'Pinned conversations'), el('button', { type: 'button', class: 'pf-ghost-btn', title: 'Insert a labeled separator' }, '+ Add separator')]),
      list
    ]);
    h.main = el('main', { class: 'pf-main' }, [scroll]);
    row.appendChild(h.main);
    // composer (SpawnBar)
    var selPeer = peerById(s, selectedPeerId);
    h.composer = el('div', { class: 'pf-composer' }, [
      el('span', { class: 'pf-chip' }, [el('span', { style: 'color:var(--pf-accent);display:flex' }, PF.icon('folder', 13)), el('b', {}, selPeer.name)]),
      el('span', { class: 'pf-chip' }, [el('b', {}, 'Opus'), el('span', { class: 'pf-subtle' }, '▾')]),
      el('input', { class: 'pf-composer-input', placeholder: 'Type a prompt or paste images and press Enter…', 'aria-label': 'Prompt' }),
      el('button', { type: 'button', class: 'pf-send-btn' }, 'Send')
    ]);
    body.appendChild(h.composer);
  }

  /* ── routines ── */
  var CADENCE_COLOR = { daily: '#2dd4bf', every2days: '#a78bfa', weekdays: '#7dd3fc', weekly: '#e879f9', twiceMonthly: '#facc15', monthly: '#e2e8f0' };
  var GROUPS = [['monthly', 'MONTHLY'], ['daily', 'DAILY'], ['twiceMonthly', 'TWICE A MONTH']];
  function occursOn(r, dt) {
    if (r.cadence === 'daily') return true;
    if (r.cadence === 'monthly' || r.cadence === 'twiceMonthly') return (r.monthDays || []).indexOf(dt.getUTCDate()) >= 0;
    return false;
  }

  function buildRoutines(h, body, s, o) {
    var now = parts(s.now);
    var today = utcDate(now.y, now.mo, now.d);
    var todayKey = keyOf(today);
    var latest = {};
    (s.runs || []).forEach(function (run) { var cur = latest[run.routineId]; if (!cur || run.slotAt > cur.slotAt) latest[run.routineId] = run; });
    var runAt = {};
    (s.runs || []).forEach(function (run) { var p = parts(run.slotAt); runAt[run.routineId + '@' + dayKey(p.y, p.mo, p.d)] = run; });

    // sidebar
    var list = el('div', { class: 'pf-routines-list' });
    GROUPS.forEach(function (g) {
      var items = (s.routines || []).filter(function (r) { return r.cadence === g[0]; });
      if (!items.length) return;
      list.appendChild(el('section', { class: 'pf-cadence-group' }, [
        el('h3', { style: 'border-top-color:' + CADENCE_COLOR[g[0]] }, g[1] + ' (' + items.length + ')'),
        el('div', {}, items.map(function (r) {
          var run = latest[r.id];
          var row = el('button', { type: 'button', class: 'pf-routine-row', 'aria-pressed': 'false', dataset: { routineId: r.id, latestRun: run ? run.id : '' } }, [
            glyph(r.icon, 16), el('span', { class: 'pf-rname' }, r.name), el('span', { class: 'pf-rcad' }, cadenceLabel(r)),
            run ? PF.dot(RUN_DOT[run.status] || 'muted', run.status === 'running') : null
          ]);
          if (run) row.querySelector('.pf-dot').title = run.status;
          h.routineRows.set(r.id, row);
          return row;
        }))
      ]));
    });
    var side = el('aside', { class: 'pf-routines-sidebar', 'aria-label': 'Routines' }, [list, el('div', { class: 'pf-routines-foot' }, el('button', { type: 'button' }, '+ New routine'))]);

    // toolbar
    var range = o.routinesRange || 'week';
    var offset = (today.getUTCDay() + 6) % 7;
    var mon = new Date(today.getTime() - offset * 864e5);
    var sun = new Date(mon.getTime() + 6 * 864e5);
    var label = range === 'month' ? ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][now.mo - 1] + ' ' + now.y
      : mon.getUTCDate() + ' – ' + sun.getUTCDate() + ' ' + MONTHS[sun.getUTCMonth()] + ' ' + sun.getUTCFullYear();
    h.toolbar = el('div', { class: 'pf-toolbar' }, [
      el('span', { class: 'pf-agent-filter' }, ['All agents', el('i', {}, '▾')]),
      el('div', { class: 'pf-pill', role: 'tablist', 'aria-label': 'Board range' }, [
        el('button', { type: 'button', class: 'pf-pill-btn' + (range === 'week' ? ' pf-pill-btn--on' : '') }, 'Week'),
        el('button', { type: 'button', class: 'pf-pill-btn' + (range === 'month' ? ' pf-pill-btn--on' : '') }, 'Month')
      ]),
      el('div', { style: 'display:flex;gap:4px' }, [el('button', { type: 'button', class: 'pf-nav-btn' }, '‹'), el('button', { type: 'button', class: 'pf-nav-btn' }, 'Today'), el('button', { type: 'button', class: 'pf-nav-btn' }, '›')]),
      el('span', { class: 'pf-range' }, label)
    ]);

    function card(r, dt) {
      var k = keyOf(dt);
      var run = runAt[r.id + '@' + k];
      var status = run ? run.status : (k > todayKey || (k === todayKey && r.time > PF.formatTime(s.now))) ? 'scheduled' : null;
      if (!status) return null;     // no recorded run in the scenario for that past slot: nothing is drawn
      var word = { running: 'running', attention: 'needs you', failed: 'failed', missed: 'missed' }[status];
      var c = el('button', { type: 'button', class: 'pf-card pf-card--' + status, 'aria-label': r.name + ' · ' + r.time + ' · ' + status, dataset: { routineId: r.id, time: r.time, runId: run ? run.id : '' } }, [
        el('b', {}, r.name), el('span', {}, r.time + (word ? ' · ' + word : ''))
      ]);
      if (run) h.routineCards.set(run.id, c);
      return c;
    }

    var board;
    if (range === 'month') {
      var first = utcDate(now.y, now.mo, 1);
      var start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 864e5);
      var grid = el('div', { class: 'pf-lane-cells', style: 'grid-auto-rows:minmax(92px,auto)' });
      for (var i = 0; i < 42; i++) {
        var dt = new Date(start.getTime() + i * 864e5);
        var inMonth = dt.getUTCMonth() === now.mo - 1;
        var cell = el('div', { class: keyOf(dt) === todayKey ? 'is-today' : '', style: inMonth ? '' : 'opacity:.35' }, [el('div', { class: 'pf-subtle', style: 'font-size:11px' }, String(dt.getUTCDate()))]);
        if (inMonth) (s.routines || []).filter(function (r) { return r.cadence !== 'daily' && occursOn(r, dt); }).forEach(function (r) { var c = card(r, dt); if (c) cell.appendChild(c); });
        grid.appendChild(cell);
      }
      board = el('div', { class: 'pf-week' }, [
        el('div', { class: 'pf-week-head' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (d) { return el('div', {}, d); })),
        el('div', { class: 'pf-lane' }, grid)
      ]);
    } else {
      var days = [];
      for (var j = 0; j < 7; j++) days.push(new Date(mon.getTime() + j * 864e5));
      var head = el('div', { class: 'pf-week-head' }, days.map(function (d) {
        var k = keyOf(d);
        return el('div', { class: k === todayKey ? 'is-today' : k < todayKey ? 'is-past' : '' }, [k === todayKey ? 'TODAY' : WEEKDAYS[d.getUTCDay()], ' ', String(d.getUTCDate())]);
      }));
      var lanes = [
        { label: 'DAILY', cadence: 'daily', cadences: ['daily'] },
        { label: 'MONTHLY & TWICE A MONTH', cadence: 'monthly', cadences: ['twiceMonthly', 'monthly'] }
      ];
      board = el('div', { class: 'pf-week' }, [head].concat(lanes.map(function (lane) {
        var rs = (s.routines || []).filter(function (r) { return lane.cadences.indexOf(r.cadence) >= 0; }).sort(function (a, b) { return a.time < b.time ? -1 : 1; });
        return el('section', { class: 'pf-lane' }, [
          el('div', { class: 'pf-lane-label', style: 'border-left-color:' + CADENCE_COLOR[lane.cadence] }, [el('span', { style: 'color:' + CADENCE_COLOR[lane.cadence] + ';display:flex' }, cadenceIcon(lane.cadence)), lane.label]),
          el('div', { class: 'pf-lane-cells' }, days.map(function (d) {
            return el('div', { class: keyOf(d) === todayKey ? 'is-today' : '' }, rs.filter(function (r) { return occursOn(r, d); }).map(function (r) { return card(r, d); }));
          }))
        ]);
      })));
    }
    var wrap = el('div', { class: 'pf-board-wrap' }, [board]);
    if (o.showPreview) {
      var r0 = routineById(s, typeof o.showPreview === 'string' ? o.showPreview : 'r-timesheet');
      var run0 = latest[r0.id];
      wrap.appendChild(el('aside', { class: 'pf-preview' }, [
        el('div', { style: 'display:flex;align-items:center;gap:8px' }, [glyph(r0.icon, 18), el('h3', {}, r0.name)]),
        el('dl', {}, [el('dt', {}, 'Agent'), el('dd', {}, peerById(s, r0.peerId).name), el('dt', {}, 'When'), el('dd', {}, cadenceLabel(r0)), el('dt', {}, 'Prompt'), el('dd', { class: 'pf-mono', style: 'font-size:11px' }, r0.prompt), el('dt', {}, 'Last run'), el('dd', {}, run0 ? PF.formatDay(run0.slotAt) + ' ' + PF.formatTime(run0.slotAt) + ' · ' + run0.status : '—')]),
        el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [PF.button('Open chat'), PF.button('Run now'), PF.button('Edit')])
      ]));
      h.preview = wrap.lastChild;
    }
    h.main = el('main', { class: 'pf-routines-main' }, [h.toolbar, wrap]);
    body.appendChild(el('div', { class: 'pf-routines' }, [side, h.main]));
  }

  /* ── session ── */
  function buildSession(h, body, s, o) {
    var pdf = (s.files || [])[0] || { path: '' };
    function row(depth, kind, name, opts) {
      opts = opts || {};
      return el('div', { class: 'pf-tree-row' + (opts.sel ? ' pf-tree-row--sel' : ''), style: 'padding-left:' + (12 + depth * 14) + 'px', title: opts.title || null }, [
        el('span', { class: 'pf-tw' }, kind === 'dir' ? (opts.open ? '▼' : '▶') : ''),
        el('span', { class: 'pf-ti' }, PF.icon(kind === 'dir' ? 'folder' : 'file', 12)),
        el('span', { class: 'pf-tn' }, name)
      ]);
    }
    var tree = el('div', { class: 'pf-filetree' }, [
      el('div', { class: 'pf-filetree-tabs' }, el('div', { class: 'pf-pill' }, [el('button', { type: 'button', class: 'pf-pill-btn' }, 'Changes'), el('button', { type: 'button', class: 'pf-pill-btn pf-pill-btn--on' }, 'Files')])),
      row(0, 'dir', '.claude', { open: true }),
      row(1, 'dir', 'skills', { open: true }),
      row(2, 'dir', 'log-time-abilitie', { open: true }),
      row(3, 'file', 'SKILL.md'),
      row(3, 'file', 'work-notes.md'),
      row(0, 'dir', 'timesheets', { open: true }),
      row(1, 'file', basename(pdf.path), { sel: true, title: pdf.path }),
      row(0, 'file', 'README.md')
    ]);
    h.sidebarTop = tree;
    h.sidebar = el('aside', { class: 'pf-sidebar' }, [tree, buildDock(h, s, ['usage', 'notes'])]);
    var lines = ((s.chat && s.chat.conversationId === (o.conversationId || 'c-timesheet')) ? s.chat.lines : []) || [];
    h.chat = el('div', { class: 'pf-chat', role: 'log' }, lines.map(function (l) {
      return el('div', { class: 'pf-chat-line' + (l.who === 'you' ? ' pf-chat-line--you' : '') }, l.text);
    }));
    h.chatPrompt = el('div', { class: 'pf-chat-prompt' }, ['❯ ', el('span', { class: 'pf-caret' })]);
    h.main = el('main', { class: 'pf-chat-wrap' }, [h.chat, el('div', { style: 'padding:0 18px 12px;font-family:var(--pf-mono);font-size:12.5px' }, h.chatPrompt)]);
    body.appendChild(h.sidebar);
    body.appendChild(h.main);
  }
})();
