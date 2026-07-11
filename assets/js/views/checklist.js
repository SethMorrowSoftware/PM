// "My tasks" checklist view — grouped by time bucket.
function renderChecklist(tasks, { onOpenTask, onToggleStatus, onToggleSubtask }) {
  const meId = window.state.me.id;
  const myTasks = tasks.filter(t => t.assignees.includes(meId));
  const t = today();

  const groups = [
    { key: 'overdue',  title: 'Overdue',          desc: 'needs attention',    color: '#EF4444',
      items: myTasks.filter(x => x.status !== 'done' && x.due && parseISO(x.due) < t) },
    { key: 'today',    title: 'Today',            desc: t.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' }), color: '#F59E0B',
      items: myTasks.filter(x => x.due === ymd(t) && x.status !== 'done') },
    { key: 'tomorrow', title: 'Tomorrow',         desc: '',                   color: '#3B82F6',
      items: myTasks.filter(x => x.due === daysFromNow(1) && x.status !== 'done') },
    { key: 'thisweek', title: 'Later this week',  desc: '',                   color: '#A855F7',
      items: myTasks.filter(x => { if (!x.due) return false; const d = parseISO(x.due); const diff = (d - t) / 86400000; return diff > 1 && diff <= 7 && x.status !== 'done'; }) },
    { key: 'later',    title: 'Later',            desc: '',                   color: '#8A94A8',
      items: myTasks.filter(x => { if (!x.due) return false; const d = parseISO(x.due); const diff = (d - t) / 86400000; return diff > 7 && x.status !== 'done'; }) },
    { key: 'nodate',   title: 'No due date',      desc: '',                   color: '#64748B',
      items: myTasks.filter(x => !x.due && x.status !== 'done') },
    { key: 'done',     title: 'Completed',        desc: '',                   color: '#22C55E',
      items: myTasks.filter(x => x.status === 'done') },
  ];

  const totalOpen = myTasks.filter(x => x.status !== 'done').length;
  const totalDone = myTasks.filter(x => x.status === 'done').length;

  const root = h('div', { class: 'checklist-wrap' });

  root.appendChild(h('div', { style: { marginBottom: '24px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' } },
    h('div', null,
      h('div', { style: { fontSize: '12px', color: 'var(--fg-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: '600' } }, 'My checklist'),
      h('h1', { style: { margin: '4px 0 0', fontSize: '24px', fontWeight: '700', letterSpacing: '-0.02em' } },
        `${totalOpen} thing${totalOpen !== 1 ? 's' : ''} to do`),
      h('p', { style: { margin: '4px 0 0', color: 'var(--fg-2)', fontSize: '13.5px' } },
        `${totalDone} done · stay focused`),
    ),
    CompletionRing(totalDone, totalOpen + totalDone),
  ));

  const wrap = h('div', { style: { display: 'grid', gap: '16px' } });
  for (const g of groups.filter(g => g.items.length)) {
    const section = h('section');
    section.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' } },
      h('span', { style: { width: '6px', height: '18px', borderRadius: '3px', background: g.color } }),
      h('h3', { style: { margin: 0, fontSize: '13.5px', fontWeight: '600', letterSpacing: '-0.01em' } }, g.title),
      g.desc ? h('span', { style: { fontSize: '12px', color: 'var(--fg-3)' } }, '· ' + g.desc) : null,
      h('span', { class: 'mono', style: { fontSize: '11px', color: 'var(--fg-3)', marginLeft: 'auto' } }, String(g.items.length)),
    ));
    const list = h('div', { style: { background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: '10px' } });
    g.items.forEach((it, i) => list.appendChild(ChecklistItem(it, {
      isLast: i === g.items.length - 1,
      onOpen: () => onOpenTask(it.id),
      onToggleStatus: () => onToggleStatus(it.id),
      onToggleSubtask,
    })));
    section.appendChild(list);
    wrap.appendChild(section);
  }
  root.appendChild(wrap);

  if (myTasks.length === 0) {
    root.appendChild(h('div', { class: 'empty' }, 'Nothing assigned to you. Take a breath.'));
  }
  return root;
}

function ChecklistItem(task, { isLast, onOpen, onToggleStatus, onToggleSubtask }) {
  const proj = projectById(task.project);
  const sub = task.subtasks || [];
  const done = task.status === 'done';
  const canWrite = task.can_write !== false;
  // Persist subtask expansion in view-local UI state (per CLAUDE.md) so it
  // survives the coarse renderApp() re-render — toggling a task's status or the
  // 60s poll rebuilds this view, and a closure flag would collapse every row.
  const exState = (window.state.ui.checklist.expanded ||= {});
  const isExpanded = () => !!exState[task.id];

  const wrap = h('div', { style: { borderBottom: isLast ? 'none' : '1px solid var(--line)' } });

  function redraw() {
    // Recompute each redraw so the "X/Y subtasks" counter stays live as
    // subtasks are toggled from the expanded list below.
    const subDone = sub.filter(s => s.done).length;
    wrap.replaceChildren();
    const head = h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 14px' } });

    // Read-only viewers (a viewer assigned to a private-project task) can't
    // toggle status — the server 403s — so render a non-interactive checkbox
    // instead of a clickable one. Writable one is a keyboard-operable checkbox.
    const cbWrap = canWrite
      ? h('div', { style: { paddingTop: '1px', cursor: 'pointer' },
          role: 'checkbox', 'aria-checked': done ? 'true' : 'false', tabindex: '0', 'aria-label': 'Mark task done',
          onClick: onToggleStatus,
          onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleStatus(e); } } }, Checkbox(done, 18))
      : h('div', { style: { paddingTop: '1px', cursor: 'default' }, role: 'img', 'aria-label': done ? 'Done' : 'Not done' }, Checkbox(done, 18));
    head.appendChild(cbWrap);

    const body = h('div', { style: { flex: 1, minWidth: 0, cursor: 'pointer' }, onClick: onOpen });
    body.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
      h('span', {
        style: {
          fontSize: '14px', fontWeight: '500',
          textDecoration: done ? 'line-through' : 'none',
          color: done ? 'var(--fg-3)' : 'var(--fg-0)',
        }
      }, task.title),
      PriorityFlag(task.priority),
    ));
    const metaRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '5px', flexWrap: 'wrap', fontSize: '11.5px', color: 'var(--fg-3)' } });
    metaRow.appendChild(h('span', { class: 'mono' }, task.ref));
    if (proj) metaRow.appendChild(h('span', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
      h('span', { style: { width: '6px', height: '6px', borderRadius: '2px', background: proj.color } }),
      proj.name));
    if (task.due) metaRow.appendChild(DueDate(task.due, true));
    if (task.comments > 0) metaRow.appendChild(h('span', {
      class: 'hstack', title: task.comments + ' comment' + (task.comments === 1 ? '' : 's'),
      style: { gap: '3px' }
    }, Icon('message', 11), String(task.comments)));
    if (sub.length > 0) {
      metaRow.appendChild(h('button', {
        onClick: (e) => { e.stopPropagation(); exState[task.id] = !isExpanded(); redraw(); },
        style: { display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--fg-2)', fontSize: '11.5px' },
      },
        h('span', { style: { display: 'inline-flex', transform: isExpanded() ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' } }, Icon('chevronRight', 11)),
        Icon('checkSquare', 11),
        ` ${subDone}/${sub.length} subtasks`));
    }
    task.labels.slice(0, 3).forEach(l => metaRow.appendChild(Tag(l, true)));
    body.appendChild(metaRow);

    head.appendChild(body);
    head.appendChild(AvatarStack(task.assignees, 3, 22));
    wrap.appendChild(head);

    if (isExpanded() && sub.length > 0) {
      const subWrap = h('div', { style: { padding: '2px 14px 12px 44px', display: 'grid', gap: '4px' } });
      for (const s of sub) {
        subWrap.appendChild(h('div', {
          style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 8px', borderRadius: '6px', cursor: canWrite ? 'pointer' : 'default' },
          // Wait for the API round-trip before flipping local state so a
          // server-side failure doesn't desync the UI into a fake-success.
          // Read-only viewers can't toggle (server 403s) — no-op the click.
          onClick: canWrite ? async () => {
            try {
              await onToggleSubtask(task.id, s.id, !s.done);
              s.done = !s.done;
              redraw();
            } catch (err) { toast(err.message || 'Subtask toggle failed', 'error'); }
          } : null,
          onMouseenter: canWrite ? (e => e.currentTarget.style.background = 'var(--bg-3)') : null,
          onMouseleave: canWrite ? (e => e.currentTarget.style.background = 'transparent') : null,
        },
          Checkbox(s.done, 14),
          h('span', {
            style: { fontSize: '12.5px', color: s.done ? 'var(--fg-3)' : 'var(--fg-1)', textDecoration: s.done ? 'line-through' : 'none' }
          }, s.text)));
      }
      wrap.appendChild(subWrap);
    }
  }
  redraw();
  return wrap;
}

function CompletionRing(done, total) {
  const pct = total ? (done / total) : 0;
  const R = 22, C = 2 * Math.PI * R;
  const wrap = h('div', {
    style: { display: 'flex', alignItems: 'center', gap: '10px',
      background: 'var(--bg-2)', border: '1px solid var(--line)',
      padding: '8px 14px 8px 10px', borderRadius: '999px' }
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '52'); svg.setAttribute('height', '52');
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.innerHTML = `
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="var(--bg-4)" stroke-width="4"/>
    <circle cx="26" cy="26" r="${R}" fill="none" stroke="var(--green)" stroke-width="4"
      stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"
      stroke-linecap="round" transform="rotate(-90 26 26)" style="transition:stroke-dashoffset 0.5s"/>
    <text x="26" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="var(--fg-0)">${Math.round(pct * 100)}%</text>`;
  wrap.appendChild(svg);
  wrap.appendChild(h('div', null,
    h('div', { style: { fontSize: '12px', fontWeight: '600' } }, `${done} of ${total}`),
    h('div', { style: { fontSize: '11px', color: 'var(--fg-3)' } }, 'completed'),
  ));
  return wrap;
}

window.renderChecklist = renderChecklist;
