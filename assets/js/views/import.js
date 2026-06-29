// CSV import flow. Exposes window.openImport() — an accessible modal that lets a
// user paste or upload a CSV, preview the parsed/resolved rows, and bulk-create
// tasks via API.createTask. Vanilla: window.h, window.toast, window.modal.
//
// No dependencies: ships its own small RFC-4180-ish CSV parser (quoted fields,
// embedded commas/quotes/newlines, CRLF or LF line endings).

(function () {
  'use strict';

  // ---- shared atoms (fall back gracefully if load order ever shifts) ----
  const h = window.h;
  const toast = window.toast || ((m) => console.log(m));

  const RECOGNIZED = ['title', 'project', 'status', 'priority', 'due',
    'description', 'estimate', 'assignees', 'labels'];

  // -------- CSV parser --------
  // Returns an array of rows; each row is an array of string cells. Handles:
  //   - double-quoted fields (with "" as an escaped quote)
  //   - commas and newlines inside quoted fields
  //   - \r\n, \n, or bare \r line terminators
  // Trailing blank line is dropped.
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { pushField(); rows.push(row); row = []; };

    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { pushField(); i++; continue; }
      if (c === '\r') {
        // swallow the \n of a \r\n pair
        if (text[i + 1] === '\n') i++;
        pushRow(); i++; continue;
      }
      if (c === '\n') { pushRow(); i++; continue; }
      field += c; i++;
    }
    // flush the final field/row unless the input ended exactly on a newline
    if (field !== '' || row.length) pushRow();

    // Drop rows that are entirely empty (e.g. a trailing newline producing [''])
    return rows.filter(r => r.some(cell => cell.trim() !== ''));
  }

  // -------- resolution helpers (read window.state lazily) --------
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

  function resolveProject(name) {
    const st = window.state || {};
    const projects = st.projects || [];
    const want = norm(name);
    if (want) {
      const hit = projects.find(p => norm(p.name) === want);
      if (hit) return hit.id;
    }
    // Fall back to the active project filter, then the first project.
    if (st.filterProject) {
      const cur = projects.find(p => p.id == st.filterProject);
      if (cur) return cur.id;
    }
    return projects.length ? projects[0].id : null;
  }

  function resolveStatus(name) {
    const statuses = window.STATUSES || [];
    const want = norm(name);
    if (want) {
      const hit = statuses.find(s => norm(s.id) === want || norm(s.name) === want);
      if (hit) return hit.id;
    }
    return 'todo';
  }

  function resolvePriority(raw) {
    const want = norm(raw);
    if (want === '') return 2;
    // numeric 0..3 wins
    if (/^[0-3]$/.test(want)) return parseInt(want, 10);
    // named: PRIO_LABELS = ['Urgent','High','Medium','Low'] -> 0..3
    const labels = window.PRIO_LABELS || ['Urgent', 'High', 'Medium', 'Low'];
    const idx = labels.findIndex(l => norm(l) === want);
    return idx >= 0 ? idx : 2;
  }

  // Split a semicolon-separated cell into names -> resolve each to an id via a
  // matcher; unknown names are collected so we can surface them in the preview.
  function resolveNames(cell, list) {
    const ids = [];
    const unknown = [];
    const parts = String(cell || '').split(';').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
      const want = norm(part);
      const hit = (list || []).find(x => norm(x.name) === want);
      if (hit) { if (!ids.includes(hit.id)) ids.push(hit.id); }
      else unknown.push(part);
    }
    return { ids, unknown };
  }

  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());

  // -------- map parsed CSV -> resolved row objects --------
  // First row = headers. Returns { rows, headerMap, missingTitle }.
  function buildRows(matrix) {
    if (!matrix.length) return { rows: [], headerMap: {}, hasTitle: false };
    const header = matrix[0].map(norm);
    const headerMap = {};
    header.forEach((name, idx) => {
      if (RECOGNIZED.includes(name) && !(name in headerMap)) headerMap[name] = idx;
    });
    const hasTitle = 'title' in headerMap;
    const cellAt = (cells, key) => {
      const idx = headerMap[key];
      return idx == null ? '' : (cells[idx] == null ? '' : cells[idx]);
    };

    const st = window.state || {};
    const users = st.users || [];
    const labels = st.labels || [];

    const rows = matrix.slice(1).map((cells) => {
      const title = String(cellAt(cells, 'title') || '').trim();
      const projectId = resolveProject(cellAt(cells, 'project'));
      const status = resolveStatus(cellAt(cells, 'status'));
      const priority = resolvePriority(cellAt(cells, 'priority'));
      const dueRaw = String(cellAt(cells, 'due') || '').trim();
      const due = isYmd(dueRaw) ? dueRaw : '';
      const description = String(cellAt(cells, 'description') || '');
      const estimate = String(cellAt(cells, 'estimate') || '').trim();
      const asg = resolveNames(cellAt(cells, 'assignees'), users);
      const lbl = resolveNames(cellAt(cells, 'labels'), labels);

      const warnings = [];
      if (dueRaw && !due) warnings.push(`due "${dueRaw}" is not YYYY-MM-DD`);
      if (asg.unknown.length) warnings.push('unknown assignee: ' + asg.unknown.join(', '));
      if (lbl.unknown.length) warnings.push('unknown label: ' + lbl.unknown.join(', '));

      const valid = !!title && projectId != null;
      return {
        title, projectId, status, priority, due, description, estimate,
        assignees: asg.ids, labels: lbl.ids, warnings, valid,
      };
    });
    return { rows, headerMap, hasTitle };
  }

  // -------- the modal --------
  window.openImport = function openImport() {
    if (typeof window.modal !== 'function') {
      toast('Import unavailable: UI not ready', 'error');
      return;
    }

    // Mutable view state for this modal instance.
    const view = {
      raw: '',          // CSV text
      fileName: '',     // name of a loaded file (for the hint line)
      parseError: '',   // inline error message
      rows: [],         // resolved rows
      validCount: 0,
      running: false,
      progress: '',     // "Imported N / M"
    };

    let bodyEl = null;     // the .modal-body we re-render into
    let importBtn = null;  // footer action (toggled disabled)
    let dlg = null;        // { el, close }

    function reparse() {
      view.parseError = '';
      view.rows = [];
      view.validCount = 0;
      const text = view.raw.trim();
      if (!text) { redraw(); return; }
      let matrix;
      try { matrix = parseCsv(view.raw); }
      catch (e) { view.parseError = 'Could not parse CSV: ' + (e.message || e); redraw(); return; }
      if (!matrix.length) { view.parseError = 'No rows found.'; redraw(); return; }

      const built = buildRows(matrix);
      if (!built.hasTitle) {
        view.parseError = 'CSV must include a "title" column. Recognized columns: ' + RECOGNIZED.join(', ') + '.';
        redraw();
        return;
      }
      view.rows = built.rows;
      view.validCount = built.rows.filter(r => r.valid).length;
      if (!built.rows.length) view.parseError = 'No data rows below the header.';
      redraw();
    }

    function onFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        view.raw = String(reader.result || '');
        view.fileName = file.name || '';
        reparse();
      };
      reader.onerror = () => { view.parseError = 'Could not read file.'; redraw(); };
      reader.readAsText(file);
    }

    async function runImport() {
      const valid = view.rows.filter(r => r.valid);
      if (!valid.length || view.running) return;
      view.running = true;
      const total = valid.length;
      let done = 0;
      const failures = [];
      redraw();

      for (const r of valid) {
        try {
          await window.API.createTask({
            title: r.title,
            project: r.projectId,
            status: r.status,
            priority: r.priority,
            due: r.due || null,
            description: r.description || '',
            estimate: r.estimate || '',
            assignees: r.assignees,
            labels: r.labels,
          });
        } catch (e) {
          failures.push((r.title || '(untitled)') + ': ' + (e.message || 'failed'));
        }
        done++;
        view.progress = `Imported ${done} / ${total}`;
        if (importBtn) importBtn.textContent = view.progress;
      }

      view.running = false;
      const ok = total - failures.length;
      if (failures.length) {
        console.warn('CSV import failures:', failures);
        toast(`Imported ${ok} of ${total}; ${failures.length} failed`, ok ? 'info' : 'error');
      } else {
        toast(`Imported ${ok} task${ok === 1 ? '' : 's'}`, 'success');
      }
      try { window.pmRefreshTasks && window.pmRefreshTasks(); } catch (_) { /* ignore */ }
      dlg && dlg.close();
    }

    // ---- field styling shared with the rest of the app's modals ----
    const fieldStyle = {
      width: '100%', background: 'var(--bg-3)', border: '1px solid var(--line-2)',
      borderRadius: '8px', padding: '9px 11px', color: 'var(--fg-0)',
      outline: 'none', fontSize: '13px', fontFamily: 'var(--font-mono, monospace)',
    };
    const labelStyle = {
      display: 'block', fontSize: '12px', color: 'var(--fg-2)',
      marginBottom: '5px', fontWeight: '500',
    };

    function renderPreview() {
      const wrap = h('div', { style: { marginTop: '14px' } });
      wrap.appendChild(h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: '6px',
        },
      },
        h('span', { style: labelStyle }, `Preview (${view.rows.length} row${view.rows.length === 1 ? '' : 's'})`),
        h('span', {
          style: {
            fontSize: '12px', fontWeight: '600',
            color: view.validCount ? 'var(--green)' : 'var(--fg-3)',
          },
        }, `${view.validCount} valid`),
      ));

      const scroll = h('div', {
        style: {
          maxHeight: '300px', overflow: 'auto', border: '1px solid var(--line)',
          borderRadius: '8px',
        },
      });
      const table = h('table', {
        style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      });
      const thStyle = {
        textAlign: 'left', padding: '6px 8px', position: 'sticky', top: '0',
        background: 'var(--bg-2)', color: 'var(--fg-2)', fontWeight: '600',
        borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap',
      };
      table.appendChild(h('thead', null, h('tr', null,
        h('th', { style: { ...thStyle, width: '20px' } }, ''),
        h('th', { style: thStyle }, 'Title'),
        h('th', { style: thStyle }, 'Project'),
        h('th', { style: thStyle }, 'Status'),
        h('th', { style: thStyle }, 'Priority'),
        h('th', { style: thStyle }, 'Due'),
        h('th', { style: thStyle }, 'Assignees'),
        h('th', { style: thStyle }, 'Labels'),
      )));

      const st = window.state || {};
      const pName = (id) => (st.projects || []).find(p => p.id == id)?.name || '—';
      const sName = (id) => (window.STATUSES || []).find(s => s.id === id)?.name || id;
      const uName = (id) => (st.users || []).find(u => u.id == id)?.name || ('#' + id);
      const lName = (id) => (st.labels || []).find(l => l.id == id)?.name || ('#' + id);
      const prioName = (p) => (window.PRIO_LABELS || [])[p] || String(p);

      const tdStyle = {
        padding: '6px 8px', borderBottom: '1px solid var(--line)',
        color: 'var(--fg-1)', verticalAlign: 'top',
      };
      const tbody = h('tbody');
      view.rows.slice(0, 20).forEach((r) => {
        const titleCell = h('td', { style: tdStyle },
          h('div', { style: { color: r.valid ? 'var(--fg-0)' : 'var(--fg-3)' } }, r.title || h('em', { style: { color: 'var(--red, #EF4444)' } }, 'missing title')),
          r.warnings.length
            ? h('div', { style: { fontSize: '11px', color: 'var(--amber, #F59E0B)', marginTop: '2px' } }, r.warnings.join('; '))
            : null,
        );
        tbody.appendChild(h('tr', { style: r.valid ? null : { opacity: '0.7' } },
          h('td', { style: { ...tdStyle, textAlign: 'center' } },
            r.valid
              ? h('span', { title: 'Will import', style: { color: 'var(--green)' } }, '✓')
              : h('span', { title: 'Skipped (needs a title and a project)', style: { color: 'var(--red, #EF4444)' } }, '✕')),
          titleCell,
          h('td', { style: tdStyle }, pName(r.projectId)),
          h('td', { style: tdStyle }, sName(r.status)),
          h('td', { style: tdStyle }, prioName(r.priority)),
          h('td', { style: tdStyle }, r.due || '—'),
          h('td', { style: tdStyle }, r.assignees.length ? r.assignees.map(uName).join(', ') : '—'),
          h('td', { style: tdStyle }, r.labels.length ? r.labels.map(lName).join(', ') : '—'),
        ));
      });
      table.appendChild(tbody);
      scroll.appendChild(table);
      wrap.appendChild(scroll);
      if (view.rows.length > 20) {
        wrap.appendChild(h('div', { style: { fontSize: '11.5px', color: 'var(--fg-3)', marginTop: '6px' } },
          `Showing first 20 of ${view.rows.length} rows. All valid rows will be imported.`));
      }
      return wrap;
    }

    function renderBody() {
      const frag = document.createDocumentFragment();

      // Intro + expected columns hint.
      frag.appendChild(h('p', {
        style: { margin: '0 0 4px', fontSize: '13px', color: 'var(--fg-1)', lineHeight: '1.5' },
      }, 'Paste CSV below or load a .csv file. The first row must be a header.'));
      frag.appendChild(h('div', {
        style: {
          fontSize: '11.5px', color: 'var(--fg-3)', marginBottom: '14px',
          fontFamily: 'var(--font-mono, monospace)',
        },
      }, 'Expected columns: ' + RECOGNIZED.join(', ') + ' (only title is required).'));

      // File input + template download.
      const fileRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' } });
      const fileInput = h('input', {
        type: 'file', accept: '.csv,text/csv',
        'aria-label': 'Load CSV file',
        style: { fontSize: '12.5px', color: 'var(--fg-2)' },
        onChange: (e) => onFile(e.target.files && e.target.files[0]),
      });
      fileRow.appendChild(fileInput);

      // Optional "Download template" — builds a sample CSV on the client.
      const tmpl = 'title,project,status,priority,due,description,estimate,assignees,labels\r\n'
        + '"Example task",,todo,Medium,,"A short description",60,,\r\n';
      const tmplHref = 'data:text/csv;charset=utf-8,' + encodeURIComponent(tmpl);
      fileRow.appendChild(h('a', {
        href: tmplHref, download: 'task-import-template.csv',
        style: { fontSize: '12px', color: 'var(--accent, #3B82F6)', textDecoration: 'none' },
      }, 'Download template'));

      if (view.fileName) {
        fileRow.appendChild(h('span', { style: { fontSize: '11.5px', color: 'var(--fg-3)' } }, 'Loaded: ' + view.fileName));
      }
      frag.appendChild(fileRow);

      // Paste textarea.
      frag.appendChild(h('label', { style: labelStyle, for: 'csv-import-text' }, 'CSV text'));
      const ta = h('textarea', {
        id: 'csv-import-text',
        rows: 7,
        placeholder: 'title,project,status,priority,due\nFix login bug,Website,in_progress,High,2026-07-15',
        value: view.raw,
        disabled: view.running,
        style: { ...fieldStyle, resize: 'vertical', minHeight: '120px', lineHeight: '1.5' },
        onInput: (e) => { view.raw = e.target.value; },
        onChange: () => reparse(),
      });
      frag.appendChild(ta);

      // A manual parse button so paste doesn't reparse on every keystroke; we
      // also reparse on textarea blur (onChange).
      const parseRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '8px' } });
      parseRow.appendChild(h('button', {
        class: 'btn btn-muted', disabled: view.running,
        onClick: () => reparse(),
      }, 'Parse / preview'));
      if (view.raw.trim() && !view.parseError && view.rows.length) {
        parseRow.appendChild(h('span', { style: { fontSize: '11.5px', color: 'var(--fg-3)' } },
          `${view.rows.length} parsed · ${view.validCount} valid`));
      }
      frag.appendChild(parseRow);

      // Inline error (empty / invalid input).
      if (view.parseError) {
        frag.appendChild(h('div', {
          role: 'alert',
          style: {
            marginTop: '12px', padding: '8px 11px', borderRadius: '8px',
            background: 'var(--red-soft, rgba(239,68,68,0.12))',
            color: 'var(--red-fg, #EF4444)', fontSize: '12.5px',
            border: '1px solid var(--line-2)',
          },
        }, view.parseError));
      }

      // Preview table.
      if (view.rows.length) frag.appendChild(renderPreview());

      return frag;
    }

    function redraw() {
      if (!bodyEl) return;
      bodyEl.replaceChildren();
      window.h(bodyEl, null, renderBody());
      // Keep the footer action button in sync with state.
      if (importBtn) {
        const can = view.validCount > 0 && !view.running;
        importBtn.disabled = !can;
        importBtn.textContent = view.running
          ? (view.progress || 'Importing…')
          : (view.validCount ? `Import ${view.validCount} task${view.validCount === 1 ? '' : 's'}` : 'Import');
      }
    }

    // Footer: Cancel + Import.
    const cancelBtn = h('button', { class: 'btn btn-ghost', onClick: () => dlg && dlg.close() }, 'Cancel');
    importBtn = h('button', {
      class: 'btn btn-primary', disabled: true,
      onClick: () => runImport(),
    }, 'Import');

    dlg = window.modal({
      title: 'Import tasks from CSV',
      width: 720,
      body: (host) => {
        // `modal` appends our body into a .modal-body; capture that container so
        // redraw() can re-render in place. We render into a wrapper we own.
        bodyEl = h('div');
        window.h(bodyEl, null, renderBody());
        return bodyEl;
      },
      footer: h('div', { class: 'hstack', style: { marginLeft: 'auto', gap: '8px' } }, cancelBtn, importBtn),
    });

    // Initial sync of the import button label.
    redraw();
  };
})();
