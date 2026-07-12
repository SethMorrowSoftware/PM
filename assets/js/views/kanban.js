// Kanban board with pointer/touch drag-to-reorder (within & across columns).
// Uses makeDraggable (Pointer Events) so it works on phones; HTML5 DnD is gone.
// On drop we compute a fractional `position` between the two neighbour cards and
// persist via handlers.onReorder(id, {status, position}). View-local drag state
// lives on window.state.ui.kanban so it survives renderApp() re-renders.
function renderKanban(tasks, { onOpenTask, onMoveTask, onAddTask, onReorder, hiddenDoneCount = 0, onShowDone }) {
  const root = h('div', { class: 'kb-board' });

  // View-local state survives re-render (lead provides state.ui.kanban).
  const kb = (state.ui && state.ui.kanban) || (state.ui = state.ui || {}, state.ui.kanban = { swimlane: 'none' });

  // --- position helpers -----------------------------------------------------
  const posOf = t => (typeof t.position === 'number' ? t.position : 0);
  const byPosition = (a, b) => posOf(a) - posOf(b) || (a.id - b.id);

  // Tasks per column, sorted by fractional position.
  const cols = {};
  for (const s of STATUSES) cols[s.id] = tasks.filter(t => t.status === s.id).sort(byPosition);

  // Compute a new position for a card dropped into `colId` at slot `index`
  // (the index it should occupy among that column's *other* cards). We average
  // the neighbours; ends get +/-1 of the edge neighbour.
  function positionFor(colId, index, movingId) {
    const list = cols[colId].filter(t => t.id !== movingId);
    const before = index > 0 ? list[index - 1] : null;
    const after = index < list.length ? list[index] : null;
    if (before && after) return (posOf(before) + posOf(after)) / 2;
    if (before) return posOf(before) + 1;
    if (after) return posOf(after) - 1;
    return 1; // empty column
  }

  // --- drag plumbing (shared across columns) --------------------------------
  let ghost = null;        // floating clone following the pointer
  let dropLine = null;     // thin indicator line
  let dragCard = null;     // the original card element being dragged

  function clearDrag() {
    if (ghost) { ghost.remove(); ghost = null; }
    if (dropLine && dropLine.parentNode) dropLine.remove();
    dropLine = null;
    if (dragCard) dragCard.classList.remove('dragging');
    dragCard = null;
    root.querySelectorAll('.kb-col-body.drag-over, .kb-col-head.drag-over')
      .forEach(el => el.classList.remove('drag-over'));
  }

  // Find the drop target {bodyEl, colId, index} under the pointer. `index` is
  // the slot among that column's cards (excluding the one being dragged).
  function locate(x, y, movingId) {
    let el = document.elementFromPoint(x, y);
    const bodyEl = el && el.closest ? el.closest('.kb-col-body') : null;
    if (!bodyEl) return null;
    const colId = bodyEl.dataset.status;
    const cards = [...bodyEl.querySelectorAll('.kb-card')].filter(c => c.dataset.id !== String(movingId));
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { index = i; break; }
    }
    return { bodyEl, colId, index, cards };
  }

  function showDropLine(loc) {
    // Inline styles so the indicator works without relying on app.css (CSS is
    // owned by another agent); a .kb-drop-line class is kept for theming hooks.
    if (!dropLine) dropLine = h('div', {
      class: 'kb-drop-line',
      style: {
        height: '2px', margin: '3px 2px', borderRadius: '2px',
        background: 'var(--acc-0, #3b82f6)', pointerEvents: 'none',
      },
    });
    if (loc.index >= loc.cards.length) loc.bodyEl.appendChild(dropLine);
    else loc.bodyEl.insertBefore(dropLine, loc.cards[loc.index]);
  }

  for (const s of STATUSES) {
    const colTasks = cols[s.id];

    // With hide-done on, the Done column's cards are filtered out upstream —
    // surface the real count so the column doesn't read as empty.
    const colHidden = s.id === 'done' ? hiddenDoneCount : 0;
    const wipCount = h('span', {
      class: 'mono',
      style: { fontSize: '11px', color: 'var(--fg-3)', background: 'var(--bg-3)', padding: '1px 6px', borderRadius: '4px' },
      title: colHidden
        ? `${colHidden} completed task${colHidden === 1 ? '' : 's'} (hidden)`
        : colTasks.length + ' task' + (colTasks.length === 1 ? '' : 's'),
    }, String(colTasks.length + colHidden));

    const head = h('div', { class: 'kb-col-head' },
      h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: s.color } }),
      h('span', { style: { fontSize: '12.5px', fontWeight: '600', letterSpacing: '-0.01em' } }, s.name),
      wipCount,
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '2px' } },
        h('button', { class: 'icon-btn sm', title: 'Add task to ' + s.name, onClick: () => onAddTask(s.id) }, Icon('plus', 13)),
      ),
    );

    const body = h('div', { class: 'kb-col-body', dataset: { status: s.id } });

    for (const t of colTasks) {
      const card = KanbanCard(t, {
        onOpen: () => onOpenTask(t.id),
        onStatus: (newStatus) => onMoveTask(t.id, newStatus),
      });
      body.appendChild(card);

      // Read-only members of a private project (can_write === false) may open a
      // card to view it but can't drag-reorder or change its status. Only wire
      // pointer-drag when the task is writable (undefined/true = the normal case).
      if (t.can_write === false) continue;

      // Suppress the synthetic click that fires after a mouse drag so releasing a
      // card over itself doesn't ALSO open the drawer (makeDraggable only
      // prevents this for touch). Capture-phase runs before the card's onClick.
      let dragged = false;
      card.addEventListener('click', (e) => {
        if (dragged) { e.stopImmediatePropagation(); e.preventDefault(); dragged = false; }
      }, true);

      makeDraggable(card, {
        data: { id: t.id },
        onStart: (e) => {
          dragged = true;
          dragCard = card;
          card.classList.add('dragging');
          // Floating clone so the card visibly moves with the finger/cursor.
          const r = card.getBoundingClientRect();
          ghost = card.cloneNode(true);
          ghost.classList.remove('dragging');
          ghost.classList.add('drag-ghost');
          ghost.style.width = r.width + 'px';
          ghost.style.left = r.left + 'px';
          ghost.style.top = r.top + 'px';
          // Anchor the clone's origin to where the drag began so it tracks the
          // pointer 1:1 regardless of where on the card the grab started.
          ghost._ox = r.left; ghost._oy = r.top;
          ghost._sx = e.clientX; ghost._sy = e.clientY;
          document.body.appendChild(ghost);
        },
        onMove: (e) => {
          if (ghost) {
            ghost.style.left = (ghost._ox + (e.clientX - ghost._sx)) + 'px';
            ghost.style.top = (ghost._oy + (e.clientY - ghost._sy)) + 'px';
          }
          const loc = locate(e.clientX, e.clientY, t.id);
          // Reset all column highlights, then mark the active one. Doing a full
          // reset on every move (instead of dragenter/dragleave) avoids the
          // old HTML5 dragleave flicker entirely.
          root.querySelectorAll('.kb-col-body.drag-over, .kb-col-head.drag-over')
            .forEach(el => el.classList.remove('drag-over'));
          if (dropLine && dropLine.parentNode) dropLine.remove();
          if (loc) {
            loc.bodyEl.classList.add('drag-over');
            const colHead = loc.bodyEl.previousElementSibling;
            if (colHead) colHead.classList.add('drag-over');
            showDropLine(loc);
          }
        },
        onDrop: (e) => {
          const loc = locate(e.clientX, e.clientY, t.id);
          clearDrag();
          if (!loc) return;
          // No-op guard: dropped in its own column at its own slot.
          if (loc.colId === t.status) {
            const origIndex = cols[t.status].findIndex(x => x.id === t.id);
            const without = cols[t.status].filter(x => x.id !== t.id);
            // loc.index is a slot among `without`; the card's own slot is the
            // count of cards before it (== origIndex clamped to without.length).
            const selfSlot = Math.min(origIndex, without.length);
            if (loc.index === selfSlot) return;
          }
          const newPos = positionFor(loc.colId, loc.index, t.id);
          Promise.resolve(onReorder(t.id, { status: loc.colId, position: newPos }))
            .catch(err => { console.error('reorder failed', err); toast('Could not move task', 'error'); });
        },
      });
    }

    if (colHidden > 0 && colTasks.length === 0) {
      // Still a live drop target — dropping a card here completes it as usual.
      body.appendChild(h('div', { style: { textAlign: 'center', padding: '22px 10px', color: 'var(--fg-4)', fontSize: '12px' } },
        `${colHidden} completed hidden`,
        h('button', {
          style: { display: 'block', margin: '6px auto 0', color: 'var(--acc-1)', fontSize: '12px', cursor: 'pointer' },
          onClick: () => onShowDone?.(),
        }, 'Show completed'),
      ));
    } else if (colTasks.length === 0) {
      body.appendChild(h('div', { style: { textAlign: 'center', padding: '30px', color: 'var(--fg-4)', fontSize: '12px' } }, 'Drop tasks here'));
    }
    body.appendChild(h('button', {
      onClick: () => onAddTask(s.id),
      style: {
        display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--fg-3)',
        padding: '8px 10px', fontSize: '12.5px', borderRadius: '7px', textAlign: 'left',
      },
      onMouseenter: e => { e.currentTarget.style.background = 'var(--bg-3)'; e.currentTarget.style.color = 'var(--fg-0)'; },
      onMouseleave: e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-3)'; },
    }, Icon('plus', 12), ' Add task'));

    root.appendChild(h('div', { class: 'kb-col' }, head, body));
  }
  return root;
}

function KanbanCard(task, { onOpen, onStatus }) {
  const proj = projectById(task.project);
  const sub = task.subtasks || [];
  const subDone = sub.filter(s => s.done).length;
  const subPct = sub.length ? (subDone / sub.length) * 100 : 0;
  const blockedCount = (task.blocked_by && task.blocked_by.length) || 0;
  // Read-only when the viewer is a viewer-role member of a private project.
  // undefined/true (the normal case) means full access.
  const readOnly = task.can_write === false;

  const card = h('div', {
    class: 'kb-card',
    dataset: { id: String(task.id) },
    tabindex: '0',
    role: 'button',
    'aria-label': task.ref + ' ' + task.title,
    onClick: onOpen,
    onKeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
    },
  });

  if (proj) card.appendChild(h('div', { class: 'kb-card-strip', style: { background: proj.color } }));

  // status menu button — keyboard/mobile fallback for changing status. On a
  // read-only card this is replaced by a non-interactive view-only cue so we
  // don't surface a status changer the viewer isn't allowed to use.
  const statusBtn = readOnly
    ? h('span', {
        class: 'kb-readonly-cue',
        title: 'View only',
        'aria-label': 'View only',
        style: { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', color: 'var(--fg-4)' },
      }, Icon('eye', 14))
    : h('button', {
        class: 'icon-btn sm',
        title: 'Change status',
        'aria-label': 'Change status',
        style: { marginLeft: 'auto' },
        onClick: (e) => {
          e.stopPropagation();
          openPopover(statusBtn, ({ close }) =>
            statusPickerContent(task.status, (newStatus) => { if (newStatus !== task.status) onStatus(newStatus); }, close),
            { align: 'end' });
        },
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); },
      }, Icon('more', 14));

  card.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' } },
    h('span', { class: 'mono', style: { fontSize: '10.5px', color: 'var(--fg-3)' } }, task.ref),
    h('span', { style: { width: '3px', height: '3px', borderRadius: '50%', background: 'var(--fg-4)' } }),
    proj ? h('span', { style: { fontSize: '11px', color: `color-mix(in srgb, ${proj.color}, var(--fg-0) 40%)`, fontWeight: '500' } }, proj.name) : null,
    h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' } },
      PriorityFlag(task.priority),
      statusBtn,
    ),
  ));

  card.appendChild(h('div', {
    style: { fontSize: '13.5px', lineHeight: '1.35', fontWeight: '500', color: 'var(--fg-0)', marginBottom: '10px' }
  }, task.title));

  if (blockedCount > 0) {
    card.appendChild(h('div', {
      class: 'dep-pill blocked',
      style: { marginBottom: '10px', display: 'inline-flex' },
      title: 'Blocked by ' + blockedCount + ' task' + (blockedCount === 1 ? '' : 's'),
    }, Icon('flag', 11), h('span', null, 'Blocked' + (blockedCount > 1 ? ' ×' + blockedCount : ''))));
  }

  if (task.labels.length > 0) {
    const row = h('div', { class: 'hstack', style: { gap: '4px', marginBottom: '10px', flexWrap: 'wrap' } });
    task.labels.forEach(l => row.appendChild(Tag(l, true)));
    card.appendChild(row);
  }

  if (sub.length > 0) {
    card.appendChild(h('div', { style: { marginBottom: '10px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '4px' } },
        h('span', { style: { fontSize: '10.5px', color: 'var(--fg-3)' } }, Icon('checkSquare', 10), ' Subtasks'),
        h('span', { class: 'mono', style: { fontSize: '10.5px', color: 'var(--fg-2)' } }, `${subDone}/${sub.length}`),
      ),
      h('div', { style: { height: '3px', background: 'var(--bg-4)', borderRadius: '2px', overflow: 'hidden' } },
        h('div', { style: { width: subPct + '%', height: '100%', background: subPct === 100 ? 'var(--green)' : 'var(--acc-0)', transition: 'width 0.3s' } }),
      ),
    ));
  }

  const bottom = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } });
  const bl = h('div', { class: 'hstack', style: { gap: '8px', fontSize: '11px', color: 'var(--fg-3)' } });
  bl.appendChild(DueDate(task.due, true));
  if (task.comments) bl.appendChild(h('span', { class: 'hstack', style: { gap: '3px' } }, Icon('message', 11), String(task.comments)));
  bottom.appendChild(bl);
  bottom.appendChild(AvatarStack(task.assignees, 3, 20));
  card.appendChild(bottom);

  return card;
}

window.renderKanban = renderKanban;
