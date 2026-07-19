// Goals / OKRs view. Read-only for everyone; create/edit/delete is admin-only
// (window.state.me.is_admin) and the server enforces that regardless. The view
// owns its local model and redraws itself in place via redraw(), mirroring the
// self-contained pattern used by renderAdminExtras() — goals live on their own
// endpoint, not in window.state, so we fetch + cache them here and re-fetch
// after every write.
//
// Reuses native atoms/classes so it looks at home: h, Icon, Avatar, DueDate,
// confirmDialog, toast, projectById, userById, plus the settings-form /
// settings-list / btn / pill / empty classes from the admin modal. Status →
// theme CSS vars (never hardcoded hex) so it tracks light/dark.
function renderGoals(tasks, handlers) {
  // Status → { label, fg var, soft fill var }. Done maps to the accent so a
  // completed goal reads "achieved", distinct from an on-track-but-open one.
  const STATUS_META = {
    on_track: { label: 'On track',  fg: 'var(--green)', soft: 'var(--green-soft)' },
    at_risk:  { label: 'At risk',   fg: 'var(--amber)', soft: 'var(--amber-soft)' },
    off_track:{ label: 'Off track', fg: 'var(--red)',   soft: 'var(--red-soft)' },
    done:     { label: 'Achieved',  fg: 'var(--acc-0)', soft: 'rgba(59,130,246,0.14)' },
  };
  const STATUS_ORDER = ['on_track', 'at_risk', 'off_track', 'done'];

  const model = {
    loading: true,
    err: '',
    saving: false,
    goals: [],
    formOpen: false,
    expanded: new Set(),   // goal ids whose description is shown
    form: blankForm(),
  };

  function blankForm() {
    return {
      id: null, name: '', description: '', due: '',
      status: 'on_track', owner_id: '', progress_mode: 'auto',
      manual_pct: 0, project_ids: [],
    };
  }

  const isAdmin = () => !!window.state.me?.is_admin;

  const root = h('div', { class: 'goals-wrap', style: { padding: '24px', display: 'grid', gap: '20px' } });

  // ---------- data ----------
  async function refresh() {
    model.loading = true;
    redraw();
    try {
      const r = await API.listGoals();
      model.goals = r.goals || [];
      model.err = '';
    } catch (e) {
      model.err = e.message || 'Failed to load goals';
      toast(model.err, 'error');
    } finally {
      model.loading = false;
    }
    redraw();
  }

  function resetForm(goal = null) {
    model.err = '';
    const f = model.form;
    f.id = goal?.id ?? null;
    f.name = goal?.name ?? '';
    f.description = goal?.description ?? '';
    f.due = goal?.due ?? '';
    f.status = goal?.status ?? 'on_track';
    f.owner_id = goal?.owner_id != null ? String(goal.owner_id) : '';
    f.progress_mode = goal?.progress_mode ?? 'auto';
    f.manual_pct = goal?.manual_pct != null ? Number(goal.manual_pct) : 0;
    f.project_ids = Array.isArray(goal?.project_ids) ? goal.project_ids.map(Number) : [];
  }

  function openForm(goal = null) {
    resetForm(goal);
    model.formOpen = true;
    redraw();
  }
  function closeForm() {
    model.formOpen = false;
    resetForm();
    redraw();
  }

  async function saveGoal() {
    const f = model.form;
    const name = (f.name || '').trim();
    if (!name) { model.err = 'Name is required'; redraw(); return; }
    let pct = Math.round(Number(f.manual_pct) || 0);
    pct = Math.max(0, Math.min(100, pct));
    const payload = {
      name,
      description: (f.description || '').trim(),
      due: f.due || null,
      status: f.status,
      owner_id: f.owner_id === '' ? null : Number(f.owner_id),
      progress_mode: f.progress_mode,
      manual_pct: pct,
      project_ids: f.project_ids.slice(),
    };
    model.saving = true;
    model.err = '';
    redraw();
    try {
      if (f.id) await API.updateGoal(f.id, payload);
      else await API.createGoal(payload);
      model.formOpen = false;
      resetForm();
      await refresh();
      toast(f.id ? 'Goal updated' : 'Goal created', 'success');
    } catch (e) {
      model.err = e.message || 'Failed to save goal';
      toast(model.err, 'error');
    } finally {
      model.saving = false;
      redraw();
    }
  }

  async function deleteGoal(goal) {
    const ok = await confirmDialog({
      title: 'Delete goal?',
      message: `“${goal.name}” will be removed. Linked tasks keep their data.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteGoal(goal.id);
      if (model.form.id === goal.id) { model.formOpen = false; resetForm(); }
      model.expanded.delete(goal.id);
      await refresh();
      toast('Goal deleted', 'success');
    } catch (e) {
      toast(e.message || 'Failed to delete goal', 'error');
    }
  }

  // ---------- pieces ----------
  function statusMeta(status) { return STATUS_META[status] || STATUS_META.on_track; }

  function StatusBadge(status) {
    const m = statusMeta(status);
    return h('span', {
      class: 'pill',
      style: {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        background: m.soft, color: m.fg,
        border: '1px solid transparent', fontWeight: '600',
      },
    },
      h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', background: m.fg } }),
      m.label);
  }

  // Inline-SVG progress ring, tinted to the goal's status colour. Mirrors the
  // CompletionRing pattern in checklist.js but parameterised on colour + size.
  function ProgressRing(pct, color, size = 56) {
    const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
    const sw = 5;
    const r = (size - sw) / 2;
    const c = 2 * Math.PI * r;
    const cx = size / 2;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${p}% complete`);
    svg.innerHTML = `
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="var(--bg-4)" stroke-width="${sw}"/>
      <circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}"
        stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"
        stroke-linecap="round" transform="rotate(-90 ${cx} ${cx})" style="transition:stroke-dashoffset 0.5s"/>
      <text x="${cx}" y="${cx + 4}" text-anchor="middle" font-size="${Math.round(size * 0.26)}" font-weight="700" fill="var(--fg-0)">${p}%</text>`;
    return svg;
  }

  function ProjectChips(projectIds) {
    const ids = Array.isArray(projectIds) ? projectIds : [];
    if (!ids.length) return null;
    const wrap = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } });
    for (const pid of ids) {
      const proj = projectById(pid);
      wrap.appendChild(h('span', {
        class: 'pill',
        title: proj?.name || `Project #${pid}`,
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', maxWidth: '180px' },
      },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '3px', flexShrink: 0, background: proj?.color || 'var(--fg-3)' } }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, proj?.name || `Project #${pid}`),
      ));
    }
    return wrap;
  }

  function GoalCard(goal) {
    const m = statusMeta(goal.status);
    const pct = Number(goal.progress || 0);
    const total = Number(goal.task_total || 0);
    const done = Number(goal.task_done || 0);
    const owner = goal.owner || (goal.owner_id != null ? userById(goal.owner_id) : null);
    const isOpen = model.expanded.has(goal.id);
    const hasDesc = !!(goal.description || '').trim();

    function toggleDesc() {
      if (!hasDesc) return;
      if (isOpen) model.expanded.delete(goal.id); else model.expanded.add(goal.id);
      redraw();
    }

    const card = h('div', {
      class: 'goal-card',
      tabindex: '0',
      role: 'button',
      'aria-expanded': hasDesc ? String(isOpen) : undefined,
      style: {
        display: 'flex', flexDirection: 'column', gap: '14px',
        background: 'var(--bg-2)', border: '1px solid var(--line)',
        borderRadius: '12px', padding: '16px', cursor: hasDesc ? 'pointer' : 'default',
        outline: 'none',
      },
      onClick: toggleDesc,
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDesc(); }
      },
      onFocus: (e) => { e.currentTarget.style.borderColor = 'var(--acc-0)'; },
      onBlur: (e) => { e.currentTarget.style.borderColor = 'var(--line)'; },
    });

    // Head: ring + title/status/owner
    const head = h('div', { style: { display: 'flex', gap: '14px', alignItems: 'flex-start' } });
    head.appendChild(ProgressRing(pct, m.fg, 56));
    const headText = h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px' } });
    headText.appendChild(h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '8px' } },
      h('h3', {
        style: {
          margin: 0, fontSize: '15px', fontWeight: '600', letterSpacing: '-0.01em',
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: 'var(--fg-0)',
        },
        title: goal.name,
      }, goal.name),
      owner ? Avatar(owner, 24) : null,
    ));
    headText.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
      StatusBadge(goal.status),
      goal.due ? DueDate(goal.due, true) : null,
    ));
    head.appendChild(headText);
    card.appendChild(head);

    // Optional description (expanded)
    if (hasDesc && isOpen) {
      card.appendChild(h('p', {
        style: { margin: 0, fontSize: '13px', lineHeight: '1.5', color: 'var(--fg-2)', whiteSpace: 'pre-wrap' },
      }, goal.description));
    }

    // Linked project chips
    const chips = ProjectChips(goal.project_ids);
    if (chips) card.appendChild(chips);

    // Caption + admin actions
    const foot = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: 'auto' } });
    foot.appendChild(h('span', {
      class: 'hstack',
      style: { gap: '5px', fontSize: '12px', color: 'var(--fg-3)' },
    }, Icon('checkSquare', 12), `${done}/${total} task${total === 1 ? '' : 's'} done`));
    if (goal.progress_mode === 'manual') {
      foot.appendChild(h('span', { class: 'pill muted', title: 'Progress set manually' }, 'Manual'));
    }

    if (isAdmin()) {
      const actions = h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } });
      actions.appendChild(h('button', {
        class: 'btn btn-ghost',
        title: 'Edit goal',
        onClick: (e) => { e.stopPropagation(); openForm(goal); },
      }, Icon('edit', 14)));
      actions.appendChild(h('button', {
        class: 'btn btn-ghost',
        title: 'Delete goal',
        onClick: (e) => { e.stopPropagation(); deleteGoal(goal); },
      }, Icon('trash', 14)));
      foot.appendChild(actions);
    }
    card.appendChild(foot);

    return card;
  }

  function SummaryStrip() {
    const counts = { on_track: 0, at_risk: 0, off_track: 0, done: 0 };
    let sum = 0;
    for (const g of model.goals) {
      if (counts[g.status] != null) counts[g.status]++;
      sum += Number(g.progress || 0);
    }
    const avg = model.goals.length ? Math.round(sum / model.goals.length) : 0;

    const strip = h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        background: 'var(--bg-2)', border: '1px solid var(--line)',
        borderRadius: '10px', padding: '10px 14px',
      },
    });
    strip.appendChild(h('span', {
      style: { fontSize: '12px', fontWeight: '600', color: 'var(--fg-2)' },
    }, `${model.goals.length} goal${model.goals.length === 1 ? '' : 's'}`));
    strip.appendChild(h('span', { style: { width: '1px', height: '16px', background: 'var(--line)' } }));
    for (const key of STATUS_ORDER) {
      const meta = STATUS_META[key];
      strip.appendChild(h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--fg-2)' },
      },
        h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: meta.fg } }),
        h('span', null, meta.label),
        h('span', { class: 'mono', style: { fontWeight: '700', color: 'var(--fg-1)' } }, String(counts[key])),
      ));
    }
    strip.appendChild(h('span', {
      style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '8px' },
    },
      h('span', { style: { fontSize: '12px', color: 'var(--fg-3)' } }, 'Avg progress'),
      h('span', { style: { fontSize: '15px', fontWeight: '700', color: 'var(--fg-0)' } }, `${avg}%`),
    ));
    return strip;
  }

  // ---------- admin form ----------
  function checkboxList(items, selected, onToggle, emptyText) {
    const wrap = h('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '6px 14px',
        maxHeight: '140px', overflowY: 'auto',
        padding: '6px 8px', border: '1px solid var(--bd-1)', borderRadius: '6px',
        background: 'var(--bg-2)',
      },
    });
    if (!items.length) { wrap.appendChild(h('span', { class: 'sub' }, emptyText)); return wrap; }
    for (const it of items) {
      const checked = selected.includes(it.id);
      wrap.appendChild(h('label', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px' },
      },
        h('input', { type: 'checkbox', checked, onChange: () => onToggle(it.id) }),
        it.node || it.name,
      ));
    }
    return wrap;
  }

  function GoalForm() {
    const f = model.form;
    const form = h('div', { class: 'settings-form', style: { background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: '12px', padding: '16px' } });

    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Name'),
      h('input', { type: 'text', value: f.name, placeholder: 'e.g. Ship v3 onboarding', onInput: e => { f.name = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Due date'),
      h('input', { type: 'date', value: f.due || '', onInput: e => { f.due = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Status'),
      h('select', { value: f.status, onChange: e => { f.status = e.target.value; } },
        STATUS_ORDER.map(s => h('option', { value: s }, STATUS_META[s].label)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Owner'),
      h('select', { value: f.owner_id, onChange: e => { f.owner_id = e.target.value; } },
        h('option', { value: '' }, 'Unassigned'),
        (window.state.users || []).map(u => h('option', { value: String(u.id) }, u.name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Progress'),
      h('select', {
        value: f.progress_mode,
        // Re-render so the manual % input shows/hides with the mode.
        onChange: e => { f.progress_mode = e.target.value; redraw(); },
      },
        h('option', { value: 'auto' }, 'Auto (from tasks)'),
        h('option', { value: 'manual' }, 'Manual'),
      ),
    ));
    if (f.progress_mode === 'manual') {
      form.appendChild(h('div', null,
        h('label', null, 'Manual %'),
        h('input', {
          type: 'number', min: '0', max: '100', value: String(f.manual_pct),
          onInput: e => { f.manual_pct = e.target.value; },
        }),
      ));
    }
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Description (optional)'),
      h('textarea', { value: f.description, placeholder: 'What does success look like?', onInput: e => { f.description = e.target.value; } }),
    ));
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Linked projects'),
      checkboxList(
        (window.state.projects || []).map(p => ({
          id: p.id,
          node: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { width: '8px', height: '8px', borderRadius: '3px', background: p.color || 'var(--fg-3)' } }),
            p.name),
        })),
        f.project_ids,
        id => { f.project_ids = f.project_ids.includes(id) ? f.project_ids.filter(x => x !== id) : [...f.project_ids, id]; redraw(); },
        'No projects yet.',
      ),
    ));
    form.appendChild(h('div', { class: 'form-foot' },
      model.err ? h('span', { class: 'err' }, model.err) : null,
      h('button', { class: 'btn btn-ghost', onClick: closeForm }, 'Cancel'),
      h('button', { class: 'btn btn-primary', disabled: model.saving, onClick: saveGoal }, f.id ? 'Save goal' : 'Create goal'),
    ));
    return form;
  }

  // ---------- render ----------
  function redraw() {
    root.replaceChildren();

    // Header
    const header = h('div', { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px' } },
      h('div', null,
        h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600', marginBottom: '6px' } },
          h('span', { class: 'hstack', style: { gap: '6px' } }, Icon('target', 14), 'Goals & OKRs')),
        h('h1', { style: { margin: 0, fontSize: '24px', fontWeight: '700', letterSpacing: '-0.02em' } }, 'Objectives'),
        h('p', { style: { margin: '4px 0 0', color: 'var(--fg-2)', fontSize: '13.5px' } }, 'Track outcomes across projects.'),
      ),
      isAdmin() && !model.formOpen
        ? h('button', { class: 'btn btn-primary', onClick: () => openForm() }, Icon('plus', 14), ' New goal')
        : null,
    );
    root.appendChild(header);

    if (isAdmin() && model.formOpen) root.appendChild(GoalForm());

    if (model.loading) {
      root.appendChild(h('div', { style: { padding: '8px 0' } }, SkeletonRows(4, { rowClass: 'skeleton-card', style: { display: 'grid', gap: '12px' } })));
      return;
    }

    if (model.err && !model.goals.length) {
      root.appendChild(h('div', { class: 'empty', style: { padding: '48px 20px' } }, model.err));
      return;
    }

    if (!model.goals.length) {
      root.appendChild(h('div', {
        class: 'empty',
        style: { padding: '56px 20px', display: 'grid', gap: '8px', justifyItems: 'center' },
      },
        Icon('target', 28),
        h('div', { style: { fontWeight: '600', color: 'var(--fg-1)' } }, 'No goals yet'),
        h('div', { style: { fontSize: '13px', color: 'var(--fg-3)' } },
          isAdmin() ? 'Create your first objective to start tracking outcomes.' : 'No objectives have been set up yet.'),
      ));
      return;
    }

    root.appendChild(SummaryStrip());

    const grid = h('div', {
      class: 'goals-grid',
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px', alignItems: 'stretch' },
    });
    for (const g of model.goals) grid.appendChild(GoalCard(g));
    root.appendChild(grid);
  }

  redraw();
  refresh();
  return root;
}

window.renderGoals = renderGoals;
