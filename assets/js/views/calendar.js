// Month calendar view.
// Cursor lives in window.state.ui.calendar.cursor ('YYYY-MM-01' string) so the
// visible month survives the full re-render that renderApp() performs.
// Drag-to-reschedule uses makeDraggable (pointer events, NOT HTML5 DnD) so it
// works on touch; dropping a task (from a day cell or the unscheduled rail) onto
// a day calls handlers.onMoveTaskDate(id, ymd).
function renderCalendar(tasks, { onOpenTask, onMoveTaskDate, onAddTask }) {
  const calState = (window.state && window.state.ui && window.state.ui.calendar) || {};
  // Parse the persisted 'YYYY-MM-01' cursor; fall back to the current month.
  function cursorDate() {
    const d = parseISO(calState.cursor);
    if (d) { d.setDate(1); return d; }
    const t = today(); t.setDate(1); return t;
  }
  function setCursor(d) {
    const c = new Date(d.getFullYear(), d.getMonth(), 1);
    calState.cursor = ymd(c);
    redraw();
  }

  const root = h('div', { style: { padding: '20px', height: '100%', display: 'flex', flexDirection: 'column' } });
  const cleanups = [];
  function teardown() { while (cleanups.length) { try { cleanups.pop()(); } catch (_) {} } }

  // Find the day cell currently under the pointer and toggle its .drag-over.
  let dragOverCell = null;
  function highlightAt(x, y) {
    const over = document.elementFromPoint(x, y);
    const cell = over && over.closest ? over.closest('.cal-cell[data-iso]') : null;
    if (cell === dragOverCell) return;
    if (dragOverCell) dragOverCell.classList.remove('drag-over');
    dragOverCell = cell;
    if (dragOverCell) dragOverCell.classList.add('drag-over');
  }
  function clearHighlight() {
    if (dragOverCell) dragOverCell.classList.remove('drag-over');
    dragOverCell = null;
  }
  async function dropAt(x, y, taskId) {
    const over = document.elementFromPoint(x, y);
    const cell = over && over.closest ? over.closest('.cal-cell[data-iso]') : null;
    clearHighlight();
    if (!cell || !taskId) return;
    const iso = cell.dataset.iso;
    try {
      await onMoveTaskDate?.(taskId, iso);
    } catch (err) {
      toast((err && err.message) || 'Could not reschedule task', 'error');
    }
  }

  // Wire a draggable event element so it can be dropped on a day. Returns nothing;
  // pushes a cleanup. `el` is the rendered event/chip, `taskId` the task it moves.
  function wireDrag(el, taskId) {
    el.style.touchAction = 'none';
    cleanups.push(makeDraggable(el, {
      onStart: () => { el.classList.add('dragging'); },
      onMove: (e) => { highlightAt(e.clientX, e.clientY); },
      onDrop: (e) => { el.classList.remove('dragging'); dropAt(e.clientX, e.clientY, taskId); },
    }));
  }

  function redraw() {
    teardown();
    clearHighlight();
    root.replaceChildren();
    const cur = cursorDate();
    const year = cur.getFullYear(), month = cur.getMonth();
    const firstDay = new Date(year, month, 1);
    const startDow = firstDay.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const dayNum = i - startDow + 1;
      const d = new Date(year, month, dayNum);
      cells.push({ date: d, iso: ymd(d), inMonth: dayNum >= 1 && dayNum <= daysInMonth, index: i });
    }
    const firstISO = cells[0].iso, lastISO = cells[cells.length - 1].iso;

    // Bucket single-day tasks (due only) per day; spanning tasks (start_date + due)
    // are laid out separately so they can stretch across cells.
    const tasksByDate = {};
    const spanning = [];
    const unscheduled = [];
    for (const t of tasks) {
      if (!t.due) { unscheduled.push(t); continue; }
      if (t.start_date && t.start_date < t.due) { spanning.push(t); continue; }
      (tasksByDate[t.due] = tasksByDate[t.due] || []).push(t);
    }

    const todayISO = ymd(today());
    const monthName = firstDay.toLocaleDateString('en', { month: 'long', year: 'numeric' });
    const dow = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

    // ---- Header ----
    root.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' } },
      h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: '600', letterSpacing: '-0.02em' } }, monthName),
      h('div', { class: 'hstack', style: { gap: '2px' } },
        h('button', { class: 'icon-btn', 'aria-label': 'Previous month',
          onClick: () => setCursor(new Date(year, month - 1, 1)) }, Icon('chevronLeft', 14)),
        h('button', { class: 'btn btn-ghost', style: { padding: '4px 10px', fontSize: '12px' },
          onClick: () => { const d = today(); d.setDate(1); setCursor(d); } }, 'Today'),
        h('button', { class: 'icon-btn', 'aria-label': 'Next month',
          onClick: () => setCursor(new Date(year, month + 1, 1)) }, Icon('chevronRight', 14)),
      ),
    ));

    // Wrapper holds the grid + the unscheduled rail side-by-side.
    const wrap = h('div', { class: 'cal-wrap', style: { display: 'flex', gap: '14px', flex: 1, minHeight: 0 } });

    // ---- Event renderer (single-day) ----
    const renderEvent = (t, opts = {}) => {
      const proj = projectById(t.project);
      const done = t.status === 'done';
      const el = h('div', {
        class: 'cal-event' + (done ? ' done' : ''),
        tabIndex: 0,
        role: 'button',
        title: t.title + (t.comments ? ` · ${t.comments} comment${t.comments === 1 ? '' : 's'}` : ''),
        style: proj ? {
          background: proj.color + '18', color: proj.color,
          borderLeft: '2px solid ' + proj.color
        } : {},
        onClick: (e) => { e.stopPropagation(); onOpenTask(t.id); },
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenTask(t.id); }
        },
      },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, t.title),
        t.comments > 0 ? h('span', { style: { marginLeft: '4px', fontSize: '10px', opacity: '0.8' } },
          Icon('message', 10), ' ' + t.comments) : null,
      );
      if (!opts.noDrag) wireDrag(el, t.id);
      return el;
    };

    // ---- Spanning bar renderer (start_date -> due) ----
    // Renders a bar inside `cell` clipped to the visible range; marked as a start
    // and/or end segment so CSS can round the right edges. We render one segment
    // per week-row the span covers (segments share the same task).
    const renderSpanSegment = (t, isStart, isEnd) => {
      const proj = projectById(t.project);
      const done = t.status === 'done';
      const el = h('div', {
        class: 'cal-event cal-span' + (done ? ' done' : '')
          + (isStart ? ' span-start' : '') + (isEnd ? ' span-end' : ''),
        tabIndex: 0,
        role: 'button',
        title: t.title + ` (${t.start_date} → ${t.due})`,
        style: proj ? {
          background: proj.color + '22', color: proj.color,
          borderLeft: (isStart ? '2px solid ' + proj.color : '2px solid transparent'),
        } : {},
        onClick: (e) => { e.stopPropagation(); onOpenTask(t.id); },
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenTask(t.id); }
        },
      },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } },
          isStart ? t.title : '…'),
      );
      // Dragging a span moves its due date (consistent with single-day events).
      wireDrag(el, t.id);
      return el;
    };

    // ---- Grid ----
    const grid = h('div', { class: 'cal-grid' });
    for (const d of dow) grid.appendChild(h('div', { class: 'cal-dow' }, d));

    const cellByIso = {};
    cells.forEach((c, i) => {
      const iso = c.iso;
      const dayTasks = tasksByDate[iso] || [];
      const isToday = iso === todayISO;
      const cell = h('div', {
        class: 'cal-cell' + (c.inMonth ? '' : ' not-in-month') + (i >= 35 ? ' last-row' : ''),
        'data-iso': iso,
      });
      cellByIso[iso] = cell;

      // Click an empty area of the day to quick-add a task due that day.
      cell.addEventListener('click', (e) => {
        if (e.target.closest('.cal-event')) return;            // a real event was clicked
        if (e.target.closest('button')) return;                // "+N more" etc.
        onAddTask?.('todo', { due: iso });
      });

      cell.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' } },
        h('span', { class: 'cal-daynum' + (isToday ? ' today' : '') }, String(c.date.getDate())),
      ));

      for (const t of dayTasks.slice(0, 3)) cell.appendChild(renderEvent(t));
      if (dayTasks.length > 3) {
        const more = h('button', {
          class: 'cal-more',
          style: {
            fontSize: '10.5px', color: 'var(--fg-2)', padding: '1px 6px',
            cursor: 'pointer', textAlign: 'left', borderRadius: '4px',
            background: 'var(--bg-3)', border: '1px solid var(--line)',
          },
          onClick: (e) => {
            e.stopPropagation();
            openPopover(more, ({ close }) => {
              const list = h('div', { style: { padding: '4px', minWidth: '240px' } });
              list.appendChild(h('div', { class: 'popover-header' },
                c.date.toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' })));
              for (const t of dayTasks) {
                const ev = renderEvent(t, { noDrag: true });
                ev.addEventListener('click', () => close());
                list.appendChild(ev);
              }
              return list;
            });
          },
        }, `+${dayTasks.length - 3} more`);
        cell.appendChild(more);
      }
      grid.appendChild(cell);
    });

    // ---- Spanning bars: place one segment in the start-of-week cell of each row
    // the span touches, within the visible window. ----
    for (const t of spanning) {
      const s = t.start_date < firstISO ? firstISO : t.start_date;
      const e = t.due > lastISO ? lastISO : t.due;
      if (e < firstISO || s > lastISO) continue;               // entirely off-screen
      const sIdx = cells.findIndex(c => c.iso === s);
      const eIdx = cells.findIndex(c => c.iso === e);
      if (sIdx < 0 || eIdx < 0) continue;
      // Walk week-rows (7-day chunks). For each row segment, span columns via CSS.
      let segStart = sIdx;
      while (segStart <= eIdx) {
        const rowEnd = Math.floor(segStart / 7) * 7 + 6;
        const segEnd = Math.min(eIdx, rowEnd);
        const colSpan = segEnd - segStart + 1;
        const isStart = segStart === sIdx && t.start_date >= firstISO;
        const isEnd = segEnd === eIdx && t.due <= lastISO;
        const seg = renderSpanSegment(t, isStart, isEnd);
        seg.style.width = `calc(${colSpan * 100}% + ${(colSpan - 1) * 7}px)`;
        seg.style.maxWidth = 'none';
        seg.style.position = 'relative';
        seg.style.zIndex = '1';
        const host = cells[segStart].iso;
        if (cellByIso[host]) cellByIso[host].appendChild(seg);
        segStart = segEnd + 1;
      }
    }

    wrap.appendChild(grid);

    // ---- Unscheduled rail ----
    const rail = h('div', { class: 'cal-rail',
      style: {
        flex: '0 0 200px', minWidth: 0, display: 'flex', flexDirection: 'column',
        gap: '6px', overflowY: 'auto', borderLeft: '1px solid var(--line)', paddingLeft: '12px',
      },
    });
    rail.appendChild(h('div', {
      style: { fontSize: '10.5px', color: 'var(--fg-3)', fontWeight: '600', letterSpacing: '0.06em', marginBottom: '2px' },
    }, `UNSCHEDULED (${unscheduled.length})`));
    if (!unscheduled.length) {
      rail.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--fg-3)' } },
        'Nothing unscheduled. Drag an event to a day to reschedule it.'));
    }
    for (const t of unscheduled) {
      const proj = projectById(t.project);
      const done = t.status === 'done';
      const chip = h('div', {
        class: 'cal-event cal-unscheduled' + (done ? ' done' : ''),
        tabIndex: 0,
        role: 'button',
        title: t.title + ' — drag onto a day to set its due date',
        style: proj ? {
          background: proj.color + '18', color: proj.color,
          borderLeft: '2px solid ' + proj.color,
        } : {},
        onClick: (e) => { e.stopPropagation(); onOpenTask(t.id); },
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenTask(t.id); }
        },
      },
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, t.title),
      );
      wireDrag(chip, t.id);
      rail.appendChild(chip);
    }
    wrap.appendChild(rail);

    root.appendChild(wrap);
  }

  redraw();
  return root;
}

window.renderCalendar = renderCalendar;
