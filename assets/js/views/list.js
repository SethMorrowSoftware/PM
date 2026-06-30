// List / table view grouped by status/project/assignee.
// View-local UI state (grouping/sort/collapsed/selected) lives in
// window.state.ui.list so it survives full re-renders (renderApp replaces root).
function renderList(tasks, handlers) {
  const { onOpenTask, onAddTask, onToggleStatus, onBulkLabels, onBulkUpdate, onReorder } = handlers;
  const root = h('div', { style: { padding: '16px 20px' } });

  // ---- persistent view state (lifted to window.state.ui.list) ----
  const ui = (window.state.ui = window.state.ui || {});
  const ls = (ui.list = ui.list || {});
  ls.groupBy = ls.groupBy || 'status';
  ls.sortBy = ls.sortBy || 'priority';
  ls.sortDir = ls.sortDir || 'asc';
  ls.collapsed = ls.collapsed || {};
  if (!Array.isArray(ls.selected)) ls.selected = [];

  // selection helpers operate on the persistent array
  const selSet = () => new Set(ls.selected);
  const isSelected = (id) => ls.selected.includes(id);
  const setSelected = (id, on) => {
    const s = selSet();
    if (on) s.add(id); else s.delete(id);
    ls.selected = [...s];
  };
  const clearSelection = () => { ls.selected = []; };
  let lastClickedId = null; // for shift-range select (within a redraw lifecycle)

  // Save a single inline edit. window.pmUpdateTask doesn't exist in this build,
  // so go through API.updateTask + the global refresh the lead exposes.
  function saveTask(id, patch) {
    const p = window.pmUpdateTask
      ? window.pmUpdateTask(id, patch)
      : API.updateTask(id, patch).then(() => window.pmRefreshTasks && window.pmRefreshTasks());
    return Promise.resolve(p).catch(err => toast(err.message || 'Update failed', 'error'));
  }

  function redraw() {
    root.replaceChildren();

    // ---------- toolbar: grouping / sort / sort-dir / bulk bar ----------
    const toolbar = h('div', { style: { display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap', alignItems: 'center' } },
      Segmented('Group by', ls.groupBy, v => { ls.groupBy = v; redraw(); },
        [['status', 'Status'], ['project', 'Project'], ['assignee', 'Assignee']]),
      Segmented('Sort', ls.sortBy, v => { ls.sortBy = v; redraw(); },
        [['priority', 'Priority'], ['due', 'Due'], ['title', 'Title']]),
      h('button', {
        class: 'btn btn-muted', title: ls.sortDir === 'asc' ? 'Ascending' : 'Descending',
        style: { padding: '5px 9px', fontSize: '12px' },
        onClick: () => { ls.sortDir = ls.sortDir === 'asc' ? 'desc' : 'asc'; redraw(); },
      }, Icon('sort', 13), ls.sortDir === 'asc' ? ' Asc' : ' Desc'),
    );

    if (ls.selected.length) toolbar.appendChild(bulkBar());
    root.appendChild(toolbar);

    // ---------- build groups ----------
    let groups = [];
    if (ls.groupBy === 'status') {
      groups = STATUSES.map(s => ({ key: s.id, title: s.name, color: s.color,
        tasks: tasks.filter(t => t.status === s.id) }));
    } else if (ls.groupBy === 'project') {
      groups = window.state.projects.map(p => ({ key: 'p' + p.id, title: p.name, color: p.color,
        tasks: tasks.filter(t => t.project == p.id) }));
    } else {
      groups = window.state.users.map(u => ({ key: 'u' + u.id, title: u.name, color: u.color,
        tasks: tasks.filter(t => t.assignees.includes(u.id)) }));
    }

    const dir = ls.sortDir === 'desc' ? -1 : 1;
    groups.forEach(g => g.tasks.sort((a, b) => {
      let r = 0;
      if (ls.sortBy === 'priority') r = a.priority - b.priority;
      else if (ls.sortBy === 'due') r = new Date(a.due || '9999') - new Date(b.due || '9999');
      else if (ls.sortBy === 'title') r = a.title.localeCompare(b.title);
      return r * dir;
    }));
    groups = groups.filter(g => g.tasks.length);

    if (!groups.length) {
      root.appendChild(h('div', {
        class: 'empty empty-cta',
        style: { marginTop: '10px', padding: '28px 22px', border: '1px dashed var(--line-2)', borderRadius: '10px' },
      },
      h('div', { style: { fontWeight: '600', marginBottom: '4px' } }, 'No matching tasks'),
      h('div', { style: { color: 'var(--fg-2)' } }, 'Try clearing filters or create a new task.')));
      return;
    }

    // visible task ids in display order (for shift-range select)
    const visibleIds = [];
    groups.forEach(g => { if (!ls.collapsed[g.key]) g.tasks.forEach(t => visibleIds.push(t.id)); });

    // select-all only governs writable rows: bulk actions mutate, and the server
    // would 403 read-only tasks, so don't auto-select them (avoids silent failures).
    const writable = (t) => t.can_write !== false;
    const selectableIds = [];
    groups.forEach(g => { if (!ls.collapsed[g.key]) g.tasks.forEach(t => { if (writable(t)) selectableIds.push(t.id); }); });

    // select-all reflects the currently visible (expanded) writable rows
    const allSelected = selectableIds.length > 0 && selectableIds.every(id => isSelected(id));
    const someSelected = selectableIds.some(id => isSelected(id));

    const selectAll = h('input', {
      type: 'checkbox', checked: allSelected, title: 'Select all',
      disabled: selectableIds.length === 0,
      onClick: e => e.stopPropagation(),
      onChange: e => {
        if (e.target.checked) { const s = selSet(); selectableIds.forEach(id => s.add(id)); ls.selected = [...s]; }
        else { const s = selSet(); selectableIds.forEach(id => s.delete(id)); ls.selected = [...s]; }
        redraw();
      },
    });
    if (selectAll instanceof HTMLInputElement) selectAll.indeterminate = !allSelected && someSelected;

    const tbl = h('div', { class: 'list-wrap' },
      h('div', { class: 'list-header' },
        h('div', { class: 'col-check' }, selectAll),
        h('div', { class: 'col-id' }, 'ID'),
        h('div', { class: 'col-title' }, 'Task'),
        h('div', { class: 'col-labels' }, 'Labels'),
        h('div', { class: 'col-assignees' }, 'Assignees'),
        h('div', { class: 'col-due' }, 'Due'),
        h('div', { class: 'col-priority' }, 'Priority'),
        h('div', { class: 'col-progress' }, 'Progress'),
        h('div', { class: 'col-actions' }),
      )
    );

    for (const g of groups) {
      const isCollapsed = !!ls.collapsed[g.key];
      tbl.appendChild(groupHead(g, isCollapsed));
      if (isCollapsed) continue;

      const rowEls = [];
      for (const t of g.tasks) {
        const rowEl = ListRow(t, {
          onOpen: onOpenTask,
          onToggleStatus,
          selected: isSelected(t.id),
          onSelect: (on, ev) => {
            if (ev && ev.shiftKey && lastClickedId != null) {
              const a = visibleIds.indexOf(lastClickedId);
              const b = visibleIds.indexOf(t.id);
              if (a > -1 && b > -1) {
                const [lo, hi] = a < b ? [a, b] : [b, a];
                const s = selSet();
                for (let i = lo; i <= hi; i++) s.add(visibleIds[i]);
                ls.selected = [...s];
                lastClickedId = t.id;
                redraw();
                return;
              }
            }
            setSelected(t.id, on);
            lastClickedId = t.id;
            redraw();
          },
          saveTask,
        });
        rowEls.push(rowEl);
        tbl.appendChild(rowEl);
      }
      wireReorder(g, rowEls);
    }

    root.appendChild(tbl);
  }

  // ---------- bulk action bar ----------
  function bulkBar() {
    const mk = (label, onClick) => h('button', {
      class: 'btn btn-ghost', style: { padding: '4px 8px', fontSize: '12px' }, onClick,
    }, label);
    return h('div', { class: 'hstack', style: {
      marginLeft: 'auto', gap: '6px', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: '8px', padding: '3px 6px',
    } },
      h('span', { style: { fontSize: '12px', color: 'var(--fg-2)', marginRight: '4px' } }, `${ls.selected.length} selected`),
      mk('Add label', (e) => {
        openPopover(e.currentTarget, ({ close }) => labelPickerContent([], lid => {
          onBulkLabels?.([...ls.selected], [lid], 'add')
            .then(() => { close(); clearSelection(); redraw(); })
            .catch(err => toast(err.message || 'Bulk update failed', 'error'));
        }, close, { keepOpen: true, onCreateLabel: window.pmCreateLabelFromPicker }));
      }),
      mk('Remove label', (e) => {
        openPopover(e.currentTarget, ({ close }) => labelPickerContent([], lid => {
          onBulkLabels?.([...ls.selected], [lid], 'remove')
            .then(() => { close(); clearSelection(); redraw(); })
            .catch(err => toast(err.message || 'Bulk update failed', 'error'));
        }, close, { keepOpen: true }));
      }),
      mk('Mark done', async () => {
        try { await onBulkUpdate?.([...ls.selected], { status: 'done' }, 'Marked done'); clearSelection(); redraw(); }
        catch (err) { toast(err.message || 'Bulk update failed', 'error'); }
      }),
      h('button', {
        class: 'btn btn-ghost', style: { padding: '4px 8px', fontSize: '12px' },
        onClick: (e) => {
          datePickerPopover(e.currentTarget, '', async (val) => {
            try { await onBulkUpdate?.([...ls.selected], { due: val || null }, 'Updated due date'); clearSelection(); redraw(); }
            catch (err) { toast(err.message || 'Bulk update failed', 'error'); }
          });
        },
      }, 'Set due'),
      mk('Clear', () => { clearSelection(); redraw(); }),
    );
  }

  // ---------- group header ----------
  function groupHead(g, isCollapsed) {
    return h('div', { class: 'list-group-head',
      onClick: () => { ls.collapsed[g.key] = !isCollapsed; redraw(); } },
      h('span', { style: { display: 'inline-flex', color: 'var(--fg-3)', transform: isCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' } },
        Icon('chevronDown', 12)),
      h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: g.color } }),
      h('span', { style: { fontSize: '12.5px', fontWeight: '600' } }, g.title),
      h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)', background: 'var(--bg-3)', padding: '1px 6px', borderRadius: '4px' } }, String(g.tasks.length)),
      h('button', { class: 'btn btn-muted', style: { marginLeft: 'auto', padding: '3px 8px', fontSize: '11.5px' },
        onClick: (e) => {
          e.stopPropagation();
          const statusId = ls.groupBy === 'status' ? g.key : undefined;
          const projectId = ls.groupBy === 'project' ? parseInt(String(g.key).slice(1), 10) : undefined;
          const assigneeId = ls.groupBy === 'assignee' ? parseInt(String(g.key).slice(1), 10) : undefined;
          onAddTask(statusId, { projectId, assigneeId });
        } },
        Icon('plus', 11), ' Add'),
    );
  }

  // ---------- drag-to-reorder within a group ----------
  // Computes a fractional position between neighbors and persists via onReorder.
  // When grouped by status, dropping also carries the group's status.
  function wireReorder(g, rowEls) {
    if (!onReorder || rowEls.length < 2) return;
    const groupStatus = ls.groupBy === 'status' ? g.key : undefined;

    rowEls.forEach((rowEl) => {
      // Read-only rows have no grip (and must not reorder — server would 403).
      const grip = rowEl.querySelector('.row-grip');
      if (!grip) return;
      makeDraggable(rowEl, {
        handle: grip,
        onStart: () => rowEl.classList.add('dragging'),
        onMove: (e) => {
          const over = document.elementFromPoint(e.clientX, e.clientY);
          const overRow = over && over.closest ? over.closest('.list-row') : null;
          if (overRow && overRow !== rowEl && rowEls.includes(overRow)) {
            const rect = overRow.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            overRow.parentNode.insertBefore(rowEl, after ? overRow.nextSibling : overRow);
          }
        },
        onDrop: () => {
          rowEl.classList.remove('dragging');
          // recompute order from the DOM, find new index of dragged row
          const ordered = rowEls.slice().sort((a, b) =>
            (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
          const idx = ordered.indexOf(rowEl);
          const id = Number(rowEl.dataset.id);
          const prev = ordered[idx - 1];
          const next = ordered[idx + 1];
          const prevPos = prev ? Number(g.tasks.find(t => t.id === Number(prev.dataset.id))?.position || 0) : null;
          const nextPos = next ? Number(g.tasks.find(t => t.id === Number(next.dataset.id))?.position || 0) : null;
          let position;
          if (prevPos != null && nextPos != null) position = (prevPos + nextPos) / 2;
          else if (prevPos != null) position = prevPos + 1;
          else if (nextPos != null) position = nextPos - 1;
          else position = 0;
          const patch = { position };
          if (groupStatus) patch.status = groupStatus;
          Promise.resolve(onReorder(id, patch)).catch(err => {
            toast(err.message || 'Reorder failed', 'error');
            redraw();
          });
        },
      });
    });
  }

  redraw();
  return root;
}

function Segmented(label, value, onChange, options) {
  const wrap = h('div', { class: 'segmented' },
    h('span', { class: 'segmented-label' }, label),
  );
  for (const [v, l] of options) {
    wrap.appendChild(h('button', {
      class: value === v ? 'active' : '',
      onClick: () => onChange(v),
    }, l));
  }
  return wrap;
}

// Milestone picker (modeled on statusPickerContent), filtered to the row's project.
function milestonePickerContent(task, value, onChange, close) {
  const wrap = h('div');
  wrap.appendChild(h('div', { class: 'popover-header' }, 'Milestone'));
  const all = window.state.milestones || [];
  const list = all.filter(m => m.project_id == null || m.project_id == task.project);
  wrap.appendChild(PopoverItem({
    selected: value == null,
    onSelect: () => { onChange(null); close(); },
    leading: h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: 'var(--fg-4)' } }),
    children: h('span', { style: { color: 'var(--fg-2)' } }, 'No milestone'),
  }));
  for (const m of list) {
    wrap.appendChild(PopoverItem({
      selected: value == m.id,
      onSelect: () => { onChange(m.id); close(); },
      leading: Icon('target', 13),
      children: h('span', null, m.name),
    }));
  }
  if (!list.length) wrap.appendChild(h('div', { class: 'empty', style: { padding: '10px', fontSize: '12px' } }, 'No milestones for this project'));
  return wrap;
}

function ListRow(task, { onOpen, onToggleStatus, selected = false, onSelect, saveTask } = {}) {
  const proj = projectById(task.project);
  const sub = task.subtasks || [];
  const subDone = sub.filter(s => s.done).length;
  const pct = sub.length ? (subDone / sub.length) * 100 : (task.status === 'done' ? 100 : 0);
  const done = task.status === 'done';
  // Viewer in a private project: read-only. Default (undefined/true) = full access.
  const canWrite = task.can_write !== false;

  const row = h('div', {
    class: 'list-row' + (done ? ' done' : '') + (canWrite ? '' : ' readonly'),
    tabindex: '0', role: 'row', dataset: { id: String(task.id) },
    'aria-readonly': canWrite ? null : 'true',
    onClick: () => onOpen(task.id),
    onKeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOpen(task.id); }
      else if (e.key === ' ') { e.preventDefault(); onSelect?.(!selected, e); }
    },
  });

  // helper: open a picker anchored on the clicked cell without opening the task.
  // Read-only rows render the same cell content but never wire the picker.
  const cell = (cls, child, openPicker) => {
    const c = h('div', { class: cls });
    if (openPicker && canWrite) {
      c.style.cursor = 'pointer';
      c.addEventListener('click', (e) => { e.stopPropagation(); openPicker(c); });
    }
    if (child) appendChildren(c, [child]);
    return c;
  };

  // ----- check cell: drag grip + selection checkbox + status toggle -----
  // The grip is omitted entirely when read-only so wireReorder skips the row.
  const checkCell = h('div', { class: 'col-check hstack', style: { gap: '6px' }, onClick: (e) => e.stopPropagation() },
    canWrite
      ? h('span', { class: 'row-grip', title: 'Drag to reorder',
          style: { display: 'inline-flex', color: 'var(--fg-4)', cursor: 'grab' },
          onClick: (e) => e.stopPropagation() }, Icon('grip', 13))
      : h('span', { style: { display: 'inline-flex', width: '13px' } }),
    h('input', {
      type: 'checkbox', checked: selected,
      onClick: e => e.stopPropagation(),
      onChange: e => onSelect?.(!!e.target.checked, e),
    }),
    canWrite
      ? h('div', { title: 'Toggle done', onClick: (e) => { e.stopPropagation(); onToggleStatus(task.id); } }, Checkbox(done))
      : h('div', { title: done ? 'Done' : 'Not done', style: { display: 'inline-flex', cursor: 'default' }, onClick: (e) => e.stopPropagation() }, Checkbox(done)),
  );
  row.appendChild(checkCell);

  // ----- id cell (status pill click-to-edit lives here as a tooltip-ish dot) -----
  row.appendChild(cell('col-id mono', h('span', { style: { fontSize: '11px', color: 'var(--fg-3)' } }, task.ref),
    (anchor) => openPopover(anchor, ({ close }) =>
      statusPickerContent(task.status, (s) => saveTask(task.id, { status: s }), close))));

  // ----- title cell (project dot + title) -----
  const titleCell = h('div', { class: 'col-title', style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } });
  if (proj) titleCell.appendChild(h('span', {
    title: proj.name,
    style: { width: '6px', height: '6px', borderRadius: '2px', background: proj.color, flexShrink: 0 },
  }));
  titleCell.appendChild(h('span', {
    class: 'title',
    style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '500' },
  }, task.title));
  if (task.milestone_id != null) {
    const ms = (window.state.milestones || []).find(m => m.id == task.milestone_id);
    if (ms) titleCell.appendChild(h('span', { class: 'hstack', title: 'Milestone: ' + ms.name,
      style: { gap: '3px', fontSize: '10.5px', color: 'var(--fg-3)', flexShrink: 0 } }, Icon('target', 11)));
  }
  row.appendChild(titleCell);

  // ----- labels cell (+ milestone picker on click) -----
  const labelsInner = h('div', { class: 'hstack', style: { gap: '3px', flexWrap: 'wrap' } });
  task.labels.slice(0, 2).forEach(l => labelsInner.appendChild(Tag(l, true)));
  if (task.labels.length > 2) labelsInner.appendChild(h('span', { style: { fontSize: '10.5px', color: 'var(--fg-3)' } }, '+' + (task.labels.length - 2)));
  if (!task.labels.length) labelsInner.appendChild(h('span', { style: { fontSize: '11px', color: 'var(--fg-4)' } }, '—'));
  if (task.comments > 0) labelsInner.appendChild(h('span', {
    class: 'hstack', title: task.comments + ' comment' + (task.comments === 1 ? '' : 's'),
    style: { gap: '3px', fontSize: '10.5px', color: 'var(--fg-3)' },
  }, Icon('message', 11), String(task.comments)));
  row.appendChild(cell('col-labels', labelsInner, (anchor) => openPopover(anchor, ({ close }) =>
    labelPickerContent(task.labels || [], (lid) => {
      const next = new Set(task.labels || []);
      if (next.has(lid)) next.delete(lid); else next.add(lid);
      saveTask(task.id, { labels: [...next] });
    }, close, { keepOpen: true, scopeProjectId: task.project, onCreateLabel: window.pmCreateLabelFromPicker }))));

  // ----- assignees cell -----
  row.appendChild(cell('col-assignees', AvatarStack(task.assignees, 3, 22), (anchor) =>
    openPopover(anchor, ({ close }) => assigneePickerContent(task.assignees || [], (uid) => {
      const next = new Set(task.assignees || []);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      saveTask(task.id, { assignees: [...next] });
    }, close))));

  // ----- due cell (date picker) -----
  row.appendChild(cell('col-due', task.due ? DueDate(task.due) : h('span', { style: { fontSize: '11px', color: 'var(--fg-4)' } }, 'No due'),
    (anchor) => datePickerPopover(anchor, task.due || '', (val) => saveTask(task.id, { due: val || null }))));

  // ----- priority cell -----
  row.appendChild(cell('col-priority', PriorityFlag(task.priority, true), (anchor) =>
    openPopover(anchor, ({ close }) => priorityPickerContent(task.priority, (p) => saveTask(task.id, { priority: p }), close))));

  // ----- progress cell -----
  row.appendChild(h('div', { class: 'col-progress', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
    h('div', { style: { flex: 1, height: '4px', background: 'var(--bg-4)', borderRadius: '2px', overflow: 'hidden' } },
      h('div', { style: { width: pct + '%', height: '100%', background: pct === 100 ? 'var(--green)' : 'var(--acc-0)', transition: 'width 0.3s' } }))));

  // ----- actions cell: more menu -----
  row.appendChild(h('div', { class: 'col-actions', style: { textAlign: 'right' } },
    h('button', {
      class: 'icon-btn sm', title: 'More',
      onClick: (e) => { e.stopPropagation(); openMoreMenu(e.currentTarget, task, saveTask, onOpen, canWrite); },
    }, Icon('more', 14))));

  return row;
}

// Per-row "more" menu: open, watch/unwatch, milestone, delete.
// On read-only rows (canWrite === false) the mutating items (set milestone,
// delete) are hidden; non-mutating ones (open, watch) stay.
function openMoreMenu(anchor, task, saveTask, onOpen, canWrite = true) {
  const me = window.state.me && window.state.me.id;
  const watching = Array.isArray(task.watchers) && me != null && task.watchers.includes(me);
  openPopover(anchor, ({ close }) => {
    const wrap = h('div');
    wrap.appendChild(PopoverItem({
      onSelect: () => { close(); onOpen(task.id); },
      leading: Icon('eye', 14), children: h('span', null, 'Open task'),
    }));
    if (canWrite) wrap.appendChild(PopoverItem({
      onSelect: () => { close(); openPopover(anchor, ({ close: c2 }) =>
        milestonePickerContent(task, task.milestone_id ?? null, (mid) => saveTask(task.id, { milestone_id: mid }), c2)); },
      leading: Icon('target', 14), children: h('span', null, 'Set milestone'),
    }));
    wrap.appendChild(PopoverItem({
      onSelect: async () => {
        close();
        try {
          if (watching) await API.unwatchTask(task.id); else await API.watchTask(task.id);
          window.pmRefreshTasks && window.pmRefreshTasks();
        } catch (err) { toast(err.message || 'Failed', 'error'); }
      },
      leading: Icon(watching ? 'bellOff' : 'eye', 14),
      children: h('span', null, watching ? 'Unwatch' : 'Watch'),
    }));
    if (canWrite) wrap.appendChild(PopoverItem({
      onSelect: async () => {
        close();
        const ok = await confirmDialog({
          title: 'Delete task?', message: `Delete “${task.title}”? This can't be undone.`,
          confirmText: 'Delete', danger: true,
        });
        if (!ok) return;
        try { await API.deleteTask(task.id); window.pmRefreshTasks && window.pmRefreshTasks(); }
        catch (err) { toast(err.message || 'Delete failed', 'error'); }
      },
      leading: Icon('trash', 14),
      children: h('span', { style: { color: 'var(--red-fg, #FCA5A5)' } }, 'Delete'),
    }));
    return wrap;
  }, { align: 'end' });
}

window.renderList = renderList;
