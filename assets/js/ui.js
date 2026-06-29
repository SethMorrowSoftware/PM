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
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof el[k] !== 'function') {
        try { el[k] = v; } catch { el.setAttribute(k, v); }
      } else {
        el.setAttribute(k, v);
      }
    }
  }
  appendChildren(el, children);
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
const parseISO = s => { if (!s) return null; const d = new Date(s); d.setHours(0,0,0,0); return d; };

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
  const el = h('span', { class: `prio p${p}`, title: PRIO_LABELS[p] }, Icon('flag', 12));
  if (showLabel) el.appendChild(h('span', null, PRIO_LABELS[p]));
  return el;
}
function StatusPill(statusId) {
  const s = statusById(statusId);
  if (!s) return document.createComment('no-status');
  return h('span', {
    style: {
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '2px 8px', borderRadius: '5px', fontSize: '11.5px', fontWeight: '500',
      background: s.color + '22', color: s.color, border: `1px solid ${s.color}33`,
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
  let label, color = 'var(--fg-2)';
  if (diff < 0) { label = `${Math.abs(diff)}d overdue`; color = '#FCA5A5'; }
  else if (diff === 0) { label = 'Today'; color = '#FCD34D'; }
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

// -------- Popover (portal to document.body) --------
// Opens under `anchor`, closes on outside click or Escape.
let _popoverCounter = 0;
function openPopover(anchor, buildContent, { offset = 6, align = 'start' } = {}) {
  const id = ++_popoverCounter;
  const pop = h('div', { class: 'popover', dataset: { popid: String(id) } });
  const content = buildContent({ close: () => closeMe() });
  appendChildren(pop, [content]);
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  const left = align === 'end' ? r.right - pop.offsetWidth : r.left;
  // clamp to viewport
  const maxLeft = window.innerWidth - pop.offsetWidth - 8;
  pop.style.top = (r.bottom + offset) + 'px';
  pop.style.left = Math.max(8, Math.min(left, maxLeft)) + 'px';

  function onDown(e) {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) closeMe();
  }
  function onKey(e) { if (e.key === 'Escape') closeMe(); }
  function closeMe() {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey);
    pop.remove();
  }

  // Defer so the click that opened it doesn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  document.addEventListener('keydown', onKey);
  // HTML `autofocus` only runs on initial page load; inputs added dynamically
  // need an explicit .focus() once they're in the DOM.
  setTimeout(() => {
    const input = pop.querySelector('input, textarea');
    if (input) input.focus();
  }, 0);
  return { close: closeMe, el: pop };
}

function PopoverItem({ selected = false, onSelect, children, leading } = {}) {
  const el = h('div', {
    class: 'pop-item' + (selected ? ' selected' : ''),
    onClick: onSelect,
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
    const labels = S().labels.filter(l => !l.archived && inScope(l) && l.name.toLowerCase().includes(q));
    for (const l of labels) {
      list.appendChild(PopoverItem({
        selected: selectedIds.includes(l.id),
        onSelect: () => { onToggle(l.id); if (!keepOpen) close(); else render(input.value); },
        leading: Tag(l.id),
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
  for (const p of S().projects) {
    wrap.appendChild(PopoverItem({
      selected: value == p.id,
      onSelect: () => { onChange(p.id); close(); },
      leading: h('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: p.color } }),
      children: h('span', null, p.name),
    }));
  }
  return wrap;
}

// -------- Toast --------
function toast(msg, kind = 'info', ms = 3200) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = h('div', { class: 'toast-host' });
    document.body.appendChild(host);
  }
  const t = h('div', { class: 'toast ' + kind }, msg);
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.2s'; }, ms - 200);
  setTimeout(() => t.remove(), ms);
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

  scrim.addEventListener('mousedown', close);
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(frag);

  // Focus the first focusable atom (fall back to the dialog itself).
  setTimeout(() => {
    const items = focusables();
    (items[0] || dialog).focus();
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
      field.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(field.value); } });
    } else {
      field.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(field.value); } });
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
function makeDraggable(el, { onStart, onMove, onDrop, handle = null, data = null, threshold = 5 } = {}) {
  const grip = handle ? (typeof handle === 'string' ? el.querySelector(handle) : handle) : el;
  if (!grip) return () => {};

  let startX = 0, startY = 0, active = false, started = false, pointerId = null;

  function decorate(e) { try { e.dragData = data; } catch (_) {} return e; }

  function onPointerDown(e) {
    // Primary button / touch / pen only; ignore right-click.
    if (e.button != null && e.button !== 0) return;
    active = true; started = false; pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
  }

  function onPointerMove(e) {
    if (!active || (pointerId != null && e.pointerId !== pointerId)) return;
    if (!started) {
      if (Math.abs(e.clientX - startX) < threshold && Math.abs(e.clientY - startY) < threshold) return;
      started = true;
      document.body.classList.add('dragging');
      // Capture so we keep getting moves even over other elements.
      try { grip.setPointerCapture(pointerId); } catch (_) {}
      if (typeof onStart === 'function') onStart(decorate(e));
    }
    e.preventDefault();
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
    active = false; started = false; pointerId = null;
  }

  function cleanupMove() {
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('pointercancel', onPointerUp, true);
  }

  grip.addEventListener('pointerdown', onPointerDown);
  grip.style.touchAction = 'none'; // prevent scroll-stealing on touch while dragging

  return function cleanup() {
    grip.removeEventListener('pointerdown', onPointerDown);
    cleanupMove();
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
window.openPopover = openPopover;
window.PopoverItem = PopoverItem;
window.assigneePickerContent = assigneePickerContent;
window.labelPickerContent = labelPickerContent;
window.statusPickerContent = statusPickerContent;
window.priorityPickerContent = priorityPickerContent;
window.projectPickerContent = projectPickerContent;
window.toast = toast;
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
    x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    x = x.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
         .replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');
    return x;
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
