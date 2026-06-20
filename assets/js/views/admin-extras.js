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
  };

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

  // ---------- render ----------
  function redraw() {
    root.replaceChildren();
    renderMilestones(root);
    renderCustomFields(root);
  }

  redraw();
  refreshMilestones();
  refreshCustomFields();
  return root;
};
