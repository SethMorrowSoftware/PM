// Audit / Activity log view — filterable + paginated.
//
// Calling convention mirrors renderDashboard: window.renderActivity(tasks,
// handlers) returns a DOM node. `tasks` is unused (activity comes from the
// server, paginated), but kept for signature parity with the other views.
//
// Data flow: a per-render closure holds the running list + paging cursor and
// re-fetches via API.activityLog. Re-filtering resets offset to 0 and replaces
// the list; "Load more" advances the cursor and appends. Filter selections are
// persisted in window.state.ui.activity so they survive the coarse renderApp()
// re-render (which would otherwise rebuild this closure from scratch).
const ACTIVITY_PAGE = 50;

// Known action vocabulary for the action dropdown. Whatever distinct actions
// turn up in the loaded rows get merged in too (see refreshActionOptions), so
// this is a sensible-defaults list, not an exhaustive one.
const ACTIVITY_ACTIONS = ['created', 'updated', 'moved', 'completed', 'commented', 'assigned'];

function renderActivity(tasks, handlers = {}) {
  const onOpenTask = handlers.onOpenTask || (() => {});
  const state = window.state;
  // View-local filter state lives on window.state.ui so a re-render keeps it.
  state.ui = state.ui || {};
  const filters = state.ui.activity = state.ui.activity || { user_id: null, action: '', q: '' };

  // Per-render runtime: the materialised list + paging cursor + flags. This is
  // intentionally a fresh closure each render; the durable bits (the filters)
  // are on window.state above.
  const run = { items: [], offset: 0, loading: false, exhausted: false, reqSeq: 0 };

  const root = h('div', { class: 'activity-wrap', style: { padding: '24px', maxWidth: '880px', margin: '0 auto' } });

  // ---- header --------------------------------------------------------------
  root.appendChild(h('div', { style: { marginBottom: '18px' } },
    h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600' } }, 'Audit log'),
    h('h1', { style: { margin: '4px 0 0', fontSize: '24px', fontWeight: '700', letterSpacing: '-0.02em' } }, 'Activity'),
    h('p', { style: { margin: '4px 0 0', color: 'var(--fg-2)', fontSize: '13.5px' } },
      'Everything that has happened across your projects, newest first.'),
  ));

  // ---- filter toolbar ------------------------------------------------------
  const controlStyle = {
    background: 'var(--bg-2)', border: '1px solid var(--line-2)', borderRadius: '7px',
    padding: '7px 10px', color: 'var(--fg-0)', outline: 'none', fontSize: '13px', fontFamily: 'inherit',
  };

  // User filter: "Everyone" + each team member.
  const userSelect = h('select', {
    'aria-label': 'Filter by user',
    style: { ...controlStyle, cursor: 'pointer' },
    value: filters.user_id == null ? '' : String(filters.user_id),
    onChange: (e) => {
      const v = e.target.value;
      filters.user_id = v === '' ? null : Number(v);
      reload();
    },
  },
    h('option', { value: '' }, 'Everyone'),
    (state.users || []).map(u => h('option', { value: String(u.id) }, u.name)),
  );
  // Ensure the persisted selection is reflected (h() sets .value before options
  // exist for some browsers; reassert after children are attached).
  userSelect.value = filters.user_id == null ? '' : String(filters.user_id);

  // Action filter: "All actions" + known vocabulary (merged with discovered
  // actions as rows load).
  const actionSelect = h('select', {
    'aria-label': 'Filter by action',
    style: { ...controlStyle, cursor: 'pointer' },
    onChange: (e) => { filters.action = e.target.value; reload(); },
  });
  function refreshActionOptions() {
    const discovered = new Set(run.items.map(a => a.action).filter(Boolean));
    const opts = [...new Set([...ACTIVITY_ACTIONS, ...discovered])].sort();
    mount(actionSelect,
      h('option', { value: '' }, 'All actions'),
      opts.map(a => h('option', { value: a }, capitalize(a))),
    );
    // Keep the current selection even if it isn't in the known set.
    if (filters.action && !opts.includes(filters.action)) {
      actionSelect.appendChild(h('option', { value: filters.action }, capitalize(filters.action)));
    }
    actionSelect.value = filters.action || '';
  }
  refreshActionOptions();

  // Search (debounced -> q param).
  let searchTimer = null;
  const searchBox = h('div', { class: 'search', style: { marginLeft: '0', width: 'min(260px, 40vw)' } },
    Icon('search', 14),
    h('input', {
      type: 'search', placeholder: 'Search activity…', 'aria-label': 'Search activity',
      value: filters.q || '',
      onInput: (e) => {
        const v = e.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { filters.q = v.trim(); reload(); }, 250);
      },
      // Enter searches immediately rather than waiting out the debounce.
      onKeydown: (e) => {
        if (imeGuard(e)) return;
        if (e.key === 'Enter') { clearTimeout(searchTimer); filters.q = e.target.value.trim(); reload(); }
      },
    }),
  );

  const toolbar = h('div', {
    class: 'activity-toolbar',
    style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginBottom: '14px' },
  },
    h('span', { class: 'hstack', style: { gap: '6px', color: 'var(--fg-3)', fontSize: '12px' } }, Icon('filter', 13), 'Filter'),
    userSelect,
    actionSelect,
    searchBox,
  );
  root.appendChild(toolbar);

  // ---- list ----------------------------------------------------------------
  const list = h('div', {
    class: 'card',
    style: { maxHeight: 'calc(100vh - 260px)', overflowY: 'auto', padding: '4px 0' },
    role: 'list', 'aria-label': 'Activity entries', 'aria-busy': 'false',
  });
  root.appendChild(list);

  // "Load more" footer.
  const moreBtn = h('button', {
    class: 'btn btn-ghost',
    style: { width: '100%', marginTop: '12px', display: 'none', justifyContent: 'center' },
    onClick: () => loadMore(),
  }, 'Load more');
  root.appendChild(moreBtn);

  // ---- rendering helpers ---------------------------------------------------
  function setBusy(on) { list.setAttribute('aria-busy', on ? 'true' : 'false'); }

  function loadingState() {
    return h('div', { class: 'empty', style: { padding: '40px 20px' } }, 'Loading activity…');
  }
  function emptyState() {
    const hasFilters = filters.user_id != null || filters.action || filters.q;
    return h('div', { class: 'empty', style: { padding: '48px 20px', display: 'grid', gap: '8px', justifyItems: 'center' } },
      Icon('activity', 22),
      h('div', null, hasFilters ? 'No activity matches these filters.' : 'No activity recorded yet.'),
      hasFilters
        ? h('button', { class: 'btn btn-muted', style: { fontSize: '12px' }, onClick: clearFilters }, 'Clear filters')
        : null,
    );
  }
  function errorState(msg) {
    return h('div', { class: 'empty', style: { padding: '40px 20px', display: 'grid', gap: '10px', justifyItems: 'center' } },
      h('div', { style: { color: 'var(--red, #EF4444)' } }, msg || 'Could not load activity.'),
      h('button', { class: 'btn btn-ghost', style: { fontSize: '12px' }, onClick: () => reload() }, 'Retry'),
    );
  }

  function renderRows() {
    mount(list);
    if (run.items.length === 0) {
      list.appendChild(run.loading ? loadingState() : emptyState());
      return;
    }
    for (const a of run.items) list.appendChild(ActivityRow(a, onOpenTask));
    if (run.loading) {
      // First page → skeleton rows; subsequent pages already show rows above, so
      // keep a lighter inline hint for the append.
      list.appendChild(run.items.length
        ? h('div', { class: 'empty', style: { padding: '14px' } }, 'Loading…')
        : SkeletonRows(6, { style: { padding: '4px 0' } }));
    }
  }

  // ---- data ----------------------------------------------------------------
  async function fetchPage(reset) {
    if (run.loading) return;
    run.loading = true;
    setBusy(true);
    moreBtn.disabled = true;
    const seq = ++run.reqSeq; // guard against out-of-order responses on rapid filtering
    if (reset) { run.offset = 0; run.exhausted = false; run.items = []; }
    renderRows();
    try {
      const resp = await API.activityLog({
        limit: ACTIVITY_PAGE,
        offset: run.offset,
        user_id: filters.user_id,
        action: filters.action,
        q: filters.q,
      });
      if (seq !== run.reqSeq) return; // a newer request superseded this one
      const rows = (resp && resp.activity) || [];
      run.items = reset ? rows : run.items.concat(rows);
      run.offset = run.items.length;
      run.exhausted = !(resp && resp.has_more);
      run.loading = false;
      refreshActionOptions();
      renderRows();
    } catch (err) {
      if (seq !== run.reqSeq) return;
      run.loading = false;
      if (reset) { mount(list, errorState(err && err.message)); }
      else { renderRows(); if (typeof toast === 'function') toast(err.message || 'Failed to load more', 'error'); }
    } finally {
      if (seq === run.reqSeq) {
        setBusy(false);
        moreBtn.disabled = false;
        moreBtn.style.display = run.exhausted || run.items.length === 0 ? 'none' : 'flex';
      }
    }
  }

  function reload() { fetchPage(true); }       // re-filter: reset + replace
  function loadMore() { fetchPage(false); }    // paginate: append

  function clearFilters() {
    filters.user_id = null; filters.action = ''; filters.q = '';
    userSelect.value = ''; actionSelect.value = '';
    const inp = searchBox.querySelector('input'); if (inp) inp.value = '';
    reload();
  }

  // Kick off the first load.
  reload();

  return root;
}

// A single activity entry: actor avatar, "<name> <action> <detail>", linked
// task chip, and a right-aligned relative timestamp. The whole row is keyboard
// focusable and opens the linked task on Enter/Space/click (when it has one).
function ActivityRow(a, onOpenTask) {
  const user = a.user || (a.user_id != null ? userById(a.user_id) : null);
  const task = a.task || null;
  const interactive = !!(task && task.id != null);

  const row = h('div', {
    class: 'activity-row',
    role: 'listitem',
    tabindex: '0',
    style: {
      display: 'flex', gap: '12px', alignItems: 'flex-start',
      padding: '12px 16px', borderTop: '1px solid var(--line)',
      cursor: interactive ? 'pointer' : 'default', transition: 'background 0.1s',
    },
    onMouseenter: e => e.currentTarget.style.background = 'var(--bg-3)',
    onMouseleave: e => e.currentTarget.style.background = 'transparent',
    onClick: interactive ? () => onOpenTask(task.id) : null,
    onKeydown: interactive ? (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenTask(task.id); }
    } : null,
  });

  row.appendChild(user ? Avatar(user, 28) : h('div', {
    class: 'avatar', style: { width: '28px', height: '28px', background: 'var(--bg-4)', color: 'var(--fg-3)', fontSize: '11px' },
  }, '?'));

  const body = h('div', { style: { flex: 1, minWidth: 0 } });
  // Sentence line: actor (bold) + action (muted) + detail.
  const sentence = h('div', { style: { fontSize: '13px', color: 'var(--fg-1)', lineHeight: '1.4' } },
    h('span', { style: { fontWeight: '600', color: 'var(--fg-0)' } }, (user && user.name) || 'Someone'),
    ' ',
    h('span', { style: { color: 'var(--fg-2)' } }, a.action || 'did something'),
    a.detail ? h('span', { style: { color: 'var(--fg-1)' } }, ' ' + a.detail) : null,
  );
  body.appendChild(sentence);

  // Linked task chip (ref + title). Clicking it opens the task; stopPropagation
  // is harmless here since the row does the same, but keeps intent explicit.
  if (task) {
    body.appendChild(h('div', {
      class: 'hstack',
      style: { gap: '6px', marginTop: '3px', fontSize: '12px', cursor: interactive ? 'pointer' : 'default' },
      onClick: interactive ? (e) => { e.stopPropagation(); onOpenTask(task.id); } : null,
    },
      h('span', { class: 'mono', style: { color: 'var(--acc-1)', fontSize: '11.5px' } }, task.ref || ''),
      task.title ? h('span', {
        style: { color: 'var(--fg-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, task.title) : null,
    ));
  }
  row.appendChild(body);

  row.appendChild(h('span', {
    style: { fontSize: '11.5px', color: 'var(--fg-4)', whiteSpace: 'nowrap', paddingTop: '1px' },
    title: a.created_at || '',
  }, relTime(a.created_at)));

  return row;
}

function capitalize(s) {
  s = String(s || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

window.renderActivity = renderActivity;
