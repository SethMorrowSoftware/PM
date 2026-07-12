// Workload / team-capacity view.
//
// One card per teammate (plus an "Unassigned" pseudo-card) summarising what's on
// each person's plate: open / in-progress / overdue / due-this-week counts, a
// stacked status-breakdown bar (colours from window.STATUSES, mirroring the
// dashboard's inline bar pattern), and a time-logged total with an optional
// estimate-vs-logged hint.
//
// Design notes / honesty:
//  - Sorted by open-task count desc so the most-loaded people surface first.
//  - "Overdue" / "due this week" use the local-wall-clock helpers (today() /
//    parseISO() / daysFromNow()), never toISOString() — same rule as ui.js, so a
//    task due "today" reads the same regardless of the viewer's timezone.
//  - `estimate` is free-text ("6h", "90m", "1h 30m", "1.5h", a bare number =>
//    hours). parseEstimate() is best-effort; if it can't parse, we just show the
//    logged time with no ratio rather than invent an estimate.
//  - Clicking a row focuses that person's work: it sets window.state.filterAssignee
//    then navigates to the List view (which applies the filter). The Unassigned
//    row has no user id to filter on, so it isn't clickable.
function renderWorkload(tasks, handlers) {
  handlers = handlers || {};
  const onNavigate = handlers.onNavigate || (() => {});
  const t = today();
  const weekEnd = parseISO(daysFromNow(7)); // exclusive-ish upper bound, 7 days out

  // Best-effort parse of a free-text estimate to minutes. Returns null if we
  // can't make sense of it (so callers can choose to omit the hint).
  function parseEstimate(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return raw > 0 ? Math.round(raw * 60) : null; // bare number => hours
    const s = String(raw).trim().toLowerCase();
    if (!s) return null;
    // Bare numeric string (possibly decimal) => hours, e.g. "1.5".
    if (/^\d+(\.\d+)?$/.test(s)) { const n = parseFloat(s); return n > 0 ? Math.round(n * 60) : null; }
    // Otherwise sum up any <num><unit> tokens we recognise (d/h/m).
    let mins = 0, matched = false;
    const re = /(\d+(?:\.\d+)?)\s*(d|h|m|hr|hrs|min|mins|hour|hours|day|days|minute|minutes)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const val = parseFloat(m[1]);
      const unit = m[2];
      if (!isFinite(val)) continue;
      if (unit === 'd' || unit === 'day' || unit === 'days') mins += val * 60 * 8; // 8h working day
      else if (unit[0] === 'h') mins += val * 60;
      else mins += val; // minutes
      matched = true;
    }
    return matched && mins > 0 ? Math.round(mins) : null;
  }

  // Compute per-bucket metrics for an arbitrary slice of tasks.
  function metricsFor(slice) {
    const open = slice.filter(x => x.status !== 'done');
    const inProgress = slice.filter(x => x.status === 'in_progress');
    const overdue = open.filter(x => x.due && parseISO(x.due) < t);
    const dueWeek = open.filter(x => {
      if (!x.due) return false;
      const d = parseISO(x.due);
      return d >= t && d < weekEnd;
    });
    const logged = slice.reduce((n, x) => n + (Number(x.time_logged) || 0), 0);
    const estTotal = slice.reduce((n, x) => {
      const e = parseEstimate(x.estimate);
      return e != null ? n + e : n;
    }, 0);
    // status breakdown over the whole slice (all statuses, for the stacked bar)
    const byStatus = (window.STATUSES || []).map(s => ({
      ...s, count: slice.filter(x => x.status === s.id).length,
    }));
    return { total: slice.length, open, inProgress, overdue, dueWeek, logged, estTotal, byStatus };
  }

  // ---- Build per-user rows -------------------------------------------------
  const users = (window.state.users || []).filter(u => u && !u.archived);
  const rows = users.map(u => {
    const slice = tasks.filter(x => Array.isArray(x.assignees) && x.assignees.includes(u.id));
    return { user: u, m: metricsFor(slice) };
  });

  // Unassigned pseudo-row (tasks with no assignees at all).
  const unassignedTasks = tasks.filter(x => !Array.isArray(x.assignees) || x.assignees.length === 0);
  const unassignedRow = { user: null, m: metricsFor(unassignedTasks) };

  // Sort real users by open-task count desc, then by name for stability.
  rows.sort((a, b) =>
    (b.m.open.length - a.m.open.length) ||
    String(a.user.name || '').localeCompare(String(b.user.name || '')));

  // Append Unassigned at the bottom if it carries any tasks.
  const allRows = rows.slice();
  if (unassignedRow.m.total > 0) allRows.push(unassignedRow);

  // Totals for the summary strip.
  const totalOpen = tasks.filter(x => x.status !== 'done').length;
  const totalOverdue = tasks.filter(x => x.status !== 'done' && x.due && parseISO(x.due) < t).length;
  const totalUnassigned = unassignedTasks.length;
  // Busiest open count for proportional gauges.
  const maxOpen = Math.max(1, ...rows.map(r => r.m.open.length), unassignedRow.m.open.length);

  // ---- Render --------------------------------------------------------------
  const root = h('div', { style: { padding: '24px', display: 'grid', gap: '20px' } });

  // Header + summary strip.
  root.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px', flexWrap: 'wrap' } },
    h('div', null,
      h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600', marginBottom: '6px' } }, 'Team capacity'),
      h('h1', { style: { margin: 0, fontSize: '24px', fontWeight: '700', letterSpacing: '-0.02em' } }, 'Workload'),
      h('p', { style: { margin: '6px 0 0', color: 'var(--fg-2)', fontSize: '14px' } },
        `${users.length} ${users.length === 1 ? 'person' : 'people'} across ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} in view.`),
    ),
    h('div', { class: 'hstack', style: { gap: '10px', flexWrap: 'wrap' } },
      SummaryStat('Open', totalOpen, 'checkSquare', 'var(--acc-1)'),
      SummaryStat('Overdue', totalOverdue, 'alert', totalOverdue > 0 ? 'var(--red-fg)' : 'var(--fg-3)'),
      SummaryStat('Unassigned', totalUnassigned, 'user', totalUnassigned > 0 ? 'var(--amber-fg)' : 'var(--fg-3)'),
    ),
  ));

  // Loading state: state.tasks not yet hydrated. (tasks is the filtered slice;
  // when the app is still loading there are simply no users and no tasks.)
  if (!window.state.users || window.state.users.length === 0) {
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'empty', style: { padding: '48px 20px' } }, 'Loading team…')));
    return root;
  }

  // Empty state: nobody has any tasks in the current filter.
  if (allRows.length === 0 || allRows.every(r => r.m.total === 0)) {
    root.appendChild(h('div', { class: 'card' },
      h('div', { class: 'empty', style: { padding: '48px 20px' } },
        Icon('inbox', 26),
        h('div', { style: { marginTop: '10px' } }, 'No tasks match the current filters.'))));
    return root;
  }

  // Cards grid.
  const grid = h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' } });
  for (const r of allRows) grid.appendChild(WorkloadCard(r, maxOpen, onNavigate, parseEstimate));
  root.appendChild(grid);

  return root;
}

// Small labelled number used in the top summary strip.
function SummaryStat(label, value, icon, color) {
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: '8px',
      background: 'var(--bg-2)', border: '1px solid var(--line)',
      borderRadius: '10px', padding: '8px 12px',
    },
  },
    h('span', { style: { color, display: 'grid', placeItems: 'center' } }, Icon(icon, 15)),
    h('div', null,
      h('div', { class: 'mono', style: { fontSize: '17px', fontWeight: '700', lineHeight: '1', color: 'var(--fg-0)' } }, String(value)),
      h('div', { style: { fontSize: '10.5px', color: 'var(--fg-3)', marginTop: '2px', letterSpacing: '0.02em' } }, label),
    ),
  );
}

// One teammate (or Unassigned) card.
function WorkloadCard(row, maxOpen, onNavigate, parseEstimate) {
  const { user, m } = row;
  const isUnassigned = !user;
  const name = isUnassigned ? 'Unassigned' : (user.name || 'Unknown');
  const role = isUnassigned ? `${m.total} ${m.total === 1 ? 'task' : 'tasks'} with no owner` : (user.role || 'No role set');

  // Clickable only for real users (we set filterAssignee then navigate to List).
  const clickable = !isUnassigned;
  const focus = () => {
    if (!clickable) return;
    window.state.filterAssignee = user.id;
    onNavigate('list');
  };

  const card = h('div', {
    class: 'card',
    role: clickable ? 'button' : undefined,
    tabIndex: clickable ? 0 : undefined,
    'aria-label': clickable ? `Show ${name}'s tasks in the list view` : undefined,
    style: { padding: '0', cursor: clickable ? 'pointer' : 'default', display: 'flex', flexDirection: 'column' },
    onClick: focus,
    onKeydown: clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focus(); } } : undefined,
  });

  // Header: avatar + name + role, with open-count badge on the right.
  const head = h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px 12px' } });
  head.appendChild(isUnassigned
    ? h('div', {
        class: 'avatar',
        style: { width: '36px', height: '36px', fontSize: '13px', background: 'var(--bg-4)', color: 'var(--fg-3)', display: 'grid', placeItems: 'center' },
        title: 'Unassigned',
      }, Icon('user', 16))
    : Avatar(user, 36));
  head.appendChild(h('div', { style: { flex: 1, minWidth: 0 } },
    h('div', { style: { fontSize: '14.5px', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
    h('div', { style: { fontSize: '11.5px', color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, role),
  ));
  head.appendChild(h('div', { style: { textAlign: 'right' } },
    h('div', { class: 'mono', style: { fontSize: '20px', fontWeight: '700', lineHeight: '1', color: 'var(--fg-0)' } }, String(m.open.length)),
    h('div', { style: { fontSize: '10px', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: '2px' } }, 'open'),
  ));
  card.appendChild(head);

  // Body.
  const body = h('div', { style: { padding: '0 16px 16px', display: 'grid', gap: '12px' } });

  // Metric chips: in progress / overdue / due this week.
  body.appendChild(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
    MetricChip('In progress', m.inProgress.length, '#F59E0B'),
    MetricChip('Overdue', m.overdue.length, m.overdue.length > 0 ? 'var(--red-fg)' : 'var(--fg-3)'),
    MetricChip('Due this week', m.dueWeek.length, m.dueWeek.length > 0 ? 'var(--amber-fg)' : 'var(--fg-3)'),
  ));

  // Stacked status-breakdown bar (mirrors dashboard's bar pattern). Omitted when
  // the person has no tasks at all.
  if (m.total > 0) {
    const bar = h('div', { style: { display: 'flex', height: '8px', borderRadius: '4px', overflow: 'hidden', background: 'var(--bg-3)' } });
    for (const s of m.byStatus) {
      if (!s.count) continue;
      bar.appendChild(h('div', {
        title: `${s.name}: ${s.count}`,
        style: { width: (s.count / m.total) * 100 + '%', background: s.color, transition: 'width 0.3s' },
      }));
    }
    body.appendChild(bar);

    // Legend: only statuses the person actually has.
    const legend = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 14px' } });
    for (const s of m.byStatus) {
      if (!s.count) continue;
      legend.appendChild(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--fg-2)' } },
        h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: s.color } }),
        h('span', null, s.name),
        h('span', { class: 'mono', style: { color: 'var(--fg-3)' } }, String(s.count)),
      ));
    }
    body.appendChild(legend);
  } else {
    body.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', padding: '4px 0' } }, 'No tasks assigned.'));
  }

  // Time logged + estimate-vs-logged hint.
  const timeRow = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', paddingTop: '2px', borderTop: '1px solid var(--line)' } });
  timeRow.appendChild(h('span', { class: 'hstack', style: { gap: '6px', alignItems: 'center', fontSize: '12px', color: 'var(--fg-2)' } },
    Icon('clock', 13),
    h('span', null, 'Time logged')));
  if (m.estTotal > 0) {
    const pct = Math.round((m.logged / m.estTotal) * 100);
    const over = m.logged > m.estTotal;
    timeRow.appendChild(h('span', { class: 'mono', style: { fontSize: '12px', color: over ? 'var(--red-fg)' : 'var(--fg-1)' } },
      `${fmtMinutes(m.logged)} / ${fmtMinutes(m.estTotal)} (${pct}%)`));
  } else {
    timeRow.appendChild(h('span', { class: 'mono', style: { fontSize: '12px', color: 'var(--fg-1)' } }, fmtMinutes(m.logged)));
  }
  timeRow.style.marginTop = '4px';
  timeRow.style.paddingTop = '10px';
  body.appendChild(timeRow);

  // Estimate progress gauge (only when we have an estimate to compare against).
  if (m.estTotal > 0) {
    const ratio = Math.min(1, m.logged / m.estTotal);
    const over = m.logged > m.estTotal;
    body.appendChild(h('div', { style: { height: '6px', background: 'var(--bg-3)', borderRadius: '3px', overflow: 'hidden' } },
      h('div', { style: {
        width: (ratio * 100) + '%', height: '100%',
        background: over ? 'var(--red)' : 'var(--acc-1)',
        borderRadius: '3px', transition: 'width 0.5s',
      } })));
  }

  card.appendChild(body);
  return card;
}

// Small bordered metric chip: value + label, value tinted by `color`.
function MetricChip(label, value, color) {
  return h('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: '1px',
      flex: '1 1 0', minWidth: '0',
      background: 'var(--bg-3)', border: '1px solid var(--line)',
      borderRadius: '8px', padding: '7px 9px',
    },
  },
    h('span', { class: 'mono', style: { fontSize: '16px', fontWeight: '700', lineHeight: '1', color } }, String(value)),
    h('span', { style: { fontSize: '10.5px', color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
  );
}

window.renderWorkload = renderWorkload;
