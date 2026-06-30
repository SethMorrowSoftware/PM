// Task detail drawer.
//
// The drawer is re-created on every renderApp() (app.js builds it fresh from
// state.tasks each time). To keep async-loaded data (comments, activity,
// dependencies, time entries) from flickering / re-fetching on every re-render
// we cache it per-open-session on the window. The cache is keyed by task id and
// invalidated whenever a *different* task is opened, so each open of a task
// fetches fresh data (no stale reuse across opens) while surviving in-session
// re-renders.
window._pmDrawerCache = window._pmDrawerCache || {};      // { [taskId]: {comments, activity, deps, time} }
window._pmAttachmentsCache = window._pmAttachmentsCache || {};
window._pmDrawerOpenFor = window._pmDrawerOpenFor;        // task id the cache is valid for

function pmDrawerCache(taskId) {
  // Switching tasks (or first open) invalidates everything so we refetch fresh.
  if (window._pmDrawerOpenFor !== taskId) {
    window._pmDrawerOpenFor = taskId;
    window._pmDrawerCache = {};
    window._pmAttachmentsCache = {};
  }
  return (window._pmDrawerCache[taskId] = window._pmDrawerCache[taskId] || {
    comments: null, activity: null, deps: null, time: null, reminders: null, _focused: false,
  });
}

function renderTaskDetail(task, { onClose, onUpdate, onToggleSubtask, onAddSubtask, onDeleteSubtask, onDeleteTask }) {
  const cache = pmDrawerCache(task.id);

  const scrim = h('div', { class: 'scrim light', onClick: onClose });
  const drawer = h('div', {
    class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': (task.ref || 'Task') + ' details', tabindex: '-1',
  });
  const host = document.createDocumentFragment();
  host.appendChild(scrim);
  host.appendChild(drawer);

  // Return focus to whatever was focused before the drawer opened.
  const prevFocus = document.activeElement;

  let editingTitle = false;
  let descEditing = false;
  let tempTitle = task.title;
  let newSubtaskText = '';
  let newCommentText = '';
  let newBlockerQuery = '';
  let logMinutes = '';
  let logNote = '';
  let newReminderAt = '';
  let newReminderEveryone = false;
  let comments = cache.comments;
  let activity = cache.activity;
  let deps = cache.deps;
  let timeData = cache.time;
  let reminders = cache.reminders;
  let attachments = window._pmAttachmentsCache[task.id] || null;
  let uploadingAttachment = false;

  async function loadComments() {
    try {
      const r = await API.listComments(task.id);
      comments = r.comments || [];
      cache.comments = comments;
      redraw();
    } catch (e) { toast('Could not load comments: ' + e.message, 'error'); }
  }
  async function loadActivity() {
    try {
      const r = await API.taskActivity(task.id);
      activity = r.activity || [];
      cache.activity = activity;
      redraw();
    } catch (e) { toast('Could not load activity: ' + e.message, 'error'); }
  }
  async function loadDeps() {
    try {
      const r = await API.listDependencies(task.id);
      deps = { blocked_by: r.blocked_by || [], blocks: r.blocks || [] };
      cache.deps = deps;
      redraw();
    } catch (e) { toast('Could not load dependencies: ' + e.message, 'error'); }
  }
  async function loadTime() {
    try {
      const r = await API.listTime(task.id);
      timeData = { entries: r.entries || [], total_minutes: r.total_minutes || 0 };
      cache.time = timeData;
      redraw();
    } catch (e) { toast('Could not load time entries: ' + e.message, 'error'); }
  }
  async function loadAttachments() {
    try {
      const r = await API.listAttachments(task.id);
      attachments = r.attachments || [];
      window._pmAttachmentsCache[task.id] = attachments;
      redraw();
    } catch (e) { toast('Could not load attachments: ' + e.message, 'error'); }
  }
  async function loadReminders() {
    try {
      const r = await API.listReminders(task.id);
      reminders = r.reminders || [];
      cache.reminders = reminders;
      redraw();
    } catch (e) { toast('Could not load reminders: ' + e.message, 'error'); }
  }
  if (comments === null) loadComments();
  if (activity === null) loadActivity();
  if (deps === null) loadDeps();
  if (timeData === null) loadTime();
  if (attachments === null) loadAttachments();
  if (reminders === null) loadReminders();

  // After mutating board-visible data, refresh the shared task list so other
  // views stay consistent. renderApp() rebuilds this drawer from state.tasks;
  // because the cache is keyed to the same open task it survives, so the
  // section we just updated still shows its data.
  function refreshBoard() { if (window.pmRefreshTasks) window.pmRefreshTasks(); }

  // ---- comment body: safe Markdown + @mention highlighting ----
  // Render the body through renderMarkdown() (escapes everything, then adds a
  // fixed safe tag set), THEN walk the resulting element's text nodes and wrap
  // "@Full Name" (only names the server actually resolved as mentions) in
  // <span class="mention">. We split text nodes — never innerHTML-concatenate
  // unescaped text — so this stays XSS-safe and markdown formatting survives.
  function renderCommentBody(c) {
    const wrap = renderMarkdown(c.body || '');
    const ids = Array.isArray(c.mentions) ? c.mentions : [];
    const names = ids.map(id => userById(id)?.name).filter(Boolean);
    if (!names.length) return wrap;
    // Build a regex that matches "@" + any of the mentioned full names.
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('@(' + names.map(esc).join('|') + ')', 'g');
    highlightMentions(wrap, re);
    return wrap;
  }

  // Walk every text node under `root` and replace "@Name" matches with a
  // .mention span, splicing the span between plain text nodes. Skips inside
  // <code>/<a> so we don't mangle code spans or rewrite link text.
  function highlightMentions(root, re) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
          const tag = p.nodeName;
          if (tag === 'CODE' || tag === 'A') return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const textNode of targets) {
      const text = textNode.nodeValue;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        frag.appendChild(h('span', { class: 'mention' }, '@' + m[1]));
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  function sectionLabel(text, trailing) {
    return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' } },
      h('div', { style: { fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600' } }, text),
      trailing || null,
    );
  }

  function redraw() {
    drawer.replaceChildren();
    // Per-project access: tasks in private projects the user can only read carry
    // can_write === false. Undefined/true means full editing (legacy + open
    // projects), so default to writable. Server-side checks remain authoritative.
    const canWrite = task.can_write !== false;
    const proj = projectById(task.project);
    const sub = task.subtasks || [];
    const subDone = sub.filter(s => s.done).length;
    const pct = sub.length ? (subDone / sub.length) * 100 : 0;

    // Head
    const head = h('div', { class: 'drawer-head' });
    head.appendChild(h('span', { class: 'mono', style: { fontSize: '11.5px', color: 'var(--fg-3)' } }, task.ref));
    if (proj) head.appendChild(h('span', { style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', color: proj.color } },
      h('span', { style: { width: '8px', height: '8px', borderRadius: '2px', background: proj.color } }),
      proj.name));
    if (!canWrite) head.appendChild(h('span', {
      class: 'chip', title: 'You have read-only access to this project',
      style: { fontSize: '10.5px', padding: '1px 7px', color: 'var(--fg-3)', gap: '4px' },
    }, Icon('eye', 11), 'View only'));

    // Watch / Unwatch toggle
    const watchers = Array.isArray(task.watchers) ? task.watchers : [];
    const meId = window.state.me?.id;
    const watching = meId != null && watchers.includes(meId);
    const watchBtn = h('button', {
      class: 'icon-btn', title: watching ? 'Unwatch' : 'Watch',
      'aria-pressed': watching ? 'true' : 'false',
      onClick: async () => {
        try {
          const r = watching ? await API.unwatchTask(task.id) : await API.watchTask(task.id);
          task.watchers = r.watchers || [];
          refreshBoard();
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, Icon(watching ? 'bellOff' : 'eye', 14));

    // Save as template (admins only).
    const templateBtn = window.state.me?.is_admin ? h('button', {
      class: 'icon-btn', title: 'Save as template',
      onClick: async () => {
        const name = await promptDialog({
          title: 'Save as template',
          label: 'Template name',
          value: task.title || '',
          placeholder: 'e.g. Bug triage checklist',
        });
        if (name == null) return;
        const trimmed = name.trim();
        if (!trimmed) { toast('Template name is required', 'error'); return; }
        try {
          await API.createTemplate({
            project_id: task.project,
            name: trimmed,
            title: task.title,
            description: task.description,
            priority: task.priority,
            estimate: task.estimate,
            default_status: task.status,
            labels: task.labels || [],
            assignees: task.assignees || [],
            subtasks: (task.subtasks || []).map(s => s.text),
          });
          toast('Template saved', 'success');
          if (window.pmLoadTemplates) window.pmLoadTemplates();
        } catch (e) { toast('Could not save template: ' + e.message, 'error'); }
      },
    }, Icon('archive', 14)) : null;

    head.appendChild(h('div', { style: { marginLeft: 'auto' }, class: 'hstack' },
      watchBtn,
      templateBtn,
      h('button', { class: 'icon-btn', title: 'Copy link',
        onClick: () => { navigator.clipboard?.writeText(`${location.origin}${location.pathname}#task=${task.id}`); toast('Link copied'); } },
        Icon('link', 14)),
      h('button', { class: 'icon-btn', title: 'Duplicate task',
        onClick: async () => {
          try {
            const r = await API.createTask({
              title: task.title + ' (copy)',
              project: task.project,
              status: task.status,
              priority: task.priority,
              description: task.description || '',
              estimate: task.estimate || '',
              due: task.due || null,
              start_date: task.start_date || null,
              milestone_id: task.milestone_id || null,
              assignees: (task.assignees || []).slice(),
              labels: (task.labels || []).slice(),
            });
            const newTask = r.task || r;
            for (const s of (task.subtasks || [])) {
              try { await API.addSubtask(newTask.id, s.text); } catch (_) {}
            }
            if (window.pmRefreshTasks) window.pmRefreshTasks();
            toast('Task duplicated', 'success');
            location.hash = '#task=' + newTask.id;
          } catch (e) { toast(e.message, 'error'); }
        } }, Icon('plusCircle', 14)),
      canWrite ? h('button', { class: 'icon-btn', title: 'Delete',
        onClick: async () => {
          const ok = await confirmDialog({ title: `Delete ${task.ref}?`, message: task.title, confirmText: 'Delete', danger: true });
          if (!ok) return;
          try {
            await onDeleteTask(task.id);
            delete window._pmDrawerCache[task.id];
            delete window._pmAttachmentsCache[task.id];
            onClose();
          } catch (e) { toast(e.message, 'error'); }
        } }, Icon('trash', 14)) : null,
      h('button', { class: 'icon-btn', title: 'Close', onClick: onClose }, Icon('x', 14)),
    ));
    drawer.appendChild(head);

    // Body
    const body = h('div', { class: 'drawer-body' });

    // Title
    if (!canWrite) {
      body.appendChild(h('h2', {
        style: { margin: 0, fontSize: '20px', fontWeight: '600', letterSpacing: '-0.01em', padding: '8px', marginLeft: '-8px' },
      }, task.title));
    } else if (editingTitle) {
      const ta = h('textarea', {
        value: tempTitle,
        onInput: e => { tempTitle = e.target.value; },
        onBlur: () => save(),
        onKeydown: e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
          if (e.key === 'Escape') { tempTitle = task.title; editingTitle = false; redraw(); }
        },
        style: {
          width: '100%', fontSize: '20px', fontWeight: '600', letterSpacing: '-0.01em',
          background: 'var(--bg-3)', border: '1px solid var(--acc-border)', borderRadius: '8px',
          padding: '10px', color: 'var(--fg-0)', outline: 'none', resize: 'none', minHeight: '60px',
        },
      });
      body.appendChild(ta);
      async function save() {
        const v = (tempTitle || '').trim();
        editingTitle = false;
        if (v && v !== task.title) {
          try { await onUpdate(task.id, { title: v }); task.title = v; }
          catch (e) { toast('Save failed: ' + e.message, 'error'); }
        }
        redraw();
      }
    } else {
      body.appendChild(h('h2', {
        onClick: () => { tempTitle = task.title; editingTitle = true; redraw(); },
        style: {
          margin: 0, fontSize: '20px', fontWeight: '600', letterSpacing: '-0.01em',
          cursor: 'text', padding: '8px', marginLeft: '-8px', borderRadius: '6px',
        },
        onMouseenter: e => e.currentTarget.style.background = 'var(--bg-3)',
        onMouseleave: e => e.currentTarget.style.background = 'transparent',
      }, task.title));
    }

    // Properties grid
    const grid = h('div', { style: { marginTop: '18px', display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: '10px', alignItems: 'center' } });

    // Status
    grid.appendChild(PropLabel('activity', 'Status'));
    {
      const btn = h('button', { disabled: !canWrite, style: { background: 'transparent', padding: '4px', borderRadius: '6px', cursor: canWrite ? 'pointer' : 'default' } }, StatusPill(task.status));
      if (canWrite) btn.addEventListener('click', () => {
        openPopover(btn, ({close}) => statusPickerContent(task.status, async v => {
          try { const r = await onUpdate(task.id, { status: v }); Object.assign(task, r.task || {status:v}); redraw(); } catch(e){toast(e.message,'error');}
        }, close));
      });
      grid.appendChild(h('div', null, btn));
    }

    // Priority
    grid.appendChild(PropLabel('flag', 'Priority'));
    {
      const btn = h('button', { class: 'chip', disabled: !canWrite, style: canWrite ? null : { cursor: 'default' } }, PriorityFlag(task.priority, true));
      if (canWrite) btn.addEventListener('click', () => {
        openPopover(btn, ({close}) => priorityPickerContent(task.priority, async v => {
          try { const r = await onUpdate(task.id, { priority: v }); Object.assign(task, r.task || {priority:v}); redraw(); } catch(e){toast(e.message,'error');}
        }, close));
      });
      grid.appendChild(h('div', null, btn));
    }

    // Assignees
    grid.appendChild(PropLabel('users', 'Assignees'));
    {
      const names = task.assignees.map(id => (userById(id)?.name || '').split(' ')[0]).filter(Boolean).join(', ');
      const btn = h('button', { class: 'chip', disabled: !canWrite, style: { padding: '3px 8px', cursor: canWrite ? 'pointer' : 'default' } },
        AvatarStack(task.assignees, 3, 20),
        h('span', { style: { marginLeft: '4px' } }, names || 'Unassigned'));
      if (canWrite) btn.addEventListener('click', () => {
        openPopover(btn, ({close}) => assigneePickerContent(task.assignees, async uid => {
          const set = new Set(task.assignees);
          set.has(uid) ? set.delete(uid) : set.add(uid);
          const arr = [...set];
          try { const r = await onUpdate(task.id, { assignees: arr }); Object.assign(task, r.task || {assignees: arr}); redraw(); } catch(e){toast(e.message,'error');}
        }, close));
      });
      grid.appendChild(h('div', null, btn));
    }

    // Due
    grid.appendChild(PropLabel('clock', 'Due date'));
    {
      const btn = h('button', { class: 'chip', disabled: !canWrite, style: { fontSize: '11.5px', cursor: canWrite ? 'pointer' : 'default' } },
        task.due ? DueDate(task.due) : h('span', { style: { color: 'var(--fg-3)' } }, canWrite ? 'Set due date' : 'No due date'));
      if (canWrite) btn.addEventListener('click', () => {
        datePickerPopover(btn, task.due || '', async v => {
          const val = v || null;
          try { const r = await onUpdate(task.id, { due: val }); Object.assign(task, r.task || {due: val}); redraw(); } catch(err){toast(err.message,'error');}
        });
      });
      grid.appendChild(h('div', null, btn));
    }

    // Start date
    grid.appendChild(PropLabel('calendar', 'Start date'));
    {
      const btn = h('button', { class: 'chip', disabled: !canWrite, style: { fontSize: '11.5px', cursor: canWrite ? 'pointer' : 'default' } },
        task.start_date ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, Icon('calendar', 11), parseISO(task.start_date).toLocaleDateString('en', { month: 'short', day: 'numeric' }))
                        : h('span', { style: { color: 'var(--fg-3)' } }, canWrite ? 'Set start date' : 'No start date'));
      if (canWrite) btn.addEventListener('click', () => {
        datePickerPopover(btn, task.start_date || '', async v => {
          const val = v || null;
          try { const r = await onUpdate(task.id, { start_date: val }); Object.assign(task, r.task || {start_date: val}); refreshBoard(); redraw(); } catch(err){toast(err.message,'error');}
        });
      });
      grid.appendChild(h('div', null, btn));
    }

    // Milestone
    grid.appendChild(PropLabel('target', 'Milestone'));
    {
      const projMilestones = (window.state.milestones || []).filter(m => m.project_id == null || m.project_id == task.project);
      const current = (window.state.milestones || []).find(m => m.id == task.milestone_id);
      const btn = h('button', { class: 'chip', disabled: !canWrite, style: { fontSize: '11.5px', cursor: canWrite ? 'pointer' : 'default' } },
        current ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px' } }, Icon('target', 11), current.name)
                : h('span', { style: { color: 'var(--fg-3)' } }, 'No milestone'));
      if (canWrite) btn.addEventListener('click', () => {
        openPopover(btn, ({ close }) => {
          const wrap = h('div');
          wrap.appendChild(h('div', { class: 'popover-header' }, 'Milestone'));
          const pick = async (val) => {
            try { const r = await onUpdate(task.id, { milestone_id: val }); Object.assign(task, r.task || { milestone_id: val }); refreshBoard(); redraw(); }
            catch (e) { toast(e.message, 'error'); }
            close();
          };
          wrap.appendChild(PopoverItem({
            selected: task.milestone_id == null,
            onSelect: () => pick(null),
            leading: Icon('x', 12),
            children: h('span', null, 'No milestone'),
          }));
          if (!projMilestones.length) {
            wrap.appendChild(h('div', { class: 'empty', style: { padding: '10px' } }, 'No milestones for this project'));
          }
          for (const m of projMilestones) {
            wrap.appendChild(PopoverItem({
              selected: task.milestone_id == m.id,
              onSelect: () => pick(m.id),
              leading: Icon('target', 12),
              children: h('span', null, m.name + (m.status === 'done' ? ' ✓' : '')),
            }));
          }
          return wrap;
        });
      });
      grid.appendChild(h('div', null, btn));
    }

    // Labels
    grid.appendChild(PropLabel('tag', 'Labels'));
    {
      const wrap = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } });
      task.labels.forEach(l => wrap.appendChild(Tag(l)));
      if (canWrite) {
        const add = h('button', { class: 'chip', style: { fontSize: '11.5px' } }, Icon('plus', 11), ' Add label');
        add.addEventListener('click', () => {
          openPopover(add, ({close}) => labelPickerContent(task.labels, async lid => {
            const set = new Set(task.labels);
            set.has(lid) ? set.delete(lid) : set.add(lid);
            const arr = [...set];
            try { const r = await onUpdate(task.id, { labels: arr }); Object.assign(task, r.task || {labels: arr}); redraw(); } catch(e){toast(e.message,'error');}
          }, close, {
            keepOpen: true,
            scopeProjectId: task.project,
            onCreateLabel: window.pmCreateLabelFromPicker,
          }));
        });
        wrap.appendChild(add);
      } else if (!task.labels.length) {
        wrap.appendChild(h('span', { style: { color: 'var(--fg-3)', fontSize: '11.5px' } }, 'No labels'));
      }
      grid.appendChild(wrap);
    }

    // Estimate
    grid.appendChild(PropLabel('zap', 'Estimate'));
    {
      const input = h('input', {
        type: 'text', placeholder: '—', value: task.estimate || '', disabled: !canWrite,
        style: { background: 'var(--bg-3)', border: '1px solid var(--line-2)', borderRadius: '6px', padding: '4px 8px', color: 'var(--fg-0)', fontSize: '12px', outline: 'none', width: '100px' },
        onBlur: canWrite ? async e => {
          const v = e.target.value.trim() || null;
          if (v === (task.estimate || null)) return;
          try { const r = await onUpdate(task.id, { estimate: v }); Object.assign(task, r.task || {estimate:v}); } catch(err){toast(err.message,'error');}
        } : null,
      });
      grid.appendChild(h('div', null, input));
    }
    body.appendChild(grid);

    // Watchers
    body.appendChild((() => {
      const wsec = h('div', { style: { marginTop: '22px' } });
      wsec.appendChild(sectionLabel(`Watchers · ${watchers.length}`));
      const row = h('div', { class: 'hstack', style: { gap: '10px', alignItems: 'center' } });
      if (watchers.length) row.appendChild(AvatarStack(watchers, 6, 24));
      else row.appendChild(h('span', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'No watchers yet.'));
      row.appendChild(h('button', {
        class: 'btn btn-ghost', style: { marginLeft: 'auto', fontSize: '12px' },
        onClick: () => watchBtn.click(),
      }, Icon(watching ? 'bellOff' : 'eye', 13), watching ? ' Unwatch' : ' Watch'));
      wsec.appendChild(row);
      return wsec;
    })());

    // Description — Markdown-rendered by default; click (or Edit) swaps to the
    // textarea editor; blur/save persists and swaps back to the rendered view.
    body.appendChild((() => {
      const dsec = h('div', { style: { marginTop: '22px' } });
      const editable = canWrite;
      // Header with an inline Edit affordance (only while showing rendered text).
      const header = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' } },
        h('div', { style: { fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600' } }, 'Description'),
        (editable && !descEditing && (task.description || '').trim())
          ? h('button', { class: 'btn btn-ghost', style: { fontSize: '11px', padding: '2px 6px' },
              onClick: () => { descEditing = true; redraw(); } }, Icon('edit', 12), ' Edit')
          : null,
      );
      dsec.appendChild(header);

      if (editable && descEditing) {
        const ta = h('textarea', {
          placeholder: 'Add a description… (Markdown supported)',
          value: task.description || '',
          style: {
            width: '100%', minHeight: '70px', resize: 'vertical',
            background: 'var(--bg-3)', border: '1px solid var(--acc-border)', borderRadius: '8px',
            padding: '12px', fontSize: '13.5px', color: 'var(--fg-1)', lineHeight: '1.55', outline: 'none',
          },
          onKeydown: e => { if (e.key === 'Escape') { e.preventDefault(); descEditing = false; redraw(); } },
          onBlur: async e => {
            const v = e.target.value;
            descEditing = false;
            if (v !== (task.description || '')) {
              try { const r = await onUpdate(task.id, { description: v }); Object.assign(task, r.task || {description:v}); }
              catch(err){toast(err.message,'error');}
            }
            redraw();
          },
        });
        dsec.appendChild(ta);
        // Focus into the editor once it's mounted (after this redraw paints).
        setTimeout(() => { if (document.body.contains(ta)) { ta.focus(); const n = ta.value.length; try { ta.setSelectionRange(n, n); } catch (_) {} } }, 0);
      } else if ((task.description || '').trim()) {
        const md = renderMarkdown(task.description);
        if (editable) {
          md.setAttribute('role', 'button');
          md.setAttribute('tabindex', '0');
          md.setAttribute('title', 'Click to edit');
          md.style.cursor = 'text';
          md.style.padding = '12px';
          md.style.border = '1px solid var(--line)';
          md.style.borderRadius = '8px';
          md.style.background = 'var(--bg-3)';
          md.addEventListener('click', () => { descEditing = true; redraw(); });
          md.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); descEditing = true; redraw(); } });
        }
        dsec.appendChild(md);
      } else {
        // Empty: muted placeholder. Opens the editor when writable.
        const ph = h('div', {
          style: { fontSize: '13px', color: 'var(--fg-3)', padding: editable ? '12px' : '0', fontStyle: 'italic',
            cursor: editable ? 'text' : 'default',
            border: editable ? '1px dashed var(--line)' : 'none', borderRadius: '8px' },
        }, editable ? 'Add a description…' : 'No description');
        if (editable) {
          ph.setAttribute('role', 'button');
          ph.setAttribute('tabindex', '0');
          ph.addEventListener('click', () => { descEditing = true; redraw(); });
          ph.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); descEditing = true; redraw(); } });
        }
        dsec.appendChild(ph);
      }
      return dsec;
    })());

    // Dependencies
    body.appendChild((() => {
      const dsec = h('div', { style: { marginTop: '24px' } });
      const blockedBy = deps ? deps.blocked_by : [];
      const blocks = deps ? deps.blocks : [];
      dsec.appendChild(sectionLabel('Dependencies'));

      const depPill = (t, kind) => {
        const isBlocked = kind === 'blocked_by' && t.status !== 'done';
        const pill = h('span', { class: 'dep-pill' + (isBlocked ? ' blocked' : '') },
          miniTaskChip(t),
          canWrite ? h('button', {
            class: 'icon-btn sm', title: 'Remove dependency', style: { marginLeft: '4px' },
            onClick: async () => {
              // blocked_by: this task depends on t. blocks: t depends on this task.
              const a = kind === 'blocked_by' ? task.id : t.id;
              const b = kind === 'blocked_by' ? t.id : task.id;
              try {
                await API.removeDependency(a, b);
                await loadDeps();
                refreshBoard();
              } catch (e) { toast(e.message, 'error'); }
            },
          }, Icon('x', 11)) : null,
        );
        // Make the chip open the task it points to. Navigate via the URL hash
        // so app.js's own hashchange listener opens it (renderApp/state are
        // module-local in app.js and not reachable from here).
        const chip = pill.querySelector('.mini-task-chip');
        if (chip) {
          chip.style.cursor = 'pointer';
          chip.addEventListener('click', () => { location.hash = '#task=' + t.id; });
        }
        return pill;
      };

      // Blocked by
      dsec.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--fg-2)', marginBottom: '6px' } }, 'Blocked by'));
      const bbWrap = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' } });
      if (deps == null) bbWrap.appendChild(h('span', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, '…'));
      else if (!blockedBy.length) bbWrap.appendChild(h('span', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'Nothing'));
      else blockedBy.forEach(t => bbWrap.appendChild(depPill(t, 'blocked_by')));
      dsec.appendChild(bbWrap);

      // Add blocker
      const addBtn = h('button', { class: 'chip', style: { fontSize: '11.5px', marginBottom: '12px' } }, Icon('gitBranch', 11), ' Add blocker');
      if (canWrite) addBtn.addEventListener('click', () => {
        openPopover(addBtn, ({ close }) => {
          const wrap = h('div');
          const input = h('input', { placeholder: 'Search tasks…', value: newBlockerQuery, autofocus: true });
          wrap.appendChild(h('div', { class: 'pop-search' }, input));
          wrap.appendChild(h('div', { class: 'popover-header' }, 'Add a blocking task'));
          const list = h('div', { style: { maxHeight: '240px', overflowY: 'auto' } });
          wrap.appendChild(list);
          const existing = new Set([task.id, ...blockedBy.map(t => t.id)]);
          function render(q = '') {
            list.replaceChildren();
            const ql = q.toLowerCase();
            const results = (window.state.tasks || []).filter(t =>
              !existing.has(t.id) &&
              ((t.title || '').toLowerCase().includes(ql) || (t.ref || '').toLowerCase().includes(ql))
            ).slice(0, 12);
            if (!results.length) { list.appendChild(h('div', { class: 'empty', style: { padding: '10px' } }, 'No matching tasks')); return; }
            for (const t of results) {
              list.appendChild(PopoverItem({
                onSelect: async () => {
                  try {
                    await API.addDependency(task.id, t.id);
                    newBlockerQuery = '';
                    await loadDeps();
                    refreshBoard();
                    close();
                  } catch (e) {
                    // Cycle / self-link errors come back as 400 with a message.
                    toast(e.message || 'Could not add dependency', 'error');
                  }
                },
                children: miniTaskChip(t),
              }));
            }
          }
          input.addEventListener('input', e => { newBlockerQuery = e.target.value; render(e.target.value); });
          render(newBlockerQuery);
          return wrap;
        });
      });
      if (canWrite) dsec.appendChild(addBtn);

      // Blocks
      dsec.appendChild(h('div', { style: { fontSize: '12px', color: 'var(--fg-2)', marginBottom: '6px' } }, 'Blocks'));
      const blWrap = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
      if (deps == null) blWrap.appendChild(h('span', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, '…'));
      else if (!blocks.length) blWrap.appendChild(h('span', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'Nothing'));
      else blocks.forEach(t => blWrap.appendChild(depPill(t, 'blocks')));
      dsec.appendChild(blWrap);

      return dsec;
    })());

    // Time tracking
    body.appendChild((() => {
      const tsec = h('div', { style: { marginTop: '24px' } });
      const total = timeData ? timeData.total_minutes : 0;
      const entries = timeData ? timeData.entries : [];
      const estLabel = task.estimate ? ` of ${task.estimate}` : '';
      tsec.appendChild(sectionLabel(
        'Time tracking',
        h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-2)' } },
          timeData == null ? '…' : `${fmtMinutes(total)} logged${estLabel}`),
      ));

      const list = h('div', { style: { display: 'grid', gap: '6px', marginBottom: '10px' } });
      if (timeData && entries.length) {
        const myId = window.state.me?.id;
        for (const en of entries) {
          const canDelete = canWrite && (window.state.me?.is_admin || (en.user && en.user.id === myId));
          list.appendChild(h('div', { class: 'time-entry' },
            en.user ? Avatar(en.user, 20) : h('span', { class: 'avatar', style: { width: '20px', height: '20px' } }, '?'),
            h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, fmtMinutes(en.minutes)),
            h('span', { style: { fontSize: '12px', color: 'var(--fg-2)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              (en.note ? en.note + ' · ' : '') + (en.user ? en.user.name : 'Former teammate')),
            h('span', { style: { fontSize: '11px', color: 'var(--fg-3)' } }, en.spent_on || relTime(en.created_at)),
            canDelete ? h('button', {
              class: 'icon-btn sm', title: 'Delete entry',
              onClick: async () => {
                const ok = await confirmDialog({ title: 'Delete time entry?', confirmText: 'Delete', danger: true });
                if (!ok) return;
                try { await API.deleteTime(en.id); await loadTime(); refreshBoard(); }
                catch (e) { toast(e.message, 'error'); }
              },
            }, Icon('trash', 11)) : null,
          ));
        }
      } else if (timeData && !entries.length) {
        list.appendChild(h('div', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'No time logged yet.'));
      }
      tsec.appendChild(list);

      // Quick log form (writers only)
      if (canWrite) {
        const minInput = h('input', {
          type: 'number', min: '1', placeholder: 'min', value: logMinutes,
          style: { width: '70px', background: 'var(--bg-3)', border: '1px solid var(--line-2)', borderRadius: '6px', padding: '5px 8px', color: 'var(--fg-0)', fontSize: '12px', outline: 'none' },
          onInput: e => { logMinutes = e.target.value; },
        });
        const noteInput = h('input', {
          type: 'text', placeholder: 'Note (optional)', value: logNote,
          style: { flex: 1, background: 'var(--bg-3)', border: '1px solid var(--line-2)', borderRadius: '6px', padding: '5px 8px', color: 'var(--fg-0)', fontSize: '12px', outline: 'none' },
          onInput: e => { logNote = e.target.value; },
        });
        const submitTime = async () => {
          const mins = parseInt(logMinutes, 10);
          if (!mins || mins <= 0) { toast('Enter minutes greater than 0', 'error'); return; }
          try {
            await API.addTime(task.id, { minutes: mins, note: logNote.trim() || undefined });
            logMinutes = ''; logNote = '';
            await loadTime();
            refreshBoard();
          } catch (e) { toast(e.message, 'error'); }
        };
        minInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitTime(); } });
        noteInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitTime(); } });
        tsec.appendChild(h('div', { class: 'hstack', style: { gap: '8px' } },
          Icon('clock', 13),
          minInput, noteInput,
          h('button', { class: 'btn btn-ghost', style: { fontSize: '12px' }, onClick: submitTime }, 'Log time'),
        ));
      }
      return tsec;
    })());

    // Reminders
    body.appendChild((() => {
      const rsec = h('div', { style: { marginTop: '24px' } });
      rsec.appendChild(sectionLabel(
        'Reminders',
        h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-2)' } },
          reminders == null ? '…' : String(reminders.length)),
      ));

      // Format an absolute reminder time (remind_at may be future, so relTime —
      // which only renders elapsed past times — isn't enough; and parseISO()
      // truncates to midnight, which would drop the reminder's clock time).
      const fmtRemind = (iso) => {
        if (!iso) return '';
        const d = new Date(String(iso).replace(' ', 'T'));
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }) +
          ' ' + d.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' });
      };

      const list = h('div', { style: { display: 'grid', gap: '6px', marginBottom: '10px' } });
      if (reminders && reminders.length) {
        for (const rm of reminders) {
          list.appendChild(h('div', { class: 'time-entry' },
            Icon('clock', 13),
            h('span', { style: { fontWeight: 600, fontSize: '12.5px' } }, fmtRemind(rm.remind_at)),
            rm.everyone || rm.channel === 'everyone'
              ? h('span', { class: 'chip', style: { fontSize: '10.5px', padding: '1px 6px' } }, Icon('users', 10), ' Everyone')
              : null,
            rm.sent_at
              ? h('span', { class: 'chip', style: { fontSize: '10.5px', padding: '1px 6px', color: 'var(--green-fg)' }, title: 'Sent ' + relTime(rm.sent_at) }, Icon('check', 10), ' Sent')
              : null,
            h('span', { style: { flex: 1 } }),
            canWrite ? h('button', {
              class: 'icon-btn sm', title: 'Delete reminder',
              onClick: async () => {
                const ok = await confirmDialog({ title: 'Delete reminder?', confirmText: 'Delete', danger: true });
                if (!ok) return;
                try { await API.deleteReminder(rm.id); await loadReminders(); }
                catch (e) { toast(e.message, 'error'); }
              },
            }, Icon('trash', 11)) : null,
          ));
        }
      } else if (reminders && !reminders.length) {
        list.appendChild(h('div', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'No reminders set.'));
      }
      rsec.appendChild(list);

      // Add reminder form (writers only).
      if (canWrite) {
        const whenInput = h('input', {
          type: 'datetime-local', value: newReminderAt,
          style: { background: 'var(--bg-3)', border: '1px solid var(--line-2)', borderRadius: '6px', padding: '5px 8px', color: 'var(--fg-0)', fontSize: '12px', outline: 'none' },
          onInput: e => { newReminderAt = e.target.value; },
        });
        const submitReminder = async () => {
          if (!newReminderAt) { toast('Pick a date and time first', 'error'); return; }
          const payload = { remind_at: newReminderAt };
          if (newReminderEveryone) payload.everyone = '1';
          try {
            await API.addReminder(task.id, payload);
            newReminderAt = ''; newReminderEveryone = false;
            await loadReminders();
          } catch (e) { toast(e.message, 'error'); }
        };
        whenInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitReminder(); } });

        const everyoneId = 'pm-remind-everyone-' + task.id;
        const everyoneBox = h('input', {
          type: 'checkbox', id: everyoneId, checked: newReminderEveryone,
          onChange: e => { newReminderEveryone = e.target.checked; },
        });
        rsec.appendChild(h('div', { class: 'hstack', style: { gap: '8px', flexWrap: 'wrap' } },
          Icon('clock', 13),
          whenInput,
          h('button', { class: 'btn btn-ghost', style: { fontSize: '12px' }, onClick: submitReminder }, 'Remind me'),
          h('label', { for: everyoneId, class: 'hstack', style: { gap: '5px', fontSize: '12px', color: 'var(--fg-2)', cursor: 'pointer' } },
            everyoneBox, 'Remind everyone on this task'),
        ));
      }
      return rsec;
    })());

    // Custom fields
    {
      const fields = (window.state.customFields || []).filter(f =>
        !f.archived && (f.project_id == null || f.project_id == task.project));
      if (fields.length) {
        const cfSec = h('div', { style: { marginTop: '24px' } });
        cfSec.appendChild(sectionLabel('Custom fields'));
        const cfGrid = h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: '10px', alignItems: 'center' } });
        for (const f of fields) {
          cfGrid.appendChild(PropLabel('settings', f.name));
          cfGrid.appendChild(h('div', { class: 'cf-field' }, customFieldEditor(f, task, canWrite)));
        }
        cfSec.appendChild(cfGrid);
        body.appendChild(cfSec);
      }
    }

    // Subtasks
    const subSection = h('div', { style: { marginTop: '24px' } });
    subSection.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' } },
      h('div', { style: { fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600' } }, 'Subtasks'),
      sub.length > 0 ? h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-2)' } }, `${subDone}/${sub.length}`) : null,
    ));
    if (sub.length > 0) {
      subSection.appendChild(h('div', { style: { height: '4px', background: 'var(--bg-4)', borderRadius: '2px', overflow: 'hidden', marginBottom: '10px' } },
        h('div', { style: { width: pct + '%', height: '100%', background: pct === 100 ? 'var(--green)' : 'var(--acc-0)', transition: 'width 0.3s' } })));
    }
    const subBox = h('div', { style: { background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: '8px' } });
    if (!sub.length && !canWrite) {
      subBox.appendChild(h('div', { style: { padding: '9px 12px', color: 'var(--fg-3)', fontSize: '12px' } }, 'No subtasks.'));
    }
    sub.forEach((s, i) => {
      const del = canWrite ? h('button', {
        class: 'icon-btn sm sub-del',
        title: 'Delete subtask',
        style: { opacity: '0', transition: 'opacity 0.1s' },
        onClick: async (e) => {
          e.stopPropagation();
          try {
            await onDeleteSubtask(task.id, s.id);
            task.subtasks = (task.subtasks || []).filter(x => x.id !== s.id);
            redraw();
          } catch(err) { toast(err.message, 'error'); }
        },
      }, Icon('trash', 12)) : null;
      const row = h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px',
          borderBottom: i === sub.length - 1 ? 'none' : '1px solid var(--line)',
          cursor: canWrite ? 'pointer' : 'default',
        },
        onClick: canWrite ? async () => {
          try {
            await onToggleSubtask(task.id, s.id, !s.done);
            s.done = !s.done;
            redraw();
          } catch(e){toast(e.message,'error');}
        } : null,
        onMouseenter: canWrite ? e => { e.currentTarget.style.background = 'var(--bg-4)'; if (del) del.style.opacity = '1'; } : null,
        onMouseleave: canWrite ? e => { e.currentTarget.style.background = 'transparent'; if (del) del.style.opacity = '0'; } : null,
      },
        Checkbox(s.done, 16),
        h('span', { style: { fontSize: '13px', flex: 1,
          color: s.done ? 'var(--fg-3)' : 'var(--fg-1)',
          textDecoration: s.done ? 'line-through' : 'none' } }, s.text),
        del,
      );
      subBox.appendChild(row);
    });
    if (canWrite) {
      const addRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px', borderTop: sub.length ? '1px solid var(--line)' : 'none' } });
      addRow.appendChild(h('div', { style: { width: '16px', height: '16px', borderRadius: '4px', border: '1.5px dashed var(--fg-4)' } }));
      const subInput = h('input', {
        placeholder: 'Add a subtask...', value: newSubtaskText,
        style: { flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '13px', color: 'var(--fg-1)' },
        onInput: e => { newSubtaskText = e.target.value; },
        onKeydown: async e => {
          if (e.key === 'Enter' && newSubtaskText.trim()) {
            try {
              const text = newSubtaskText.trim();
              const r = await onAddSubtask(task.id, text);
              task.subtasks = task.subtasks || [];
              task.subtasks.push(r.subtask);
              newSubtaskText = '';
              redraw();
            } catch(err){toast(err.message,'error');}
          }
        },
      });
      addRow.appendChild(subInput);
      subBox.appendChild(addRow);
    }
    subSection.appendChild(subBox);
    body.appendChild(subSection);

    // Attachments
    const attSection = h('div', { style: { marginTop: '24px' } });
    attSection.appendChild(h('div', {
      style: { fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600', marginBottom: '10px' }
    }, `Attachments · ${attachments == null ? '…' : attachments.length}`));

    // Delete control for an attachment row (respects read-only gating).
    const attDeleteBtn = (a) => canWrite ? h('button', {
      class: 'btn btn-ghost',
      style: { fontSize: '11px', padding: '2px 6px' },
      onClick: async () => {
        const ok = await confirmDialog({ title: 'Delete attachment?', message: a.name, confirmText: 'Delete', danger: true });
        if (!ok) return;
        try {
          await API.deleteAttachment(a.id);
          attachments = attachments.filter(x => x.id !== a.id);
          window._pmAttachmentsCache[task.id] = attachments;
          task.attachments = Math.max(0, (task.attachments || 0) - 1);
          redraw();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, 'Delete') : null;

    const attList = h('div', { style: { display: 'grid', gap: '8px' } });
    if (attachments && attachments.length) {
      // Images (excluding SVG) get a clickable thumbnail that opens a lightbox.
      // The list of images is captured so the lightbox can offer prev/next.
      const images = attachments.filter(isImageAttachment);
      attachments.forEach((a) => {
        if (isImageAttachment(a)) {
          const idx = images.indexOf(a);
          const thumb = h('img', {
            class: 'att-thumb',
            src: `api/attachments.php?id=${a.id}&download=1`,
            alt: a.name,
            loading: 'lazy',
            // Fallback inline styles in case the att-thumb class is not yet styled.
            style: {
              width: '64px', height: '64px', objectFit: 'cover', borderRadius: '8px',
              border: '1px solid var(--line)', background: 'var(--bg-4)', cursor: 'zoom-in',
              flex: '0 0 auto', display: 'block',
            },
          });
          const openIt = () => openAttachmentLightbox(images, idx);
          const thumbBtn = h('button', {
            class: 'att-thumb-btn',
            title: 'Preview ' + a.name,
            'aria-label': 'Preview ' + a.name,
            style: { padding: 0, border: 'none', background: 'transparent', cursor: 'zoom-in', lineHeight: 0, flex: '0 0 auto' },
            onClick: openIt,
          }, thumb);
          attList.appendChild(h('div', {
            style: {
              display: 'flex', gap: '10px', alignItems: 'center',
              background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px 10px',
            },
          },
            thumbBtn,
            h('div', { style: { flex: 1, minWidth: 0, display: 'grid', gap: '2px' } },
              h('a', {
                href: a.download_url,
                style: { color: 'var(--fg-1)', fontSize: '12.5px', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' },
                title: a.name,
              }, a.name),
              h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)' } }, formatBytes(a.size)),
            ),
            attDeleteBtn(a),
          ));
        } else {
          // Non-image attachment: unchanged row.
          attList.appendChild(h('div', {
            style: {
              display: 'flex', gap: '8px', alignItems: 'center',
              background: 'var(--bg-3)', border: '1px solid var(--line)', borderRadius: '8px', padding: '8px 10px',
            },
          },
            Icon('paperclip', 13),
            h('a', {
              href: a.download_url,
              style: { color: 'var(--fg-1)', fontSize: '12.5px', textDecoration: 'none', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: a.name,
            }, a.name),
            h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)' } }, formatBytes(a.size)),
            attDeleteBtn(a),
          ));
        }
      });
    } else if (attachments && attachments.length === 0) {
      attList.appendChild(h('div', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'No attachments yet.'));
    }
    attSection.appendChild(attList);

    if (canWrite) {
      const fileInput = h('input', {
        type: 'file',
        style: { display: 'none' },
        onChange: async (e) => {
          const file = e.target.files && e.target.files[0];
          if (!file) return;
          uploadingAttachment = true;
          redraw();
          try {
            const r = await API.uploadAttachment(task.id, file);
            attachments = attachments || [];
            attachments.unshift(r.attachment);
            window._pmAttachmentsCache[task.id] = attachments;
            task.attachments = (task.attachments || 0) + 1;
            toast('Attachment uploaded', 'success');
          } catch (err) {
            toast('Upload failed: ' + err.message, 'error');
          } finally {
            uploadingAttachment = false;
            e.target.value = '';
            redraw();
          }
        },
      });
      attSection.appendChild(fileInput);
      attSection.appendChild(h('div', { style: { marginTop: '10px' } },
        h('button', {
          class: 'btn btn-ghost',
          disabled: uploadingAttachment,
          onClick: () => fileInput.click(),
        }, Icon('plus', 12), uploadingAttachment ? ' Uploading…' : ' Upload file'),
      ));
    }
    body.appendChild(attSection);

    // Comments
    const cmtSection = h('div', { style: { marginTop: '24px' } });
    cmtSection.appendChild(h('div', {
      style: { fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600', marginBottom: '10px' }
    }, `Comments · ${comments == null ? '…' : comments.length}`));

    const list = h('div', { style: { display: 'grid', gap: '12px' } });
    if (comments) {
      for (const c of comments) {
        const canModerate = canWrite && ((window.state.me?.is_admin) || (c.user?.id === window.state.me?.id));
        list.appendChild(h('div', { style: { display: 'flex', gap: '10px' } },
          Avatar(c.user, 28),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: '12.5px', color: 'var(--fg-1)', display: 'flex', alignItems: 'center', gap: '6px' } },
              h('span', { style: { fontWeight: 600 } }, c.user.name),
              h('span', { style: { color: 'var(--fg-3)', fontSize: '11.5px' } }, relTime(c.created_at)),
              c.updated_at ? h('span', { style: { color: 'var(--fg-4)', fontSize: '10.5px' } }, '(edited)') : null,
              canModerate ? h('button', { class: 'btn btn-ghost', style: { marginLeft: 'auto', fontSize: '11px', padding: '2px 6px' }, onClick: async () => {
                const next = await promptDialog({ title: 'Edit comment', value: c.body, multiline: true });
                if (next == null) return;
                if (!next.trim()) return toast('Comment cannot be empty', 'error');
                try {
                  const r = await API.updateComment(task.id, c.id, next.trim());
                  const idx = comments.findIndex(x => x.id === c.id);
                  if (idx >= 0) comments[idx] = r.comment;
                  cache.comments = comments;
                  redraw();
                } catch (e) { toast(e.message, 'error'); }
              } }, 'Edit') : null,
              canModerate ? h('button', { class: 'btn btn-ghost', style: { fontSize: '11px', padding: '2px 6px' }, onClick: async () => {
                const ok = await confirmDialog({ title: 'Delete this comment?', confirmText: 'Delete', danger: true });
                if (!ok) return;
                try {
                  await API.deleteComment(task.id, c.id);
                  comments = comments.filter(x => x.id !== c.id);
                  cache.comments = comments;
                  redraw();
                } catch (e) { toast(e.message, 'error'); }
              } }, 'Delete') : null,
            ),
            h('div', { style: { marginTop: '4px' } }, renderCommentBody(c)),
            // Reactions: interactive when writable; read-only display otherwise.
            canWrite
              ? emojiReactionBar(c.reactions || [], async (emoji) => {
                  const existing = (c.reactions || []).find(r => r.emoji === emoji);
                  try {
                    if (existing && existing.mine) await API.removeReaction(task.id, c.id, emoji);
                    else await API.addReaction(task.id, c.id, emoji);
                    await loadComments();
                  } catch (e) { toast(e.message, 'error'); }
                })
              : readonlyReactionBar(c.reactions || []),
          ),
        ));
      }
      if (!comments.length) list.appendChild(h('div', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'No comments yet.'));
    }
    cmtSection.appendChild(list);

    // New comment box (with @mention autocomplete) — writers only.
    if (canWrite) {
      const me = window.state.me;
      const submit = async () => {
        const v = (newCommentText || '').trim();
        if (!v) return;
        try {
          const r = await API.addComment(task.id, v);
          comments = comments || [];
          comments.push(r.comment);
          cache.comments = comments;
          newCommentText = '';
          // A new comment can add watchers / mentions server-side; refresh task +
          // notifications + the per-task activity timeline.
          refreshBoard();
          if (window.pmLoadNotifications) window.pmLoadNotifications();
          if (window.pmRefreshActivity) window.pmRefreshActivity();
          loadActivity();
          redraw();
        } catch(e){toast(e.message,'error');}
      };
      const composer = mentionTextarea({
        value: newCommentText,
        placeholder: 'Leave a comment… use @ to mention',
        onInput: v => { newCommentText = v; },
        onSubmit: submit,
      });
      cmtSection.appendChild(h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px' } },
        Avatar(me, 28),
        h('div', { style: { flex: 1, minWidth: 0 } },
          composer,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } },
            h('button', { class: 'btn btn-primary', style: { padding: '4px 10px', fontSize: '12px' }, onClick: submit }, 'Comment')),
        ),
      ));
    }
    body.appendChild(cmtSection);

    // Activity timeline
    const tlSection = h('div', { style: { marginTop: '24px' } });
    tlSection.appendChild(h('div', {
      style: { fontSize: '11px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600', marginBottom: '10px' }
    }, 'Activity'));
    const tl = h('div', { class: 'timeline' });
    if (activity == null) {
      tl.appendChild(h('div', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'Loading…'));
    } else if (!activity.length) {
      tl.appendChild(h('div', { style: { color: 'var(--fg-3)', fontSize: '12px' } }, 'No activity yet.'));
    } else {
      for (const a of activity) {
        tl.appendChild(h('div', { class: 'tl-row', style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } },
          Avatar(a.user, 22),
          h('div', { style: { flex: 1, minWidth: 0, fontSize: '12.5px', color: 'var(--fg-2)' } },
            h('span', { style: { fontWeight: 600, color: 'var(--fg-1)' } }, a.user?.name || 'Someone'),
            ' ',
            h('span', null, activityVerb(a.action)),
            a.detail ? h('span', { style: { color: 'var(--fg-3)' } }, ' — ' + a.detail) : null,
            h('span', { style: { color: 'var(--fg-4)', fontSize: '11px', marginLeft: '6px' } }, relTime(a.created_at)),
          ),
        ));
      }
    }
    tlSection.appendChild(tl);
    body.appendChild(tlSection);

    drawer.appendChild(body);
  }

  // ----- accessibility: focus trap + Escape + return focus -----
  const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  function onKey(e) {
    if (e.key === 'Escape') {
      // Defer to any overlay above the drawer. modal()/confirmDialog()/
      // promptDialog() handle Escape on a capture-phase document listener and
      // call preventDefault (so by the time this bubble handler runs the modal
      // is already gone but defaultPrevented is set). openPopover() closes on a
      // bubble listener AFTER this one, so it's still in the DOM here — detect
      // it directly. In either case, don't also close the drawer.
      if (e.defaultPrevented) return;
      if (document.querySelector('.popover') || document.querySelector('.modal')) return;
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    // If an inner control already handled Tab (e.g. the @mention autocomplete
    // accepting a match), don't also run the focus trap.
    if (e.defaultPrevented) return;
    const items = [...drawer.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !drawer.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !drawer.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }
  drawer.addEventListener('keydown', onKey);
  // Restore focus when the drawer leaves the DOM (close, delete, or re-render
  // replacing the root). renderApp() removes this node; a re-render of the same
  // open task immediately re-adds a fresh one, so only restore focus if nothing
  // re-mounted a drawer (i.e. it was actually closed).
  const mo = new MutationObserver(() => {
    if (!document.body.contains(drawer)) {
      mo.disconnect();
      setTimeout(() => {
        if (!document.querySelector('.drawer') && prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (_) {}
        }
      }, 0);
    }
  });
  setTimeout(() => { try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {} }, 0);

  redraw();
  // Move initial focus into the drawer for keyboard/screen-reader users — but
  // only on the first render of this open session. renderApp() re-creates the
  // drawer on every state change; re-grabbing focus then would yank it away
  // from whatever the user is editing.
  if (!cache._focused) {
    cache._focused = true;
    setTimeout(() => {
      if (!document.body.contains(drawer)) return;
      const f = drawer.querySelector(FOCUSABLE);
      (f || drawer).focus();
    }, 0);
  }
  return host;
}

// ---- custom field editor ----
// Renders an input appropriate to the field_type, seeded from task.custom.
// Saves via API.setCustomValue then mutates task.custom + refreshes the board.
function customFieldEditor(field, task, canWrite = true) {
  const cur = (task.custom && task.custom[field.id] != null) ? task.custom[field.id] : '';
  const baseStyle = { background: 'var(--bg-3)', border: '1px solid var(--line-2)', borderRadius: '6px', padding: '4px 8px', color: 'var(--fg-0)', fontSize: '12px', outline: 'none' };

  async function save(value) {
    if (!canWrite) return;
    const v = value == null ? '' : String(value);
    if (v === String(cur == null ? '' : cur)) return;
    try {
      await API.setCustomValue(task.id, field.id, v);
      task.custom = task.custom || {};
      if (v === '') delete task.custom[field.id];
      else task.custom[field.id] = v;
      if (window.pmRefreshTasks) window.pmRefreshTasks();
    } catch (e) { toast(e.message, 'error'); }
  }

  switch (field.field_type) {
    case 'number': {
      return h('input', { type: 'number', value: cur, disabled: !canWrite, style: { ...baseStyle, width: '120px' },
        onBlur: canWrite ? e => save(e.target.value) : null });
    }
    case 'date': {
      const btn = h('button', { class: 'chip', disabled: !canWrite, style: { fontSize: '11.5px', cursor: canWrite ? 'pointer' : 'default' } },
        cur ? parseISO(cur).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
            : h('span', { style: { color: 'var(--fg-3)' } }, canWrite ? 'Set date' : '—'));
      if (canWrite) btn.addEventListener('click', () => datePickerPopover(btn, cur || '', v => save(v || '')));
      return btn;
    }
    case 'checkbox': {
      const checked = cur === '1' || cur === 'true' || cur === true;
      const box = h('div', { style: { cursor: canWrite ? 'pointer' : 'default', display: 'inline-flex' },
        onClick: canWrite ? () => save(checked ? '' : '1') : null }, Checkbox(checked, 18));
      return box;
    }
    case 'select': {
      const opts = Array.isArray(field.options) ? field.options : [];
      const sel = h('select', { disabled: !canWrite, style: { ...baseStyle, width: 'auto' }, onChange: canWrite ? e => save(e.target.value) : null },
        h('option', { value: '' }, '—'),
        ...opts.map(o => h('option', { value: o, selected: String(cur) === String(o) }, o)),
      );
      return sel;
    }
    case 'user': {
      const u = userById(cur);
      const btn = h('button', { class: 'chip', disabled: !canWrite, style: { fontSize: '11.5px', cursor: canWrite ? 'pointer' : 'default' } },
        u ? h('span', { class: 'hstack', style: { gap: '6px' } }, Avatar(u, 18), u.name)
          : h('span', { style: { color: 'var(--fg-3)' } }, 'Unassigned'));
      if (canWrite) btn.addEventListener('click', () => {
        openPopover(btn, ({ close }) => {
          const wrap = h('div');
          wrap.appendChild(h('div', { class: 'popover-header' }, 'Select user'));
          wrap.appendChild(PopoverItem({ selected: !cur, onSelect: () => { save(''); close(); }, leading: Icon('x', 12), children: h('span', null, 'Unassigned') }));
          for (const usr of (window.state.users || [])) {
            wrap.appendChild(PopoverItem({
              selected: String(cur) === String(usr.id),
              onSelect: () => { save(usr.id); close(); },
              leading: Avatar(usr, 20),
              children: h('span', null, usr.name),
            }));
          }
          return wrap;
        });
      });
      return btn;
    }
    default: { // text
      return h('input', { type: 'text', value: cur, placeholder: '—', disabled: !canWrite, style: { ...baseStyle, width: '100%', maxWidth: '260px' },
        onBlur: canWrite ? e => save(e.target.value) : null });
    }
  }
}

// Human-readable verb for an activity action key.
function activityVerb(action) {
  const map = {
    created: 'created this task',
    moved: 'changed status',
    completed: 'completed this task',
    commented: 'commented',
    mention: 'mentioned someone',
    updated: 'updated this task',
    deleted: 'deleted this task',
    recurring_spawn: 'generated this from a recurring rule',
  };
  return map[action] || (action || 'updated').replace(/_/g, ' ');
}

function PropLabel(icon, text) {
  return h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--fg-3)', fontSize: '12px', fontWeight: '500' }
  }, Icon(icon, 13), text);
}

// Read-only reaction display for viewers (no add button, no toggling). Mirrors
// the chip markup of ui.js's emojiReactionBar so it stays visually consistent.
function readonlyReactionBar(reactions = []) {
  const row = h('div', { class: 'reaction-bar hstack', style: { gap: '4px', flexWrap: 'wrap', alignItems: 'center' } });
  for (const r of reactions) {
    if (!r || !r.count) continue;
    row.appendChild(h('span', { class: 'reaction' + (r.mine ? ' mine' : ''), style: { cursor: 'default' } },
      h('span', null, r.emoji), h('span', { class: 'reaction-count' }, String(r.count))));
  }
  return row;
}

function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = Math.max(0, Number(n) || 0);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// True for image attachments we can preview inline. SVG is excluded — the
// backend never serves it inline (it forces octet-stream), and it carries an
// XSS surface, so it stays a plain download row like other files.
function isImageAttachment(a) {
  const m = String((a && a.mime) || '').toLowerCase();
  return m.startsWith('image/') && m !== 'image/svg+xml';
}

// Full-screen lightbox for image attachments. `images` is the ordered list of
// previewable attachments; `startIndex` is the one that was clicked. Closes on
// overlay click, the close button, and Escape; restores focus to whatever was
// focused before it opened. Prev/next cycle through `images`.
function openAttachmentLightbox(images, startIndex) {
  if (!Array.isArray(images) || !images.length) return;
  let i = Math.max(0, Math.min(startIndex || 0, images.length - 1));
  const prevFocus = document.activeElement;

  const scrim = h('div', {
    class: 'scrim',
    style: { zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    onClick: (e) => { if (e.target === scrim) close(); },
  });

  const dialog = h('div', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image preview', tabindex: '-1',
    style: {
      position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: '10px', maxWidth: '92vw', maxHeight: '92vh',
    },
  });

  const img = h('img', {
    alt: '',
    style: {
      maxWidth: '92vw', maxHeight: '78vh', objectFit: 'contain',
      borderRadius: '8px', background: 'var(--bg-4)', boxShadow: '0 10px 40px rgba(0,0,0,0.45)',
    },
  });

  const caption = h('a', {
    target: '_blank', rel: 'noopener',
    style: { color: 'var(--fg-1)', fontSize: '13px', textDecoration: 'none', maxWidth: '80vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  });

  const counter = h('span', { style: { color: 'var(--fg-3)', fontSize: '12px' } });

  const downloadLink = h('a', {
    class: 'btn btn-ghost', style: { fontSize: '12px' },
  }, Icon('download', 13), ' Download');

  const closeBtn = h('button', {
    class: 'icon-btn', title: 'Close', 'aria-label': 'Close preview',
    style: { position: 'absolute', top: '-6px', right: '-6px', background: 'var(--bg-2)', borderRadius: '999px' },
    onClick: close,
  }, Icon('x', 16));

  const multi = images.length > 1;
  const prevBtn = multi ? h('button', {
    class: 'icon-btn', title: 'Previous image', 'aria-label': 'Previous image',
    style: { background: 'var(--bg-2)', borderRadius: '999px' },
    onClick: () => { i = (i - 1 + images.length) % images.length; show(); },
  }, Icon('chevronLeft', 18)) : null;
  const nextBtn = multi ? h('button', {
    class: 'icon-btn', title: 'Next image', 'aria-label': 'Next image',
    style: { background: 'var(--bg-2)', borderRadius: '999px' },
    onClick: () => { i = (i + 1) % images.length; show(); },
  }, Icon('chevronRight', 18)) : null;

  const stage = h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
    prevBtn, img, nextBtn);

  const bar = h('div', { class: 'hstack', style: { gap: '12px', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' } },
    caption, multi ? counter : null, downloadLink);

  dialog.appendChild(closeBtn);
  dialog.appendChild(stage);
  dialog.appendChild(bar);
  scrim.appendChild(dialog);

  function show() {
    const a = images[i];
    img.src = `api/attachments.php?id=${a.id}&inline=1`;
    img.alt = a.name || 'Image attachment';
    caption.textContent = a.name || 'Image';
    caption.href = `api/attachments.php?id=${a.id}&inline=1`;
    downloadLink.href = `api/attachments.php?id=${a.id}&download=1`;
    downloadLink.setAttribute('download', a.name || '');
    if (multi) counter.textContent = `${i + 1} / ${images.length}`;
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (multi && e.key === 'ArrowLeft') { e.preventDefault(); i = (i - 1 + images.length) % images.length; show(); return; }
    if (multi && e.key === 'ArrowRight') { e.preventDefault(); i = (i + 1) % images.length; show(); return; }
    if (e.key === 'Tab') {
      // Minimal focus trap: keep Tab within the dialog.
      const items = [...dialog.querySelectorAll('a[href], button:not([disabled])')].filter(el => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) { e.preventDefault(); last.focus(); }
      } else {
        if (active === last || !dialog.contains(active)) { e.preventDefault(); first.focus(); }
      }
    }
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') { try { prevFocus.focus(); } catch (_) {} }
  }

  // Capture phase so Escape closes the lightbox before the drawer's own handler.
  document.addEventListener('keydown', onKey, true);
  show();
  document.body.appendChild(scrim);
  setTimeout(() => { try { (closeBtn || dialog).focus(); } catch (_) {} }, 0);
}

window.renderTaskDetail = renderTaskDetail;
