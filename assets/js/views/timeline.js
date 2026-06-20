// Gantt / timeline view.
// Rows grouped by project (then milestone within project). Horizontal bars span
// start_date -> due (single-day marker if only due is set). Bars drag
// horizontally to reschedule (preserving duration when start_date is present),
// dependency links are drawn between visible bars, and the day/week axis zooms
// between 'week' and 'month' granularity. All date math is local wall-clock.

const TL_DAY_MS = 86400000;

// Map a task status to one of the .tl-bar color classes defined in app.css.
// Neutral statuses (backlog/todo) fall through to the default bar styling.
const TL_STATUS_CLASS = {
  in_progress: 'amber',
  review: 'violet',
  done: 'green',
};

// Days between two YYYY-MM-DD strings (or Date objects), local wall-clock.
function tlDayDiff(a, b) {
  const da = a instanceof Date ? a : parseISO(a);
  const db = b instanceof Date ? b : parseISO(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / TL_DAY_MS);
}

// A YYYY-MM-DD string `n` days after a Date, local wall-clock (no toISOString).
function tlAddDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  return ymd(d);
}

function renderTimeline(tasks, handlers = {}) {
  const { onOpenTask, onMoveTaskDate } = handlers;

  // --- view state (lifted to state.ui.timeline so it survives renderApp) ---
  const ui = (window.state.ui = window.state.ui || {});
  const tl = (ui.timeline = ui.timeline || {});
  if (tl.zoom !== 'week' && tl.zoom !== 'month') tl.zoom = 'week';
  if (!tl.cursor || isNaN(parseISO(tl.cursor)?.getTime?.())) tl.cursor = ymd(today());

  const root = h('div', { style: { padding: '20px', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } });

  function persist() {
    try { localStorage.setItem('pm_timeline', JSON.stringify(tl)); } catch (_) {}
  }

  function redraw() {
    root.replaceChildren();

    // --- window: a run of days starting at the cursor ---
    // week zoom => one day per column; month zoom => one day per column but a
    // wider span and weekly axis labels. Columns are always day-granular so bar
    // geometry stays simple; the axis just labels differently.
    const days = tl.zoom === 'week' ? 28 : 84;       // 4 weeks vs 12 weeks
    const start = parseISO(tl.cursor);
    start.setDate(start.getDate() - start.getDay()); // align to Sunday
    const startISO = ymd(start);
    const colW = 100 / days;                          // % per day
    const todayISO = ymd(today());

    // ---------- header / controls ----------
    const shift = (n) => { const d = parseISO(tl.cursor); d.setDate(d.getDate() + n); tl.cursor = ymd(d); persist(); redraw(); };
    const rangeLabel = start.toLocaleDateString('en', { month: 'short', day: 'numeric' })
      + ' – ' + new Date(start.getFullYear(), start.getMonth(), start.getDate() + days - 1)
        .toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });

    const zoomBtn = (z, label) => h('button', {
      class: 'btn btn-ghost' + (tl.zoom === z ? ' active' : ''),
      style: { padding: '4px 10px', fontSize: '12px', fontWeight: tl.zoom === z ? '600' : '400',
        background: tl.zoom === z ? 'var(--bg-4)' : undefined },
      onClick: () => { if (tl.zoom !== z) { tl.zoom = z; persist(); redraw(); } },
    }, label);

    root.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' } },
      h('h2', { style: { margin: 0, fontSize: '18px', fontWeight: '600', letterSpacing: '-0.02em' } }, 'Timeline'),
      h('span', { style: { fontSize: '12.5px', color: 'var(--fg-3)' } }, rangeLabel),
      h('div', { class: 'hstack', style: { gap: '2px' } },
        h('button', { class: 'icon-btn', title: 'Previous', onClick: () => shift(tl.zoom === 'week' ? -7 : -28) }, Icon('chevronLeft', 14)),
        h('button', { class: 'btn btn-ghost', style: { padding: '4px 10px', fontSize: '12px' },
          onClick: () => { tl.cursor = ymd(today()); persist(); redraw(); } }, 'Today'),
        h('button', { class: 'icon-btn', title: 'Next', onClick: () => shift(tl.zoom === 'week' ? 7 : 28) }, Icon('chevronRight', 14)),
      ),
      h('div', { class: 'hstack', style: { gap: '2px', marginLeft: 'auto', border: '1px solid var(--line)', borderRadius: '7px', padding: '2px' } },
        zoomBtn('week', 'Week'), zoomBtn('month', 'Month'),
      ),
    ));

    // ---------- bucket tasks into project -> milestone -> tasks ----------
    const scheduled = tasks.filter(t => t.start_date || t.due);
    const unscheduled = tasks.filter(t => !t.start_date && !t.due);

    if (scheduled.length === 0) {
      root.appendChild(h('div', { class: 'empty-cta', style: { margin: 'auto', textAlign: 'center', color: 'var(--fg-3)' } },
        Icon('calendar', 28),
        h('div', { style: { fontSize: '15px', fontWeight: '600', color: 'var(--fg-1)', marginTop: '10px' } }, 'Nothing scheduled yet'),
        h('div', { style: { fontSize: '12.5px', marginTop: '4px' } }, 'Give tasks a start or due date to see them on the timeline.'),
      ));
      return;
    }

    // group by project (preserve project list order), then by milestone.
    const projOrder = window.state.projects.map(p => p.id);
    const byProject = new Map();
    for (const t of scheduled) {
      const pid = t.project;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(t);
    }
    const orderedPids = [...byProject.keys()].sort((a, b) => {
      const ia = projOrder.indexOf(a), ib = projOrder.indexOf(b);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });

    const milestones = window.state.milestones || [];

    // ---------- scrollable body (axis + rows share one horizontal scroll) ----
    const scroll = h('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } });
    const timeline = h('div', { class: 'timeline', style: { minWidth: tl.zoom === 'month' ? '900px' : '640px' } });

    // Axis: one cell per "tick". Week zoom labels every day; month zoom labels
    // the start of each week (every 7 days) to avoid clutter.
    const axis = h('div', { class: 'tl-axis' });
    axis.appendChild(h('div', { class: 'tl-axis-cell', style: { flex: '0 0 200px', textAlign: 'left' } }, 'PROJECT / TASK'));
    const ticks = h('div', { class: 'tl-axis', style: { flex: 1, border: 'none' } });
    if (tl.zoom === 'week') {
      for (let i = 0; i < days; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const iso = ymd(d);
        ticks.appendChild(h('div', { class: 'tl-axis-cell' + (iso === todayISO ? ' is-today' : ''), style: { flex: `0 0 ${colW}%` } },
          h('div', null, d.toLocaleDateString('en', { weekday: 'narrow' })),
          h('div', { style: { fontSize: '11px', color: 'var(--fg-2)' } }, String(d.getDate())),
        ));
      }
    } else {
      for (let i = 0; i < days; i += 7) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        ticks.appendChild(h('div', { class: 'tl-axis-cell', style: { flex: `0 0 ${colW * 7}%` } },
          d.toLocaleDateString('en', { month: 'short', day: 'numeric' })));
      }
    }
    axis.style.display = 'flex';
    axis.appendChild(ticks);
    timeline.appendChild(axis);

    // Track bar elements + their on-screen geometry so we can draw dep links.
    // geom: id -> { left, right, top } in px relative to the grid layer.
    const barEls = new Map();
    const gridLayers = []; // one overlay per row's grid for dep links

    // Today marker as a vertical accent line over each grid.
    const todayOffset = tlDayDiff(start, today()); // days from window start

    function makeGrid() {
      const grid = h('div', { class: 'tl-grid', style: {
        backgroundSize: `${colW}% 100%`,
      } });
      if (todayOffset >= 0 && todayOffset < days) {
        grid.appendChild(h('div', { style: {
          position: 'absolute', top: 0, bottom: 0, left: (todayOffset * colW) + '%',
          width: '2px', background: 'var(--acc-1)', opacity: '0.5', pointerEvents: 'none', zIndex: '1',
        } }));
      }
      return grid;
    }

    // ---------- render a single task row ----------
    function taskRow(t) {
      const row = h('div', { class: 'tl-row' });
      const proj = projectById(t.project);
      row.appendChild(h('div', { class: 'tl-label', title: `${t.ref} ${t.title}`, style: { paddingLeft: '28px' } },
        proj ? h('span', { style: { display: 'inline-block', width: '7px', height: '7px', borderRadius: '2px',
          background: proj.color, marginRight: '6px' } }) : null,
        t.title,
      ));

      const grid = makeGrid();

      // resolve bar span in days from window start.
      // - both start_date & due: [start, due]
      // - due only: single day at due
      // - start only: single day at start
      const sISO = t.start_date || t.due;
      const eISO = t.due || t.start_date;
      let s = parseISO(sISO), e = parseISO(eISO);
      if (s > e) { const tmp = s; s = e; e = tmp; }            // guard inverted
      const offset = tlDayDiff(start, s);                      // days from window start
      const span = tlDayDiff(s, e) + 1;                        // inclusive day count
      const dueOnly = !t.start_date && !!t.due;

      // skip bars entirely outside the window (still render the row label).
      if (offset + span > 0 && offset < days) {
        const leftPct = Math.max(0, offset) * colW;
        const visSpan = Math.min(offset + span, days) - Math.max(0, offset);
        const widthPct = Math.max(colW * 0.9, visSpan * colW);

        const statusCls = TL_STATUS_CLASS[t.status] || '';
        const overdue = t.due && t.status !== 'done' && parseISO(t.due) < today();
        const blocked = Array.isArray(t.blocked_by) && t.blocked_by.length > 0;

        const bar = h('div', {
          class: 'tl-bar' + (statusCls ? ' ' + statusCls : '') + (t.status === 'done' ? ' done' : '')
            + (overdue ? ' red' : '') + (blocked ? ' blocked' : ''),
          tabindex: '0', role: 'button',
          'aria-label': `${t.ref} ${t.title}` + (blocked ? ' (blocked)' : ''),
          'data-id': String(t.id),
          title: `${t.ref} · ${t.title}\n${sISO}${dueOnly ? '' : ' → ' + eISO}` + (blocked ? '\nBlocked by another task' : ''),
          style: {
            left: leftPct + '%', width: widthPct + '%',
            // distinct edge for blocked bars even when status color applies.
            boxShadow: blocked ? 'inset 3px 0 0 var(--red)' : undefined,
          },
        }, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, dueOnly ? t.ref : t.title));

        // open on click (suppressed if a drag happened) and keyboard.
        let dragged = false;
        bar.addEventListener('click', () => { if (!dragged) onOpenTask?.(t.id); });
        bar.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpenTask?.(t.id); }
        });

        // ---- horizontal drag to reschedule ----
        // Translate pixel delta -> whole-day delta using the grid's pixel width.
        // Delta is measured from where the pointer first went down so grabbing
        // the bar anywhere doesn't cause an initial jump.
        let pxPerDay = 0, anchorX = 0, dayDelta = 0;
        makeDraggable(bar, {
          onStart: (ev) => {
            dragged = false;
            const gridRect = grid.getBoundingClientRect();
            pxPerDay = gridRect.width / days || 1;
            anchorX = ev.clientX;
            dayDelta = 0;
            bar.classList.add('dragging');
          },
          onMove: (ev) => {
            if (!pxPerDay) return;
            dayDelta = Math.round((ev.clientX - anchorX) / pxPerDay);
            if (dayDelta !== 0) dragged = true;
            bar.style.transform = `translateY(-50%) translateX(${dayDelta * pxPerDay}px)`;
          },
          onDrop: async () => {
            bar.classList.remove('dragging');
            bar.style.transform = '';
            if (!dayDelta) return;
            try {
              if (t.start_date && t.due) {
                // preserve duration: shift both ends by dayDelta.
                const ns = tlAddDays(parseISO(t.start_date), dayDelta);
                const nd = tlAddDays(parseISO(t.due), dayDelta);
                await API.updateTask(t.id, { start_date: ns, due: nd });
                window.pmRefreshTasks?.();
              } else {
                // due-only (or start-only): move the single anchor day.
                const anchor = t.due || t.start_date;
                const nd = tlAddDays(parseISO(anchor), dayDelta);
                if (t.due) {
                  await onMoveTaskDate?.(t.id, nd);
                } else {
                  await API.updateTask(t.id, { start_date: nd });
                  window.pmRefreshTasks?.();
                }
              }
            } catch (err) {
              toast(err.message || 'Could not reschedule task', 'error');
              redraw();
            }
          },
        });

        grid.appendChild(bar);
        barEls.set(t.id, { bar, grid });
      }

      row.appendChild(grid);
      gridLayers.push(grid);
      return row;
    }

    // ---------- emit rows grouped by project -> milestone ----------
    for (const pid of orderedPids) {
      const proj = projectById(pid);
      const list = byProject.get(pid);

      timeline.appendChild(h('div', { class: 'tl-row tl-group' },
        h('div', { class: 'tl-label' },
          proj ? h('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px',
            background: proj.color, marginRight: '7px' } }) : null,
          proj ? proj.name : 'No project',
        ),
        makeGrid(),
      ));

      // partition this project's tasks by milestone (ordered by sort_order/due).
      const projMs = milestones.filter(m => m.project_id == pid)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      const byMs = new Map();
      const noMs = [];
      for (const t of list) {
        if (t.milestone_id && projMs.some(m => m.id == t.milestone_id)) {
          if (!byMs.has(t.milestone_id)) byMs.set(t.milestone_id, []);
          byMs.get(t.milestone_id).push(t);
        } else noMs.push(t);
      }

      for (const m of projMs) {
        const mTasks = byMs.get(m.id);
        if (!mTasks || !mTasks.length) continue;
        timeline.appendChild(h('div', { class: 'tl-row tl-group' },
          h('div', { class: 'tl-label', style: { paddingLeft: '24px', fontWeight: '500', color: 'var(--fg-1)' } },
            Icon('target', 12), ' ' + m.name),
          makeGrid(),
        ));
        for (const t of mTasks) timeline.appendChild(taskRow(t));
      }
      for (const t of noMs) timeline.appendChild(taskRow(t));
    }

    scroll.appendChild(timeline);
    root.appendChild(scroll);

    // Unscheduled note (kept out of the grid; they have no dates to place).
    if (unscheduled.length) {
      root.appendChild(h('div', { style: { marginTop: '10px', fontSize: '11.5px', color: 'var(--fg-3)' } },
        `${unscheduled.length} task${unscheduled.length === 1 ? '' : 's'} without dates are not shown — add a start or due date to schedule.`));
    }

    // ---------- dependency links (drawn after layout) ----------
    // For each visible task that is blocked_by a visible task, draw a thin
    // connector from the source bar's right edge to the target bar's left edge.
    // Geometry simplification: links are absolutely positioned over the whole
    // timeline using getBoundingClientRect deltas; we render them in a single
    // overlay so they don't perturb row layout. If a referenced task isn't
    // visible we simply skip it (the .blocked edge on the bar still flags it).
    requestAnimationFrame(() => {
      const tlRect = timeline.getBoundingClientRect();
      const overlay = h('div', { style: {
        position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3',
      } });
      let drew = false;
      for (const t of scheduled) {
        if (!Array.isArray(t.blocked_by) || !t.blocked_by.length) continue;
        const dst = barEls.get(t.id);
        if (!dst) continue;
        for (const depId of t.blocked_by) {
          const src = barEls.get(depId);
          if (!src) continue; // referenced task not visible — skip safely.
          const sr = src.bar.getBoundingClientRect();
          const dr = dst.bar.getBoundingClientRect();
          const x1 = sr.right - tlRect.left;
          const y1 = sr.top + sr.height / 2 - tlRect.top;
          const x2 = dr.left - tlRect.left;
          const y2 = dr.top + dr.height / 2 - tlRect.top;
          // Simple two-segment connector: horizontal stub from source, then a
          // straight dashed line to the target's left-middle. We approximate
          // with one rotated dashed segment (good enough; arrow via ::after).
          const dx = x2 - x1, dy = y2 - y1;
          const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
          const ang = Math.atan2(dy, dx) * 180 / Math.PI;
          overlay.appendChild(h('div', { class: 'tl-dep', style: {
            left: x1 + 'px', top: y1 + 'px', width: len + 'px',
            transform: `rotate(${ang}deg)`, transformOrigin: '0 0',
          } }));
          drew = true;
        }
      }
      if (drew) {
        timeline.style.position = timeline.style.position || 'relative';
        timeline.appendChild(overlay);
      }
    });
  }

  redraw();
  return root;
}

window.renderTimeline = renderTimeline;
