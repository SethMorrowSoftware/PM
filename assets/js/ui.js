// Tiny hyperscript + UI atoms (avatars, tags, pills, pickers, popover, toast).

// -------- h() --------
// Usage: h('div', {class:'foo', onClick:fn, style:{color:'red'}}, child1, child2, ...)
// - tag may be a string or an existing DOM node (props are applied to it)
// - children may be strings, numbers, DOM nodes, arrays (flattened), or null/false/undefined (skipped)
function h(tag, props, ...children) {
  const el = typeof tag === 'string' ? document.createElement(tag) : tag;
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k === 'ref' && typeof v === 'function') v(el);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      // NOTE: there is deliberately no `html:` escape hatch here. Passing raw
      // HTML strings to innerHTML is the classic XSS foot-gun; all rendering goes
      // through text nodes or the safe renderMarkdown(). Keep it that way.
      else if (k in el && typeof el[k] !== 'function') {
        try { el[k] = v; } catch { el.setAttribute(k, v); }
      } else {
        el.setAttribute(k, v);
      }
    }
  }
  appendChildren(el, children);
  // A <select>'s `value` only "sticks" once its <option>s exist, but props are
  // applied above BEFORE children are appended — so h('select', {value}, ...opts)
  // would otherwise ignore `value` and default to the first option. Re-assert it
  // here so edit/prefill dropdowns (project visibility, label scope, goal owner,
  // email-notif preference, …) reflect the real current value.
  if (props && 'value' in props && props.value != null && el.tagName === 'SELECT') {
    el.value = props.value;
  }
  return el;
}
function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) { appendChildren(el, c); continue; }
    if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}
// Replace all children of `host` with the new node(s).
function mount(host, ...children) {
  host.replaceChildren();
  appendChildren(host, children);
}

// -------- look-ups (use window.state lazily) --------
const S = () => window.state;
const userById    = id => S().users.find(u => u.id == id);
const projectById = id => S().projects.find(p => p.id == id);
const labelById   = id => S().labels.find(l => l.id == id);
const STATUSES = [
  { id: 'backlog',     name: 'Backlog',     color: '#5D6679' },
  { id: 'todo',        name: 'To do',       color: '#8A94A8' },
  { id: 'in_progress', name: 'In progress', color: '#F59E0B' },
  { id: 'review',      name: 'In review',   color: '#A855F7' },
  { id: 'done',        name: 'Done',        color: '#22C55E' },
];
const statusById = id => STATUSES.find(s => s.id === id);

// -------- Date helpers --------
// All date math is local-wall-clock; we deliberately avoid toISOString() which
// returns UTC and can shift the calendar day for users east of UTC.
const today = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const daysFromNow = (n) => {
  const d = today();
  d.setDate(d.getDate() + n);
  return ymd(d);
};
// Parse a date string to a *local* midnight Date. A bare "YYYY-MM-DD" is built
// from its parts so it lands on that exact calendar day in the viewer's TZ —
// `new Date('2026-06-30')` would parse as UTC midnight and then floor back a day
// for anyone west of UTC (the whole point of the local-wall-clock rule above).
const parseISO = s => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  d.setHours(0, 0, 0, 0);
  return d;
};

// -------- Avatars --------
function Avatar(user, size = 22, ring = false) {
  if (!user) return document.createComment('no-user');
  const el = h('div', {
    class: 'avatar', title: user.name,
    style: {
      width: size + 'px', height: size + 'px',
      fontSize: Math.max(9, size * 0.38) + 'px',
      background: user.color,
      boxShadow: ring ? '0 0 0 2px var(--bg-1)' : undefined,
    },
  }, user.initials);
  return el;
}
function AvatarStack(userIds = [], max = 3, size = 22) {
  const shown = userIds.slice(0, max);
  const extra = userIds.length - shown.length;
  const wrap = h('div', { class: 'av-stack' });
  for (const id of shown) {
    const u = userById(id);
    if (!u) continue;
    wrap.appendChild(h('div', {
      class: 'avatar', title: u.name,
      style: {
        width: size + 'px', height: size + 'px',
        fontSize: Math.max(9, size * 0.38) + 'px',
        background: u.color,
      },
    }, u.initials));
  }
  if (extra > 0) wrap.appendChild(h('div', {
    class: 'av-more',
    style: { width: size + 'px', height: size + 'px', fontSize: Math.max(9, size * 0.38) + 'px' }
  }, '+' + extra));
  return wrap;
}

// -------- Tag / Priority / Status --------
function Tag(labelId, small = false) {
  const l = labelById(labelId);
  if (!l) return document.createComment('no-label');
  return h('span', { class: `tag ${l.color}${small ? ' small' : ''}` }, l.name);
}
const PRIO_LABELS = ['Urgent', 'High', 'Medium', 'Low'];
function PriorityFlag(p, showLabel = false) {
  // role="img"+aria-label so screen readers announce the priority (the glyph is
  // identical across priorities — only color differs, which is invisible to SR
  // and colorblind users; the text label carries the meaning).
  const el = h('span', {
    class: `prio p${p}`, title: PRIO_LABELS[p],
    role: 'img', 'aria-label': 'Priority: ' + PRIO_LABELS[p],
  }, Icon('flag', 12));
  if (showLabel) el.appendChild(h('span', { 'aria-hidden': 'true' }, PRIO_LABELS[p]));
  return el;
}
function StatusPill(statusId) {
  const s = statusById(statusId);
  if (!s) return document.createComment('no-status');
  return h('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '2px 8px', borderRadius: '5px', fontSize: '11.5px', fontWeight: '500',
      // Blend the status hue toward the theme foreground so the label keeps
      // enough contrast on the soft tint in BOTH themes (the raw mid-tone
      // status colors fail WCAG as text on the light-theme white surface).
      // Falls back to the inherited (legible) text color if color-mix is
      // unsupported. The dot below stays the pure status color.
      background: s.color + '22', color: `color-mix(in srgb, ${s.color}, var(--fg-0) 42%)`, border: `1px solid ${s.color}33`,
    },
  },
    h('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: s.color } }),
    s.name);
}

// -------- Due date --------
function DueDate(due, small = false) {
  if (!due) return document.createComment('no-due');
  const d = parseISO(due);
  const t = today();
  const diff = Math.round((d - t) / 86400000);
  // Use theme-aware tokens (not hardcoded dark-mode pastels) so overdue/today
  // colors stay legible in the light theme too.
  let label, color = 'var(--fg-2)';
  if (diff < 0) { label = `${Math.abs(diff)}d overdue`; color = 'var(--red-fg)'; }
  else if (diff === 0) { label = 'Today'; color = 'var(--amber-fg)'; }
  else if (diff === 1) { label = 'Tomorrow'; color = 'var(--fg-1)'; }
  else if (diff < 7) { label = d.toLocaleDateString('en', { weekday: 'short' }); }
  else { label = d.toLocaleDateString('en', { month: 'short', day: 'numeric' }); }
  return h('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      fontSize: small ? '11px' : '12px', color,
    },
  }, Icon('clock', small ? 11 : 12), label);
}

// -------- Checkbox --------
function Checkbox(checked, size = 16) {
  const el = h('div', { class: 'checkbox' + (checked ? ' checked' : ''),
    style: { width: size + 'px', height: size + 'px' } });
  if (checked) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', Math.round(size * 0.7));
    svg.setAttribute('height', Math.round(size * 0.7));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'white');
    svg.setAttribute('stroke-width', '3.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = '<path d="M20 6 9 17l-5-5"/>';
    el.appendChild(svg);
  }
  return el;
}

// -------- Device helpers --------
// Small, cheap predicates the UI uses to adapt at build time. They're read on
// every render (renderApp() rebuilds the tree), and app.js re-renders when the
// phone breakpoint is crossed, so a rotate/resize picks up the new answer.
function pmCoarsePointer() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
function pmIsPhone() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
}
function pmIsMobile() {
  return !!(window.matchMedia && window.matchMedia('(max-width: 980px)').matches);
}

// -------- Popover (portal to document.body) --------
// Opens under `anchor`, closes on outside click or Escape.
//
// Positioning is `fixed`, not `absolute`: getBoundingClientRect() is in
// viewport coordinates, so an absolutely-positioned panel drifts by the page
// scroll offset the moment the document itself can scroll. It's clamped on
// both axes and flips above the anchor when there's no room below, so a picker
// opened near the bottom of a phone screen stays reachable.
//
// On phones the panel instead docks to the bottom of the screen as a sheet:
// full width, under the thumb, and impossible to clip.
let _popoverCounter = 0;
function openPopover(anchor, buildContent, { offset = 6, align = 'start' } = {}) {
  const id = ++_popoverCounter;
  const sheet = pmIsPhone();
  const pop = h('div', { class: 'popover' + (sheet ? ' pop-sheet' : ''), dataset: { popid: String(id) } });
  const content = buildContent({ close: () => closeMe() });
  appendChildren(pop, [content]);

  // A sheet reads as modal, so it gets its own scrim to tap away on.
  const scrim = sheet ? h('div', { class: 'pop-sheet-scrim' }) : null;
  if (scrim) {
    scrim.addEventListener('pointerdown', () => closeMe());
    document.body.appendChild(scrim);
  }
  document.body.appendChild(pop);

  function place() {
    if (sheet) return; // CSS docks the sheet; nothing to compute.
    const r = anchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    // Cap the height first so a long list measures at its final size.
    pop.style.maxHeight = Math.max(180, vh - 16) + 'px';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = r.bottom + offset;
    if (top + ph > vh - 8) {
      const above = r.top - offset - ph;      // flip above the anchor
      top = above >= 8 ? above : Math.max(8, vh - ph - 8);
    }
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }
  place();

  function onDown(e) {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) closeMe();
  }
  function onKey(e) { if (e.key === 'Escape') closeMe(); }
  function closeMe() {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', place);
    if (scrim) scrim.remove();
    pop.remove();
  }
  window.addEventListener('resize', place);

  // Keyboard: roving focus over .pop-item options so pickers (status, priority,
  // assignee, label, project, milestone) are fully operable without a mouse.
  const popItems = () => [...pop.querySelectorAll('.pop-item')].filter(el => el.offsetParent !== null);
  let activeItem = -1;
  function focusItem(i) {
    const list = popItems();
    if (!list.length) return;
    activeItem = (i + list.length) % list.length;
    list.forEach((el, idx) => { el.tabIndex = idx === activeItem ? 0 : -1; });
    list[activeItem].focus();
  }
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(activeItem + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(activeItem - 1); }
  });

  // Defer so the click that opened it doesn't immediately close it.
  // pointerdown (not mousedown) so a touch closes it on contact rather than
  // waiting for the browser's synthesised mouse event.
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  document.addEventListener('keydown', onKey);
  // HTML `autofocus` only runs on initial page load; inputs added dynamically
  // need an explicit .focus() once they're in the DOM. With no input (e.g. the
  // status/priority pickers), focus the first option so arrow keys work at once.
  // On touch we deliberately DON'T focus the search field: the on-screen
  // keyboard would spring up and cover the very list the user came to pick from.
  setTimeout(() => {
    const input = pop.querySelector('input, textarea');
    if (input && !pmCoarsePointer()) input.focus();
    else if (!input) focusItem(0);
    place();
  }, 0);
  return { close: closeMe, el: pop };
}

function PopoverItem({ selected = false, onSelect, children, leading } = {}) {
  const el = h('div', {
    class: 'pop-item' + (selected ? ' selected' : ''),
    // Keyboard-operable option: role + roving tabindex (openPopover manages the
    // active tabindex and arrow-key movement); Enter/Space activate it.
    role: 'option', tabindex: '-1', 'aria-selected': selected ? 'true' : 'false',
    onClick: onSelect,
    onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); if (onSelect) onSelect(e); } },
  });
  if (leading) el.appendChild(leading);
  if (Array.isArray(children)) appendChildren(el, children);
  else if (children != null) appendChildren(el, [children]);
  el.appendChild(h('span', { class: 'check' }, Icon('check', 14)));
  return el;
}

// -------- Picker builders --------
function assigneePickerContent(selectedIds, onToggle, close) {
  const wrap = h('div');
  const input = h('input', { placeholder: 'Assign to...', autofocus: true });
  wrap.appendChild(h('div', { class: 'pop-search' }, input));
  wrap.appendChild(h('div', { class: 'popover-header' }, 'Teammates'));
  const list = h('div');
  wrap.appendChild(list);

  function render(query = '') {
    list.replaceChildren();
    const users = S().users.filter(u => u.name.toLowerCase().includes(query.toLowerCase()));
    for (const u of users) {
      list.appendChild(PopoverItem({
        selected: selectedIds.includes(u.id),
        onSelect: () => { onToggle(u.id); close(); },
        leading: Avatar(u, 22),
        children: h('div', null,
          h('div', { style: { fontWeight: '500' } }, u.name),
          h('div', { style: { fontSize: '11px', color: 'var(--fg-3)' } }, u.role || '')
        ),
      }));
    }
  }
  input.addEventListener('input', e => render(e.target.value));
  render();
  return wrap;
}

function labelPickerContent(selectedIds, onToggle, close, { keepOpen = false, scopeProjectId = null, onCreateLabel = null } = {}) {
  const wrap = h('div');
  // Track selection in a local Set so the checkmarks update live on every toggle
  // when keepOpen re-renders. Every caller REPLACES its source array on toggle
  // (state.filterLabels = [...set], saveTask({labels:[...next]}), Object.assign,
  // form.labels = [...set]) rather than mutating the array we were handed here,
  // so reading the original `selectedIds` reference would freeze the checks at
  // open-time. We flip optimistically; a reopen re-syncs from the source of truth.
  const selected = new Set((selectedIds || []).map(Number));
  const input = h('input', { placeholder: 'Find labels...', autofocus: true });
  wrap.appendChild(h('div', { class: 'pop-search' }, input));
  wrap.appendChild(h('div', { class: 'popover-header' }, 'Labels'));
  const list = h('div');
  wrap.appendChild(list);
  async function createFromQuery(name) {
    if (typeof onCreateLabel !== 'function') return;
    const trimmed = name.trim();
    if (!trimmed) return;
    await onCreateLabel(trimmed, scopeProjectId);
    input.value = '';
  }
  function inScope(l) {
    if (scopeProjectId == null) return true;
    return l.project_id == null || l.project_id == scopeProjectId;
  }
  function render(query = '') {
    list.replaceChildren();
    const q = query.toLowerCase();
    // Archived / out-of-scope labels stay listed while attached so they can
    // still be deselected (the server exempts already-attached ids too).
    const labels = S().labels.filter(l => (selected.has(Number(l.id)) || (!l.archived && inScope(l))) && l.name.toLowerCase().includes(q));
    for (const l of labels) {
      list.appendChild(PopoverItem({
        selected: selected.has(Number(l.id)),
        onSelect: () => {
          const idn = Number(l.id);
          if (selected.has(idn)) selected.delete(idn); else selected.add(idn);
          onToggle(l.id);
          if (!keepOpen) close(); else render(input.value);
        },
        leading: Tag(l.id),
        children: l.archived ? h('span', { class: 'pill muted', style: { marginLeft: '6px' } }, 'Archived') : null,
      }));
    }
    const exact = labels.some(l => l.name.toLowerCase() === q);
    if (q && !exact && typeof onCreateLabel === 'function') {
      list.appendChild(PopoverItem({
        selected: false,
        onSelect: async () => {
          try { await createFromQuery(query); if (!keepOpen) close(); else render(''); }
          catch (e) { toast(e.message || 'Could not create label', 'error'); }
        },
        leading: Icon('plus', 12),
        children: h('span', null, `Create label "${query.trim()}"`),
      }));
    }
    if (!labels.length && !q) list.appendChild(h('div', { class: 'empty', style: { padding: '10px' } }, 'No labels'));
  }
  input.addEventListener('input', e => render(e.target.value));
  input.addEventListener('keydown', async e => {
    if (imeGuard(e)) return;
    if (e.key === 'Enter' && typeof onCreateLabel === 'function' && input.value.trim()) {
      e.preventDefault();
      try { await createFromQuery(input.value); if (!keepOpen) close(); else render(''); }
      catch (err) { toast(err.message || 'Could not create label', 'error'); }
    }
  });
  render();
  return wrap;
}

function statusPickerContent(value, onChange, close) {
  const wrap = h('div');
  wrap.appendChild(h('div', { class: 'popover-header' }, 'Change status'));
  for (const s of STATUSES) {
    wrap.appendChild(PopoverItem({
      selected: value === s.id,
      onSelect: () => { onChange(s.id); close(); },
      leading: h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: s.color } }),
      children: h('span', null, s.name),
    }));
  }
  return wrap;
}

function priorityPickerContent(value, onChange, close) {
  const wrap = h('div');
  wrap.appendChild(h('div', { class: 'popover-header' }, 'Priority'));
  for (let p = 0; p < 4; p++) {
    wrap.appendChild(PopoverItem({
      selected: value === p,
      onSelect: () => { onChange(p); close(); },
      leading: PriorityFlag(p),
      children: h('span', null, PRIO_LABELS[p]),
    }));
  }
  return wrap;
}

function projectPickerContent(value, onChange, close) {
  const wrap = h('div');
  wrap.appendChild(h('div', { class: 'popover-header' }, 'Project'));
  // Archived projects reject new tasks (server 409s), so don't offer them —
  // but keep the currently-selected one visible (flagged) so a task already
  // living in an archived project still shows its project.
  for (const p of S().projects.filter(p => !p.archived || p.id == value)) {
    wrap.appendChild(PopoverItem({
      selected: value == p.id,
      onSelect: () => { onChange(p.id); close(); },
      leading: h('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: p.color } }),
      children: h('span', null, p.name, p.archived ? h('span', { class: 'pill muted', style: { marginLeft: '6px' } }, 'Archived') : null),
    }));
  }
  return wrap;
}

// -------- IME guard --------
// True while an IME composition is being committed (keyCode 229 covers the
// stray post-compositionend Enter Safari fires). Every Enter-submits keydown
// handler must bail on this, or CJK users get half-composed text submitted.
function imeGuard(e) { return e.isComposing || e.keyCode === 229; }

// -------- Toast --------
// toast(msg, kind, ms) — or pass an options object as the third argument to
// get an inline action button: toast('Task completed', 'success',
// { ms: 8000, action: { label: 'Undo', onClick: fn } }). Clicking the action
// dismisses the toast immediately.
function toast(msg, kind = 'info', msOrOpts = 3200) {
  const opts = (msOrOpts && typeof msOrOpts === 'object') ? msOrOpts : { ms: msOrOpts };
  const ms = opts.ms || 3200;
  let host = document.querySelector('.toast-host');
  if (!host) {
    // Live region so screen readers announce success/error toasts (they're
    // otherwise purely visual and auto-dismiss in a few seconds).
    host = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.appendChild(host);
  }
  // Errors are more urgent — announce assertively.
  host.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  const t = h('div', { class: 'toast ' + kind }, msg);
  let fadeT, killT;
  if (opts.action && typeof opts.action.onClick === 'function') {
    t.appendChild(h('button', {
      class: 'toast-action',
      onClick: () => {
        clearTimeout(fadeT); clearTimeout(killT);
        t.remove();
        try { opts.action.onClick(); } catch (e) { console.error(e); }
      },
    }, opts.action.label || 'Undo'));
  }
  host.appendChild(t);
  fadeT = setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.2s'; }, ms - 200);
  killT = setTimeout(() => t.remove(), ms);
}

// -------- relTime / fmtMinutes --------
// relTime moved here from views/dashboard.js so every view shares one impl.
// Server timestamps are UTC "YYYY-MM-DD HH:MM:SS"; treat them as UTC by
// swapping the space for 'T' and appending 'Z' before constructing the Date.
function relTime(iso) {
  if (!iso) return '';
  const then = new Date(String(iso).replace(' ', 'T') + 'Z');
  if (isNaN(then.getTime())) return '';
  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  if (secs < 604800) return Math.floor(secs / 86400) + 'd';
  return then.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// 90 -> "1h 30m"; 45 -> "45m"; 0 -> "0m"
function fmtMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

// -------- Generic accessible modal --------
// modal({title, body, footer, width}) -> { el, close }
// `body`/`footer` may be a Node, an array of Nodes, a string, or a function
// returning any of those. Implements role="dialog" + aria-modal, Esc=close,
// click-scrim=close, a focus trap over Tab/Shift+Tab, and restores focus to
// whatever was focused before the modal opened.
function modal({ title = '', body = null, footer = null, width = null } = {}) {
  const prevFocus = document.activeElement;
  const frag = document.createDocumentFragment();
  const scrim = h('div', { class: 'scrim' });
  const dialog = h('div', {
    class: 'modal dialog', role: 'dialog', 'aria-modal': 'true', tabindex: '-1',
    style: width ? { width: typeof width === 'number' ? width + 'px' : width } : undefined,
  });
  frag.appendChild(scrim);
  frag.appendChild(dialog);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    dialog.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch (_) {}
    }
  }

  function resolveContent(c) {
    if (typeof c === 'function') c = c();
    if (c == null) return [];
    return Array.isArray(c) ? c : [c];
  }

  if (title != null && title !== '') {
    const head = h('div', { class: 'modal-head' });
    const titleId = 'dlg-title-' + (++_popoverCounter);
    head.appendChild(h('div', { class: 'modal-title-input', id: titleId, style: { fontSize: '17px', fontWeight: '500' } }, title));
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.appendChild(head);
  }
  const bodyEl = h('div', { class: 'modal-body', style: { display: 'block' } });
  appendChildren(bodyEl, resolveContent(body));
  dialog.appendChild(bodyEl);

  if (footer != null) {
    const footEl = h('div', { class: 'modal-foot' });
    appendChildren(footEl, resolveContent(footer));
    dialog.appendChild(footEl);
  }

  const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function focusables() {
    return [...dialog.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) { e.preventDefault(); dialog.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !dialog.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !dialog.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }

  // pointerdown so a tap on the scrim dismisses on contact instead of waiting
  // for the browser's synthesised mouse event.
  scrim.addEventListener('pointerdown', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(frag);

  // Focus the first focusable atom (fall back to the dialog itself). On touch,
  // skip straight to the dialog when the first stop is a text field — focusing
  // it would throw up the on-screen keyboard over the dialog before the user
  // has even read it.
  setTimeout(() => {
    const items = focusables();
    const first = items[0];
    const isField = first && /^(INPUT|TEXTAREA|SELECT)$/.test(first.tagName);
    ((isField && pmCoarsePointer()) ? dialog : (first || dialog)).focus();
  }, 0);

  return { el: dialog, close };
}

// confirmDialog({title, message, confirmText, cancelText, danger}) -> Promise<bool>
function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; m.close(); resolve(val); };
    const cancelBtn = h('button', { class: 'btn btn-ghost', onClick: () => finish(false) }, cancelText);
    const okBtn = h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), onClick: () => finish(true) }, confirmText);
    const m = modal({
      title,
      body: message ? h('div', { style: { fontSize: '13.5px', color: 'var(--fg-1)', lineHeight: '1.5' } }, message) : null,
      footer: h('div', { class: 'hstack', style: { marginLeft: 'auto', gap: '8px' } }, cancelBtn, okBtn),
    });
    // Esc / scrim resolve false too: wrap the modal's close.
    const origClose = m.close;
    m.close = () => { origClose(); if (!done) { done = true; resolve(false); } };
    m.el.addEventListener('keydown', e => { if (e.key === 'Enter' && document.activeElement !== cancelBtn) { e.preventDefault(); finish(true); } });
    setTimeout(() => okBtn.focus(), 0);
  });
}

// promptDialog({title, label, value, placeholder, multiline}) -> Promise<string|null>
function promptDialog({ title = 'Enter a value', label = '', value = '', placeholder = '', multiline = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = (val) => { if (done) return; done = true; m.close(); resolve(val); };
    const field = multiline
      ? h('textarea', { class: 'input', rows: 4, placeholder, style: { width: '100%', resize: 'vertical' } })
      : h('input', { class: 'input', type: 'text', placeholder, value, style: { width: '100%' } });
    if (multiline) field.value = value || '';
    if (!multiline) {
      field.addEventListener('keydown', e => { if (imeGuard(e)) return; if (e.key === 'Enter') { e.preventDefault(); finish(field.value); } });
    } else {
      field.addEventListener('keydown', e => { if (imeGuard(e)) return; if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(field.value); } });
    }
    const bodyKids = [];
    if (label) bodyKids.push(h('label', { style: { display: 'block', fontSize: '12px', color: 'var(--fg-2)', marginBottom: '6px' } }, label));
    bodyKids.push(field);
    const cancelBtn = h('button', { class: 'btn btn-ghost', onClick: () => finish(null) }, 'Cancel');
    const okBtn = h('button', { class: 'btn btn-primary', onClick: () => finish(field.value) }, 'Save');
    const m = modal({
      title,
      body: bodyKids,
      footer: h('div', { class: 'hstack', style: { marginLeft: 'auto', gap: '8px' } }, cancelBtn, okBtn),
    });
    const origClose = m.close;
    m.close = () => { origClose(); if (!done) { done = true; resolve(null); } };
    setTimeout(() => { field.focus(); if (!multiline) field.select && field.select(); }, 0);
  });
}

// -------- Date picker popover --------
// datePickerPopover(anchor, value, onPick): small month grid in a popover.
// `value` is a YYYY-MM-DD string (or falsy). onPick receives a YYYY-MM-DD
// string, or '' when the user clicks "Clear".
function datePickerPopover(anchor, value, onPick) {
  const selected = value ? parseISO(value) : null;
  let cursor = selected ? new Date(selected.getFullYear(), selected.getMonth(), 1)
                        : (() => { const t = today(); return new Date(t.getFullYear(), t.getMonth(), 1); })();
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DOW = ['S','M','T','W','T','F','S'];

  return openPopover(anchor, ({ close }) => {
    const wrap = h('div', { class: 'datepicker', style: { padding: '8px', width: '236px' } });

    function render() {
      wrap.replaceChildren();
      const header = h('div', { class: 'hstack', style: { justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
        h('button', { class: 'btn btn-ghost', style: { padding: '4px' }, 'aria-label': 'Previous month',
          onClick: () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); render(); } }, Icon('chevronLeft', 16)),
        h('div', { style: { fontSize: '13px', fontWeight: '600' } }, `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`),
        h('button', { class: 'btn btn-ghost', style: { padding: '4px' }, 'aria-label': 'Next month',
          onClick: () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); render(); } }, Icon('chevronRight', 16)),
      );
      wrap.appendChild(header);

      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' } });
      for (const d of DOW) grid.appendChild(h('div', { style: { textAlign: 'center', fontSize: '10px', color: 'var(--fg-3)', padding: '2px 0' } }, d));

      const firstDow = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay();
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const todayStr = ymd(today());
      for (let i = 0; i < firstDow; i++) grid.appendChild(h('div'));
      for (let day = 1; day <= daysInMonth; day++) {
        const cellDate = new Date(cursor.getFullYear(), cursor.getMonth(), day);
        const cellStr = ymd(cellDate);
        const isSel = value && cellStr === value;
        const isToday = cellStr === todayStr;
        grid.appendChild(h('button', {
          class: 'btn btn-ghost dp-day' + (isSel ? ' selected' : ''),
          style: {
            padding: '0', height: '28px', fontSize: '12px', borderRadius: '6px',
            background: isSel ? 'var(--acc-1)' : undefined,
            color: isSel ? '#fff' : undefined,
            border: !isSel && isToday ? '1px solid var(--acc-border)' : undefined,
          },
          onClick: () => { onPick(cellStr); close(); },
        }, String(day)));
      }
      wrap.appendChild(grid);

      wrap.appendChild(h('div', { class: 'hstack', style: { justifyContent: 'space-between', marginTop: '8px' } },
        h('button', { class: 'btn btn-ghost', style: { fontSize: '12px' }, onClick: () => { onPick(''); close(); } }, 'Clear'),
        h('button', { class: 'btn btn-ghost', style: { fontSize: '12px' }, onClick: () => { onPick(todayStr); close(); } }, 'Today'),
      ));
    }
    render();
    return wrap;
  });
}

// -------- @-mention textarea --------
// mentionTextarea({value, onInput, onSubmit, placeholder, rows}) -> wrapper el
// containing a <textarea> with an @-autocomplete dropdown that matches
// window.state.users by name. Selecting a user inserts "@Full Name " at the
// caret. Enter (without Shift) calls onSubmit(currentValue); typing calls
// onInput(value). The returned wrapper is focusable (focuses the textarea).
function mentionTextarea({ value = '', onInput, onSubmit, placeholder = '', rows = 3 } = {}) {
  const wrap = h('div', { class: 'mention-wrap', style: { position: 'relative' } });
  const ta = h('textarea', {
    class: 'input mention-input', rows, placeholder,
    style: { width: '100%', resize: 'vertical' },
  });
  ta.value = value || '';
  const menu = h('div', { class: 'popover mention-menu', style: { display: 'none', position: 'absolute', left: '0', right: '0', top: '100%', zIndex: '80', maxHeight: '200px', overflowY: 'auto' } });

  let matches = [];
  let activeIdx = 0;
  let tokenStart = -1; // index of the '@' currently being completed

  function findToken() {
    const pos = ta.selectionStart;
    const upto = ta.value.slice(0, pos);
    const at = upto.lastIndexOf('@');
    if (at < 0) return null;
    // Must be at start or preceded by whitespace; query has no whitespace.
    if (at > 0 && !/\s/.test(upto[at - 1])) return null;
    const query = upto.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { at, query };
  }

  function closeMenu() { menu.style.display = 'none'; matches = []; tokenStart = -1; }

  function renderMenu() {
    menu.replaceChildren();
    if (!matches.length) { closeMenu(); return; }
    matches.forEach((u, i) => {
      menu.appendChild(h('div', {
        class: 'pop-item mention-item' + (i === activeIdx ? ' selected' : ''),
        onMousedown: e => { e.preventDefault(); pick(u); },
      }, Avatar(u, 20), h('span', { style: { marginLeft: '8px' } }, u.name)));
    });
    menu.style.display = 'block';
  }

  function updateMenu() {
    const tok = findToken();
    if (!tok) { closeMenu(); return; }
    const users = (S().users || []);
    const q = tok.query.toLowerCase();
    matches = users.filter(u => u.name.toLowerCase().includes(q)).slice(0, 8);
    tokenStart = tok.at;
    activeIdx = 0;
    renderMenu();
  }

  function pick(u) {
    if (tokenStart < 0) return;
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, tokenStart);
    const after = ta.value.slice(pos);
    const insert = '@' + u.name + ' ';
    ta.value = before + insert + after;
    const caret = (before + insert).length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    closeMenu();
    if (typeof onInput === 'function') onInput(ta.value);
  }

  ta.addEventListener('input', () => {
    if (typeof onInput === 'function') onInput(ta.value);
    updateMenu();
  });
  ta.addEventListener('keyup', e => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) updateMenu();
  });
  ta.addEventListener('keydown', e => {
    // During IME composition, Enter/Arrows/Tab/Escape belong to the candidate
    // window — don't submit, navigate the mention menu, or close anything.
    if (imeGuard(e)) return;
    const open = menu.style.display !== 'none' && matches.length;
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      renderMenu();
      return;
    }
    if (open && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      pick(matches[activeIdx]);
      return;
    }
    if (open && e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (typeof onSubmit === 'function') onSubmit(ta.value);
    }
  });
  ta.addEventListener('blur', () => setTimeout(closeMenu, 120));

  wrap.appendChild(ta);
  wrap.appendChild(menu);
  // Make the wrapper itself behave like the field for callers that .focus() it.
  wrap.focus = () => ta.focus();
  wrap.getValue = () => ta.value;
  wrap.setValue = (v) => { ta.value = v || ''; };
  wrap._textarea = ta;
  return wrap;
}

// -------- Pointer-based drag helper (mouse + touch) --------
// makeDraggable(el, {onStart, onMove, onDrop, handle, data}) -> cleanup fn.
// Uses Pointer Events so it works on touch and mouse alike (NOT HTML5 DnD).
// A small movement threshold avoids hijacking taps/clicks. While dragging,
// document.body gets the 'dragging' class. Callbacks receive the pointer
// event (which carries clientX/clientY); `data` is attached to each event as
// `e.dragData` for convenience.
//
// TOUCH BEHAVIOUR — this is the part that makes or breaks mobile. Blanket
// `touch-action:none` on a whole card hands the browser's scroll gesture to us
// for every finger that lands on it, which is why the board and the calendar
// used to be almost impossible to scroll on a phone. Instead:
//   * With an explicit `handle` (a grip), only that grip opts out of native
//     scrolling and drags start immediately — the rest of the row still scrolls.
//   * With no handle the element itself is the drag target, so on touch we
//     require a long press (`touchDelay`) held still before the drag arms. A
//     finger that moves first just scrolls, exactly as the user expects; once
//     armed we preventDefault() the touchmove and take the gesture over.
// Mouse and pen keep the original immediate-drag behaviour.
function makeDraggable(el, { onStart, onMove, onDrop, handle = null, data = null, threshold = 5, touchDelay = 300 } = {}) {
  const grip = handle ? (typeof handle === 'string' ? el.querySelector(handle) : handle) : el;
  if (!grip) return () => {};
  const hasHandle = grip !== el;

  let startX = 0, startY = 0, active = false, started = false, armed = false;
  let pointerId = null, isTouch = false, pressTimer = null;

  function decorate(e) { try { e.dragData = data; } catch (_) {} return e; }

  // Non-passive so preventDefault() actually suppresses the scroll once the
  // long press has armed the drag. Bound per-gesture, released on end.
  function onTouchMove(e) { if (armed) e.preventDefault(); }
  function blockContextMenu(e) { if (armed) e.preventDefault(); }

  function arm() {
    if (!active || armed) return;
    armed = true;
    grip.classList.add('drag-armed');
    // A short buzz is the standard "you've picked it up" cue on touch.
    try { navigator.vibrate && navigator.vibrate(12); } catch (_) {}
  }

  function disarm() {
    clearTimeout(pressTimer); pressTimer = null;
    armed = false;
    grip.classList.remove('drag-armed');
    el.removeEventListener('touchmove', onTouchMove, { passive: false });
    el.removeEventListener('contextmenu', blockContextMenu);
  }

  function onPointerDown(e) {
    // Primary button / touch / pen only; ignore right-click.
    if (e.button != null && e.button !== 0) return;
    active = true; started = false; pointerId = e.pointerId;
    isTouch = e.pointerType === 'touch';
    startX = e.clientX; startY = e.clientY;
    // Mouse/pen, or a dedicated grip: armed at once. A bare touch on the card
    // itself has to earn it with a long press so scrolling stays native.
    armed = !isTouch || hasHandle;
    if (isTouch && !hasHandle) {
      el.addEventListener('touchmove', onTouchMove, { passive: false });
      el.addEventListener('contextmenu', blockContextMenu);
      pressTimer = setTimeout(arm, touchDelay);
    }
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
  }

  function onPointerMove(e) {
    if (!active || (pointerId != null && e.pointerId !== pointerId)) return;
    const dx = Math.abs(e.clientX - startX), dy = Math.abs(e.clientY - startY);
    if (!armed) {
      // Still waiting on the long press, and the finger moved — the user is
      // scrolling. Stand down completely and let the browser have the gesture.
      if (dx > threshold || dy > threshold) { abort(); }
      return;
    }
    if (!started) {
      if (dx < threshold && dy < threshold) return;
      started = true;
      document.body.classList.add('dragging');
      // Capture so we keep getting moves even over other elements.
      try { grip.setPointerCapture(pointerId); } catch (_) {}
      if (typeof onStart === 'function') onStart(decorate(e));
    }
    if (e.cancelable) e.preventDefault();
    if (typeof onMove === 'function') onMove(decorate(e));
  }

  function onPointerUp(e) {
    if (pointerId != null && e.pointerId !== pointerId) return;
    cleanupMove();
    if (started) {
      document.body.classList.remove('dragging');
      try { grip.releasePointerCapture(pointerId); } catch (_) {}
      if (typeof onDrop === 'function') onDrop(decorate(e));
    }
    disarm();
    active = false; started = false; pointerId = null;
  }

  // Give up on this gesture without firing onDrop (the user is scrolling).
  function abort() {
    cleanupMove();
    disarm();
    active = false; started = false; pointerId = null;
  }

  function cleanupMove() {
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerUp, true);
  }

  grip.addEventListener('pointerdown', onPointerDown);
  // Only a dedicated grip claims the gesture up front. A whole card keeps
  // `manipulation`: the browser may pan it on BOTH axes (the timeline scrolls
  // horizontally, so pinning it to pan-y would trap that gesture) while still
  // dropping the legacy double-tap-zoom delay. Once the long press arms, the
  // non-passive touchmove above takes the gesture back.
  grip.style.touchAction = hasHandle ? 'none' : 'manipulation';
  // Long-press on a card must not raise iOS's selection callout / magnifier.
  if (!hasHandle) el.classList.add('drag-source');

  return function cleanup() {
    grip.removeEventListener('pointerdown', onPointerDown);
    cleanupMove();
    disarm();
    document.body.classList.remove('dragging');
  };
}

// Convenience wrapper over makeDraggable for a simple reorderable list. Returns
// a cleanup fn that tears down every item's drag handler.
function sortableList(container, { itemSelector = '[data-id]', onReorder, handle = null } = {}) {
  const cleanups = [];
  const items = [...container.querySelectorAll(itemSelector)];
  items.forEach(item => {
    let placeholderIndex = null;
    const c = makeDraggable(item, {
      handle,
      data: { id: item.dataset.id },
      onStart: () => { item.classList.add('drag-ghost'); },
      onMove: (e) => {
        const over = document.elementFromPoint(e.clientX, e.clientY);
        const overItem = over && over.closest ? over.closest(itemSelector) : null;
        if (overItem && overItem !== item && container.contains(overItem)) {
          const rect = overItem.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          container.insertBefore(item, after ? overItem.nextSibling : overItem);
        }
      },
      onDrop: () => {
        item.classList.remove('drag-ghost');
        const order = [...container.querySelectorAll(itemSelector)].map(n => n.dataset.id);
        if (typeof onReorder === 'function') onReorder(item.dataset.id, order);
      },
    });
    cleanups.push(c);
  });
  return () => cleanups.forEach(fn => fn());
}

// -------- Emoji reaction bar --------
// emojiReactionBar(reactions, onToggle): a row of .reaction chips plus a small
// add-reaction button that opens a tiny emoji popover. `reactions` is an array
// of {emoji, count, mine}. onToggle(emoji) is called for a chip click or a
// popover pick.
const REACTION_EMOJIS = ['👍', '❤️', '🎉', '✅', '👀', '🙏'];
function emojiReactionBar(reactions = [], onToggle) {
  const row = h('div', { class: 'reaction-bar hstack', style: { gap: '4px', flexWrap: 'wrap', alignItems: 'center' } });
  for (const r of reactions) {
    if (!r || !r.count) continue;
    row.appendChild(h('button', {
      class: 'reaction' + (r.mine ? ' mine' : ''),
      type: 'button',
      onClick: () => { if (typeof onToggle === 'function') onToggle(r.emoji); },
    }, h('span', null, r.emoji), h('span', { class: 'reaction-count' }, String(r.count))));
  }
  const addBtn = h('button', { class: 'reaction reaction-add', type: 'button', 'aria-label': 'Add reaction' },
    Icon('smile', 14));
  addBtn.addEventListener('click', () => {
    openPopover(addBtn, ({ close }) => {
      const grid = h('div', { class: 'emoji-grid', style: { display: 'flex', gap: '4px', padding: '6px' } });
      for (const e of REACTION_EMOJIS) {
        grid.appendChild(h('button', {
          class: 'btn btn-ghost emoji-pick', type: 'button', style: { fontSize: '18px', padding: '4px 6px' },
          onClick: () => { if (typeof onToggle === 'function') onToggle(e); close(); },
        }, e));
      }
      return grid;
    });
  });
  row.appendChild(addBtn);
  return row;
}

// -------- Theme toggle --------
// ThemeToggle(onToggle): a button rendering Icon('sun') when the current theme
// is dark (click -> go light) or Icon('moon') when light. onClick calls
// onToggle().
function ThemeToggle(onToggle) {
  const isLight = S() && S().theme === 'light';
  const btn = h('button', {
    class: 'btn btn-ghost theme-toggle', type: 'button',
    'aria-label': isLight ? 'Switch to dark theme' : 'Switch to light theme',
    title: isLight ? 'Dark mode' : 'Light mode',
    onClick: () => { if (typeof onToggle === 'function') onToggle(); },
  }, Icon(isLight ? 'moon' : 'sun', 18));
  return btn;
}

// -------- Mini task chip (dependency lists) --------
// miniTaskChip(task): compact chip with a status dot, mono ref, and title.
function miniTaskChip(task) {
  if (!task) return document.createComment('no-task');
  const s = statusById(task.status);
  return h('span', { class: 'mini-task-chip', title: task.title || '' },
    h('span', { class: 'mini-task-dot', style: { width: '7px', height: '7px', borderRadius: '50%', background: (s && s.color) || 'var(--fg-3)', display: 'inline-block' } }),
    task.ref ? h('span', { class: 'mono', style: { color: 'var(--fg-3)', fontSize: '11.5px' } }, task.ref) : null,
    h('span', { class: 'mini-task-title', style: { fontSize: '12.5px', color: 'var(--fg-1)' } }, task.title || ''),
  );
}

window.h = h;
window.mount = mount;
window.STATUSES = STATUSES;
window.statusById = statusById;
window.userById = userById;
window.projectById = projectById;
window.labelById = labelById;
window.today = today;
window.ymd = ymd;
window.daysFromNow = daysFromNow;
window.parseISO = parseISO;
window.Avatar = Avatar;
window.AvatarStack = AvatarStack;
window.Tag = Tag;
window.PriorityFlag = PriorityFlag;
window.StatusPill = StatusPill;
window.DueDate = DueDate;
window.Checkbox = Checkbox;
window.pmCoarsePointer = pmCoarsePointer;
window.pmIsPhone = pmIsPhone;
window.pmIsMobile = pmIsMobile;
window.openPopover = openPopover;
window.PopoverItem = PopoverItem;
window.assigneePickerContent = assigneePickerContent;
window.labelPickerContent = labelPickerContent;
window.statusPickerContent = statusPickerContent;
window.priorityPickerContent = priorityPickerContent;
window.projectPickerContent = projectPickerContent;
window.toast = toast;
window.imeGuard = imeGuard;
window.PRIO_LABELS = PRIO_LABELS;
window.relTime = relTime;
window.fmtMinutes = fmtMinutes;
window.modal = modal;
window.confirmDialog = confirmDialog;
window.promptDialog = promptDialog;
window.datePickerPopover = datePickerPopover;
window.mentionTextarea = mentionTextarea;
window.makeDraggable = makeDraggable;
window.sortableList = sortableList;
window.emojiReactionBar = emojiReactionBar;
window.ThemeToggle = ThemeToggle;
window.miniTaskChip = miniTaskChip;

// -------- Loading skeletons --------
// Prefer these over a bare "Loading…" string for a more finished feel.
// Skeleton({w, h, class, style}) → one shimmer block. w/h accept a number (px)
// or any CSS length string.
function Skeleton({ w, h: height, class: cls = '', style = {} } = {}) {
  const s = { ...style };
  if (w != null) s.width = typeof w === 'number' ? w + 'px' : w;
  if (height != null) s.height = typeof height === 'number' ? height + 'px' : height;
  return h('div', { class: ('skeleton ' + cls).trim(), style: s, 'aria-hidden': 'true' });
}
// SkeletonRows(n, {style, rowClass}) → a labelled block of N shimmer rows for a
// list/table/feed loading state (announced once to assistive tech).
function SkeletonRows(n = 5, { style = {}, rowClass = 'skeleton-row' } = {}) {
  const wrap = h('div', { class: 'skeleton-rows', role: 'status', 'aria-label': 'Loading', style });
  for (let i = 0; i < n; i++) wrap.appendChild(h('div', { class: 'skeleton ' + rowClass, 'aria-hidden': 'true' }));
  return wrap;
}
window.Skeleton = Skeleton;
window.SkeletonRows = SkeletonRows;

// -------- Minimal, SAFE Markdown renderer --------
// Security model: ALL input HTML is escaped FIRST, then a fixed, small set of
// formatting tags is introduced (strong/em/code/a/p/ul/li/br). Links are only
// emitted for http(s)/mailto. No raw user HTML can survive, so this is XSS-safe
// even though the formatting itself is intentionally simple.
function renderMarkdown(text) {
  const div = document.createElement('div');
  div.className = 'md';
  const src = (text == null ? '' : String(text));
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Inline formatting. Code spans are isolated by splitting so their contents
  // are never touched by the other transforms (no fragile placeholders).
  const inline = (s) => s.split(/(`[^`]+`)/g).map(part => {
    if (part.length >= 2 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
      return '<code>' + part.slice(1, -1) + '</code>';
    }
    let x = part;
    x = x.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
      /^(https?:\/\/|mailto:)/i.test(u.replace(/&amp;/g, '&'))
        ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>' : m);
    x = x.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, (m, pre, url) =>
      pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url.replace(/&amp;/g, '&') + '</a>');
    // Emphasis must not rewrite the generated <a> tags — URLs routinely contain
    // _ and * — so isolate them the same way code spans are isolated above.
    // Input is fully escaped before inline() runs, so a literal '<a ' can only
    // originate from the two link transforms.
    return x.split(/(<a [^>]*>[\s\S]*?<\/a>)/g).map(seg => {
      if (seg.startsWith('<a ')) return seg;
      return seg
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
        .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');
    }).join('');
  }).join('');

  const lines = esc(src).split(/\r?\n/);
  let html = '', inList = false, para = [];
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  const flushPara = () => { if (para.length) { html += '<p>' + inline(para.join('<br>')) + '</p>'; para = []; } };
  for (const line of lines) {
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      if (!inList) { html += '<ul>'; inList = true; }
      html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>';
    } else if (line.trim() === '') {
      flushPara(); closeList();
    } else {
      closeList(); para.push(line);
    }
  }
  flushPara(); closeList();
  div.innerHTML = html;
  return div;
}

window.renderMarkdown = renderMarkdown;
