// Main app shell. Assumes icons.js, api.js, ui.js, and the view files have loaded.

(async function main() {
  const rootEl = document.getElementById('root');
  mount(rootEl, h('div', { class: 'empty', style: { padding: '80px 20px' } }, 'Loading…'));

  // Ensure session.
  try {
    const me = (await API.me()).user;
    if (!me) { location.href = 'login.html'; return; }
  } catch (e) {
    console.error('Auth check failed, redirecting to login:', e);
    location.href = 'login.html'; return;
  }

  // Bootstrap all data.
  let boot;
  try { boot = await API.bootstrap(); }
  catch (e) {
    mount(rootEl, h('div', { class: 'empty' }, 'Failed to load: ' + (e.message || 'Unknown error')));
    return;
  }

  // Global state (used by UI helpers that call `window.state`).
  const state = window.state = {
    me:       boot.me,
    users:    boot.users,
    projects: boot.projects,
    labels:   boot.labels,
    tasks:    boot.tasks,
    activity: [],
    savedViews: [],
    view: localStorage.getItem('pm_view') || 'dashboard',
    filterProject: null,
    filterAssignee: null,
    filterLabels: [],
    search: '',
    openTaskId: null,
    quickAddOpen: false,
    quickAddStatus: 'todo',
    settingsOpen: false,
    mobileSidebarOpen: false,
    notifOpen: false,
    shortcutsOpen: false,
    // v2 collections
    notifications: [],
    unread: 0,
    milestones: [],
    customFields: [],
    templates: [],
    goals: [],
    // theme: initialize from the RESOLVED theme so ThemeToggle reflects what's
    // actually on screen. An explicit saved choice wins; otherwise follow the OS
    // (matching the CSS, which uses prefers-color-scheme when no data-theme is
    // set). Without this, an OS-light first-run showed the light UI but held
    // theme:'dark', so the first toggle click appeared to do nothing.
    theme: (function () {
      const s = localStorage.getItem('pm_theme');
      if (s === 'light' || s === 'dark') return s;
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    })(),
    density: localStorage.getItem('pm_density') === 'compact' ? 'compact' : 'comfortable',
    // view-local UI state, LIFTED here so it survives full re-renders
    ui: {
      list:      { groupBy: 'status', sortBy: 'priority', sortDir: 'asc', collapsed: {}, selected: [] },
      calendar:  { cursor: ymd(today()).slice(0, 8) + '01' },
      checklist: { expanded: {}, showCompleted: false },
      kanban:    { swimlane: 'none' },
      timeline:  { zoom: 'week', cursor: ymd(today()) },
      activity:  { user_id: null, action: '', q: '' },
      dashboard: { customizing: false },
    },
  };
  // The app has finished its initial auth check + data load. From here on a 401
  // means the session expired mid-use, so api.js may redirect to login.
  window.__pmBooted = true;
  // Apply persisted theme immediately (index.html also sets it pre-paint).
  try {
    const savedTheme = localStorage.getItem('pm_theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
      document.documentElement.dataset.theme = savedTheme;
    }
  } catch { /* ignore */ }
  const saved = localStorage.getItem('pm_project');
  if (saved && saved !== 'null') state.filterProject = parseInt(saved, 10);
  const savedAssignee = localStorage.getItem('pm_assignee');
  if (savedAssignee && savedAssignee !== 'null') state.filterAssignee = parseInt(savedAssignee, 10);
  try {
    const savedLabels = JSON.parse(localStorage.getItem('pm_labels') || '[]');
    if (Array.isArray(savedLabels)) state.filterLabels = savedLabels.map(Number).filter(Boolean);
  } catch { /* ignore unparsable history */ }

  function taskIdFromHash() {
    const m = (location.hash || '').match(/^#task=(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  }

  function setTaskHash(taskId) {
    if (taskId) {
      const next = `#task=${taskId}`;
      if (location.hash !== next) history.replaceState(null, '', next);
      return;
    }
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  function syncTaskFromHash() {
    const hashId = taskIdFromHash();
    if (!hashId) {
      if (state.openTaskId !== null) {
        state.openTaskId = null;
        renderApp();
      }
      return;
    }
    // A deep-linked task may not be in the bulk-loaded set (large/paginated
    // workspace). Fetch it on demand via openTaskById rather than silently
    // dropping the hash and refusing to open it.
    if (!state.tasks.some(t => t.id === hashId)) {
      if (typeof openTaskById === 'function') openTaskById(hashId);
      return;
    }
    if (state.openTaskId !== hashId) {
      state.openTaskId = hashId;
      renderApp();
    }
  }

  // Activity is fetched at boot and re-fetched (debounced) whenever something
  // in the UI makes a change that might produce a server-side activity row.
  // We keep it cheap: only the dashboard actually consumes it.
  function refreshActivity() {
    clearTimeout(refreshActivity._t);
    refreshActivity._t = setTimeout(() => {
      API.listActivity().then(r => {
        state.activity = r.activity;
        if (state.view === 'dashboard') renderApp();
      }).catch(e => console.warn('Activity refresh failed:', e));
    }, 400);
  }
  API.listActivity().then(r => { state.activity = r.activity; if (state.view === 'dashboard') renderApp(); })
    .catch(e => console.warn('Initial activity load failed:', e));
  API.listSavedViews().then(r => { state.savedViews = r.saved_views || []; renderApp(); })
    .catch(e => console.warn('Saved views load failed:', e));
  // Exposed so view modules (e.g. task drawer when a comment is posted) can
  // nudge the feed without reaching into app.js internals.
  window.pmRefreshActivity = () => refreshActivity();
  window.pmCreateLabelFromPicker = (name, projectId) => createLabelFromPicker(name, projectId);

  // ----- v2 boot loads + helpers -----
  function loadNotifications() {
    return API.listNotifications().then(r => {
      state.notifications = r.notifications || [];
      state.unread = r.unread || 0;
      renderApp();
    }).catch(e => console.warn('Notifications load failed:', e));
  }
  function loadMilestones() {
    return API.listMilestones().then(r => { state.milestones = r.milestones || []; renderApp(); })
      .catch(e => console.warn('Milestones load failed:', e));
  }
  function loadCustomFields() {
    return API.listCustomFields().then(r => { state.customFields = r.fields || []; renderApp(); })
      .catch(e => console.warn('Custom fields load failed:', e));
  }
  function loadTemplates() {
    return API.listTemplates().then(r => { state.templates = r.templates || []; renderApp(); })
      .catch(e => console.warn('Templates load failed:', e));
  }
  function loadGoals() {
    return API.listGoals().then(r => { state.goals = r.goals || []; renderApp(); })
      .catch(e => console.warn('Goals load failed:', e));
  }
  function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = state.theme;
    // Keep the mobile browser chrome / PWA color in sync with the chosen theme.
    try {
      const tc = document.querySelector('meta[name="theme-color"]:not([media])');
      if (tc) tc.setAttribute('content', state.theme === 'light' ? '#F6F8FB' : '#0B0F17');
    } catch { /* ignore */ }
    try { localStorage.setItem('pm_theme', state.theme); } catch { /* ignore */ }
    renderApp();
  }
  function toggleDensity() {
    state.density = state.density === 'compact' ? 'comfortable' : 'compact';
    try { localStorage.setItem('pm_density', state.density); } catch { /* ignore */ }
    renderApp();
  }
  loadNotifications();
  loadMilestones();
  loadCustomFields();
  loadTemplates();
  loadGoals();
  // Light polling keeps the notification bell fresh without SSE/websockets,
  // which are impractical on shared cPanel hosting. Skip the tick while the user
  // is mid-interaction in a modal or the task drawer: loadNotifications() calls
  // renderApp(), which replaces the root and would wipe unsaved input (new-task
  // fields, profile/settings forms, a comment being typed). The bell catches up
  // on the next poll once the surface is closed.
  setInterval(() => {
    if (state.openTaskId || state.quickAddOpen || state.profileOpen ||
        state.settingsOpen || state.shortcutsOpen) return;
    // Also skip while an open popover/picker or the notification dropdown is on
    // screen — a full renderApp() would detach its anchor and mis-position it.
    if (document.querySelector('.popover') || state.notifOpen) return;
    loadNotifications();
  }, 60000);

  // Single global Escape handler for the hand-built overlays (quick-add,
  // profile, settings). Installed ONCE here rather than per-render so it can't
  // leak duplicate listeners. Closes the topmost overlay; defers to any open
  // popover (which has its own Esc) so a first Esc dismisses the popover and a
  // second closes the modal. The modal() helper manages its own dialogs.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.popover')) return;
    if (state.settingsOpen) { state.settingsOpen = false; renderApp(); }
    else if (state.profileOpen) { state.profileOpen = false; renderApp(); }
    else if (state.quickAddOpen) { state.quickAddOpen = false; state.quickAddDefaults = null; renderApp(); }
  });

  // Exposed so view modules / the task drawer can refresh shared data.
  window.pmRefreshTasks = () => refreshTasks();
  window.pmLoadNotifications = () => loadNotifications();
  window.pmLoadMilestones = () => loadMilestones();
  window.pmLoadCustomFields = () => loadCustomFields();
  window.pmLoadTemplates = () => loadTemplates();
  window.pmLoadGoals = () => loadGoals();
  window.pmToggleTheme = () => toggleTheme();
  window.pmToggleDensity = () => toggleDensity();

  // ----- actions -----
  async function refreshTasks() {
    const r = await API.listTasks();
    state.tasks = r.tasks;
    renderApp();
  }
  async function refreshLabels(opts = {}) {
    const r = await API.listLabels(opts);
    state.labels = r.labels || [];
    renderApp();
    return state.labels;
  }
  async function createLabelFromPicker(name, projectId = null) {
    const payload = { name, color: 'slate' };
    if (projectId != null) payload.project_id = projectId;
    const r = await API.createLabel(payload);
    await refreshLabels();
    return r.label;
  }
  async function updateTask(id, patch) {
    const r = await API.updateTask(id, patch);
    state.tasks = state.tasks.map(t => t.id === id ? r.task : t);
    renderApp();
    refreshActivity();
    return r;
  }
  async function moveTask(id, statusId) { return updateTask(id, { status: statusId }); }
  async function toggleStatus(id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    return updateTask(id, { status: t.status === 'done' ? 'todo' : 'done' });
  }
  async function toggleSubtask(taskId, subId, done) {
    await API.updateSubtask(taskId, subId, { done });
    const t = state.tasks.find(x => x.id === taskId);
    if (t) t.subtasks = (t.subtasks || []).map(s => s.id === subId ? { ...s, done } : s);
  }
  async function addSubtask(taskId, text) {
    const r = await API.addSubtask(taskId, text);
    const t = state.tasks.find(x => x.id === taskId);
    if (t) t.subtasks = [...(t.subtasks || []), r.subtask];
    return r;
  }
  async function deleteSubtask(taskId, subId) {
    await API.deleteSubtask(taskId, subId);
    const t = state.tasks.find(x => x.id === taskId);
    if (t) t.subtasks = (t.subtasks || []).filter(s => s.id !== subId);
  }
  async function deleteTask(id) {
    await API.deleteTask(id);
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderApp();
  }
  async function createTask(data) {
    const r = await API.createTask(data);
    state.tasks = [r.task, ...state.tasks];
    renderApp();
    refreshActivity();
    return r.task;
  }
  async function bulkUpdateLabels(taskIds, labelIds, mode) {
    const ids = [...new Set((taskIds || []).map(Number).filter(Boolean))];
    const lids = [...new Set((labelIds || []).map(Number).filter(Boolean))];
    if (!ids.length || !lids.length) return;
    for (const id of ids) {
      const task = state.tasks.find(t => t.id === id);
      if (!task) continue;
      const next = new Set(task.labels || []);
      if (mode === 'add') lids.forEach(lid => next.add(lid));
      if (mode === 'remove') lids.forEach(lid => next.delete(lid));
      await API.updateTask(id, { labels: [...next] });
    }
    await refreshTasks();
    toast(`Updated labels on ${ids.length} task${ids.length === 1 ? '' : 's'}`, 'success');
  }
  async function bulkUpdateTasks(taskIds, patch, successLabel = 'Updated tasks') {
    const ids = [...new Set((taskIds || []).map(Number).filter(Boolean))];
    if (!ids.length) return;
    await API.bulkUpdateTasks(ids, patch);
    await refreshTasks();
    toast(`${successLabel} (${ids.length})`, 'success');
  }
  function applySavedView(sv) {
    if (!sv) return;
    state.view = sv.view_key || 'list';
    state.filterProject = sv.filters?.project ?? null;
    state.filterAssignee = sv.filters?.assignee ?? null;
    state.filterLabels = Array.isArray(sv.filters?.labels) ? sv.filters.labels : [];
    state.search = sv.filters?.search || '';
    // v2.3: restore per-view layout (grouping/sort/columns/cursor) if the saved
    // view captured it.
    const savedUi = sv.filters?.ui;
    if (savedUi && typeof savedUi === 'object') {
      for (const k in savedUi) {
        if (savedUi[k] && typeof savedUi[k] === 'object') state.ui[k] = { ...(state.ui[k] || {}), ...savedUi[k] };
      }
    }
    persist();
    renderApp();
  }
  async function saveCurrentView() {
    const name = await promptDialog({ title: 'Save view', label: 'Name this view', placeholder: 'e.g. My urgent tasks' });
    if (!name) return;
    const payload = {
      name,
      view_key: state.view,
      filters: {
        project: state.filterProject,
        assignee: state.filterAssignee,
        labels: state.filterLabels,
        search: state.search,
        ui: JSON.parse(JSON.stringify(state.ui)),
      },
    };
    const r = await API.createSavedView(payload);
    state.savedViews = [r.saved_view, ...(state.savedViews || [])];
    renderApp();
    toast('Saved view created', 'success');
  }

  // ----- filter logic -----
  function filteredTasks() {
    const q = state.search.trim().toLowerCase();
    return state.tasks.filter(t => {
      if (state.filterProject && t.project != state.filterProject) return false;
      if (state.filterAssignee && !(t.assignees || []).includes(state.filterAssignee)) return false;
      if (state.filterLabels.length && !state.filterLabels.some(l => (t.labels || []).includes(l))) return false;
      if (q && !(t.title || '').toLowerCase().includes(q) && !(t.ref || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // Export the currently-filtered tasks to a CSV download (client-side, no deps).
  function exportTasksCsv(tasks) {
    const esc = v => {
      let s = v == null ? '' : String(v);
      // Neutralize spreadsheet formula injection: a cell a user controls (e.g. a
      // task titled =HYPERLINK(...)) would otherwise execute when the CSV is
      // opened in Excel/Sheets. Prefix leading =,+,-,@,tab,CR with a single quote.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = ['Ref', 'Title', 'Project', 'Status', 'Priority', 'Assignees', 'Labels',
      'Due', 'Start', 'Estimate', 'Time logged (min)', 'Milestone'];
    const rows = tasks.map(t => [
      t.ref, t.title,
      projectById(t.project)?.name || '',
      statusById(t.status)?.name || t.status,
      PRIO_LABELS[t.priority] || '',
      (t.assignees || []).map(id => userById(id)?.name || id).join('; '),
      (t.labels || []).map(id => labelById(id)?.name || id).join('; '),
      t.due || '', t.start_date || '', t.estimate || '', t.time_logged || 0,
      (state.milestones.find(m => m.id == t.milestone_id)?.name) || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `castle-tasks-${ymd(today())}.csv` });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 0);
    toast(`Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'}`, 'success');
  }

  // ----- command palette (⌘K) item provider -----
  function commandItems(query) {
    const q = (query || '').trim().toLowerCase();
    const cmds = [];
    const add = (label, icon, run, hint) => cmds.push({ label, icon, run, hint });
    const views = [
      ['dashboard', 'Dashboard', 'dashboard'], ['kanban', 'Kanban', 'kanban'],
      ['list', 'List', 'list'], ['checklist', 'My tasks', 'checkSquare'],
      ['calendar', 'Calendar', 'calendar'], ['timeline', 'Timeline', 'gantt'],
      ['workload', 'Workload', 'users'], ['activity', 'Activity', 'activity'],
      ['goals', 'Goals', 'target'],
    ];
    for (const [k, l, ic] of views) add(`Go to ${l}`, ic, () => { state.view = k; persist(); renderApp(); }, 'View');
    add('New task', 'plus', () => { state.quickAddStatus = 'todo'; state.quickAddDefaults = null; state.quickAddOpen = true; renderApp(); }, 'Create');
    add('Settings', 'settings', () => { state.settingsOpen = true; renderApp(); }, 'Admin');
    add(state.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme', state.theme === 'light' ? 'moon' : 'sun', () => toggleTheme(), 'Theme');
    add('Export tasks to CSV', 'download', () => exportTasksCsv(filteredTasks()), 'Export');
    add('Import tasks from CSV', 'upload', () => { if (typeof openImport === 'function') openImport(); }, 'Import');
    add('Clear filters', 'x', () => { state.filterProject = null; state.filterAssignee = null; state.filterLabels = []; persist(); renderApp(); }, 'Filter');
    add(state.density === 'compact' ? 'Comfortable density' : 'Compact density', 'list', () => toggleDensity(), 'Display');
    add('Keyboard shortcuts', 'alert', () => { state.shortcutsOpen = true; renderApp(); }, 'Help');
    for (const p of state.projects) add(`Filter: ${p.name}`, 'folder', () => { state.filterProject = p.id; if (state.view === 'dashboard') state.view = 'kanban'; persist(); renderApp(); }, 'Project');

    const taskItem = (t) => ({
      label: t.title, sublabel: t.ref, icon: 'checkSquare',
      hint: projectById(t.project)?.name || '',
      run: () => openTaskById(t.id),
    });
    if (!q) {
      // Instant on open: commands + recently-loaded tasks (no server round-trip).
      return [...cmds.slice(0, 9), ...state.tasks.slice(0, 6).map(taskItem)];
    }
    const cmdMatches = cmds.filter(c => c.label.toLowerCase().includes(q) || (c.hint || '').toLowerCase().includes(q));
    // Server-backed task search so the palette can jump to ANY task, not just
    // the bulk-loaded set (scales past a few thousand). Falls back to local.
    return API.searchTasks({ q: query, limit: 8 })
      .then(r => [...cmdMatches, ...((r.tasks || []).map(taskItem))])
      .catch(() => {
        const pool = state.tasks.filter(t => t.title.toLowerCase().includes(q) || (t.ref || '').toLowerCase().includes(q)).slice(0, 8);
        return [...cmdMatches, ...pool.map(taskItem)];
      });
  }
  async function openTaskById(id) {
    // Server search can return a task not in the bulk-loaded set — fetch it on
    // demand so the drawer can render it.
    if (!state.tasks.some(t => t.id === id)) {
      try { const r = await API.getTask(id); if (r.task) state.tasks = [r.task, ...state.tasks]; } catch (_) { /* ignore */ }
    }
    state.openTaskId = id; setTaskHash(id); renderApp();
  }
  function openCmd() {
    if (typeof openCommandPalette === 'function') openCommandPalette(commandItems);
    else document.getElementById('global-search')?.focus();
  }
  window.pmOpenCommandPalette = () => openCmd();

  // Make a non-<button> clickable element operable by keyboard: adds a button
  // role, puts it in the tab order, and triggers on Enter/Space. Spread into an
  // h() props object: h('div', clickable(fn, {class:'nav-item'}), ...).
  function clickable(onActivate, extra = {}) {
    return {
      role: 'button', tabindex: '0',
      onClick: onActivate,
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          onActivate(e);
        }
      },
      ...extra,
    };
  }
  window.pmClickable = clickable;

  // ----- render root -----
  function renderApp() {
    if (window.innerWidth > 980 && state.mobileSidebarOpen) state.mobileSidebarOpen = false;
    const app = h('div', { class: 'app' + (state.density === 'compact' ? ' density-compact' : '') });
    if (state.mobileSidebarOpen) app.classList.add('mobile-nav-open');
    app.appendChild(renderSidebar());
    app.appendChild(renderMain());
    mount(rootEl, app);
    if (state.mobileSidebarOpen) {
      rootEl.appendChild(h('button', {
        class: 'scrim mobile-nav-scrim',
        'aria-label': 'Close navigation',
        onClick: () => { state.mobileSidebarOpen = false; renderApp(); },
      }));
    }

    if (state.openTaskId) {
      const t = state.tasks.find(x => x.id === state.openTaskId);
      if (t) rootEl.appendChild(renderTaskDetail(t, {
        onClose: () => { state.openTaskId = null; setTaskHash(null); renderApp(); },
        onUpdate: updateTask,
        onToggleSubtask: toggleSubtask,
        onAddSubtask: addSubtask,
        onDeleteSubtask: deleteSubtask,
        onDeleteTask: deleteTask,
      }));
      else {
        state.openTaskId = null;
        setTaskHash(null);
      }
    }
    if (state.quickAddOpen) rootEl.appendChild(renderQuickAdd());
    if (state.profileOpen) rootEl.appendChild(renderProfile());
    if (state.settingsOpen) rootEl.appendChild(renderSettings());
    if (state.shortcutsOpen) rootEl.appendChild(renderShortcutsHelp());
    // App-like bottom nav on phones — hidden while any overlay/drawer is open.
    if (!state.openTaskId && !state.quickAddOpen && !state.settingsOpen && !state.profileOpen && !state.shortcutsOpen && !state.mobileSidebarOpen) {
      rootEl.appendChild(renderMobileNav());
    }
  }

  // ----- sidebar -----
  function renderSidebar() {
    const side = h('aside', { class: 'sidebar' });

    side.appendChild(h('div', { class: 'brand' },
      (() => {
        const m = h('div', { class: 'brand-mark' });
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'white');
        svg.setAttribute('stroke-width', '2.2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.innerHTML = '<path d="M3 21V8l9-5 9 5v13" /><path d="M9 21v-7h6v7" /><path d="M3 10h4M17 10h4M3 15h4M17 15h4" />';
        m.appendChild(svg);
        return m;
      })(),
      h('div', null,
        h('div', { class: 'brand-name' }, 'Castle'),
        h('div', { class: 'brand-sub' }, 'tech · tasks'),
      ),
    ));

    side.appendChild(h('div', { class: 'workspace-switcher' },
      h('div', { class: 'ws-avatar' }, (state.me.initials || 'CT').slice(0, 2)),
      h('div', { class: 'ws-name' }, 'Workspace'),
      Icon('chevronDown', 13, 1.75, 'ws-chev'),
    ));

    const scroll = h('div', { class: 'sidebar-scroll' });

    // Section: main nav
    const nav1 = h('div', { class: 'nav-section' });
    nav1.appendChild(NavItem('home', 'Home', state.view === 'dashboard' && !state.filterProject, () => {
      state.view = 'dashboard'; state.filterProject = null; persist(); renderApp();
    }));
    const myOpen = state.tasks.filter(t => t.assignees.includes(state.me.id) && t.status !== 'done').length;
    nav1.appendChild(NavItem('checkSquare', 'My tasks', state.view === 'checklist' && !state.filterProject, () => {
      state.view = 'checklist'; state.filterProject = null; persist(); renderApp();
    }, String(myOpen)));
    scroll.appendChild(nav1);

    // Section: projects
    const projSection = h('div', { class: 'nav-section' });
    projSection.appendChild(h('div', { class: 'nav-label' }, 'Projects'));
    for (const p of state.projects) {
      const count = state.tasks.filter(t => t.project == p.id && t.status !== 'done').length;
      const isActive = state.filterProject == p.id;
      const row = h('div', clickable(() => {
          state.filterProject = isActive ? null : p.id;
          if (state.view === 'dashboard') state.view = 'kanban';
          if (window.innerWidth <= 980) state.mobileSidebarOpen = false;
          persist(); renderApp();
        }, {
        class: 'nav-proj' + (isActive ? ' active' : ''),
        'aria-pressed': isActive ? 'true' : 'false',
        'aria-label': 'Filter by project ' + p.name,
      }),
        h('span', { class: 'proj-dot', style: { background: p.color } }),
        h('span', { class: 'proj-name' }, p.name),
        p.visibility === 'private' ? Icon('lock', 11, 1.75, 'proj-lock') : null,
        h('span', { class: 'proj-count' }, String(count)),
      );
      if (p.visibility === 'private') row.title = 'Private project — members only';
      projSection.appendChild(row);
    }
    scroll.appendChild(projSection);

    // Section: labels (first 5)
    const labelSection = h('div', { class: 'nav-section' });
    labelSection.appendChild(h('div', { class: 'nav-label' }, 'Labels'));
    for (const l of state.labels.slice(0, 5)) {
      labelSection.appendChild(h('div', clickable(() => {
          state.filterLabels = [l.id]; state.view = 'list';
          if (window.innerWidth <= 980) state.mobileSidebarOpen = false;
          persist(); renderApp();
        }, { class: 'nav-item', style: { padding: '5px 10px' }, 'aria-label': 'Filter by label ' + l.name }),
        h('span', {
          style: {
            width: '10px', height: '10px', padding: 0, borderRadius: '3px',
            background: labelCssColor(l.color), display: 'inline-block',
          }
        }),
        h('span', { style: { fontSize: '12.5px' } }, l.name),
      ));
    }
    scroll.appendChild(labelSection);

    side.appendChild(scroll);

    // Footer (user)
    side.appendChild(h('div', { class: 'sidebar-footer' },
      Avatar(state.me, 28),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'me' }, state.me.name),
        h('div', { class: 'me-role' }, state.me.role || ''),
      ),
      h('button', { class: 'icon-btn sm', title: 'Profile',
        onClick: () => { state.profileOpen = true; renderApp(); } }, Icon('settings', 14)),
      h('button', { class: 'icon-btn sm', title: 'Log out',
        onClick: async () => { await API.logout(); location.href = 'login.html'; } }, Icon('logout', 14)),
    ));

    return side;
  }

  function NavItem(icon, label, active, onClick, count) {
    const wrappedClick = () => {
      onClick();
      if (window.innerWidth <= 980) state.mobileSidebarOpen = false;
    };
    const el = h('div', clickable(wrappedClick, {
      class: 'nav-item' + (active ? ' active' : ''),
      'aria-current': active ? 'page' : null,
      'aria-label': label,
    }),
      Icon(icon, 15),
      h('span', null, label),
    );
    if (count) el.appendChild(h('span', { class: 'count' }, count));
    return el;
  }

  function labelCssColor(name) {
    return {
      red: '#EF4444', blue: '#3B82F6', amber: '#F59E0B', green: '#22C55E',
      violet: '#A855F7', slate: '#64748B', pink: '#EC4899', cyan: '#06B6D4',
    }[name] || '#64748B';
  }

  // ----- mobile bottom nav (phones; CSS hides it on desktop) -----
  function renderMobileNav() {
    const item = (icon, label, active, onClick, extra) => h('button', {
      class: 'mbn-item' + (active ? ' active' : '') + (extra ? ' ' + extra : ''),
      'aria-current': active ? 'page' : null,
      onClick,
    }, Icon(icon, 19), h('span', null, label));
    return h('nav', { class: 'mobile-bottom-nav', 'aria-label': 'Primary' },
      item('home', 'Home', state.view === 'dashboard', () => { state.view = 'dashboard'; persist(); renderApp(); }),
      item('checkSquare', 'My Tasks', state.view === 'checklist', () => { state.view = 'checklist'; persist(); renderApp(); }),
      item('kanban', 'Board', state.view === 'kanban', () => { state.view = 'kanban'; persist(); renderApp(); }),
      item('plus', 'New', false, () => { state.quickAddStatus = 'todo'; state.quickAddDefaults = null; state.quickAddOpen = true; renderApp(); }, 'mbn-new'),
      item('list', 'Menu', false, () => { state.mobileSidebarOpen = true; renderApp(); }),
    );
  }

  // ----- main area -----
  function renderMain() {
    const main = h('main', { class: 'main' });
    main.appendChild(renderTopbar());
    main.appendChild(renderFilters());
    const content = h('div', { class: 'content' });
    main.appendChild(content);

    const tasks = filteredTasks();
    const handlers = {
      onOpenTask: (id) => { state.openTaskId = id; setTaskHash(id); renderApp(); },
      onAddTask: (statusId, extras = {}) => {
        state.quickAddStatus = statusId || 'todo';
        state.quickAddDefaults = {
          projectId: extras.projectId ?? null,
          assigneeId: extras.assigneeId ?? null,
          due: extras.due ?? null,
        };
        state.quickAddOpen = true;
        renderApp();
      },
      onMoveTask: (id, s) => moveTask(id, s),
      onToggleStatus: id => toggleStatus(id),
      onBulkLabels: bulkUpdateLabels,
      onBulkUpdate: bulkUpdateTasks,
      onToggleSubtask: toggleSubtask,
      onMoveTaskDate: (id, due) => updateTask(id, { due }),
      onReorder: (id, patch) => updateTask(id, patch),
      onNavigate: (v, projectId) => {
        state.view = v;
        if (projectId !== undefined) state.filterProject = projectId;
        persist(); renderApp();
      },
      activity: state.activity,
    };

    switch (state.view) {
      case 'dashboard': content.appendChild(renderDashboard(state.tasks, handlers)); break;
      case 'kanban':    content.appendChild(renderKanban(tasks, handlers)); break;
      case 'list':      content.appendChild(renderList(tasks, handlers)); break;
      case 'checklist': content.appendChild(renderChecklist(state.tasks, handlers)); break;
      case 'calendar':  content.appendChild(renderCalendar(tasks, handlers)); break;
      case 'timeline':  content.appendChild(renderTimeline(tasks, handlers)); break;
      case 'workload':  content.appendChild(renderWorkload(tasks, handlers)); break;
      case 'activity':  content.appendChild(renderActivity(state.tasks, handlers)); break;
      case 'goals':     content.appendChild(renderGoals(state.tasks, handlers)); break;
      default: content.appendChild(h('div', { class: 'empty' }, 'Unknown view'));
    }
    return main;
  }

  // Notification dropdown, portalled via openPopover and anchored to the bell.
  function openNotifications(anchor) {
    openPopover(anchor, ({ close }) => {
      const wrap = h('div', { class: 'notif-panel' });
      wrap.appendChild(h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                 padding: '10px 12px', borderBottom: '1px solid var(--line)' } },
        h('strong', { style: { fontSize: 'var(--fs-md, 13px)' } }, 'Notifications'),
        state.notifications.some(n => !n.is_read)
          ? h('button', { class: 'btn btn-ghost', style: { fontSize: '11.5px', padding: '3px 7px' },
              onClick: async () => { try { await API.markAllNotificationsRead(); } catch (e) { toast(e.message, 'error'); } await loadNotifications(); close(); } },
              'Mark all read')
          : null,
      ));
      if (!state.notifications.length) {
        wrap.appendChild(h('div', { class: 'empty', style: { padding: '24px 16px' } }, "You're all caught up."));
      }
      for (const n of state.notifications) {
        const openNotif = async () => {
          if (!n.is_read) { try { await API.markNotificationRead(n.id); } catch { /* ignore */ } }
          close();
          await loadNotifications();
          // Use openTaskById so a notification for a task outside the bulk-loaded
          // set still opens (it fetches on demand) instead of silently no-opping.
          if (n.task_id) { await openTaskById(n.task_id); }
        };
        wrap.appendChild(h('div', clickable(openNotif, {
          class: 'notif-item' + (n.is_read ? '' : ' unread'),
        }),
          n.actor ? Avatar(n.actor, 26) : h('span', { class: 'notif-ico' }, Icon('bell', 14)),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '12.5px', color: 'var(--fg-1)' } }, n.body || n.type),
            h('div', { style: { fontSize: '11px', color: 'var(--fg-3)', marginTop: '2px' } }, relTime(n.created_at)),
          ),
        ));
      }
      return wrap;
    }, { align: 'end' });
  }

  function renderTopbar() {
    const bar = h('div', { class: 'topbar' });
    bar.appendChild(h('button', {
      class: 'icon-btn mobile-nav-toggle',
      title: 'Open navigation',
      onClick: () => { state.mobileSidebarOpen = !state.mobileSidebarOpen; renderApp(); },
    }, Icon('list', 16)));
    const proj = state.filterProject ? projectById(state.filterProject) : null;
    const viewLabels = { dashboard: 'Dashboard', kanban: 'Kanban', list: 'List', checklist: 'My tasks', calendar: 'Calendar', timeline: 'Timeline', workload: 'Workload', activity: 'Activity', goals: 'Goals' };
    bar.appendChild(h('div', { class: 'crumbs' },
      h('span', null, 'Workspace'),
      Icon('chevronRight', 12, 1.75, 'sep'),
      proj ? h('span', null, proj.name) : null,
      proj ? Icon('chevronRight', 12, 1.75, 'sep') : null,
      h('span', { class: 'cur' }, viewLabels[state.view] || ''),
    ));

    const search = h('div', { class: 'search', style: { marginLeft: 'auto' } });
    search.appendChild(Icon('search', 14, 1.75, ''));
    const input = h('input', {
      id: 'global-search', placeholder: 'Search tasks...', value: state.search,
      'aria-label': 'Search tasks', type: 'search',
      onInput: e => { state.search = e.target.value; renderMainContent(); },
    });
    search.appendChild(input);
    search.appendChild(h('span', { class: 'kbd' }, navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K'));
    bar.appendChild(search);

    // Theme toggle (sun/moon) — built in ui.js, reads window.state.theme.
    bar.appendChild(ThemeToggle(toggleTheme));

    // Notification bell + unread badge.
    const bell = h('button', { class: 'icon-btn', title: 'Notifications', style: { position: 'relative' } }, Icon('bell', 16));
    if (state.unread > 0) bell.appendChild(h('span', { class: 'badge-count' }, state.unread > 9 ? '9+' : String(state.unread)));
    bell.addEventListener('click', () => openNotifications(bell));
    bar.appendChild(bell);

    bar.appendChild(h('button', { class: 'btn btn-primary',
      onClick: () => { state.quickAddStatus = 'todo'; state.quickAddDefaults = null; state.quickAddOpen = true; renderApp(); } },
      Icon('plus', 14), ' New task'));
    bar.appendChild(h('button', {
      class: 'btn btn-muted',
      onClick: () => { state.settingsOpen = true; renderApp(); },
    }, Icon('settings', 14), ' Settings'));
    return bar;
  }

  // Re-render just main area (used for search typing to avoid losing focus).
  // Replacing .main destroys the search <input>; re-focus it and restore the
  // caret so the user's still typing into the same-looking box.
  let mainRenderHandle = null;
  function renderMainContent() {
    clearTimeout(mainRenderHandle);
    mainRenderHandle = setTimeout(() => {
      const mainEl = rootEl.querySelector('.main');
      if (!mainEl) return renderApp();
      const prev = document.getElementById('global-search');
      const hadFocus = prev && document.activeElement === prev;
      const caret = hadFocus ? prev.selectionStart : null;
      const newMain = renderMain();
      mainEl.replaceWith(newMain);
      if (hadFocus) {
        const next = document.getElementById('global-search');
        if (next) {
          next.focus();
          if (caret != null) try { next.setSelectionRange(caret, caret); } catch {}
        }
      }
    }, 100);
  }

  function renderFilters() {
    const bar = h('div', { class: 'filters' });
    const viewDef = [
      ['dashboard', 'Dashboard', 'dashboard'],
      ['kanban',    'Kanban',    'kanban'],
      ['list',      'List',      'list'],
      ['checklist', 'My tasks',  'checkSquare'],
      ['calendar',  'Calendar',  'calendar'],
      ['timeline',  'Timeline',  'gantt'],
      ['workload',  'Workload',  'users'],
      ['activity',  'Activity',  'activity'],
      ['goals',     'Goals',     'target'],
    ];
    const tabs = h('div', { class: 'view-tabs' });
    for (const [k, l, ic] of viewDef) {
      tabs.appendChild(h('button', {
        class: 'view-tab' + (state.view === k ? ' active' : ''),
        // title keeps the label available on hover / to screen readers when the
        // text collapses to an icon-only tab on narrower screens.
        title: l, 'aria-label': l,
        onClick: () => { state.view = k; persist(); renderApp(); },
      }, Icon(ic, 13), h('span', { class: 'view-tab-label' }, l)));
    }
    bar.appendChild(tabs);

    if (state.view !== 'dashboard' && state.view !== 'checklist') {
      bar.appendChild(h('div', { class: 'filters-sep' }));

      // Project filter
      const projName = state.filterProject ? projectById(state.filterProject)?.name : 'All projects';
      const projBtn = h('button', { class: 'filter-pill' }, Icon('folder', 12), ' ' + projName + ' ', Icon('chevronDown', 11));
      projBtn.addEventListener('click', () => {
        openPopover(projBtn, ({close}) => {
          const wrap = h('div');
          wrap.appendChild(PopoverItem({
            selected: !state.filterProject,
            onSelect: () => { state.filterProject = null; persist(); close(); renderApp(); },
            children: h('span', null, 'All projects'),
          }));
          return h('div', null, wrap, projectPickerContent(state.filterProject, (id) => {
            state.filterProject = id; persist(); renderApp();
          }, close));
        });
      });
      bar.appendChild(projBtn);

      // Assignee filter
      const asgLabel = state.filterAssignee ? (userById(state.filterAssignee)?.name || 'Someone') : 'Anyone';
      const asgBtn = h('button', { class: 'filter-pill' }, Icon('user', 12), ' ' + asgLabel + ' ', Icon('chevronDown', 11));
      asgBtn.addEventListener('click', () => {
        openPopover(asgBtn, ({close}) => assigneePickerContent(
          state.filterAssignee ? [state.filterAssignee] : [],
          uid => { state.filterAssignee = state.filterAssignee === uid ? null : uid; persist(); renderApp(); },
          close,
        ));
      });
      bar.appendChild(asgBtn);

      // Labels
      const lblLabel = state.filterLabels.length ? `${state.filterLabels.length} label${state.filterLabels.length > 1 ? 's' : ''}` : 'Labels';
      const lblBtn = h('button', { class: 'filter-pill' }, Icon('tag', 12), ' ' + lblLabel + ' ', Icon('chevronDown', 11));
      lblBtn.addEventListener('click', () => {
        openPopover(lblBtn, ({close}) => labelPickerContent(
          state.filterLabels,
          lid => {
            const set = new Set(state.filterLabels);
            set.has(lid) ? set.delete(lid) : set.add(lid);
            state.filterLabels = [...set];
            persist();
            renderApp();
          },
          close, { keepOpen: true, scopeProjectId: state.filterProject },
        ));
      });
      bar.appendChild(lblBtn);

      // Clear
      if (state.filterProject || state.filterAssignee || state.filterLabels.length) {
        bar.appendChild(h('button', {
          class: 'btn btn-muted', style: { fontSize: '11.5px', padding: '4px 8px' },
          onClick: () => { state.filterProject = null; state.filterAssignee = null; state.filterLabels = []; persist(); renderApp(); }
        }, Icon('x', 11), ' Clear'));
      }

      const savedViews = state.savedViews || [];
      const svBtn = h('button', { class: 'filter-pill' }, Icon('star', 12), ' Saved views ', Icon('chevronDown', 11));
      svBtn.addEventListener('click', () => {
        openPopover(svBtn, ({ close }) => {
          const wrap = h('div', { style: { minWidth: '220px', padding: '4px' } });
          wrap.appendChild(PopoverItem({
            selected: false,
            onSelect: async () => { close(); try { await saveCurrentView(); } catch (e) { toast(e.message, 'error'); } },
            children: h('span', null, '+ Save current filters'),
          }));
          if (!savedViews.length) wrap.appendChild(h('div', { class: 'empty', style: { padding: '10px' } }, 'No saved views yet.'));
          savedViews.forEach(v => {
            wrap.appendChild(PopoverItem({
              selected: false,
              onSelect: () => { close(); applySavedView(v); },
              children: h('span', null, v.name),
            }));
          });
          return wrap;
        });
      });
      bar.appendChild(svBtn);

      // Count + import/export
      const n = filteredTasks().length;
      bar.appendChild(h('div', { style: { marginLeft: 'auto' }, class: 'hstack' },
        h('button', { class: 'btn btn-muted', style: { fontSize: '11.5px', padding: '4px 8px' }, title: 'Import tasks from CSV',
          onClick: () => { if (typeof openImport === 'function') openImport(); else toast('Import unavailable', 'error'); } }, Icon('upload', 12), ' Import'),
        h('button', { class: 'btn btn-muted', style: { fontSize: '11.5px', padding: '4px 8px' }, title: 'Export these tasks to CSV',
          onClick: () => exportTasksCsv(filteredTasks()) }, Icon('download', 12), ' Export'),
        h('span', { style: { fontSize: '11.5px', color: 'var(--fg-3)' } }, `${n} task${n !== 1 ? 's' : ''}`),
      ));
    }
    return bar;
  }

  // ----- quick-add modal -----
  function renderQuickAdd() {
    const defaults = state.quickAddDefaults || {};
    const assignees = defaults.assigneeId != null ? [defaults.assigneeId] : [state.me.id];
    const form = {
      title: '', status: state.quickAddStatus || 'todo',
      project: defaults.projectId || state.filterProject || (state.projects[0] && state.projects[0].id),
      priority: 2, assignees, labels: [], due: defaults.due || null,
      description: '', estimate: '', templateSubtasks: [],
    };

    const frag = document.createDocumentFragment();
    const scrim = h('div', { class: 'scrim', onClick: close });
    frag.appendChild(scrim);
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New task' });
    frag.appendChild(modal);

    function close() {
      state.quickAddOpen = false;
      state.quickAddDefaults = null;
      scrim.remove(); modal.remove();
    }
    let submitting = false;
    async function submit() {
      const title = form.title.trim();
      if (!title) return;
      // Guard against double-submit (fast double-Enter, or Enter + Create click)
      // which would otherwise create duplicate tasks — both calls read a valid
      // title before either resolves. Also disable the button while in flight.
      if (submitting) return;
      submitting = true;
      const btn = modal.querySelector('.btn-primary');
      if (btn) btn.disabled = true;
      try {
        const t = await createTask({
          title, status: form.status, project: form.project,
          priority: form.priority, assignees: form.assignees, labels: form.labels,
          due: form.due, description: form.description || '', estimate: form.estimate || '',
        });
        // Templates can carry subtasks — create them, then refresh so they show.
        if (Array.isArray(form.templateSubtasks) && form.templateSubtasks.length) {
          for (const st of form.templateSubtasks) {
            try { await API.addSubtask(t.id, st); } catch (_) { /* best effort */ }
          }
          try { await refreshTasks(); } catch (_) { /* best effort */ }
        }
        close();
        state.openTaskId = t.id;
        // Keep the URL hash in sync so the new task is shareable as a deep
        // link the same way it would be if the drawer had been opened by
        // clicking a card.
        setTaskHash(t.id);
        renderApp();
      } catch (e) {
        toast(e.message, 'error');
        // Re-enable so the user can retry after a failure.
        submitting = false;
        if (btn) btn.disabled = false;
      }
    }

    function applyTemplate(tpl) {
      if (tpl.title) form.title = tpl.title;
      if (tpl.project_id) form.project = tpl.project_id;
      if (tpl.priority != null) form.priority = tpl.priority;
      if (tpl.default_status) form.status = tpl.default_status;
      if (Array.isArray(tpl.assignees) && tpl.assignees.length) form.assignees = tpl.assignees.slice();
      if (Array.isArray(tpl.labels) && tpl.labels.length) form.labels = tpl.labels.slice();
      form.description = tpl.description || '';
      form.estimate = tpl.estimate || '';
      form.templateSubtasks = Array.isArray(tpl.subtasks) ? tpl.subtasks.slice() : [];
      toast(`Applied template "${tpl.name}"`, 'success');
      redraw();
    }

    function redraw() {
      modal.replaceChildren();
      const head = h('div', { class: 'modal-head' });
      head.appendChild(h('div', { class: 'modal-head-label' }, 'Create task'));
      const titleInput = h('input', {
        class: 'modal-title-input', autofocus: true, placeholder: 'What needs to be done?',
        value: form.title,
        onInput: e => { form.title = e.target.value; submitBtn.disabled = !form.title.trim(); },
        onKeydown: e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') close(); },
      });
      head.appendChild(titleInput);
      modal.appendChild(head);

      const body = h('div', { class: 'modal-body' });

      const projBtn = h('button', { class: 'chip' },
        form.project ? [
          h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: projectById(form.project)?.color || '#64748B' } }),
          projectById(form.project)?.name || 'Project',
        ] : 'Project');
      projBtn.addEventListener('click', () => openPopover(projBtn, ({close}) => projectPickerContent(form.project, v => { form.project = v; redraw(); }, close)));
      body.appendChild(projBtn);

      const statBtn = h('button', { class: 'chip' }, StatusPill(form.status));
      statBtn.addEventListener('click', () => openPopover(statBtn, ({close}) => statusPickerContent(form.status, v => { form.status = v; redraw(); }, close)));
      body.appendChild(statBtn);

      const prioBtn = h('button', { class: 'chip' }, PriorityFlag(form.priority, true));
      prioBtn.addEventListener('click', () => openPopover(prioBtn, ({close}) => priorityPickerContent(form.priority, v => { form.priority = v; redraw(); }, close)));
      body.appendChild(prioBtn);

      const asgBtn = h('button', { class: 'chip' }, Icon('user', 11), ' ',
        form.assignees.length ? `${form.assignees.length} assignee${form.assignees.length > 1 ? 's' : ''}` : 'Unassigned');
      asgBtn.addEventListener('click', () => openPopover(asgBtn, ({close}) => assigneePickerContent(form.assignees, uid => {
        const set = new Set(form.assignees); set.has(uid) ? set.delete(uid) : set.add(uid);
        form.assignees = [...set]; redraw();
      }, close)));
      body.appendChild(asgBtn);

      const lblBtn = h('button', { class: 'chip' }, Icon('tag', 11), ' ',
        form.labels.length ? `${form.labels.length} label${form.labels.length > 1 ? 's' : ''}` : 'Labels');
      lblBtn.addEventListener('click', () => openPopover(lblBtn, ({close}) => labelPickerContent(form.labels, lid => {
        const set = new Set(form.labels); set.has(lid) ? set.delete(lid) : set.add(lid);
        form.labels = [...set]; redraw();
      }, close, {
        keepOpen: true,
        scopeProjectId: form.project || null,
        onCreateLabel: createLabelFromPicker,
      })));
      body.appendChild(lblBtn);

      if ((state.templates || []).length) {
        const applied = form.templateSubtasks.length || form.description;
        const tplBtn = h('button', { class: 'chip' }, Icon('archive', 11), ' ', applied ? 'Template applied' : 'Use template');
        tplBtn.addEventListener('click', () => openPopover(tplBtn, ({ close }) => {
          const wrap = h('div', { style: { minWidth: '220px', padding: '4px' } });
          wrap.appendChild(h('div', { class: 'popover-header' }, 'Start from template'));
          const tpls = (state.templates || []).filter(t => t.project_id == null || t.project_id == form.project);
          if (!tpls.length) wrap.appendChild(h('div', { class: 'empty', style: { padding: '10px' } }, 'No templates for this project'));
          tpls.forEach(t => wrap.appendChild(PopoverItem({
            selected: false,
            onSelect: () => { applyTemplate(t); close(); },
            children: h('span', null, t.name),
          })));
          return wrap;
        }));
        body.appendChild(tplBtn);
      }

      modal.appendChild(body);

      const foot = h('div', { class: 'modal-foot' });
      foot.appendChild(h('span', { class: 'hint' },
        h('span', { class: 'kbd-inline' }, 'Esc'), ' to close · ',
        h('span', { class: 'kbd-inline' }, 'Enter'), ' to create'));
      const submitBtn = h('button', { class: 'btn btn-primary', disabled: !form.title.trim(), onClick: submit }, 'Create task');
      foot.appendChild(h('div', { class: 'hstack' },
        h('button', { class: 'btn btn-ghost', onClick: close }, 'Cancel'),
        submitBtn,
      ));
      modal.appendChild(foot);

      setTimeout(() => titleInput.focus(), 0);
    }
    redraw();
    return frag;
  }

  // ----- profile modal -----
  function renderProfile() {
    const form = {
      name: state.me.name || '',
      role: state.me.role || '',
      color: state.me.color || '#3B82F6',
      current_password: '',
      password: '',
    };
    const frag = document.createDocumentFragment();
    const scrim = h('div', { class: 'scrim', onClick: close });
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Profile & preferences' });
    frag.appendChild(scrim);
    frag.appendChild(modal);

    function close() {
      state.profileOpen = false;
      scrim.remove(); modal.remove();
    }

    async function submit() {
      const name = form.name.trim();
      if (!name) { toast('Name is required', 'error'); return; }
      if (form.password && form.password.length < 8) {
        toast('New password must be at least 8 characters', 'error'); return;
      }
      if (form.password && !form.current_password) {
        toast('Enter your current password to change it', 'error'); return;
      }
      try {
        const payload = { name, role: form.role.trim(), color: form.color };
        if (form.password) {
          payload.password = form.password;
          payload.current_password = form.current_password;
        }
        const r = await API.updateProfile(payload);
        state.me = r.user;
        state.users = state.users.map(u => u.id === r.user.id ? r.user : u);
        toast('Profile updated', 'success');
        close();
        renderApp();
      } catch (e) { toast(e.message || 'Update failed', 'error'); }
    }

    const palette = ['#3B82F6','#A855F7','#F59E0B','#22C55E','#EC4899','#06B6D4','#EF4444','#8B5CF6','#64748B'];

    function redraw() {
      modal.replaceChildren();
      const head = h('div', { class: 'modal-head' });
      head.appendChild(h('div', { class: 'modal-head-label' }, 'Profile'));
      head.appendChild(h('div', { style: { fontSize: '17px', fontWeight: '500' } }, 'Edit your profile'));
      modal.appendChild(head);

      const body = h('div', { class: 'modal-body', style: { flexDirection: 'column', gap: '12px', padding: '18px 20px' } });

      const fieldStyle = {
        width: '100%', background: 'var(--bg-3)', border: '1px solid var(--line-2)',
        borderRadius: '8px', padding: '9px 11px', color: 'var(--fg-0)', outline: 'none', fontSize: '13.5px',
      };

      body.appendChild(h('div', null,
        h('label', { style: { display: 'block', fontSize: '12px', color: 'var(--fg-2)', marginBottom: '5px', fontWeight: '500' } }, 'Name'),
        h('input', { style: fieldStyle, value: form.name, onInput: e => { form.name = e.target.value; } }),
      ));
      body.appendChild(h('div', null,
        h('label', { style: { display: 'block', fontSize: '12px', color: 'var(--fg-2)', marginBottom: '5px', fontWeight: '500' } }, 'Role'),
        h('input', { style: fieldStyle, value: form.role, onInput: e => { form.role = e.target.value; }, placeholder: 'e.g. Field Tech' }),
      ));

      const swatches = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } });
      for (const c of palette) {
        const isOn = form.color.toLowerCase() === c.toLowerCase();
        swatches.appendChild(h('button', {
          title: c,
          style: {
            width: '26px', height: '26px', borderRadius: '6px', background: c,
            border: isOn ? '2px solid var(--fg-0)' : '2px solid transparent',
            outline: '1px solid var(--line-2)', cursor: 'pointer',
          },
          onClick: (e) => { e.preventDefault(); form.color = c; redraw(); },
        }));
      }
      body.appendChild(h('div', null,
        h('label', { style: { display: 'block', fontSize: '12px', color: 'var(--fg-2)', marginBottom: '5px', fontWeight: '500' } }, 'Avatar color'),
        swatches,
      ));

      body.appendChild(h('div', { style: { height: '1px', background: 'var(--line)', margin: '4px 0 2px' } }));
      body.appendChild(h('div', { style: { fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600' } }, 'Change password (optional)'));

      body.appendChild(h('div', null,
        h('label', { style: { display: 'block', fontSize: '12px', color: 'var(--fg-2)', marginBottom: '5px', fontWeight: '500' } }, 'Current password'),
        h('input', { type: 'password', style: fieldStyle, value: form.current_password, autocomplete: 'current-password',
          onInput: e => { form.current_password = e.target.value; } }),
      ));
      body.appendChild(h('div', null,
        h('label', { style: { display: 'block', fontSize: '12px', color: 'var(--fg-2)', marginBottom: '5px', fontWeight: '500' } }, 'New password'),
        h('input', { type: 'password', style: fieldStyle, value: form.password, autocomplete: 'new-password', minlength: 8,
          onInput: e => { form.password = e.target.value; },
          onKeydown: e => { if (e.key === 'Enter') submit(); } }),
      ));

      modal.appendChild(body);

      const foot = h('div', { class: 'modal-foot' });
      foot.appendChild(h('span', { class: 'hint' }, state.me.email || ''));
      foot.appendChild(h('div', { class: 'hstack' },
        h('button', { class: 'btn btn-ghost', onClick: close }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onClick: submit }, 'Save'),
      ));
      modal.appendChild(foot);
    }
    redraw();
    return frag;
  }

  // ----- admin settings -----
  function renderSettings() {
    const colors = ['#3B82F6','#A855F7','#F59E0B','#22C55E','#EC4899','#06B6D4','#EF4444','#8B5CF6','#64748B'];
    const model = {
      includeArchived: true,
      includeArchivedLabels: true,
      saving: false,
      loading: true,
      labelsLoading: true,
      err: '',
      labelErr: '',
      projects: [],
      labels: [],
      projectDetails: {},
      form: {
        id: null,
        name: '',
        key_prefix: 'PRJ',
        color: colors[0],
        description: '',
        slack_channel: '',
      },
      labelForm: {
        id: null,
        name: '',
        color: 'slate',
        project_id: '',
      },
      slackLoading: true,
      recurringLoading: true,
      slackErr: '',
      recurringErr: '',
      slack: {
        enabled: false,
        has_token: false,
        token_preview: '',
        bot_token: '',
        default_channel: '',
        events: {},
        templates: {},
        last_ok_at: null,
        last_error: null,
      },
      recurringRules: [],
      recurringForm: {
        id: null,
        project_id: '',
        title: '',
        description: '',
        priority: 2,
        estimate: '',
        assignees: [],
        labels: [],
        cadence: 'weekly',
        interval_n: 1,
        weekday: '',
        month_day: '',
        month_of_year: '',
        next_run: ymd(today()),
        ends_on: '',
        occurrences_left: '',
        paused: false,
      },
    };

    const frag = document.createDocumentFragment();
    const scrim = h('div', { class: 'scrim', onClick: close });
    const modal = h('div', { class: 'settings-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Admin settings' });
    frag.appendChild(scrim);
    frag.appendChild(modal);

    function close() {
      state.settingsOpen = false;
      scrim.remove();
      modal.remove();
    }

    function resetForm(p = null) {
      model.err = '';
      model.form.id = p?.id ?? null;
      model.form.name = p?.name ?? '';
      model.form.key_prefix = p?.key_prefix ?? 'PRJ';
      model.form.color = p?.color ?? colors[0];
      model.form.description = p?.description ?? '';
      model.form.slack_channel = p?.slack_channel ?? '';
    }

    function detailMeta(project) {
      const d = model.projectDetails[project.id];
      return d ? `${d.task_count || 0} tasks` : '…';
    }
    function scopeLabel(l) {
      if (l.project_id == null) return 'Global';
      return projectById(l.project_id)?.name || `Project #${l.project_id}`;
    }
    function resetLabelForm(l = null) {
      model.labelErr = '';
      model.labelForm.id = l?.id ?? null;
      model.labelForm.name = l?.name ?? '';
      model.labelForm.color = l?.color ?? 'slate';
      model.labelForm.project_id = l?.project_id == null ? '' : String(l.project_id);
    }
    function resetRecurringForm(r = null) {
      model.recurringErr = '';
      model.recurringForm.id = r?.id ?? null;
      model.recurringForm.project_id = r?.project_id ? String(r.project_id) : '';
      model.recurringForm.title = r?.title ?? '';
      model.recurringForm.description = r?.description ?? '';
      // Don't fall through `|| 2` because 0 (Urgent) is a valid priority and
      // would otherwise get coerced to Medium when re-opening the rule.
      const pri = r?.priority == null ? 2 : Number(r.priority);
      model.recurringForm.priority = Number.isFinite(pri) ? Math.max(0, Math.min(3, pri)) : 2;
      model.recurringForm.estimate = r?.estimate ?? '';
      model.recurringForm.assignees = Array.isArray(r?.assignees) ? r.assignees.map(Number).filter(Boolean) : [];
      model.recurringForm.labels = Array.isArray(r?.labels) ? r.labels.map(Number).filter(Boolean) : [];
      model.recurringForm.cadence = r?.cadence ?? 'weekly';
      model.recurringForm.interval_n = Number(r?.interval_n ?? 1) || 1;
      model.recurringForm.weekday = r?.weekday == null ? '' : String(r.weekday);
      model.recurringForm.month_day = r?.month_day == null ? '' : String(r.month_day);
      model.recurringForm.month_of_year = r?.month_of_year == null ? '' : String(r.month_of_year);
      model.recurringForm.next_run = r?.next_run ?? ymd(today());
      model.recurringForm.ends_on = r?.ends_on ?? '';
      model.recurringForm.occurrences_left = r?.occurrences_left == null ? '' : String(r.occurrences_left);
      model.recurringForm.paused = !!r?.paused;
    }
    function toggleRecurringAssignee(uid, on) {
      const id = Number(uid);
      if (!id) return;
      const cur = new Set(model.recurringForm.assignees || []);
      if (on) cur.add(id); else cur.delete(id);
      model.recurringForm.assignees = Array.from(cur);
    }
    function toggleRecurringLabel(lid, on) {
      const id = Number(lid);
      if (!id) return;
      const cur = new Set(model.recurringForm.labels || []);
      if (on) cur.add(id); else cur.delete(id);
      model.recurringForm.labels = Array.from(cur);
    }
    function labelsForRecurringProject() {
      const pid = Number(model.recurringForm.project_id || 0);
      if (!pid) return [];
      return (state.labels || []).filter(l => !l.archived && (l.project_id == null || Number(l.project_id) === pid));
    }

    async function refreshProjects() {
      model.loading = true;
      redraw();
      try {
        const r = await API.listProjects({ onlyActive: !model.includeArchived });
        model.projects = r.projects || [];
      } catch (e) {
        model.err = e.message || 'Failed to load projects';
      } finally {
        model.loading = false;
      }
      redraw();
      for (const p of model.projects) {
        if (model.projectDetails[p.id]) continue;
        API.getProject(p.id).then(r => {
          model.projectDetails[p.id] = r.project;
          redraw();
        }).catch(() => {});
      }
    }
    async function refreshLabelsAdmin() {
      model.labelsLoading = true;
      redraw();
      try {
        const r = await API.listLabels({ includeArchived: model.includeArchivedLabels });
        model.labels = r.labels || [];
      } catch (e) {
        model.labelErr = e.message || 'Failed to load labels';
      } finally {
        model.labelsLoading = false;
      }
      redraw();
    }
    async function refreshSlack() {
      model.slackLoading = true;
      redraw();
      try {
        const r = await API.getSlack();
        model.slack = {
          ...model.slack,
          ...(r.slack || {}),
          bot_token: '',
          events: { ...(r.slack?.events || {}) },
          templates: { ...(r.slack?.templates || {}) },
        };
      } catch (e) {
        model.slackErr = e.message || 'Failed to load Slack settings';
      } finally {
        model.slackLoading = false;
      }
      redraw();
    }
    async function saveSlack() {
      model.slackErr = '';
      model.saving = true;
      redraw();
      const payload = {
        enabled: !!model.slack.enabled,
        default_channel: (model.slack.default_channel || '').trim(),
        events: model.slack.events || {},
        templates: model.slack.templates || {},
      };
      if ((model.slack.bot_token || '').trim()) payload.bot_token = model.slack.bot_token.trim();
      try {
        const r = await API.updateSlack(payload);
        model.slack = {
          ...model.slack,
          ...(r.slack || {}),
          bot_token: '',
          events: { ...(r.slack?.events || {}) },
          templates: { ...(r.slack?.templates || {}) },
        };
        toast('Slack settings saved', 'success');
      } catch (e) {
        model.slackErr = e.message || 'Failed to save Slack settings';
      } finally {
        model.saving = false;
        redraw();
      }
    }
    async function sendSlackTest() {
      const channel = (model.slack.default_channel || '').trim();
      if (!channel) {
        model.slackErr = 'Set a default channel before sending a test';
        redraw();
        return;
      }
      model.saving = true;
      redraw();
      try {
        await API.testSlack(channel);
        toast('Slack test sent', 'success');
        await refreshSlack();
      } catch (e) {
        model.slackErr = e.message || 'Slack test failed';
      } finally {
        model.saving = false;
        redraw();
      }
    }
    async function refreshRecurringAdmin() {
      model.recurringLoading = true;
      redraw();
      try {
        const r = await API.listRecurring();
        model.recurringRules = r.rules || [];
      } catch (e) {
        model.recurringErr = e.message || 'Failed to load recurring rules';
      } finally {
        model.recurringLoading = false;
      }
      redraw();
    }
    async function saveRecurringRule() {
      const f = model.recurringForm;
      const payload = {
        project_id: Number(f.project_id),
        title: (f.title || '').trim(),
        description: (f.description || '').trim(),
        // Tasks use priority 0..3 (PRIO_LABELS = Urgent/High/Medium/Low). The
        // UI dropdown writes those same numbers, so just clamp into range.
        priority: Math.max(0, Math.min(3, Number(f.priority))),
        estimate: (f.estimate || '').trim() || null,
        assignees: Array.isArray(f.assignees) ? f.assignees.map(Number).filter(Boolean) : [],
        labels: Array.isArray(f.labels) ? f.labels.map(Number).filter(Boolean) : [],
        cadence: f.cadence,
        interval_n: Math.max(1, Number(f.interval_n) || 1),
        next_run: f.next_run,
        ends_on: f.ends_on || null,
        occurrences_left: f.occurrences_left === '' ? null : Math.max(0, Number(f.occurrences_left) || 0),
        paused: !!f.paused,
      };
      if (!payload.project_id) { model.recurringErr = 'Project is required'; redraw(); return; }
      if (!payload.title) { model.recurringErr = 'Title is required'; redraw(); return; }
      if (!payload.next_run) { model.recurringErr = 'Next run date is required'; redraw(); return; }
      if (f.cadence === 'weekly' && f.weekday !== '') payload.weekday = Number(f.weekday);
      if ((f.cadence === 'monthly' || f.cadence === 'yearly') && f.month_day !== '') payload.month_day = Number(f.month_day);
      if (f.cadence === 'yearly' && f.month_of_year !== '') payload.month_of_year = Number(f.month_of_year);
      model.saving = true;
      model.recurringErr = '';
      redraw();
      try {
        if (f.id) await API.updateRecurring(f.id, payload);
        else await API.createRecurring(payload);
        resetRecurringForm();
        await refreshRecurringAdmin();
        await refreshTasks();
        toast(f.id ? 'Recurring rule updated' : 'Recurring rule created', 'success');
      } catch (e) {
        model.recurringErr = e.message || 'Failed to save recurring rule';
      } finally {
        model.saving = false;
        redraw();
      }
    }
    async function deleteRecurringRule(rule) {
      if (!(await confirmDialog({ title: 'Delete recurring rule', message: `Delete recurring rule "${rule.title}"?`, confirmText: 'Delete', danger: true }))) return;
      try {
        await API.deleteRecurring(rule.id);
        await refreshRecurringAdmin();
        toast('Recurring rule deleted', 'success');
      } catch (e) {
        toast(e.message || 'Delete failed', 'error');
      }
    }
    async function toggleRecurringPause(rule) {
      try {
        await API.updateRecurring(rule.id, { paused: !rule.paused });
        await refreshRecurringAdmin();
        toast(rule.paused ? 'Rule resumed' : 'Rule paused', 'success');
      } catch (e) {
        toast(e.message || 'Update failed', 'error');
      }
    }

    async function saveProject() {
      const payload = {
        name: model.form.name.trim(),
        key_prefix: model.form.key_prefix.trim().toUpperCase(),
        color: model.form.color,
        description: model.form.description.trim(),
        slack_channel: model.form.slack_channel.trim(),
      };
      if (!payload.name) { model.err = 'Project name is required'; redraw(); return; }
      if (!payload.key_prefix) { model.err = 'Key prefix is required'; redraw(); return; }
      model.saving = true;
      model.err = '';
      redraw();
      try {
        if (model.form.id) await API.updateProject(model.form.id, payload);
        else await API.createProject(payload);
        const [projects, tasks] = await Promise.all([API.listProjects(), API.listTasks()]);
        state.projects = projects.projects;
        state.tasks = tasks.tasks;
        resetForm(null);
        await refreshProjects();
        renderApp();
        toast(model.form.id ? 'Project updated' : 'Project created', 'success');
      } catch (e) {
        model.err = e.message || 'Save failed';
      } finally {
        model.saving = false;
        redraw();
      }
    }

    async function archiveProject(project, archived) {
      const action = archived ? 'archive' : 'unarchive';
      if (!(await confirmDialog({ title: `${action[0].toUpperCase()}${action.slice(1)} project`, message: `Are you sure you want to ${action} "${project.name}"?`, confirmText: action[0].toUpperCase() + action.slice(1) }))) return;
      try {
        await API.updateProject(project.id, { archived });
        if (archived && state.filterProject == project.id) state.filterProject = null;
        const [projects, tasks] = await Promise.all([API.listProjects(), API.listTasks()]);
        state.projects = projects.projects;
        state.tasks = tasks.tasks;
        await refreshProjects();
        renderApp();
        toast(`Project ${archived ? 'archived' : 'restored'}`, 'success');
      } catch (e) {
        toast(e.message || 'Update failed', 'error');
      }
    }

    async function deleteProject(project) {
      const detail = model.projectDetails[project.id];
      const warning = detail ? `This project has ${detail.task_count || 0} tasks. ` : '';
      if (!(await confirmDialog({ title: 'Delete project', message: `Delete "${project.name}" permanently? ${warning}This cannot be undone.`, confirmText: 'Delete', danger: true }))) return;
      try {
        await API.deleteProject(project.id, false);
      } catch (e) {
        if (e.status === 409) {
          const msg = `${e.body?.error || 'Project has work linked to it.'}\nUse archive instead.`;
          toast(msg, 'error');
          return;
        }
        toast(e.message || 'Delete failed', 'error');
        return;
      }
      const [projects, tasks] = await Promise.all([API.listProjects(), API.listTasks()]);
      state.projects = projects.projects;
      state.tasks = tasks.tasks;
      if (state.filterProject == project.id) state.filterProject = null;
      await refreshProjects();
      renderApp();
      toast('Project deleted', 'success');
    }
    async function saveLabel() {
      const payload = {
        name: model.labelForm.name.trim(),
        color: model.labelForm.color,
        project_id: model.labelForm.project_id === '' ? null : Number(model.labelForm.project_id),
      };
      if (!payload.name) { model.labelErr = 'Label name is required'; redraw(); return; }
      model.saving = true;
      model.labelErr = '';
      redraw();
      try {
        if (model.labelForm.id) await API.updateLabel(model.labelForm.id, payload);
        else await API.createLabel(payload);
        resetLabelForm(null);
        await refreshLabelsAdmin();
        await refreshLabels();
        toast(model.labelForm.id ? 'Label updated' : 'Label created', 'success');
      } catch (e) {
        model.labelErr = e.message || 'Save failed';
      } finally {
        model.saving = false;
        redraw();
      }
    }
    async function archiveLabel(label, archived) {
      try {
        await API.updateLabel(label.id, { archived });
        await refreshLabelsAdmin();
        await refreshLabels();
        toast(`Label ${archived ? 'archived' : 'restored'}`, 'success');
      } catch (e) {
        toast(e.message || 'Label update failed', 'error');
      }
    }
    async function deleteLabel(label) {
      if (!(await confirmDialog({ title: 'Delete label', message: `Delete label "${label.name}" permanently?`, confirmText: 'Delete', danger: true }))) return;
      try { await API.deleteLabel(label.id, false); }
      catch (e) {
        if (e.status === 409) {
          toast(e.body?.error || 'Label is in use. Archive or merge instead.', 'error');
          return;
        }
        toast(e.message || 'Delete failed', 'error');
        return;
      }
      await refreshLabelsAdmin();
      await refreshLabels();
      toast('Label deleted', 'success');
    }
    async function mergeLabel(source) {
      const siblings = model.labels.filter(l => l.id !== source.id && l.project_id == source.project_id && !l.archived);
      if (!siblings.length) {
        toast('No compatible label available in this scope to merge into', 'error');
        return;
      }
      // Accessible, themed dialog instead of native prompt() (per CLAUDE.md).
      const raw = await promptDialog({
        title: `Merge "${source.name}" into…`,
        label: 'Enter the target label id — options: ' + siblings.map(l => `${l.id} (${l.name})`).join(', '),
        placeholder: 'e.g. ' + siblings[0].id,
      });
      if (!raw) return;
      const targetId = Number(String(raw).trim());
      if (!targetId) return;
      try {
        await API.post(`labels.php?id=${source.id}&action=merge&target_id=${targetId}`, {});
        await refreshLabelsAdmin();
        await refreshLabels();
        toast('Labels merged', 'success');
      } catch (e) {
        toast(e.message || 'Merge failed', 'error');
      }
    }

    function redraw() {
      modal.replaceChildren();
      modal.appendChild(h('div', { class: 'settings-head' },
        Icon('settings', 15),
        h('div', { class: 'settings-title' }, state.me?.is_admin ? 'Admin settings' : 'Workspace settings'),
        h('button', { class: 'btn btn-ghost', onClick: close }, Icon('x', 14), ' Close'),
      ));

      const body = h('div', { class: 'settings-body' });
      modal.appendChild(body);

      const head = h('div', { class: 'settings-section-head' },
        h('div', null,
          h('h3', null, 'Projects'),
          h('div', { class: 'sub' }, 'Create, edit, archive, and review all workspace projects.'),
        ),
        h('label', { class: 'check-row', style: { whiteSpace: 'nowrap' } },
          h('input', {
            type: 'checkbox',
            checked: model.includeArchived,
            onChange: e => { model.includeArchived = !!e.target.checked; refreshProjects(); },
          }),
          ' Show archived',
        ),
      );
      body.appendChild(head);

      const form = h('div', { class: 'settings-form' });
      form.appendChild(h('div', null,
        h('label', null, 'Project name'),
        h('input', { type: 'text', value: model.form.name, onInput: e => { model.form.name = e.target.value; } }),
      ));
      form.appendChild(h('div', null,
        h('label', null, 'Key prefix'),
        h('input', { type: 'text', maxlength: 8, value: model.form.key_prefix, onInput: e => { model.form.key_prefix = e.target.value; } }),
      ));
      const colorWrap = h('div', { class: 'full' },
        h('label', null, 'Color'),
        h('div', { class: 'palette' }, colors.map(c => h('button', {
          class: 'swatch' + (model.form.color.toLowerCase() === c.toLowerCase() ? ' on' : ''),
          style: { background: c },
          title: c,
          onClick: e => { e.preventDefault(); model.form.color = c; redraw(); },
        }))),
      );
      form.appendChild(colorWrap);
      form.appendChild(h('div', { class: 'full' },
        h('label', null, 'Description'),
        h('textarea', { value: model.form.description, onInput: e => { model.form.description = e.target.value; } }),
      ));
      form.appendChild(h('div', { class: 'full' },
        h('label', null, 'Slack channel override (optional)'),
        h('input', { type: 'text', placeholder: '#project-channel', value: model.form.slack_channel, onInput: e => { model.form.slack_channel = e.target.value; } }),
      ));
      form.appendChild(h('div', { class: 'form-foot' },
        model.err ? h('span', { class: 'err' }, model.err) : null,
        model.form.id ? h('button', { class: 'btn btn-ghost', onClick: () => { resetForm(); redraw(); } }, 'Cancel edit') : null,
        h('button', { class: 'btn btn-primary', disabled: model.saving, onClick: saveProject }, model.form.id ? 'Save project' : 'Create project'),
      ));
      body.appendChild(form);

      if (model.loading) {
        body.appendChild(h('div', { class: 'empty' }, 'Loading projects…'));
        return;
      }
      const list = h('div', { class: 'settings-list' });
      for (const p of model.projects) {
        const arch = !!p.archived;
        list.appendChild(h('div', { class: 'settings-row' + (arch ? ' archived' : '') },
          h('span', { class: 'proj-dot', style: { background: p.color, marginRight: '2px' } }),
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' },
              p.name,
              arch ? h('span', { class: 'pill muted' }, 'Archived') : null,
            ),
            h('div', { class: 'row-meta' },
              h('span', { class: 'mono' }, p.key_prefix),
              h('span', null, detailMeta(p)),
              p.slack_channel ? h('span', null, `Slack: ${p.slack_channel}`) : null,
            ),
          ),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-ghost', onClick: () => { resetForm(p); redraw(); } }, 'Edit'),
            h('button', { class: 'btn btn-ghost', onClick: () => archiveProject(p, !arch) }, arch ? 'Unarchive' : 'Archive'),
            h('button', { class: 'btn btn-ghost', onClick: () => deleteProject(p) }, 'Delete'),
          ),
        ));
      }
      if (!model.projects.length) list.appendChild(h('div', { class: 'empty' }, 'No projects found.'));
      body.appendChild(list);

      body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
        h('div', null,
          h('h3', null, 'Labels'),
          h('div', { class: 'sub' }, 'Manage label taxonomy with project or global scope, usage-aware guardrails, and merge controls.'),
        ),
        h('label', { class: 'check-row', style: { whiteSpace: 'nowrap' } },
          h('input', {
            type: 'checkbox',
            checked: model.includeArchivedLabels,
            onChange: e => { model.includeArchivedLabels = !!e.target.checked; refreshLabelsAdmin(); },
          }),
          ' Show archived',
        ),
      ));
      const labelForm = h('div', { class: 'settings-form' });
      labelForm.appendChild(h('div', null,
        h('label', null, 'Label name'),
        h('input', { type: 'text', value: model.labelForm.name, onInput: e => { model.labelForm.name = e.target.value; } }),
      ));
      labelForm.appendChild(h('div', null,
        h('label', null, 'Scope'),
        h('select', {
          value: model.labelForm.project_id,
          onChange: e => { model.labelForm.project_id = e.target.value; },
        },
          h('option', { value: '' }, 'Global'),
          state.projects.map(p => h('option', { value: String(p.id) }, p.name)),
        ),
      ));
      labelForm.appendChild(h('div', { class: 'full' },
        h('label', null, 'Color'),
        h('div', { class: 'palette' }, ['red','blue','amber','green','violet','slate','pink','cyan'].map(c => h('button', {
          class: 'swatch named' + (model.labelForm.color === c ? ' on' : ''),
          style: { background: labelCssColor(c) },
          title: c,
          onClick: e => { e.preventDefault(); model.labelForm.color = c; redraw(); },
        }))),
      ));
      labelForm.appendChild(h('div', { class: 'form-foot' },
        model.labelErr ? h('span', { class: 'err' }, model.labelErr) : null,
        model.labelForm.id ? h('button', { class: 'btn btn-ghost', onClick: () => { resetLabelForm(); redraw(); } }, 'Cancel edit') : null,
        h('button', { class: 'btn btn-primary', disabled: model.saving, onClick: saveLabel }, model.labelForm.id ? 'Save label' : 'Create label'),
      ));
      body.appendChild(labelForm);

      if (model.labelsLoading) body.appendChild(h('div', { class: 'empty' }, 'Loading labels…'));
      else {
        const labelList = h('div', { class: 'settings-list' });
        for (const l of model.labels) {
          labelList.appendChild(h('div', { class: 'settings-row' + (l.archived ? ' archived' : '') },
            h('span', { style: {
              width: '10px', height: '10px', borderRadius: '3px', background: labelCssColor(l.color), flexShrink: 0,
            } }),
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' },
                l.name,
                l.archived ? h('span', { class: 'pill muted' }, 'Archived') : null,
              ),
              h('div', { class: 'row-meta' },
                h('span', null, scopeLabel(l)),
                h('span', null, `${l.usage_count || 0} task${(l.usage_count || 0) === 1 ? '' : 's'}`),
                (l.usage_count || 0) === 0 ? h('span', { class: 'pill ok' }, 'Safe to archive') : null,
              ),
            ),
            h('div', { class: 'row-actions' },
              h('button', { class: 'btn btn-ghost', onClick: () => { resetLabelForm(l); redraw(); } }, 'Edit'),
              h('button', { class: 'btn btn-ghost', onClick: () => mergeLabel(l) }, 'Merge'),
              h('button', { class: 'btn btn-ghost', onClick: () => archiveLabel(l, !l.archived) }, l.archived ? 'Unarchive' : 'Archive'),
              h('button', { class: 'btn btn-ghost', onClick: () => deleteLabel(l) }, 'Delete'),
            ),
          ));
        }
        if (!model.labels.length) labelList.appendChild(h('div', { class: 'empty' }, 'No labels found.'));
        body.appendChild(labelList);
      }

      if (state.me?.is_admin) body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
        h('div', null,
          h('h3', null, 'Slack integration'),
          h('div', { class: 'sub' }, 'Manage bot token, default channel, event toggles, templates, and test delivery.'),
        ),
      ));
      if (state.me?.is_admin && model.slackLoading) body.appendChild(h('div', { class: 'empty' }, 'Loading Slack settings…'));
      else if (state.me?.is_admin) {
        const slackForm = h('div', { class: 'settings-form' });
        slackForm.appendChild(h('div', { class: 'full check-grid' },
          h('label', { class: 'check-row' },
            h('input', {
              type: 'checkbox',
              checked: !!model.slack.enabled,
              onChange: e => { model.slack.enabled = !!e.target.checked; },
            }),
            'Enable Slack delivery',
          ),
        ));
        slackForm.appendChild(h('div', null,
          h('label', null, 'Default channel'),
          h('input', { type: 'text', placeholder: '#team-alerts', value: model.slack.default_channel || '', onInput: e => { model.slack.default_channel = e.target.value; } }),
        ));
        slackForm.appendChild(h('div', null,
          h('label', null, 'Bot token'),
          h('input', { type: 'password', placeholder: model.slack.token_preview || 'xoxb-…', value: model.slack.bot_token || '', onInput: e => { model.slack.bot_token = e.target.value; } }),
        ));
        slackForm.appendChild(h('div', { class: 'full hint' },
          model.slack.has_token ? `Token configured (${model.slack.token_preview || 'hidden'}). Leave blank to keep unchanged.` : 'No token configured yet.',
        ));
        slackForm.appendChild(h('div', { class: 'full check-grid' }, ['task_created','task_completed','task_assigned','comment_added','project_archived','mention_added'].map(key =>
          h('label', { class: 'check-row' },
            h('input', {
              type: 'checkbox',
              checked: !!model.slack.events?.[key],
              onChange: e => { model.slack.events[key] = !!e.target.checked; },
            }),
            key.replaceAll('_', ' '),
          ))));
        const eventKeys = ['task_created','task_completed','task_assigned','comment_added','project_archived','mention_added'];
        for (const key of eventKeys) {
          slackForm.appendChild(h('div', { class: 'full' },
            h('label', null, `Template override (${key})`),
            h('textarea', {
              value: model.slack.templates?.[key] || '',
              placeholder: '{actor} {verb} {ref}',
              onInput: e => {
                if (!model.slack.templates) model.slack.templates = {};
                model.slack.templates[key] = e.target.value;
              },
            }),
          ));
        }
        slackForm.appendChild(h('div', { class: 'form-foot' },
          model.slackErr ? h('span', { class: 'err' }, model.slackErr) : null,
          h('button', { class: 'btn btn-ghost', disabled: model.saving, onClick: sendSlackTest }, 'Send test'),
          h('button', { class: 'btn btn-primary', disabled: model.saving, onClick: saveSlack }, 'Save Slack settings'),
        ));
        body.appendChild(slackForm);
        body.appendChild(h('div', { class: 'settings-status' + (model.slack.last_error ? ' err' : '') },
          h('span', null, model.slack.last_ok_at ? `Last success: ${model.slack.last_ok_at}` : 'No successful delivery yet'),
          model.slack.last_error ? h('span', null, `Last error: ${model.slack.last_error}`) : null,
        ));
      }

      if (!state.me?.is_admin) return;

      body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
        h('div', null,
          h('h3', null, 'Recurring rules'),
          h('div', { class: 'sub' }, 'Create and manage recurring task templates from the UI. New rules generate an initial task automatically.'),
        ),
      ));
      const recurringForm = h('div', { class: 'settings-form' });
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Project'),
        h('select', { value: model.recurringForm.project_id, onChange: e => { model.recurringForm.project_id = e.target.value; } },
          h('option', { value: '' }, 'Select project'),
          state.projects.map(p => h('option', { value: String(p.id) }, p.name)),
        ),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Title'),
        h('input', { type: 'text', value: model.recurringForm.title, onInput: e => { model.recurringForm.title = e.target.value; } }),
      ));
      recurringForm.appendChild(h('div', { class: 'full' },
        h('label', null, 'Description'),
        h('textarea', { value: model.recurringForm.description, onInput: e => { model.recurringForm.description = e.target.value; } }),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Priority'),
        h('select', { value: String(model.recurringForm.priority), onChange: e => { model.recurringForm.priority = Number(e.target.value); } },
          // Match the task-priority convention used everywhere else
          // (PRIO_LABELS): 0 = Urgent, 1 = High, 2 = Medium, 3 = Low.
          h('option', { value: '0' }, 'Urgent'),
          h('option', { value: '1' }, 'High'),
          h('option', { value: '2' }, 'Medium'),
          h('option', { value: '3' }, 'Low'),
        ),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Estimate (hours)'),
        h('input', { type: 'number', min: 0, step: '0.25', value: model.recurringForm.estimate, onInput: e => { model.recurringForm.estimate = e.target.value; } }),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Cadence'),
        h('select', { value: model.recurringForm.cadence, onChange: e => { model.recurringForm.cadence = e.target.value; redraw(); } },
          ['daily','weekly','monthly','yearly'].map(c => h('option', { value: c }, c)),
        ),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Every N'),
        h('input', { type: 'number', min: 1, value: model.recurringForm.interval_n, onInput: e => { model.recurringForm.interval_n = e.target.value; } }),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Next run'),
        h('input', { type: 'date', value: model.recurringForm.next_run, onInput: e => { model.recurringForm.next_run = e.target.value; } }),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Ends on'),
        h('input', { type: 'date', value: model.recurringForm.ends_on, onInput: e => { model.recurringForm.ends_on = e.target.value; } }),
      ));
      recurringForm.appendChild(h('div', null,
        h('label', null, 'Occurrences left'),
        h('input', { type: 'number', min: 0, value: model.recurringForm.occurrences_left, placeholder: 'Unlimited', onInput: e => { model.recurringForm.occurrences_left = e.target.value; } }),
      ));
      if (model.recurringForm.cadence === 'weekly') {
        recurringForm.appendChild(h('div', null,
          h('label', null, 'Weekday (0-6)'),
          h('input', { type: 'number', min: 0, max: 6, value: model.recurringForm.weekday, onInput: e => { model.recurringForm.weekday = e.target.value; } }),
        ));
      }
      if (model.recurringForm.cadence === 'monthly' || model.recurringForm.cadence === 'yearly') {
        recurringForm.appendChild(h('div', null,
          h('label', null, 'Day of month'),
          h('input', { type: 'number', min: 1, max: 31, value: model.recurringForm.month_day, onInput: e => { model.recurringForm.month_day = e.target.value; } }),
        ));
      }
      if (model.recurringForm.cadence === 'yearly') {
        recurringForm.appendChild(h('div', null,
          h('label', null, 'Month of year'),
          h('input', { type: 'number', min: 1, max: 12, value: model.recurringForm.month_of_year, onInput: e => { model.recurringForm.month_of_year = e.target.value; } }),
        ));
      }
      recurringForm.appendChild(h('div', { class: 'full check-grid' },
        h('label', { class: 'check-row' },
          h('input', { type: 'checkbox', checked: !!model.recurringForm.paused, onChange: e => { model.recurringForm.paused = !!e.target.checked; } }),
          'Paused',
        ),
      ));
      const recurringLabelOptions = labelsForRecurringProject();
      recurringForm.appendChild(h('div', { class: 'full check-grid' },
        h('span', { class: 'hint' }, 'Assignees'),
        ...state.users.filter(u => !u.archived).map(u => h('label', { class: 'check-row' },
          h('input', {
            type: 'checkbox',
            checked: (model.recurringForm.assignees || []).includes(u.id),
            onChange: e => { toggleRecurringAssignee(u.id, !!e.target.checked); },
          }),
          u.name,
        )),
      ));
      recurringForm.appendChild(h('div', { class: 'full check-grid' },
        h('span', { class: 'hint' }, 'Labels'),
        ...(recurringLabelOptions.length
          ? recurringLabelOptions.map(l => h('label', { class: 'check-row' },
              h('input', {
                type: 'checkbox',
                checked: (model.recurringForm.labels || []).includes(l.id),
                onChange: e => { toggleRecurringLabel(l.id, !!e.target.checked); },
              }),
              `${l.name}${l.project_id == null ? ' (Global)' : ''}`,
            ))
          : [h('span', { class: 'hint' }, 'Select a project to choose labels')]),
      ));
      recurringForm.appendChild(h('div', { class: 'form-foot' },
        model.recurringErr ? h('span', { class: 'err' }, model.recurringErr) : null,
        model.recurringForm.id ? h('button', { class: 'btn btn-ghost', onClick: () => { resetRecurringForm(); redraw(); } }, 'Cancel edit') : null,
        h('button', { class: 'btn btn-primary', disabled: model.saving, onClick: saveRecurringRule }, model.recurringForm.id ? 'Save rule' : 'Create rule'),
      ));
      body.appendChild(recurringForm);

      if (model.recurringLoading) body.appendChild(h('div', { class: 'empty' }, 'Loading recurring rules…'));
      else {
        const recurringList = h('div', { class: 'settings-list' });
        for (const r of model.recurringRules) {
          recurringList.appendChild(h('div', { class: 'settings-row' + (r.paused ? ' archived' : '') },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' },
                r.title,
                r.paused ? h('span', { class: 'pill muted' }, 'Paused') : null,
              ),
              h('div', { class: 'row-meta' },
                h('span', null, `${projectById(r.project_id)?.name || 'Unknown project'} • ${r.cadence} every ${r.interval_n}`),
                h('span', null, `Next: ${r.next_run}`),
              ),
            ),
            h('div', { class: 'row-actions' },
              h('button', { class: 'btn btn-ghost', onClick: () => { resetRecurringForm(r); redraw(); } }, 'Edit'),
              h('button', { class: 'btn btn-ghost', onClick: () => toggleRecurringPause(r) }, r.paused ? 'Resume' : 'Pause'),
              h('button', { class: 'btn btn-ghost', onClick: () => deleteRecurringRule(r) }, 'Delete'),
            ),
          ));
        }
        if (!model.recurringRules.length) recurringList.appendChild(h('div', { class: 'empty' }, 'No recurring rules yet.'));
        body.appendChild(recurringList);
      }

      // v2: Milestones + Custom fields admin (self-contained panel, cached so
      // its internal state survives settings re-renders).
      if (!model.adminExtras && typeof renderAdminExtras === 'function') {
        model.adminExtras = h('div');
        try { model.adminExtras.appendChild(renderAdminExtras()); } catch (e) { /* optional panel */ }
      }
      if (model.adminExtras) body.appendChild(model.adminExtras);
    }

    refreshProjects();
    refreshLabelsAdmin();
    if (state.me?.is_admin) {
      refreshSlack();
      refreshRecurringAdmin();
    }
    redraw();
    return frag;
  }

  // ----- keyboard shortcuts help -----
  let shortcutsKeyHandler = null;
  function renderShortcutsHelp() {
    const frag = document.createDocumentFragment();
    const scrim = h('div', { class: 'scrim', onClick: close });
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard & shortcuts', style: { maxWidth: '460px' } });
    frag.appendChild(scrim);
    frag.appendChild(modal);
    function close() {
      state.shortcutsOpen = false; scrim.remove(); modal.remove();
      if (shortcutsKeyHandler) { document.removeEventListener('keydown', shortcutsKeyHandler); shortcutsKeyHandler = null; }
    }
    // renderApp() re-invokes this on every re-render while shortcutsOpen is true;
    // remove any handler from a prior render before adding a fresh one so they
    // don't stack up on document.
    if (shortcutsKeyHandler) document.removeEventListener('keydown', shortcutsKeyHandler);
    const onKey = e => { if (e.key === 'Escape') close(); };
    shortcutsKeyHandler = onKey;
    document.addEventListener('keydown', onKey);
    const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
    const rows = [
      [`${mod} K`, 'Open the command palette'],
      [`${mod} N`, 'Create a new task'],
      ['?', 'Show this help'],
      ['Esc', 'Close dialogs, popovers & menus'],
      ['Drag', 'Reorder cards/rows (Kanban, List) · reschedule (Calendar, Timeline)'],
      ['Click a day', 'Create a task on that date (Calendar)'],
      ['Enter', 'Open the focused task'],
    ];
    modal.appendChild(h('div', { class: 'modal-head' },
      h('div', { class: 'modal-head-label' }, 'Help'),
      h('div', { style: { fontSize: '17px', fontWeight: '500' } }, 'Keyboard & shortcuts'),
    ));
    const body = h('div', { class: 'modal-body', style: { flexDirection: 'column', gap: '10px', padding: '18px 20px' } });
    for (const [k, label] of rows) {
      body.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
        h('span', { style: { fontSize: '13px', color: 'var(--fg-1)' } }, label),
        h('span', { class: 'kbd', style: { whiteSpace: 'nowrap' } }, k),
      ));
    }
    modal.appendChild(body);
    modal.appendChild(h('div', { class: 'modal-foot' },
      h('span', { class: 'hint' }, 'Press ? anytime'),
      h('button', { class: 'btn btn-primary', onClick: close }, 'Got it'),
    ));
    return frag;
  }

  // ----- persistence -----
  function persist() {
    // Wrapped in try/catch because Safari private mode throws a QuotaError
    // the first time localStorage is written to, and we don't want a UI
    // setting to blow up renders.
    try {
      localStorage.setItem('pm_view', state.view);
      localStorage.setItem('pm_project',  state.filterProject  == null ? 'null' : String(state.filterProject));
      localStorage.setItem('pm_assignee', state.filterAssignee == null ? 'null' : String(state.filterAssignee));
      localStorage.setItem('pm_labels',   JSON.stringify(state.filterLabels || []));
    } catch (e) {
      console.warn('Filter persistence failed:', e);
    }
  }

  // ----- shortcuts -----
  // Don't hijack typing inside any text field, and don't steal focus from
  // the user while they're mid-edit inside a modal.
  function shortcutBlocked() {
    if (state.quickAddOpen || state.settingsOpen || state.profileOpen || state.openTaskId) return true;
    const el = document.activeElement;
    if (!el) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      // Ctrl/Cmd+K opens the command palette (search + jump-to-task + actions).
      if (state.quickAddOpen || state.settingsOpen || state.profileOpen) return;
      e.preventDefault();
      openCmd();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'n' && !e.shiftKey) {
      if (shortcutBlocked()) return;
      e.preventDefault();
      state.quickAddStatus = 'todo';
      state.quickAddDefaults = null;
      state.quickAddOpen = true;
      renderApp();
    }
    if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (shortcutBlocked()) return;
      e.preventDefault();
      state.shortcutsOpen = true;
      renderApp();
    }
  });

  window.addEventListener('hashchange', syncTaskFromHash);

  // Support direct links copied from the detail drawer, e.g. #task=123.
  syncTaskFromHash();

  renderApp();
})();
