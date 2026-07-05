// Dashboard view.
//
// Metrics philosophy: trend arrows show REAL this-week-vs-last-week deltas, not
// decoration. Where a metric has no honest historical signal we omit the arrow
// (pass trend=null) rather than fake a direction. Server timestamps are UTC
// "YYYY-MM-DD HH:MM:SS"; localDate() converts one to a local YYYY-MM-DD so the
// bucketing matches the user's wall clock (consistent with ui.js date helpers).
//
// NOTE: there is no `done_at`/`completed_at` column, so "completed" timing is
// approximated by `updated_at` of tasks whose status is currently `done`. That's
// the most honest signal available without a schema change; re-opening a task
// would drop it from the completed series, which is acceptable for a dashboard.
//
// CUSTOMIZABLE LAYOUT (v2.x): the body widgets below (everything except the
// always-on greeting + stat-cards header) live in a named registry. Users can
// show/hide and reorder them; the layout persists in localStorage['pm_dash_layout']
// as JSON { order:[keys...], hidden:[keys...] }. Unknown/new keys append at the
// end so future widgets surface automatically. The customize toggle itself lives
// in window.state.ui.dashboard so it survives the coarse renderApp() re-render.

const DASH_LAYOUT_KEY = 'pm_dash_layout';

// Default widget order (keys must match the registry built in renderDashboard).
// Stat cards + greeting are NOT in here — they are always-on header chrome.
const DASH_DEFAULT_ORDER = [
  'focus', 'statusBreakdown', 'throughput', 'timeLogged',
  'workload', 'projects', 'milestones', 'activity',
];

// Load + sanitize the saved layout. Falls back to a sensible default when the
// key is absent or the JSON is corrupt. `validKeys` is the set of keys the
// current registry actually knows about; unknown stored keys are dropped, and
// any known key missing from `order` is appended at the end (so a newly added
// widget shows up for existing users without wiping their arrangement).
function loadDashLayout(validKeys) {
  let saved = null;
  try {
    const raw = localStorage.getItem(DASH_LAYOUT_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (_) { saved = null; }

  const order = [];
  const seen = new Set();
  const pushKey = (k) => { if (validKeys.includes(k) && !seen.has(k)) { seen.add(k); order.push(k); } };

  if (saved && Array.isArray(saved.order)) saved.order.forEach(pushKey);
  else DASH_DEFAULT_ORDER.forEach(pushKey);
  // Append any registry key not yet placed (new widgets / recovered defaults).
  DASH_DEFAULT_ORDER.forEach(pushKey);
  validKeys.forEach(pushKey);

  const hiddenSrc = (saved && Array.isArray(saved.hidden)) ? saved.hidden : [];
  const hidden = hiddenSrc.filter(k => validKeys.includes(k));

  return { order, hidden: [...new Set(hidden)] };
}

function saveDashLayout(layout) {
  try {
    localStorage.setItem(DASH_LAYOUT_KEY, JSON.stringify({
      order: layout.order, hidden: layout.hidden,
    }));
  } catch (_) { /* storage full / disabled — layout just won't persist */ }
}

function renderDashboard(tasks, { onOpenTask, onNavigate, activity }) {
  const t = today();
  const overdue    = tasks.filter(x => x.status !== 'done' && x.due && parseISO(x.due) < t);
  const dueToday   = tasks.filter(x => x.due === daysFromNow(0) && x.status !== 'done');
  const inProgress = tasks.filter(x => x.status === 'in_progress');
  const completed  = tasks.filter(x => x.status === 'done');
  const me = window.state.me;
  const myName = (me.name || '').split(' ')[0] || 'there';
  const myTasks = tasks.filter(x => x.assignees.includes(me.id) && x.status !== 'done');

  const byStatus = STATUSES.map(s => ({ ...s, count: tasks.filter(x => x.status === s.id).length }));
  const total = tasks.length;
  const completionPct = total ? Math.round((completed.length / total) * 100) : 0;

  // ---- honest week-over-week deltas ------------------------------------------
  // Convert a UTC server timestamp to a local YYYY-MM-DD date key.
  const localDate = (iso) => {
    if (!iso) return null;
    const d = new Date(String(iso).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return null;
    return ymd(d); // local wall-clock date
  };
  // Date keys for [today-13 .. today], oldest first.
  const dayKeys = [];
  for (let i = 13; i >= 0; i--) dayKeys.push(daysFromNow(-i));
  const startThisWeek = daysFromNow(-6); // inclusive 7-day window ending today
  const startLastWeek = daysFromNow(-13);
  // Exclusive upper bound for last week. Must be startThisWeek (-6) so last week
  // also spans a full 7 days [-13 .. -7]; using -7 made it 6 days and biased
  // every week-over-week delta upward even when activity was flat.
  const endLastWeek   = daysFromNow(-6);

  // Per-day created / completed counts over the 14-day window.
  const createdByDay   = Object.fromEntries(dayKeys.map(k => [k, 0]));
  const completedByDay = Object.fromEntries(dayKeys.map(k => [k, 0]));
  for (const x of tasks) {
    const ck = localDate(x.created_at);
    if (ck != null && ck in createdByDay) createdByDay[ck]++;
    if (x.status === 'done') {
      const dk = localDate(x.updated_at);
      if (dk != null && dk in completedByDay) completedByDay[dk]++;
    }
  }
  const sumRange = (map, fromKey, toKeyExclusive) =>
    dayKeys.reduce((n, k) => n + ((k >= fromKey && k < toKeyExclusive) ? map[k] : 0), 0);
  // this-week window is [startThisWeek .. today] inclusive -> exclusive bound = tomorrow
  const tomorrow = daysFromNow(1);
  const createdThis   = sumRange(createdByDay,   startThisWeek, tomorrow);
  const createdLast   = sumRange(createdByDay,   startLastWeek, endLastWeek);
  const completedThis = sumRange(completedByDay, startThisWeek, tomorrow);
  const completedLast = sumRange(completedByDay, startLastWeek, endLastWeek);

  // trend(delta, higherIsBetter): returns {dir:'up'|'down'|'flat', good:bool}.
  const trendFor = (cur, prev, higherIsBetter = true) => {
    const delta = cur - prev;
    if (delta === 0) return { dir: 'flat', good: true, delta };
    const dir = delta > 0 ? 'up' : 'down';
    const good = higherIsBetter ? delta > 0 : delta < 0;
    return { dir, good, delta };
  };
  const fmtDelta = (d) => (d > 0 ? '+' : '') + d;

  // Open-tasks trend = created-minus-completed this week vs last (fewer net new
  // open tasks is better, so higherIsBetter=false).
  const openNetThis = createdThis - completedThis;
  const openNetLast = createdLast - completedLast;
  const openTrend = trendFor(openNetThis, openNetLast, false);
  const completedTrend = trendFor(completedThis, completedLast, true);

  const workload = window.state.users
    .filter(u => u.id !== me.id)
    .map(u => ({ user: u, open: tasks.filter(x => x.assignees.includes(u.id) && x.status !== 'done').length }))
    .sort((a, b) => b.open - a.open);
  const maxWork = Math.max(...workload.map(w => w.open), 1);

  const projects = window.state.projects;
  const milestones = (window.state.milestones || []);

  // ---- widget builders -------------------------------------------------------
  // Each returns the same DOM the original inline code produced. They are pure
  // wrt the data captured above, so the registry can call them lazily and the
  // customize layer can place/hide them without touching their internals.

  function buildFocus() {
    const focusCard = Card({ gridColumn: 'span 7' });
    focusCard.appendChild(CardHeader('Your focus', `${myTasks.length} open tasks assigned to you`,
      h('button', { class: 'btn btn-muted', style: { padding: '4px 8px', fontSize: '12px' },
        onClick: () => onNavigate('checklist') }, 'Open checklist ', Icon('chevronRight', 12))));
    const focusList = h('div', { style: { display: 'flex', flexDirection: 'column' } });
    for (const x of myTasks.slice(0, 5)) focusList.appendChild(FocusRow(x, () => onOpenTask(x.id)));
    if (myTasks.length === 0) focusList.appendChild(h('div', { class: 'empty' }, 'Nothing on your plate. Nice.'));
    focusCard.appendChild(focusList);
    return focusCard;
  }

  function buildStatusBreakdown() {
    const sbCard = Card({ gridColumn: 'span 5' });
    sbCard.appendChild(CardHeader('Status breakdown', `${total} total tasks`));
    const sbBody = h('div', { style: { padding: '0 16px 18px' } });
    const bar = h('div', { style: { display: 'flex', height: '10px', borderRadius: '5px', overflow: 'hidden', background: 'var(--bg-3)', marginBottom: '14px' } });
    for (const s of byStatus) {
      bar.appendChild(h('div', {
        title: `${s.name}: ${s.count}`,
        style: { width: (total ? (s.count / total) * 100 : 0) + '%', background: s.color, transition: 'width 0.3s' }
      }));
    }
    sbBody.appendChild(bar);
    const sbList = h('div', { style: { display: 'grid', gap: '8px' } });
    for (const s of byStatus) {
      sbList.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' } },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: s.color } }),
        h('span', { style: { color: 'var(--fg-1)', flex: 1 } }, s.name),
        h('span', { class: 'mono', style: { color: 'var(--fg-2)', fontSize: '12px' } }, String(s.count)),
        h('span', { class: 'mono', style: { color: 'var(--fg-3)', fontSize: '11px', width: '40px', textAlign: 'right' } },
          `${total ? Math.round(s.count / total * 100) : 0}%`),
      ));
    }
    sbBody.appendChild(sbList);
    sbCard.appendChild(sbBody);
    return sbCard;
  }

  function buildThroughput() {
    // Throughput chart: 14-day created vs completed (inline SVG, themed).
    const chartCard = Card({ gridColumn: 'span 7' });
    chartCard.appendChild(CardHeader('Throughput', 'Created vs completed, last 14 days',
      h('div', { class: 'hstack', style: { gap: '12px', fontSize: '11px', color: 'var(--fg-3)' } },
        LegendDot('var(--acc-1)', 'Created'),
        LegendDot('#22C55E', 'Completed'))));
    chartCard.appendChild(ThroughputChart(dayKeys, createdByDay, completedByDay));
    return chartCard;
  }

  function buildTimeLogged() {
    // Time logged chart: per-project totals (per-day isn't derivable from the
    // task payload — time_logged is a per-task SUM with no entry dates — so we
    // show project breakdown + an overall total via fmtMinutes, per contract).
    const timeCard = Card({ gridColumn: 'span 5' });
    const totalLogged = tasks.reduce((n, x) => n + (Number(x.time_logged) || 0), 0);
    timeCard.appendChild(CardHeader('Time logged', `${fmtMinutes(totalLogged)} across all tasks`));
    timeCard.appendChild(TimeLoggedChart(tasks, projects));
    return timeCard;
  }

  function buildWorkload() {
    const wlCard = Card({ gridColumn: 'span 5' });
    wlCard.appendChild(CardHeader('Team workload', 'Open tasks per teammate'));
    const wlBody = h('div', { style: { padding: '4px 16px 16px', display: 'grid', gap: '10px' } });
    if (!workload.length) {
      wlBody.appendChild(h('div', { class: 'empty', style: { padding: '16px' } }, 'No teammates to show yet.'));
    }
    for (const w of workload) {
      wlBody.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        Avatar(w.user, 26),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' } },
            h('span', { style: { fontSize: '12.5px', fontWeight: '500' } }, w.user.name),
            h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-2)' } }, `${w.open} open`)),
          h('div', { style: { height: '6px', background: 'var(--bg-3)', borderRadius: '3px', overflow: 'hidden' } },
            h('div', { style: {
              width: (w.open / maxWork) * 100 + '%', height: '100%',
              background: `linear-gradient(90deg, ${w.user.color}, ${w.user.color}aa)`,
              borderRadius: '3px', transition: 'width 0.5s'
            } })),
        ),
      ));
    }
    wlCard.appendChild(wlBody);
    return wlCard;
  }

  function buildProjects() {
    const pCard = Card({ gridColumn: 'span 7' });
    pCard.appendChild(CardHeader('Active projects'));
    const pBody = h('div', { style: { padding: '0 16px 16px', display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(2, 1fr)' } });
    if (!projects.length) {
      // Don't send a non-admin to a surface they can't open — branch the copy.
      const isAdmin = !!(window.state && window.state.me && window.state.me.is_admin);
      pBody.appendChild(h('div', { class: 'empty', style: { gridColumn: '1 / -1', padding: '16px' } },
        isAdmin ? 'Create your first project in Admin settings.'
                : 'No projects yet — ask an admin to create one, then you can start adding tasks.'));
    }
    for (const p of projects) {
      const pTasks = tasks.filter(x => x.project == p.id);
      const pDone = pTasks.filter(x => x.status === 'done').length;
      const pct = pTasks.length ? Math.round((pDone / pTasks.length) * 100) : 0;
      const tile = h('div', {
        style: { padding: '12px', borderRadius: '10px', background: 'var(--bg-3)', border: '1px solid var(--line)', cursor: 'pointer' },
        onClick: () => onNavigate('kanban', p.id),
      });
      tile.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
        h('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: p.color } }),
        h('span', { style: { fontWeight: '600', fontSize: '13px', flex: 1 } }, p.name),
        h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)' } }, `${pDone}/${pTasks.length}`),
      ));
      tile.appendChild(h('div', { style: { height: '4px', background: 'var(--bg-4)', borderRadius: '2px', overflow: 'hidden' } },
        h('div', { style: { width: pct + '%', height: '100%', background: p.color, borderRadius: '2px', transition: 'width 0.5s' } })));
      const allAssignees = [...new Set(pTasks.flatMap(x => x.assignees))].slice(0, 4);
      tile.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '10px', alignItems: 'center' } },
        AvatarStack(allAssignees, 4, 20),
        h('span', { style: { fontSize: '11px', color: 'var(--fg-3)' } }, `${pct}% complete`),
      ));
      pBody.appendChild(tile);
    }
    pCard.appendChild(pBody);
    return pCard;
  }

  function buildMilestones() {
    const msCard = Card({ gridColumn: 'span 5' });
    msCard.appendChild(CardHeader('Milestones', `${milestones.filter(m => m.status !== 'done').length} open`));
    const msBody = h('div', { style: { padding: '0 16px 16px', display: 'grid', gap: '12px' } });
    if (!milestones.length) {
      msBody.appendChild(h('div', { class: 'empty', style: { padding: '16px' } }, 'No milestones yet.'));
    }
    // Open milestones first, then by due date; cap the list.
    const msSorted = milestones.slice().sort((a, b) => {
      const ad = a.status === 'done' ? 1 : 0, bd = b.status === 'done' ? 1 : 0;
      if (ad !== bd) return ad - bd;
      return String(a.due || '9999').localeCompare(String(b.due || '9999'));
    });
    for (const m of msSorted.slice(0, 6)) {
      const tc = m.task_count || 0;
      const dc = m.done_count || 0;
      const pct = tc ? Math.round((dc / tc) * 100) : (m.status === 'done' ? 100 : 0);
      const proj = projectById(m.project_id);
      msBody.appendChild(h('div', { class: 'milestone-row' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
          Icon('target', 13),
          h('span', { style: { fontSize: '12.5px', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.name),
          proj ? h('span', { style: { fontSize: '10.5px', color: proj.color } }, proj.name) : null,
          m.due ? DueDate(m.due, true) : null,
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('div', { style: { flex: 1, height: '6px', background: 'var(--bg-3)', borderRadius: '3px', overflow: 'hidden' } },
            h('div', { style: {
              width: pct + '%', height: '100%',
              background: m.status === 'done' ? '#22C55E' : 'var(--acc-1)',
              borderRadius: '3px', transition: 'width 0.5s'
            } })),
          h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)', width: '54px', textAlign: 'right' } }, `${dc}/${tc}`),
        ),
      ));
    }
    msCard.appendChild(msBody);
    return msCard;
  }

  function buildActivity() {
    const aCard = Card({ gridColumn: 'span 7' });
    aCard.appendChild(CardHeader('Recent activity'));
    const aBody = h('div', { style: { padding: '0 16px 16px', display: 'grid', gap: '10px' } });
    const items = (activity || []).slice(0, 8);
    if (items.length === 0) {
      aBody.appendChild(h('div', { class: 'empty', style: { padding: '16px' } }, 'No activity yet.'));
    } else for (const a of items) {
      aBody.appendChild(h('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } },
        Avatar(a.user, 24),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { fontSize: '12.5px', color: 'var(--fg-1)', lineHeight: '1.35' } },
            h('span', { style: { fontWeight: '600' } }, a.user.name),
            ' ',
            h('span', { style: { color: 'var(--fg-3)' } }, a.action),
            ' ',
            a.task ? h('span', { class: 'mono', style: { color: 'var(--acc-1)', fontSize: '11.5px' } }, a.task.ref) : null,
          ),
          a.detail ? h('div', { style: { fontSize: '11.5px', color: 'var(--fg-3)', marginTop: '2px' } }, a.detail) : null,
        ),
        h('span', { style: { fontSize: '11px', color: 'var(--fg-4)', whiteSpace: 'nowrap' } }, relTime(a.created_at)),
      ));
    }
    aCard.appendChild(aBody);
    return aCard;
  }

  // ---- widget registry -------------------------------------------------------
  // key: stable id stored in localStorage; title: label shown in customize UI;
  // span: the grid column-span this widget wants (mirrors its gridColumn);
  // render(): returns the widget's DOM node.
  const WIDGETS = [
    { key: 'focus',           title: 'Your focus',       span: 7, render: buildFocus },
    { key: 'statusBreakdown', title: 'Status breakdown', span: 5, render: buildStatusBreakdown },
    { key: 'throughput',      title: 'Throughput',       span: 7, render: buildThroughput },
    { key: 'timeLogged',      title: 'Time logged',      span: 5, render: buildTimeLogged },
    { key: 'workload',        title: 'Team workload',    span: 5, render: buildWorkload },
    { key: 'projects',        title: 'Active projects',  span: 7, render: buildProjects },
    { key: 'milestones',      title: 'Milestones',       span: 5, render: buildMilestones },
    { key: 'activity',        title: 'Recent activity',  span: 7, render: buildActivity },
  ];
  const widgetByKey = Object.fromEntries(WIDGETS.map(w => [w.key, w]));
  const validKeys = WIDGETS.map(w => w.key);

  // ---- persistent customize state -------------------------------------------
  // The customize toggle lives on window.state.ui.dashboard so it survives the
  // coarse renderApp() re-render (per v2 convention). The actual layout lives in
  // localStorage and is reloaded each render.
  const ui = (window.state.ui = window.state.ui || {});
  const ds = (ui.dashboard = ui.dashboard || {});
  let layout = loadDashLayout(validKeys);

  const persist = () => { saveDashLayout(layout); };
  const isHidden = (key) => layout.hidden.includes(key);
  const setHidden = (key, hide) => {
    const set = new Set(layout.hidden);
    if (hide) set.add(key); else set.delete(key);
    layout.hidden = [...set];
    persist();
  };

  // ---- root + redraw ---------------------------------------------------------
  const root = h('div', { class: 'dash-grid', style: { padding: '24px', display: 'grid', gap: '20px' } });

  function redraw() {
    root.replaceChildren();

    // Greeting (always on). The "Customize" toggle lives in this header.
    root.appendChild(buildGreeting());

    // Stat cards (always on).
    root.appendChild(StatCard('Open tasks',      total - completed.length,
      openTrend.dir === 'flat' ? 'no change wk/wk' : `${fmtDelta(openNetThis - openNetLast)} net wk/wk`,
      openTrend, 'blue', 'checkSquare'));
    root.appendChild(StatCard('Due today',       dueToday.length,
      overdue.length > 0 ? `${overdue.length} overdue` : 'on track',
      null, 'amber', 'clock'));
    root.appendChild(StatCard('In progress',     inProgress.length,
      `${new Set(inProgress.flatMap(x => x.assignees)).size} people active`,
      null, 'violet', 'activity'));
    root.appendChild(StatCard('Completed (7d)',  completedThis,
      completedTrend.dir === 'flat' ? `${completionPct}% done overall` : `${fmtDelta(completedTrend.delta)} vs last week`,
      completedTrend, 'green', 'trendUp'));

    const customizing = !!ds.customizing;

    if (customizing) root.appendChild(buildCustomizeBar());

    // Visible widgets, in saved order.
    const visibleKeys = layout.order.filter(k => widgetByKey[k] && !isHidden(k));
    for (const key of visibleKeys) {
      const w = widgetByKey[key];
      const node = w.render();
      if (customizing) root.appendChild(wrapForCustomize(w, node));
      else root.appendChild(node);
    }

    if (customizing) {
      // Wire pointer/touch drag reordering across the wrapped widgets. Mirrors
      // ui.js sortableList, but operates on our wrapper nodes (data-dash-key) and
      // writes the new order back into `layout` + localStorage on drop.
      enableReorder();
      // Hidden-widgets panel so users can re-show things they've turned off.
      root.appendChild(buildHiddenPanel());
    }
  }

  // ---- greeting --------------------------------------------------------------
  function buildGreeting() {
    return h('div', { style: { gridColumn: 'span 12', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '20px' } },
      h('div', null,
        h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600', marginBottom: '6px' } },
          t.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })),
        h('h1', { style: { margin: 0, fontSize: '26px', fontWeight: '700', letterSpacing: '-0.02em' } }, `Good day, ${myName}.`),
        h('p', { style: { margin: '6px 0 0', color: 'var(--fg-2)', fontSize: '14px' } },
          `${dueToday.length} due today, ${overdue.length} overdue, ${inProgress.length} in progress.`),
      ),
      h('div', { class: 'hstack', style: { gap: '8px' } },
        h('button', {
          class: ds.customizing ? 'btn btn-primary' : 'btn btn-ghost',
          'aria-pressed': ds.customizing ? 'true' : 'false',
          title: ds.customizing ? 'Finish customizing the dashboard' : 'Show / hide and reorder dashboard widgets',
          onClick: () => { ds.customizing = !ds.customizing; redraw(); },
        }, Icon('settings', 14), ds.customizing ? ' Done' : ' Customize'),
        h('button', { class: 'btn btn-ghost', onClick: () => onNavigate('calendar') }, Icon('calendar', 14), ' This week'),
      ),
    );
  }

  // ---- customize toolbar (top of grid while editing) -------------------------
  function buildCustomizeBar() {
    const hiddenCount = layout.hidden.filter(k => widgetByKey[k]).length;
    return h('div', {
      style: {
        gridColumn: 'span 12', display: 'flex', alignItems: 'center', gap: '12px',
        padding: '10px 14px', borderRadius: '10px',
        background: 'var(--bg-2)', border: '1px dashed var(--line)',
      },
    },
      h('span', { class: 'hstack', style: { gap: '8px', alignItems: 'center', color: 'var(--fg-2)', fontSize: '12.5px' } },
        Icon('grip', 14),
        'Drag the handle to reorder. Toggle the eye to show or hide a widget.'),
      h('span', { style: { flex: 1 } }),
      hiddenCount
        ? h('span', { style: { fontSize: '11.5px', color: 'var(--fg-3)' } }, `${hiddenCount} hidden`)
        : null,
      h('button', {
        class: 'btn btn-ghost', style: { fontSize: '12px' },
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Reset dashboard layout?',
            message: 'This restores the default widget order and shows every widget again.',
            confirmText: 'Reset layout', cancelText: 'Cancel',
          });
          if (!ok) return;
          try { localStorage.removeItem(DASH_LAYOUT_KEY); } catch (_) {}
          layout = loadDashLayout(validKeys);
          redraw();
        },
      }, Icon('x', 13), ' Reset layout'),
    );
  }

  // ---- per-widget customize wrapper -----------------------------------------
  // Keeps the widget's grid span (so the layout still looks like the dashboard
  // while editing) and overlays a control bar with a drag handle + hide toggle.
  function wrapForCustomize(w, node) {
    const wrap = h('div', {
      class: 'dash-widget-edit',
      'data-dash-key': w.key,
      style: { gridColumn: `span ${w.span}`, position: 'relative' },
    });

    const handle = h('button', {
      class: 'dash-drag-handle',
      type: 'button',
      title: 'Drag to reorder',
      'aria-label': `Reorder ${w.title}`,
      style: {
        display: 'inline-grid', placeItems: 'center', cursor: 'grab',
        width: '26px', height: '26px', borderRadius: '6px',
        background: 'var(--bg-3)', border: '1px solid var(--line)', color: 'var(--fg-2)',
        touchAction: 'none',
      },
    }, Icon('grip', 14));

    const hideBtn = h('button', {
      class: 'btn btn-ghost',
      type: 'button',
      title: 'Hide this widget',
      'aria-label': `Hide ${w.title}`,
      style: { padding: '3px 8px', fontSize: '11.5px' },
      onClick: () => { setHidden(w.key, true); redraw(); },
    }, Icon('eye', 13), ' Hide');

    const bar = h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '6px 8px', marginBottom: '8px',
        borderRadius: '8px', background: 'var(--bg-2)', border: '1px solid var(--line)',
      },
    },
      handle,
      h('span', { style: { fontSize: '12.5px', fontWeight: '600', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w.title),
      hideBtn,
    );

    // Dim the live widget slightly so the editing chrome reads as primary.
    node.style.opacity = node.style.opacity || '0.92';
    node.style.pointerEvents = 'none'; // don't trigger navigations while editing

    wrap.appendChild(bar);
    wrap.appendChild(node);
    wrap._dragHandle = handle; // picked up by enableReorder()
    return wrap;
  }

  // Pointer/touch reordering of the wrapper nodes. On drop we read the DOM order
  // of the [data-dash-key] wrappers, fold it back into layout.order (preserving
  // the relative position of any hidden keys), persist, and redraw.
  function enableReorder() {
    const items = [...root.querySelectorAll('.dash-widget-edit')];
    for (const item of items) {
      const grip = item._dragHandle || item;
      makeDraggable(item, {
        handle: grip,
        onStart: () => { item.classList.add('drag-ghost'); item.style.opacity = '0.6'; },
        onMove: (e) => {
          const over = document.elementFromPoint(e.clientX, e.clientY);
          const overItem = over && over.closest ? over.closest('.dash-widget-edit') : null;
          if (overItem && overItem !== item && root.contains(overItem)) {
            const rect = overItem.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            root.insertBefore(item, after ? overItem.nextSibling : overItem);
          }
        },
        onDrop: () => {
          item.classList.remove('drag-ghost');
          const visibleOrder = [...root.querySelectorAll('.dash-widget-edit')]
            .map(n => n.getAttribute('data-dash-key'))
            .filter(k => widgetByKey[k]);
          layout.order = mergeVisibleOrder(layout.order, visibleOrder);
          persist();
          redraw();
        },
      });
    }
  }

  // Re-thread a freshly dragged visible-only order back into the full order
  // array, leaving hidden keys parked at their original relative slots. We do
  // this by walking the old order and, whenever we hit a visible key, emitting
  // the next key from the new visible sequence instead.
  function mergeVisibleOrder(fullOrder, visibleOrder) {
    const visibleSet = new Set(visibleOrder);
    let vi = 0;
    const out = fullOrder.map(k => {
      if (visibleSet.has(k)) { return visibleOrder[vi++]; }
      return k; // hidden key keeps its place
    });
    // Safety: ensure every known key appears exactly once.
    const seen = new Set();
    const deduped = out.filter(k => widgetByKey[k] && !seen.has(k) && seen.add(k));
    validKeys.forEach(k => { if (!seen.has(k)) { seen.add(k); deduped.push(k); } });
    return deduped;
  }

  // ---- hidden-widgets panel (re-show controls) -------------------------------
  function buildHiddenPanel() {
    const hiddenKeys = layout.order.filter(k => widgetByKey[k] && isHidden(k));
    const panel = h('div', {
      style: {
        gridColumn: 'span 12', padding: '14px',
        borderRadius: '10px', background: 'var(--bg-2)', border: '1px solid var(--line)',
      },
    });
    panel.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', fontWeight: '600', letterSpacing: '0.02em', marginBottom: '10px' } },
      'Hidden widgets'));
    if (!hiddenKeys.length) {
      panel.appendChild(h('div', { class: 'empty', style: { padding: '6px 0' } }, 'Nothing hidden — every widget is showing.'));
      return panel;
    }
    const chips = h('div', { class: 'hstack', style: { gap: '8px', flexWrap: 'wrap' } });
    for (const key of hiddenKeys) {
      const w = widgetByKey[key];
      chips.appendChild(h('button', {
        class: 'btn btn-muted',
        type: 'button',
        title: `Show ${w.title}`,
        'aria-label': `Show ${w.title}`,
        style: { fontSize: '12px', padding: '4px 10px' },
        onClick: () => { setHidden(key, false); redraw(); },
      }, Icon('plus', 13), ' ', w.title));
    }
    panel.appendChild(chips);
    return panel;
  }

  redraw();
  return root;
}

function Card(extraStyle = {}) {
  return h('div', { class: 'card', style: extraStyle });
}
function CardHeader(title, subtitle, action) {
  const wrap = h('div', { class: 'card-head' });
  const left = h('div', null, h('h3', null, title));
  if (subtitle) left.appendChild(h('div', { class: 'sub' }, subtitle));
  wrap.appendChild(left);
  if (action) wrap.appendChild(action);
  return wrap;
}

function LegendDot(color, label) {
  return h('span', { class: 'hstack', style: { gap: '5px', alignItems: 'center' } },
    h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: color } }),
    label);
}

// StatCard. `trend` is null (no arrow) or {dir:'up'|'down'|'flat', good:bool}.
// Color follows whether the change is GOOD (green) or BAD (red), not the raw
// direction — so e.g. "fewer net-new open tasks" reads green even though it's a
// down arrow. `flat` and `null` stay neutral.
function StatCard(label, value, delta, trend, tone, icon) {
  const tones = {
    blue:   { bg: 'rgba(59,130,246,0.08)', border: 'rgba(59,130,246,0.2)', fg: '#60A5FA' },
    amber:  { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.2)', fg: '#FCD34D' },
    violet: { bg: 'rgba(168,85,247,0.08)', border: 'rgba(168,85,247,0.2)', fg: '#D8B4FE' },
    green:  { bg: 'rgba(34,197,94,0.08)',  border: 'rgba(34,197,94,0.2)',  fg: '#86EFAC' },
  }[tone];
  const dir = trend && trend.dir;
  const deltaColor = !trend || dir === 'flat'
    ? 'var(--fg-3)'
    : (trend.good ? '#86EFAC' : '#FCA5A5');
  return h('div', {
    style: {
      gridColumn: 'span 3', background: 'var(--bg-2)', border: '1px solid var(--line)',
      borderRadius: '12px', padding: '16px', position: 'relative', overflow: 'hidden'
    }
  },
    h('div', {
      style: {
        position: 'absolute', top: '12px', right: '12px',
        width: '32px', height: '32px', borderRadius: '8px',
        background: tones.bg, border: `1px solid ${tones.border}`, color: tones.fg,
        display: 'grid', placeItems: 'center'
      }
    }, Icon(icon, 16)),
    h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', fontWeight: '600', letterSpacing: '0.02em' } }, label),
    h('div', { style: { fontSize: '30px', fontWeight: '700', letterSpacing: '-0.02em', marginTop: '4px' } }, String(value)),
    h('div', {
      style: { fontSize: '11.5px', color: deltaColor, marginTop: '6px', display: 'flex', alignItems: 'center', gap: '4px' }
    },
      dir === 'up'   ? Icon('trendUp', 11)   : null,
      dir === 'down' ? Icon('trendDown', 11) : null,
      delta),
  );
}

// 14-day grouped bar chart (inline SVG). Two series share each day slot.
// Colors are passed via fill so they track the theme's accent / status green.
function ThroughputChart(dayKeys, createdByDay, completedByDay) {
  const W = 560, H = 150, padL = 8, padR = 8, padT = 10, padB = 22;
  const n = dayKeys.length;
  const max = Math.max(1, ...dayKeys.map(k => Math.max(createdByDay[k], completedByDay[k])));
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / n;
  const barW = Math.max(2, slot * 0.34);
  const yFor = v => padT + plotH - (v / max) * plotH;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.display = 'block';

  const rect = (x, y, w, hgt, fill, title) => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', x.toFixed(1)); r.setAttribute('y', y.toFixed(1));
    r.setAttribute('width', w.toFixed(1)); r.setAttribute('height', Math.max(0, hgt).toFixed(1));
    r.setAttribute('rx', '2'); r.setAttribute('fill', fill);
    if (title) { const tEl = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tEl.textContent = title; r.appendChild(tEl); }
    return r;
  };
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
  line.setAttribute('y1', padT + plotH); line.setAttribute('y2', padT + plotH);
  line.setAttribute('stroke', 'var(--line)'); line.setAttribute('stroke-width', '1');
  svg.appendChild(line);

  dayKeys.forEach((k, i) => {
    const cx = padL + slot * i + slot / 2;
    const cv = createdByDay[k], dv = completedByDay[k];
    const cy = yFor(cv), dy = yFor(dv);
    const d = new Date(k + 'T00:00:00');
    const lbl = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
    svg.appendChild(rect(cx - barW - 1, cy, barW, padT + plotH - cy, 'var(--acc-1)', `${lbl}: ${cv} created`));
    svg.appendChild(rect(cx + 1, dy, barW, padT + plotH - dy, '#22C55E', `${lbl}: ${dv} completed`));
    // sparse x labels: first, middle, last
    if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', cx.toFixed(1));
      txt.setAttribute('y', (H - 6).toFixed(1));
      txt.setAttribute('text-anchor', i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle');
      txt.setAttribute('font-size', '10');
      txt.setAttribute('fill', 'var(--fg-3)');
      txt.textContent = d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
      svg.appendChild(txt);
    }
  });

  return h('div', { style: { padding: '4px 16px 16px' } }, svg);
}

// Per-project time-logged bars. Per-day breakdown isn't derivable from the task
// payload (time_logged is a per-task SUM without entry dates), so we group by
// project — useful and honest — and label totals with fmtMinutes.
function TimeLoggedChart(tasks, projects) {
  const byProj = new Map();
  for (const x of tasks) {
    const mins = Number(x.time_logged) || 0;
    if (!mins) continue;
    byProj.set(x.project, (byProj.get(x.project) || 0) + mins);
  }
  const rows = [...byProj.entries()]
    .map(([pid, mins]) => ({ proj: projectById(pid), pid, mins }))
    .sort((a, b) => b.mins - a.mins)
    .slice(0, 6);
  const max = Math.max(1, ...rows.map(r => r.mins));

  const body = h('div', { style: { padding: '4px 16px 16px', display: 'grid', gap: '10px' } });
  if (!rows.length) {
    body.appendChild(h('div', { class: 'empty', style: { padding: '16px' } }, 'No time logged yet.'));
    return body;
  }
  for (const r of rows) {
    const color = (r.proj && r.proj.color) || 'var(--acc-1)';
    const name = r.proj ? r.proj.name : 'No project';
    body.appendChild(h('div', null,
      h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '12.5px' } },
        h('span', { class: 'hstack', style: { gap: '6px', alignItems: 'center' } },
          h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: color } }),
          name),
        h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-2)' } }, fmtMinutes(r.mins))),
      h('div', { style: { height: '6px', background: 'var(--bg-3)', borderRadius: '3px', overflow: 'hidden' } },
        h('div', { style: { width: (r.mins / max) * 100 + '%', height: '100%', background: color, borderRadius: '3px', transition: 'width 0.5s' } })),
    ));
  }
  return body;
}

function FocusRow(task, onClick) {
  const proj = projectById(task.project);
  const sub = task.subtasks || [];
  const subDone = sub.filter(s => s.done).length;
  const row = h('div', {
    onClick,
    style: {
      display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px',
      borderTop: '1px solid var(--line)', cursor: 'pointer', transition: 'background 0.1s',
    },
    onMouseenter: e => e.currentTarget.style.background = 'var(--bg-3)',
    onMouseleave: e => e.currentTarget.style.background = 'transparent',
  });
  row.appendChild(PriorityFlag(task.priority));
  const body = h('div', { style: { flex: 1, minWidth: 0 } });
  body.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
    h('span', { class: 'mono', style: { fontSize: '10.5px', color: 'var(--fg-3)' } }, task.ref),
    h('span', { style: { width: '4px', height: '4px', borderRadius: '50%', background: 'var(--fg-4)' } }),
    proj ? h('span', { style: { fontSize: '11px', color: proj.color } }, proj.name) : null,
  ));
  body.appendChild(h('div', {
    style: { fontSize: '13.5px', fontWeight: '500', marginTop: '2px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  }, task.title));
  row.appendChild(body);
  if (sub.length > 0) row.appendChild(h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)' } }, `${subDone}/${sub.length}`));
  const labelRow = h('div', { class: 'hstack', style: { gap: '8px' } });
  task.labels.slice(0, 2).forEach(l => labelRow.appendChild(Tag(l, true)));
  row.appendChild(labelRow);
  if (task.due) row.appendChild(DueDate(task.due, true));
  return row;
}

window.renderDashboard = renderDashboard;
