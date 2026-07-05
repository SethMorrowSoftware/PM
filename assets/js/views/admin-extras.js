// Admin-only panel appended inside the Admin Settings modal: Milestones +
// Custom fields management. Self-contained — owns its local state and
// re-renders itself in place via a local redraw(), mirroring the pattern used
// by renderSettings() in app.js. Uses the same class names as that modal so it
// looks native (settings-section-head, settings-form, settings-list,
// settings-row, row-main/title/meta/actions, form-foot, btn*, pill, empty, err).
//
// Writes here (milestone + custom-field create/edit/delete) are admin-only on
// the server; this panel is only mounted for admins by the lead. We still
// surface API errors via toast(e.message, 'error').

window.renderAdminExtras = function () {
  const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'user'];

  const model = {
    msLoading: true,
    msErr: '',
    msSaving: false,
    milestones: [],
    msForm: { id: null, project_id: '', name: '', description: '', due: '', status: 'open' },

    cfLoading: true,
    cfErr: '',
    cfSaving: false,
    fields: [],
    cfForm: { id: null, project_id: '', name: '', field_type: 'text', options: '' },

    tplLoading: true,
    tplErr: '',
    tplSaving: false,
    templates: [],
    tplForm: {
      id: null, project_id: '', name: '', title: '', description: '',
      priority: 2, estimate: '', default_status: 'todo',
      labels: [], assignees: [], subtasks: '',
    },

    autoLoading: true,
    autoErr: '',
    autoSaving: false,
    automations: [],
    autoForm: {
      id: null, project_id: '', name: '', trigger_event: 'task_created', enabled: true,
      // conditions
      condPriority: '', condStatus: '', condLabel: '',
      // actions: [{type, value?, label_id?, user_id?, text?}]
      actions: [],
    },

    // Team: list users + create/edit/delete + role & admin management.
    teamLoading: true,
    teamErr: '',
    teamSaving: false,
    users: [],
    teamForm: { id: null, name: '', email: '', password: '', role: '' },

    // Intake forms: public request links (v3).
    intakeLoading: true,
    intakeErr: '',
    intakeSaving: false,
    intakeForms: [],
    intakeForm: { project_id: '', name: '', description: '', default_priority: 2, default_label_id: '' },

    // Project access: pick a project, then manage its visibility + member list.
    paProjectId: '',     // '' = none chosen yet
    paLoading: false,    // true while listProjectMembers is in flight
    paBusy: false,       // true while a mutation (visibility/add/remove/role) is in flight
    paErr: '',
    paVisibility: '',    // 'open' | 'private' (as loaded from the server)
    paMembers: [],       // [{user_id, role, user:{id,name,initials,color}}]
    paAddUser: '',       // user_id selected in the add-member control
    paAddRole: 'editor',
  };

  const PROJECT_ROLES = ['owner', 'editor', 'viewer'];

  const TRIGGERS = [
    { id: 'task_created',   name: 'Task created' },
    { id: 'task_completed', name: 'Task completed' },
    { id: 'comment_added',  name: 'Comment added' },
    { id: 'due_soon',       name: 'Due soon' },
  ];
  const ACTION_TYPES = [
    { id: 'set_priority', name: 'Set priority',  field: 'priority' },
    { id: 'set_status',   name: 'Set status',    field: 'status' },
    { id: 'add_label',    name: 'Add label',     field: 'label' },
    { id: 'assign',       name: 'Assign user',   field: 'user' },
    { id: 'add_watcher',  name: 'Add watcher',   field: 'user' },
    { id: 'notify',       name: 'Notify user',   field: 'user+text' },
    { id: 'comment',      name: 'Add comment',   field: 'text' },
  ];
  const PRIOS = ['Urgent', 'High', 'Medium', 'Low'];

  // Root we own and redraw into. A plain div so the lead can append it once.
  const root = h('div', { class: 'admin-extras' });

  // ---------- helpers ----------
  function scopeName(projectId) {
    if (projectId == null || projectId === '') return 'Global';
    return projectById(projectId)?.name || `Project #${projectId}`;
  }
  function projectLabel(projectId) {
    if (projectId == null) return '—';
    return projectById(projectId)?.name || `Project #${projectId}`;
  }
  function projectColor(projectId) {
    return projectById(projectId)?.color || 'var(--fg-3)';
  }
  // Non-archived labels visible in a scope (global scope = global labels only;
  // a project scope = its own labels + global labels), mirroring app.js.
  function labelsInScope(projectIdStr) {
    const pid = projectIdStr === '' ? null : Number(projectIdStr);
    return (state.labels || []).filter(l =>
      !l.archived && (l.project_id == null || (pid != null && Number(l.project_id) === pid))
    );
  }
  function priorityName(p) { return PRIOS[Number(p)] ?? '—'; }
  function statusName(id) { return (window.STATUSES || []).find(s => s.id === id)?.name || id || '—'; }

  // ---------- milestones ----------
  function resetMsForm(ms = null) {
    model.msErr = '';
    model.msForm.id = ms?.id ?? null;
    model.msForm.project_id = ms?.project_id != null ? String(ms.project_id) : '';
    model.msForm.name = ms?.name ?? '';
    model.msForm.description = ms?.description ?? '';
    model.msForm.due = ms?.due ?? '';
    model.msForm.status = ms?.status ?? 'open';
  }

  async function refreshMilestones() {
    model.msLoading = true;
    redraw();
    try {
      const r = await API.listMilestones();
      model.milestones = r.milestones || [];
    } catch (e) {
      model.msErr = e.message || 'Failed to load milestones';
      toast(e.message || 'Failed to load milestones', 'error');
    } finally {
      model.msLoading = false;
    }
    redraw();
  }

  async function saveMilestone() {
    const f = model.msForm;
    const payload = {
      project_id: Number(f.project_id),
      name: (f.name || '').trim(),
      description: (f.description || '').trim(),
      due: f.due || null,
    };
    if (!payload.project_id) { model.msErr = 'Project is required'; redraw(); return; }
    if (!payload.name) { model.msErr = 'Name is required'; redraw(); return; }
    model.msSaving = true;
    model.msErr = '';
    redraw();
    try {
      if (f.id) await API.updateMilestone(f.id, { ...payload, status: f.status });
      else await API.createMilestone(payload);
      resetMsForm();
      await refreshMilestones();
      window.pmLoadMilestones?.();
      toast(f.id ? 'Milestone updated' : 'Milestone created', 'success');
    } catch (e) {
      model.msErr = e.message || 'Failed to save milestone';
      toast(e.message || 'Failed to save milestone', 'error');
    } finally {
      model.msSaving = false;
      redraw();
    }
  }

  async function deleteMilestone(ms) {
    const ok = await confirmDialog({
      title: 'Delete milestone?',
      message: `“${ms.name}” will be removed. Tasks keep their data but lose this milestone.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteMilestone(ms.id);
      if (model.msForm.id === ms.id) resetMsForm();
      await refreshMilestones();
      window.pmLoadMilestones?.();
      toast('Milestone deleted', 'success');
    } catch (e) {
      toast(e.message || 'Failed to delete milestone', 'error');
    }
  }

  function milestoneProgress(ms) {
    const total = Number(ms.task_count || 0);
    const done = Number(ms.done_count || 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const wrap = h('span', {
      class: 'ax-progress',
      title: `${done} of ${total} tasks done`,
      style: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
    });
    wrap.appendChild(h('span', {
      style: {
        width: '60px', height: '6px', borderRadius: '999px',
        background: 'var(--bg-4)', overflow: 'hidden', flexShrink: 0,
      },
    }, h('span', {
      style: {
        display: 'block', height: '100%', width: pct + '%',
        background: 'var(--acc-1)', borderRadius: '999px',
      },
    })));
    wrap.appendChild(h('span', { class: 'pill' + (total && done >= total ? ' ok' : ''), }, `${done}/${total}`));
    return wrap;
  }

  function renderMilestones(body) {
    body.appendChild(h('div', { class: 'settings-section-head' },
      h('div', null,
        h('h3', null, 'Milestones'),
        h('div', { class: 'sub' }, 'Group tasks into project milestones with a due date and completion tracking.'),
      ),
    ));

    const form = h('div', { class: 'settings-form' });
    form.appendChild(h('div', null,
      h('label', null, 'Project'),
      h('select', {
        value: model.msForm.project_id,
        onChange: e => { model.msForm.project_id = e.target.value; },
      },
        h('option', { value: '' }, 'Select project…'),
        (state.projects || []).map(p => h('option', { value: String(p.id) }, p.name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Name'),
      h('input', { type: 'text', value: model.msForm.name, onInput: e => { model.msForm.name = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Due date'),
      h('input', { type: 'date', value: model.msForm.due || '', onInput: e => { model.msForm.due = e.target.value; } }),
    ));
    if (model.msForm.id) {
      form.appendChild(h('div', null,
        h('label', null, 'Status'),
        h('select', {
          value: model.msForm.status,
          onChange: e => { model.msForm.status = e.target.value; },
        },
          h('option', { value: 'open' }, 'Open'),
          h('option', { value: 'done' }, 'Done'),
        ),
      ));
    }
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Description (optional)'),
      h('textarea', { value: model.msForm.description, onInput: e => { model.msForm.description = e.target.value; } }),
    ));
    form.appendChild(h('div', { class: 'form-foot' },
      model.msErr ? h('span', { class: 'err' }, model.msErr) : null,
      model.msForm.id ? h('button', { class: 'btn btn-ghost', onClick: () => { resetMsForm(); redraw(); } }, 'Cancel edit') : null,
      h('button', { class: 'btn btn-primary', disabled: model.msSaving, onClick: saveMilestone }, model.msForm.id ? 'Save milestone' : 'Create milestone'),
    ));
    body.appendChild(form);

    if (model.msLoading) { body.appendChild(h('div', { class: 'empty' }, 'Loading milestones…')); return; }

    const list = h('div', { class: 'settings-list' });
    // Group rows by project so it reads like the rest of the settings panel.
    const byProject = new Map();
    for (const ms of model.milestones) {
      const key = ms.project_id == null ? '' : String(ms.project_id);
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(ms);
    }
    for (const [key, group] of byProject) {
      list.appendChild(h('div', { class: 'row-meta', style: { padding: '4px 2px', fontWeight: '600' } },
        h('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: projectColor(key === '' ? null : Number(key)), display: 'inline-block', marginRight: '6px', verticalAlign: 'middle' } }),
        projectLabel(key === '' ? null : Number(key)),
      ));
      for (const ms of group) {
        const done = ms.status === 'done';
        list.appendChild(h('div', { class: 'settings-row' + (done ? ' archived' : '') },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title' },
              ms.name,
              done ? h('span', { class: 'pill ok' }, 'Done') : h('span', { class: 'pill muted' }, 'Open'),
            ),
            h('div', { class: 'row-meta' },
              h('span', null, projectLabel(ms.project_id)),
              ms.due ? DueDate(ms.due, true) : h('span', null, 'No due date'),
              milestoneProgress(ms),
            ),
          ),
          h('div', { class: 'row-actions' },
            h('button', { class: 'btn btn-ghost', onClick: () => { resetMsForm(ms); redraw(); } }, 'Edit'),
            h('button', { class: 'btn btn-ghost', onClick: () => deleteMilestone(ms) }, 'Delete'),
          ),
        ));
      }
    }
    if (!model.milestones.length) list.appendChild(h('div', { class: 'empty' }, 'No milestones yet.'));
    body.appendChild(list);
  }

  // ---------- custom fields ----------
  function resetCfForm(f = null) {
    model.cfErr = '';
    model.cfForm.id = f?.id ?? null;
    model.cfForm.project_id = f?.project_id != null ? String(f.project_id) : '';
    model.cfForm.name = f?.name ?? '';
    model.cfForm.field_type = f?.field_type ?? 'text';
    model.cfForm.options = Array.isArray(f?.options) ? f.options.join(', ') : '';
  }

  async function refreshCustomFields() {
    model.cfLoading = true;
    redraw();
    try {
      const r = await API.listCustomFields();
      model.fields = r.fields || [];
    } catch (e) {
      model.cfErr = e.message || 'Failed to load custom fields';
      toast(e.message || 'Failed to load custom fields', 'error');
    } finally {
      model.cfLoading = false;
    }
    redraw();
  }

  function parseOptions(str) {
    return (str || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  async function saveCustomField() {
    const f = model.cfForm;
    const payload = {
      project_id: f.project_id === '' ? null : Number(f.project_id),
      name: (f.name || '').trim(),
      field_type: f.field_type,
    };
    if (!payload.name) { model.cfErr = 'Name is required'; redraw(); return; }
    if (f.field_type === 'select') {
      payload.options = parseOptions(f.options);
      if (!payload.options.length) { model.cfErr = 'Add at least one option for a select field'; redraw(); return; }
    }
    model.cfSaving = true;
    model.cfErr = '';
    redraw();
    try {
      if (f.id) await API.updateCustomField(f.id, payload);
      else await API.createCustomField(payload);
      resetCfForm();
      await refreshCustomFields();
      window.pmLoadCustomFields?.();
      toast(f.id ? 'Custom field updated' : 'Custom field created', 'success');
    } catch (e) {
      model.cfErr = e.message || 'Failed to save custom field';
      toast(e.message || 'Failed to save custom field', 'error');
    } finally {
      model.cfSaving = false;
      redraw();
    }
  }

  async function deleteCustomField(field) {
    const ok = await confirmDialog({
      title: 'Delete custom field?',
      message: `“${field.name}” and any values stored for it will be removed.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteCustomField(field.id);
      if (model.cfForm.id === field.id) resetCfForm();
      await refreshCustomFields();
      window.pmLoadCustomFields?.();
      toast('Custom field deleted', 'success');
    } catch (e) {
      toast(e.message || 'Failed to delete custom field', 'error');
    }
  }

  function renderCustomFields(body) {
    body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
      h('div', null,
        h('h3', null, 'Custom fields'),
        h('div', { class: 'sub' }, 'Define extra task fields, global or scoped to one project.'),
      ),
    ));

    const form = h('div', { class: 'settings-form' });
    form.appendChild(h('div', null,
      h('label', null, 'Scope'),
      h('select', {
        value: model.cfForm.project_id,
        onChange: e => { model.cfForm.project_id = e.target.value; },
      },
        h('option', { value: '' }, 'Global'),
        (state.projects || []).map(p => h('option', { value: String(p.id) }, p.name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Field name'),
      h('input', { type: 'text', value: model.cfForm.name, onInput: e => { model.cfForm.name = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Type'),
      h('select', {
        value: model.cfForm.field_type,
        // Re-render so the options input shows/hides when type changes.
        onChange: e => { model.cfForm.field_type = e.target.value; redraw(); },
      },
        FIELD_TYPES.map(t => h('option', { value: t }, t.charAt(0).toUpperCase() + t.slice(1))),
      ),
    ));
    if (model.cfForm.field_type === 'select') {
      form.appendChild(h('div', { class: 'full' },
        h('label', null, 'Options (comma-separated)'),
        h('input', { type: 'text', placeholder: 'Low, Medium, High', value: model.cfForm.options, onInput: e => { model.cfForm.options = e.target.value; } }),
      ));
    }
    form.appendChild(h('div', { class: 'form-foot' },
      model.cfErr ? h('span', { class: 'err' }, model.cfErr) : null,
      model.cfForm.id ? h('button', { class: 'btn btn-ghost', onClick: () => { resetCfForm(); redraw(); } }, 'Cancel edit') : null,
      h('button', { class: 'btn btn-primary', disabled: model.cfSaving, onClick: saveCustomField }, model.cfForm.id ? 'Save field' : 'Create field'),
    ));
    body.appendChild(form);

    if (model.cfLoading) { body.appendChild(h('div', { class: 'empty' }, 'Loading custom fields…')); return; }

    const list = h('div', { class: 'settings-list' });
    for (const field of model.fields) {
      const arch = !!field.archived;
      const opts = Array.isArray(field.options) ? field.options : [];
      list.appendChild(h('div', { class: 'settings-row' + (arch ? ' archived' : '') },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' },
            field.name,
            arch ? h('span', { class: 'pill muted' }, 'Archived') : null,
          ),
          h('div', { class: 'row-meta' },
            h('span', null, scopeName(field.project_id)),
            h('span', { class: 'pill' }, field.field_type),
            field.field_type === 'select' && opts.length ? h('span', null, opts.join(', ')) : null,
          ),
        ),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-ghost', onClick: () => { resetCfForm(field); redraw(); } }, 'Edit'),
          h('button', { class: 'btn btn-ghost', onClick: () => deleteCustomField(field) }, 'Delete'),
        ),
      ));
    }
    if (!model.fields.length) list.appendChild(h('div', { class: 'empty' }, 'No custom fields yet.'));
    body.appendChild(list);
  }

  // ---------- task templates ----------
  function resetTplForm(t = null) {
    model.tplErr = '';
    const f = model.tplForm;
    f.id = t?.id ?? null;
    f.project_id = t?.project_id != null ? String(t.project_id) : '';
    f.name = t?.name ?? '';
    f.title = t?.title ?? '';
    f.description = t?.description ?? '';
    f.priority = t?.priority != null ? Number(t.priority) : 2;
    f.estimate = t?.estimate != null && t?.estimate !== '' ? String(t.estimate) : '';
    f.default_status = t?.default_status ?? 'todo';
    f.labels = Array.isArray(t?.labels) ? t.labels.map(Number) : [];
    f.assignees = Array.isArray(t?.assignees) ? t.assignees.map(Number) : [];
    f.subtasks = Array.isArray(t?.subtasks) ? t.subtasks.join('\n') : '';
  }

  async function refreshTemplates() {
    model.tplLoading = true;
    redraw();
    try {
      const r = await API.listTemplates();
      model.templates = r.templates || [];
    } catch (e) {
      model.tplErr = e.message || 'Failed to load templates';
      toast(e.message || 'Failed to load templates', 'error');
    } finally {
      model.tplLoading = false;
    }
    redraw();
  }

  async function saveTemplate() {
    const f = model.tplForm;
    const payload = {
      project_id: f.project_id === '' ? null : Number(f.project_id),
      name: (f.name || '').trim(),
      title: (f.title || '').trim(),
      description: (f.description || '').trim(),
      priority: Number(f.priority),
      estimate: f.estimate === '' ? null : Number(f.estimate),
      default_status: f.default_status,
      labels: f.labels.slice(),
      assignees: f.assignees.slice(),
      subtasks: (f.subtasks || '').split('\n').map(s => s.trim()).filter(Boolean),
    };
    if (!payload.name) { model.tplErr = 'Name is required'; redraw(); return; }
    model.tplSaving = true;
    model.tplErr = '';
    redraw();
    try {
      if (f.id) await API.updateTemplate(f.id, payload);
      else await API.createTemplate(payload);
      resetTplForm();
      await refreshTemplates();
      window.pmLoadTemplates?.();
      toast(f.id ? 'Template updated' : 'Template created', 'success');
    } catch (e) {
      model.tplErr = e.message || 'Failed to save template';
      toast(e.message || 'Failed to save template', 'error');
    } finally {
      model.tplSaving = false;
      redraw();
    }
  }

  async function deleteTemplate(tpl) {
    const ok = await confirmDialog({
      title: 'Delete template?',
      message: `“${tpl.name}” will be removed from quick-add.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteTemplate(tpl.id);
      if (model.tplForm.id === tpl.id) resetTplForm();
      await refreshTemplates();
      window.pmLoadTemplates?.();
      toast('Template deleted', 'success');
    } catch (e) {
      toast(e.message || 'Failed to delete template', 'error');
    }
  }

  function checkboxList(items, selected, onToggle, emptyText) {
    const wrap = h('div', {
      class: 'ax-checks',
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '6px 14px',
        maxHeight: '120px', overflowY: 'auto',
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

  function renderTemplates(body) {
    body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
      h('div', null,
        h('h3', null, 'Task templates'),
        h('div', { class: 'sub' }, 'Reusable task blueprints surfaced in quick-add, global or scoped to a project.'),
      ),
    ));

    const f = model.tplForm;
    const form = h('div', { class: 'settings-form' });
    form.appendChild(h('div', null,
      h('label', null, 'Scope'),
      h('select', {
        value: f.project_id,
        // Re-render so the in-scope label list updates when scope changes.
        onChange: e => { f.project_id = e.target.value; f.labels = f.labels.filter(id => labelsInScope(f.project_id).some(l => l.id === id)); redraw(); },
      },
        h('option', { value: '' }, 'Global'),
        (state.projects || []).map(p => h('option', { value: String(p.id) }, p.name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Template name'),
      h('input', { type: 'text', value: f.name, onInput: e => { f.name = e.target.value; } }),
    ));
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Task title'),
      h('input', { type: 'text', value: f.title, onInput: e => { f.title = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Priority'),
      h('select', {
        value: String(f.priority),
        onChange: e => { f.priority = Number(e.target.value); },
      },
        PRIOS.map((name, i) => h('option', { value: String(i) }, name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Default status'),
      h('select', {
        value: f.default_status,
        onChange: e => { f.default_status = e.target.value; },
      },
        (window.STATUSES || []).map(s => h('option', { value: s.id }, s.name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Estimate (min)'),
      h('input', { type: 'number', min: '0', value: f.estimate, onInput: e => { f.estimate = e.target.value; } }),
    ));
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Description'),
      h('textarea', { value: f.description, onInput: e => { f.description = e.target.value; } }),
    ));
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Labels'),
      checkboxList(
        labelsInScope(f.project_id).map(l => ({ id: l.id, node: Tag(l.id, true) })),
        f.labels,
        id => { f.labels = f.labels.includes(id) ? f.labels.filter(x => x !== id) : [...f.labels, id]; redraw(); },
        'No labels in this scope.',
      ),
    ));
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Assignees'),
      checkboxList(
        (state.users || []).map(u => ({ id: u.id, name: u.name })),
        f.assignees,
        id => { f.assignees = f.assignees.includes(id) ? f.assignees.filter(x => x !== id) : [...f.assignees, id]; redraw(); },
        'No users.',
      ),
    ));
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Subtasks (one per line)'),
      h('textarea', { placeholder: 'Draft outline\nReview with team', value: f.subtasks, onInput: e => { f.subtasks = e.target.value; } }),
    ));
    form.appendChild(h('div', { class: 'form-foot' },
      model.tplErr ? h('span', { class: 'err' }, model.tplErr) : null,
      f.id ? h('button', { class: 'btn btn-ghost', onClick: () => { resetTplForm(); redraw(); } }, 'Cancel edit') : null,
      h('button', { class: 'btn btn-primary', disabled: model.tplSaving, onClick: saveTemplate }, f.id ? 'Save template' : 'Create template'),
    ));
    body.appendChild(form);

    if (model.tplLoading) { body.appendChild(h('div', { class: 'empty' }, 'Loading templates…')); return; }

    const list = h('div', { class: 'settings-list' });
    for (const tpl of model.templates) {
      const subCount = Array.isArray(tpl.subtasks) ? tpl.subtasks.length : 0;
      list.appendChild(h('div', { class: 'settings-row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' },
            tpl.name,
            h('span', { class: 'pill muted' }, scopeName(tpl.project_id)),
          ),
          h('div', { class: 'row-meta' },
            h('span', null, priorityName(tpl.priority)),
            h('span', null, statusName(tpl.default_status)),
            h('span', null, `${subCount} subtask${subCount === 1 ? '' : 's'}`),
          ),
        ),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-ghost', onClick: () => { resetTplForm(tpl); redraw(); } }, 'Edit'),
          h('button', { class: 'btn btn-ghost', onClick: () => deleteTemplate(tpl) }, 'Delete'),
        ),
      ));
    }
    if (!model.templates.length) list.appendChild(h('div', { class: 'empty' }, 'No templates yet.'));
    body.appendChild(list);
  }

  // ---------- automation rules ----------
  function resetAutoForm(a = null) {
    model.autoErr = '';
    const f = model.autoForm;
    f.id = a?.id ?? null;
    f.project_id = a?.project_id != null ? String(a.project_id) : '';
    f.name = a?.name ?? '';
    f.trigger_event = a?.trigger_event ?? 'task_created';
    f.enabled = a?.enabled != null ? !!a.enabled : true;
    const c = a?.conditions || {};
    f.condPriority = c.priority != null ? String(c.priority) : '';
    f.condStatus = c.status != null ? String(c.status) : '';
    f.condLabel = c.label_id != null ? String(c.label_id) : '';
    // Normalize actions into editable rows.
    f.actions = Array.isArray(a?.actions) ? a.actions.map(normalizeAction) : [];
  }
  function normalizeAction(a) {
    const t = a?.type || 'set_priority';
    return {
      type: t,
      value: a?.value != null ? a.value : '',
      label_id: a?.label_id != null ? String(a.label_id) : '',
      user_id: a?.user_id != null ? String(a.user_id) : '',
      text: a?.text != null ? a.text : '',
    };
  }
  function blankAction() {
    return { type: 'set_priority', value: '0', label_id: '', user_id: '', text: '' };
  }

  async function refreshAutomations() {
    model.autoLoading = true;
    redraw();
    try {
      const r = await API.listAutomations();
      model.automations = r.automations || [];
    } catch (e) {
      model.autoErr = e.message || 'Failed to load automations';
      toast(e.message || 'Failed to load automations', 'error');
    } finally {
      model.autoLoading = false;
    }
    redraw();
  }

  // Build the actions[] payload from editable rows, keeping only the fields each
  // action type uses (must match the backend VOCAB exactly).
  function serializeActions() {
    return model.autoForm.actions.map(a => {
      switch (a.type) {
        case 'set_priority': return { type: 'set_priority', value: Number(a.value) };
        case 'set_status':   return { type: 'set_status', value: a.value };
        case 'add_label':    return { type: 'add_label', label_id: Number(a.label_id) };
        case 'assign':       return { type: 'assign', user_id: Number(a.user_id) };
        case 'add_watcher':  return { type: 'add_watcher', user_id: Number(a.user_id) };
        case 'notify':       return { type: 'notify', user_id: Number(a.user_id), text: (a.text || '').trim() || undefined };
        case 'comment':      return { type: 'comment', text: (a.text || '').trim() };
        default:             return { type: a.type };
      }
    });
  }
  function actionIsValid(a) {
    switch (a.type) {
      case 'set_priority': return a.value !== '' && !Number.isNaN(Number(a.value));
      case 'set_status':   return !!a.value;
      case 'add_label':    return !!a.label_id;
      case 'assign':
      case 'add_watcher':
      case 'notify':       return !!a.user_id;
      case 'comment':      return !!(a.text || '').trim();
      default:             return false;
    }
  }

  function buildConditions() {
    const f = model.autoForm;
    const c = {};
    if (f.condPriority !== '') c.priority = Number(f.condPriority);
    if (f.condStatus !== '') c.status = f.condStatus;
    if (f.condLabel !== '') c.label_id = Number(f.condLabel);
    return c;
  }

  async function saveAutomation() {
    const f = model.autoForm;
    const name = (f.name || '').trim();
    if (!name) { model.autoErr = 'Name is required'; redraw(); return; }
    if (!f.trigger_event) { model.autoErr = 'Trigger is required'; redraw(); return; }
    if (!f.actions.length) { model.autoErr = 'Add at least one action'; redraw(); return; }
    if (!f.actions.every(actionIsValid)) { model.autoErr = 'Every action needs its value filled in'; redraw(); return; }
    const payload = {
      project_id: f.project_id === '' ? null : Number(f.project_id),
      name,
      trigger_event: f.trigger_event,
      conditions: buildConditions(),
      actions: serializeActions(),
      enabled: !!f.enabled,
    };
    model.autoSaving = true;
    model.autoErr = '';
    redraw();
    try {
      if (f.id) await API.updateAutomation(f.id, payload);
      else await API.createAutomation(payload);
      resetAutoForm();
      await refreshAutomations();
      toast(f.id ? 'Automation updated' : 'Automation created', 'success');
    } catch (e) {
      model.autoErr = e.message || 'Failed to save automation';
      toast(e.message || 'Failed to save automation', 'error');
    } finally {
      model.autoSaving = false;
      redraw();
    }
  }

  async function toggleAutomation(rule) {
    try {
      await API.updateAutomation(rule.id, { enabled: !rule.enabled });
      await refreshAutomations();
    } catch (e) {
      toast(e.message || 'Failed to update automation', 'error');
    }
  }

  async function deleteAutomation(rule) {
    const ok = await confirmDialog({
      title: 'Delete automation?',
      message: `“${rule.name}” will stop running.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteAutomation(rule.id);
      if (model.autoForm.id === rule.id) resetAutoForm();
      await refreshAutomations();
      toast('Automation deleted', 'success');
    } catch (e) {
      toast(e.message || 'Failed to delete automation', 'error');
    }
  }

  function triggerName(id) { return TRIGGERS.find(t => t.id === id)?.name || id; }

  function conditionSummary(conds) {
    const c = conds || {};
    const parts = [];
    if (c.priority != null) parts.push(`priority ${priorityName(c.priority)}`);
    if (c.status != null) parts.push(`status ${statusName(c.status)}`);
    if (c.label_id != null) parts.push(`label ${labelById(c.label_id)?.name || '#' + c.label_id}`);
    return parts.join(' & ');
  }
  function actionSummary(a) {
    switch (a.type) {
      case 'set_priority': return `set priority ${priorityName(a.value)}`;
      case 'set_status':   return `set status ${statusName(a.value)}`;
      case 'add_label':    return `add label ${labelById(a.label_id)?.name || '#' + a.label_id}`;
      case 'assign':       return `assign ${userById(a.user_id)?.name || '#' + a.user_id}`;
      case 'add_watcher':  return `watch as ${userById(a.user_id)?.name || '#' + a.user_id}`;
      case 'notify':       return `notify ${userById(a.user_id)?.name || '#' + a.user_id}`;
      case 'comment':      return `comment "${(a.text || '').slice(0, 24)}"`;
      default:             return a.type;
    }
  }
  function ruleSummary(rule) {
    const cond = conditionSummary(rule.conditions);
    const acts = (rule.actions || []).map(actionSummary).join(', ') || 'no actions';
    return `When ${triggerName(rule.trigger_event)}${cond ? ` if ${cond}` : ''} → ${acts}`;
  }

  // One editable action row inside the builder.
  function actionRow(a, idx) {
    const def = ACTION_TYPES.find(t => t.id === a.type) || ACTION_TYPES[0];
    const row = h('div', {
      class: 'ax-action-row',
      style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
    });
    row.appendChild(h('select', {
      value: a.type,
      onChange: e => {
        a.type = e.target.value;
        // Seed a sensible default value for the newly chosen type.
        const nd = ACTION_TYPES.find(t => t.id === a.type);
        if (nd?.field === 'priority' && a.value === '') a.value = '0';
        redraw();
      },
    }, ACTION_TYPES.map(t => h('option', { value: t.id }, t.name))));

    // Value control depends on the action's field kind.
    if (def.field === 'priority') {
      row.appendChild(h('select', {
        value: String(a.value === '' ? '0' : a.value),
        onChange: e => { a.value = e.target.value; },
      }, PRIOS.map((n, i) => h('option', { value: String(i) }, n))));
    } else if (def.field === 'status') {
      row.appendChild(h('select', {
        value: a.value || (window.STATUSES?.[0]?.id ?? ''),
        onChange: e => { a.value = e.target.value; },
      }, (window.STATUSES || []).map(s => h('option', { value: s.id }, s.name))));
    } else if (def.field === 'label') {
      row.appendChild(h('select', {
        value: a.label_id,
        onChange: e => { a.label_id = e.target.value; },
      },
        h('option', { value: '' }, 'Select label…'),
        labelsInScope(model.autoForm.project_id).map(l => h('option', { value: String(l.id) }, l.name)),
      ));
    } else if (def.field === 'user' || def.field === 'user+text') {
      row.appendChild(h('select', {
        value: a.user_id,
        onChange: e => { a.user_id = e.target.value; },
      },
        h('option', { value: '' }, 'Select user…'),
        (state.users || []).map(u => h('option', { value: String(u.id) }, u.name)),
      ));
    }
    if (def.field === 'text' || def.field === 'user+text') {
      row.appendChild(h('input', {
        type: 'text',
        placeholder: def.field === 'user+text' ? 'Message (optional)' : 'Comment text',
        value: a.text,
        style: { flex: '1', minWidth: '140px' },
        onInput: e => { a.text = e.target.value; },
      }));
    }

    row.appendChild(h('button', {
      class: 'btn btn-ghost', title: 'Remove action',
      onClick: () => { model.autoForm.actions.splice(idx, 1); redraw(); },
    }, Icon('x', 14)));
    return row;
  }

  function renderAutomations(body) {
    body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
      h('div', null,
        h('h3', null, 'Automation rules'),
        h('div', { class: 'sub' }, 'Run actions automatically when a trigger fires, optionally filtered by conditions.'),
      ),
    ));

    const f = model.autoForm;
    const form = h('div', { class: 'settings-form' });
    form.appendChild(h('div', null,
      h('label', null, 'Scope'),
      h('select', {
        value: f.project_id,
        onChange: e => { f.project_id = e.target.value; if (f.condLabel && !labelsInScope(f.project_id).some(l => String(l.id) === f.condLabel)) f.condLabel = ''; redraw(); },
      },
        h('option', { value: '' }, 'Global'),
        (state.projects || []).map(p => h('option', { value: String(p.id) }, p.name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Rule name'),
      h('input', { type: 'text', value: f.name, onInput: e => { f.name = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Trigger'),
      h('select', {
        value: f.trigger_event,
        onChange: e => { f.trigger_event = e.target.value; },
      }, TRIGGERS.map(t => h('option', { value: t.id }, t.name))),
    ));

    // Conditions
    form.appendChild(h('div', null,
      h('label', null, 'If priority'),
      h('select', { value: f.condPriority, onChange: e => { f.condPriority = e.target.value; } },
        h('option', { value: '' }, 'Any'),
        PRIOS.map((n, i) => h('option', { value: String(i) }, n)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'If status'),
      h('select', { value: f.condStatus, onChange: e => { f.condStatus = e.target.value; } },
        h('option', { value: '' }, 'Any'),
        (window.STATUSES || []).map(s => h('option', { value: s.id }, s.name)),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'If label'),
      h('select', { value: f.condLabel, onChange: e => { f.condLabel = e.target.value; } },
        h('option', { value: '' }, 'Any'),
        labelsInScope(f.project_id).map(l => h('option', { value: String(l.id) }, l.name)),
      ),
    ));

    // Actions builder
    const actionsWrap = h('div', { class: 'full' },
      h('label', null, 'Actions'),
    );
    const rows = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    if (!f.actions.length) rows.appendChild(h('div', { class: 'sub' }, 'No actions yet — add one below.'));
    f.actions.forEach((a, i) => rows.appendChild(actionRow(a, i)));
    actionsWrap.appendChild(rows);
    actionsWrap.appendChild(h('button', {
      class: 'btn btn-ghost', style: { marginTop: '8px' },
      onClick: () => { f.actions.push(blankAction()); redraw(); },
    }, Icon('plus', 14), ' Add action'));
    form.appendChild(actionsWrap);

    form.appendChild(h('div', { class: 'full' },
      h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: f.enabled, onChange: e => { f.enabled = e.target.checked; } }),
        'Enabled',
      ),
    ));

    form.appendChild(h('div', { class: 'form-foot' },
      model.autoErr ? h('span', { class: 'err' }, model.autoErr) : null,
      f.id ? h('button', { class: 'btn btn-ghost', onClick: () => { resetAutoForm(); redraw(); } }, 'Cancel edit') : null,
      h('button', { class: 'btn btn-primary', disabled: model.autoSaving, onClick: saveAutomation }, f.id ? 'Save rule' : 'Create rule'),
    ));
    body.appendChild(form);

    if (model.autoLoading) { body.appendChild(h('div', { class: 'empty' }, 'Loading automations…')); return; }

    const list = h('div', { class: 'settings-list' });
    for (const rule of model.automations) {
      const on = !!rule.enabled;
      list.appendChild(h('div', { class: 'settings-row' + (on ? '' : ' archived') },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' },
            rule.name,
            h('span', { class: 'pill muted' }, scopeName(rule.project_id)),
            on ? h('span', { class: 'pill ok' }, 'On') : h('span', { class: 'pill muted' }, 'Off'),
          ),
          h('div', { class: 'row-meta' },
            h('span', null, ruleSummary(rule)),
            rule.run_count != null ? h('span', null, `ran ${rule.run_count}×`) : null,
          ),
        ),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-ghost', onClick: () => toggleAutomation(rule) }, on ? 'Disable' : 'Enable'),
          h('button', { class: 'btn btn-ghost', onClick: () => { resetAutoForm(rule); redraw(); } }, 'Edit'),
          h('button', { class: 'btn btn-ghost', onClick: () => deleteAutomation(rule) }, 'Delete'),
        ),
      ));
    }
    if (!model.automations.length) list.appendChild(h('div', { class: 'empty' }, 'No automation rules yet.'));
    body.appendChild(list);
  }

  // ---------- project access ----------
  function roleName(r) { return (r || '').charAt(0).toUpperCase() + (r || '').slice(1); }

  // Load the chosen project's visibility + members. No-op when nothing is picked.
  async function refreshProjectAccess() {
    const pid = model.paProjectId === '' ? null : Number(model.paProjectId);
    if (!pid) {
      model.paVisibility = '';
      model.paMembers = [];
      model.paLoading = false;
      redraw();
      return;
    }
    model.paLoading = true;
    model.paErr = '';
    redraw();
    try {
      const r = await API.listProjectMembers(pid);
      model.paVisibility = r.visibility || 'open';
      model.paMembers = Array.isArray(r.members) ? r.members : [];
    } catch (e) {
      model.paErr = e.message || 'Failed to load project access';
      model.paVisibility = '';
      model.paMembers = [];
      toast(e.message || 'Failed to load project access', 'error');
    } finally {
      model.paLoading = false;
    }
    redraw();
  }

  async function changeVisibility(value) {
    const pid = model.paProjectId === '' ? null : Number(model.paProjectId);
    if (!pid) return;
    model.paBusy = true;
    model.paErr = '';
    redraw();
    try {
      await API.setProjectVisibility(pid, value);
      toast(value === 'private' ? 'Project is now private' : 'Project is now open', 'success');
      await refreshProjectAccess();
    } catch (e) {
      model.paErr = e.message || 'Failed to update visibility';
      toast(e.message || 'Failed to update visibility', 'error');
    } finally {
      model.paBusy = false;
      redraw();
    }
  }

  async function addProjectMember(userId, role) {
    const pid = model.paProjectId === '' ? null : Number(model.paProjectId);
    if (!pid || !userId) return;
    model.paBusy = true;
    model.paErr = '';
    redraw();
    try {
      await API.addProjectMember(pid, Number(userId), role);
      toast('Member saved', 'success');
      await refreshProjectAccess();
    } catch (e) {
      model.paErr = e.message || 'Failed to add member';
      toast(e.message || 'Failed to add member', 'error');
    } finally {
      model.paBusy = false;
      redraw();
    }
  }

  async function setMemberRole(userId, role) {
    // addProjectMember is an upsert on the server, so re-adding updates the role.
    await addProjectMember(userId, role);
  }

  async function removeProjectMember(member) {
    const pid = model.paProjectId === '' ? null : Number(model.paProjectId);
    if (!pid) return;
    const who = member.user?.name || `User #${member.user_id}`;
    const ok = await confirmDialog({
      title: 'Remove member?',
      message: `${who} will lose access to this project.`,
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    model.paBusy = true;
    model.paErr = '';
    redraw();
    try {
      await API.removeProjectMember(pid, member.user_id);
      toast('Member removed', 'success');
      await refreshProjectAccess();
    } catch (e) {
      model.paErr = e.message || 'Failed to remove member';
      toast(e.message || 'Failed to remove member', 'error');
    } finally {
      model.paBusy = false;
      redraw();
    }
  }

  function renderProjectAccess(body) {
    body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
      h('div', null,
        h('h3', null, 'Project access'),
        h('div', { class: 'sub' }, 'Control who can see and edit a project. Open = every signed-in user can view & edit. Private = only members below.'),
      ),
    ));

    // Project picker.
    const form = h('div', { class: 'settings-form' });
    form.appendChild(h('div', null,
      h('label', null, 'Project'),
      h('select', {
        value: model.paProjectId,
        onChange: e => {
          model.paProjectId = e.target.value;
          model.paAddUser = '';
          model.paAddRole = 'editor';
          refreshProjectAccess();
        },
      },
        h('option', { value: '' }, 'Select project…'),
        (state.projects || []).map(p => h('option', { value: String(p.id) }, p.name)),
      ),
    ));

    if (model.paProjectId !== '' && model.paVisibility) {
      form.appendChild(h('div', null,
        h('label', null, 'Visibility'),
        h('select', {
          value: model.paVisibility,
          disabled: model.paBusy || model.paLoading,
          onChange: e => changeVisibility(e.target.value),
        },
          h('option', { value: 'open' }, 'Open — anyone signed in'),
          h('option', { value: 'private' }, 'Private — members only'),
        ),
      ));
    }
    if (model.paErr) {
      form.appendChild(h('div', { class: 'full' }, h('span', { class: 'err' }, model.paErr)));
    }
    body.appendChild(form);

    if (model.paProjectId === '') {
      body.appendChild(h('div', { class: 'empty' }, 'Select a project to manage its access.'));
      return;
    }
    if (model.paLoading) {
      body.appendChild(h('div', { class: 'empty' }, 'Loading project access…'));
      return;
    }
    if (!model.paVisibility) return; // load failed; error already shown above.

    // For open projects, membership is advisory until the project is made private.
    if (model.paVisibility !== 'private') {
      body.appendChild(h('div', { class: 'sub', style: { margin: '4px 0 10px' } },
        'This project is Open, so membership is ignored until you set it to Private. You can pre-add members below.'));
    }

    // Members list.
    const list = h('div', { class: 'settings-list' });
    for (const m of model.paMembers) {
      const u = m.user || userById(m.user_id) || null;
      const name = u?.name || `User #${m.user_id}`;
      list.appendChild(h('div', { class: 'settings-row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            Avatar(u, 24),
            name,
          ),
        ),
        h('div', { class: 'row-actions' },
          h('select', {
            value: m.role,
            disabled: model.paBusy,
            title: 'Role',
            onChange: e => setMemberRole(m.user_id, e.target.value),
          }, PROJECT_ROLES.map(r => h('option', { value: r }, roleName(r)))),
          h('button', { class: 'btn btn-ghost', disabled: model.paBusy, onClick: () => removeProjectMember(m) }, 'Remove'),
        ),
      ));
    }
    if (!model.paMembers.length) list.appendChild(h('div', { class: 'empty' }, 'No members yet.'));
    body.appendChild(list);

    // Add-member control: only users who aren't already members.
    const memberIds = new Set(model.paMembers.map(m => Number(m.user_id)));
    const available = (state.users || []).filter(u => !memberIds.has(Number(u.id)));
    const addForm = h('div', { class: 'settings-form' });
    addForm.appendChild(h('div', null,
      h('label', null, 'Add member'),
      h('select', {
        value: model.paAddUser,
        disabled: model.paBusy || !available.length,
        onChange: e => { model.paAddUser = e.target.value; },
      },
        h('option', { value: '' }, available.length ? 'Select user…' : 'Everyone is a member'),
        available.map(u => h('option', { value: String(u.id) }, u.name)),
      ),
    ));
    addForm.appendChild(h('div', null,
      h('label', null, 'Role'),
      h('select', {
        value: model.paAddRole,
        disabled: model.paBusy || !available.length,
        onChange: e => { model.paAddRole = e.target.value; },
      }, PROJECT_ROLES.map(r => h('option', { value: r }, roleName(r)))),
    ));
    addForm.appendChild(h('div', { class: 'form-foot' },
      h('button', {
        class: 'btn btn-primary',
        disabled: model.paBusy || !model.paAddUser,
        onClick: () => {
          const uid = model.paAddUser;
          model.paAddUser = '';
          addProjectMember(uid, model.paAddRole);
        },
      }, 'Add member'),
    ));
    body.appendChild(addForm);
  }

  // ---------- team / members ----------
  function resetTeamForm(u = null) {
    model.teamErr = '';
    model.teamForm.id = u?.id ?? null;
    model.teamForm.name = u?.name ?? '';
    model.teamForm.email = u?.email ?? '';
    model.teamForm.password = '';
    model.teamForm.role = u?.role ?? '';
  }

  async function refreshTeam() {
    model.teamLoading = true;
    redraw();
    try {
      const r = await API.listUsers();
      model.users = r.users || [];
      // Keep the app-wide user list (assignee pickers, avatars) in sync.
      if (window.state) window.state.users = model.users;
    } catch (e) {
      model.teamErr = e.message || 'Failed to load team';
      toast(e.message || 'Failed to load team', 'error');
    } finally {
      model.teamLoading = false;
    }
    redraw();
  }

  function randomPassword() {
    // Readable-ish random password the admin can share; avoids ambiguous chars.
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let out = '';
    const buf = new Uint32Array(14);
    (window.crypto || {}).getRandomValues?.(buf);
    for (let i = 0; i < 14; i++) out += cs[(buf[i] || (i * 7 + 11)) % cs.length];
    return out;
  }

  function genPassword() {
    model.teamForm.password = randomPassword();
    redraw();
  }

  // Fail-safe reset: an admin sets a member's password directly (no current
  // password needed — that's the point when someone is locked out). The
  // dialog is pre-filled with a strong generated password the admin can
  // accept as-is or type over; it's copied to the clipboard on success.
  async function resetMemberPassword(u) {
    const pw = await promptDialog({
      title: `Reset password — ${u.name}`,
      label: 'New password (they can change it later under Profile)',
      value: randomPassword(),
    });
    if (pw == null || pw === '') return;
    if (pw.length < 8) { toast('Password must be at least 8 characters', 'error'); return; }
    try {
      await API.updateUser(u.id, { password: pw });
      let copied = false;
      try { await navigator.clipboard.writeText(pw); copied = true; } catch (_) { /* http or denied */ }
      toast(`Password updated for ${u.name}${copied ? ' — copied to clipboard' : ''}`, 'success', { ms: 6000 });
    } catch (e) { toast(e.message || 'Password reset failed', 'error'); }
  }

  async function saveTeamMember() {
    const f = model.teamForm;
    const name = (f.name || '').trim();
    const email = (f.email || '').trim();
    if (!name) { model.teamErr = 'Name is required'; redraw(); return; }
    model.teamSaving = true;
    model.teamErr = '';
    redraw();
    try {
      if (f.id) {
        // Edit an existing member (name + role). Email/password change happen
        // elsewhere (the user's own Profile / admin reset flow).
        await API.updateUser(f.id, { name, role: f.role || '' });
        toast('Member updated', 'success');
      } else {
        // Create: the register endpoint lets a signed-in admin add users even
        // when public registration is disabled. is_admin defaults to 0 — promote
        // afterward with the "Make admin" action.
        if (!email) { throw new Error('Email is required'); }
        if ((f.password || '').length < 8) { throw new Error('Set an initial password of at least 8 characters (use Generate)'); }
        await API.register({ name, email, password: f.password, role: f.role || '' });
        toast(`Added ${name}. Share their initial password so they can sign in.`, 'success');
      }
      resetTeamForm();
      await refreshTeam();
    } catch (e) {
      model.teamErr = e.message || 'Failed to save member';
      toast(e.message || 'Failed to save member', 'error');
    } finally {
      model.teamSaving = false;
      redraw();
    }
  }

  async function toggleAdmin(u) {
    try {
      await API.updateUser(u.id, { is_admin: !u.is_admin });
      await refreshTeam();
      toast(u.is_admin ? `${u.name} is no longer an admin` : `${u.name} is now an admin`, 'success');
    } catch (e) {
      toast(e.message || 'Could not change admin status', 'error');
    }
  }

  async function deleteMember(u) {
    const ok = await confirmDialog({
      title: `Remove ${u.name}?`,
      message: 'They lose access immediately. Their comments and activity are kept (attributed to a former teammate).',
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await API.deleteUser(u.id);
      if (model.teamForm.id === u.id) resetTeamForm();
      await refreshTeam();
      toast('Member removed', 'success');
    } catch (e) {
      toast(e.message || 'Could not remove member', 'error');
    }
  }

  function renderTeam(body) {
    // Managing users is admin-only server-side; only show the panel to admins.
    if (!(window.state && window.state.me && window.state.me.is_admin)) return;

    body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
      h('div', null,
        h('h3', null, 'Team members'),
        h('div', { class: 'sub' }, 'Add teammates, set roles, grant admin, or remove access. New members sign in with the initial password you set here.'),
      ),
    ));

    const editing = !!model.teamForm.id;
    const form = h('div', { class: 'settings-form' });
    form.appendChild(h('div', null,
      h('label', null, 'Name'),
      h('input', { type: 'text', value: model.teamForm.name, placeholder: 'Jane Technician', onInput: e => { model.teamForm.name = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Role (optional)'),
      h('input', { type: 'text', value: model.teamForm.role, placeholder: 'e.g. Field Tech', onInput: e => { model.teamForm.role = e.target.value; } }),
    ));
    if (!editing) {
      form.appendChild(h('div', null,
        h('label', null, 'Email'),
        h('input', { type: 'email', value: model.teamForm.email, placeholder: 'jane@castletechteam.com', onInput: e => { model.teamForm.email = e.target.value; } }),
      ));
      form.appendChild(h('div', null,
        h('label', null, 'Initial password'),
        h('div', { style: { display: 'flex', gap: '6px' } },
          h('input', { type: 'text', value: model.teamForm.password, placeholder: 'min 8 characters', style: { flex: 1 }, onInput: e => { model.teamForm.password = e.target.value; } }),
          h('button', { class: 'btn btn-ghost', type: 'button', onClick: genPassword }, 'Generate'),
        ),
      ));
    } else {
      form.appendChild(h('div', null,
        h('label', null, 'Email'),
        h('input', { type: 'email', value: model.teamForm.email, disabled: true, style: { opacity: 0.7 } }),
      ));
    }
    form.appendChild(h('div', { class: 'form-foot' },
      model.teamErr ? h('span', { class: 'err' }, model.teamErr) : null,
      editing ? h('button', { class: 'btn btn-ghost', onClick: () => { resetTeamForm(); redraw(); } }, 'Cancel edit') : null,
      h('button', { class: 'btn btn-primary', disabled: model.teamSaving, onClick: saveTeamMember }, editing ? 'Save member' : 'Add member'),
    ));
    body.appendChild(form);

    if (model.teamLoading) { body.appendChild(h('div', { class: 'empty' }, 'Loading team…')); return; }

    const meId = window.state.me.id;
    const list = h('div', { class: 'settings-list' });
    for (const u of model.users) {
      list.appendChild(h('div', { class: 'settings-row' },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' },
            Avatar(u, 22),
            h('span', { style: { marginLeft: '2px' } }, u.name),
            u.is_admin ? h('span', { class: 'pill ok' }, 'Admin') : null,
            u.id === meId ? h('span', { class: 'pill muted' }, 'You') : null,
          ),
          h('div', { class: 'row-meta' },
            h('span', null, u.role || 'No role'),
            u.email ? h('span', null, u.email) : null,
          ),
        ),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-ghost', onClick: () => { resetTeamForm(u); redraw(); } }, 'Edit'),
          h('button', { class: 'btn btn-ghost', title: 'Set a new password for this member (fail-safe reset)',
            onClick: () => resetMemberPassword(u) }, 'Reset password'),
          h('button', { class: 'btn btn-ghost', onClick: () => toggleAdmin(u) }, u.is_admin ? 'Remove admin' : 'Make admin'),
          u.id === meId ? null : h('button', { class: 'btn btn-ghost', onClick: () => deleteMember(u) }, 'Remove'),
        ),
      ));
    }
    if (!model.users.length) list.appendChild(h('div', { class: 'empty' }, 'No team members yet.'));
    body.appendChild(list);
  }

  // ---------- Intake forms (public request links) ----------
  async function refreshIntake() {
    model.intakeLoading = true; redraw();
    try {
      const r = await API.listIntakeForms();
      model.intakeForms = r.forms || [];
      model.intakeErr = '';
    } catch (e) { model.intakeErr = e.message || 'Failed to load intake forms'; }
    model.intakeLoading = false; redraw();
  }
  async function saveIntakeForm() {
    const f = model.intakeForm;
    if (!f.project_id) { model.intakeErr = 'Pick a project for submissions to land in'; redraw(); return; }
    if (!f.name.trim()) { model.intakeErr = 'Form name is required'; redraw(); return; }
    model.intakeSaving = true; model.intakeErr = ''; redraw();
    try {
      await API.createIntakeForm({
        project_id: Number(f.project_id),
        name: f.name.trim(),
        description: f.description.trim(),
        default_priority: Number(f.default_priority),
        default_label_id: f.default_label_id ? Number(f.default_label_id) : null,
      });
      model.intakeForm = { project_id: '', name: '', description: '', default_priority: 2, default_label_id: '' };
      toast('Intake form created', 'success');
      await refreshIntake();
    } catch (e) { model.intakeErr = e.message || 'Failed to save form'; }
    model.intakeSaving = false; redraw();
  }
  function intakeUrl(f) {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'form.php?f=' + f.token;
  }
  function renderIntake(body) {
    if (!(window.state && window.state.me && window.state.me.is_admin)) return;

    body.appendChild(h('div', { class: 'settings-section-head', style: { marginTop: '20px' } },
      h('div', null,
        h('h3', null, 'Intake forms'),
        h('div', { class: 'sub' },
          'Public "report an issue" links — no account needed. Print one as a QR code and anyone on the floor can file a request straight onto the board.'),
      ),
    ));

    const f = model.intakeForm;
    const form = h('div', { class: 'settings-form' });
    form.appendChild(h('div', null,
      h('label', null, 'Form name'),
      h('input', { type: 'text', value: f.name, placeholder: 'e.g. Report a ride/arcade issue', onInput: e => { f.name = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Submissions land in'),
      h('select', { value: f.project_id, onChange: e => { f.project_id = e.target.value; } },
        h('option', { value: '' }, 'Select project…'),
        (window.state.projects || []).map(p => h('option', { value: String(p.id) }, p.name)),
      ),
    ));
    form.appendChild(h('div', { class: 'full' },
      h('label', null, 'Intro text shown on the form (optional)'),
      h('input', { type: 'text', value: f.description, placeholder: 'Spotted a problem? Tell the tech team.', onInput: e => { f.description = e.target.value; } }),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Default priority'),
      h('select', { value: String(f.default_priority), onChange: e => { f.default_priority = Number(e.target.value); } },
        h('option', { value: '0' }, 'Urgent'), h('option', { value: '1' }, 'High'),
        h('option', { value: '2' }, 'Medium'), h('option', { value: '3' }, 'Low'),
      ),
    ));
    form.appendChild(h('div', null,
      h('label', null, 'Auto-apply label (optional)'),
      h('select', { value: f.default_label_id, onChange: e => { f.default_label_id = e.target.value; } },
        h('option', { value: '' }, 'None'),
        (window.state.labels || []).map(l => h('option', { value: String(l.id) }, l.name)),
      ),
    ));
    form.appendChild(h('div', { class: 'form-foot' },
      model.intakeErr ? h('span', { class: 'err' }, model.intakeErr) : null,
      h('button', { class: 'btn btn-primary', disabled: model.intakeSaving, onClick: saveIntakeForm }, 'Create form'),
    ));
    body.appendChild(form);

    if (model.intakeLoading) { body.appendChild(h('div', { class: 'empty' }, 'Loading intake forms…')); return; }

    const list = h('div', { class: 'settings-list' });
    for (const it of model.intakeForms) {
      const proj = (window.state.projects || []).find(p => p.id == it.project_id);
      list.appendChild(h('div', { class: 'settings-row' + (it.enabled ? '' : ' archived') },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' },
            it.name,
            it.enabled ? null : h('span', { class: 'pill muted' }, 'Off'),
          ),
          h('div', { class: 'row-meta' },
            h('span', null, `→ ${proj ? proj.name : 'Unknown project'}`),
            h('span', null, `${it.submissions} submission${it.submissions === 1 ? '' : 's'}`),
            h('span', { class: 'mono', style: { userSelect: 'all', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '340px' } }, intakeUrl(it)),
          ),
        ),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-ghost', title: 'Copy the public link', onClick: async () => {
            try { await navigator.clipboard.writeText(intakeUrl(it)); toast('Public form link copied', 'success'); }
            catch (_) { toast('Copy failed — the URL is shown in the row', 'error'); }
          } }, 'Copy link'),
          h('button', { class: 'btn btn-ghost', onClick: async () => {
            try { await API.updateIntakeForm(it.id, { enabled: !it.enabled }); await refreshIntake(); }
            catch (e) { toast(e.message || 'Failed', 'error'); }
          } }, it.enabled ? 'Turn off' : 'Turn on'),
          h('button', { class: 'btn btn-ghost', onClick: async () => {
            const ok = await confirmDialog({
              title: 'Delete intake form?',
              body: `"${it.name}" — its public link stops working immediately. Tasks it already created are kept.`,
              confirmText: 'Delete form',
            });
            if (!ok) return;
            try { await API.deleteIntakeForm(it.id); toast('Intake form deleted', 'success'); await refreshIntake(); }
            catch (e) { toast(e.message || 'Failed', 'error'); }
          } }, 'Delete'),
        ),
      ));
    }
    if (!model.intakeForms.length) list.appendChild(h('div', { class: 'empty' }, 'No intake forms yet — create one above and share the link.'));
    body.appendChild(list);
  }

  // ---------- render ----------
  function redraw() {
    root.replaceChildren();
    renderTeam(root);
    renderIntake(root);
    renderMilestones(root);
    renderCustomFields(root);
    renderTemplates(root);
    renderAutomations(root);
    renderProjectAccess(root);
  }

  redraw();
  if (window.state && window.state.me && window.state.me.is_admin) { refreshTeam(); refreshIntake(); }
  refreshMilestones();
  refreshCustomFields();
  refreshTemplates();
  refreshAutomations();
  return root;
};
