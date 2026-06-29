# Castle Tech Tasks — v2 Build Contract

This is the **single source of truth** for the v2 upgrade. Every agent builds to
this so independently-edited files integrate cleanly. **Do not deviate** from the
names/signatures here; if something is missing, follow the closest existing
pattern and note it in your final message.

## Hard rules (from CLAUDE.md — non-negotiable)
- **No build step, no bundler, no Node runtime, no Composer, no framework, no
  TypeScript, no ES modules.** Vanilla ES2020 on the `window` global; PHP 8 + PDO
  (MySQL/MariaDB) only. Must work by drag-dropping files into cPanel File Manager.
- Frontend: everything is a global on `window`, loaded via `<script>` tags in
  strict order. DOM is built with `h(tag, props, ...children)` (see `assets/js/ui.js`).
  Event props are camelCase `onClick`/`onInput` (lowercased internally). `class`
  sets className; `style` takes an object; `html` sets innerHTML.
- Dates are **local wall-clock**. Use `today()`, `ymd()`, `daysFromNow()`,
  `parseISO()` from ui.js. **Never** use `toISOString()` for task dates.
- PHP endpoints start with `require_once __DIR__.'/bootstrap.php'; pm_boot();`
  then `pm_require_auth()` (or `pm_require_admin()`), respond only via
  `pm_json()` / `pm_error()`, read input via `pm_param()`/`pm_int_param()`/`pm_body()`,
  and use parameterized `pm_fetch_all/one`, `pm_exec`, `pm_last_id`. Build dynamic
  `IN()` lists from `array_fill` (see `pm_list_tasks` in tasks.php).
- **Authorization model (current, intentional):** all *authenticated* users may
  read/write tasks, projects, and labels. Admin-only: Slack, recurring rules,
  user role changes, **custom-field definitions, and milestone create/edit/delete**.
  Do NOT re-gate task/project/label writes to admin.
- **Testing:** every change must keep `bash scripts/beta-smoke.sh` green
  (`php -l` on all PHP, `node --check` on all JS). Run it before you finish.
- **Keep your final message SHORT**: list files changed, any contract deviations,
  and confirm smoke passed. Do not paste large code or long explanations.

## New DB tables (already created in install.php — DO NOT edit install.php)
`task_dependencies(task_id, depends_on_id, type, created_at)` ·
`milestones(id, project_id, name, description, due, status[open|done], sort_order, created_at)` ·
`time_entries(id, task_id, user_id, minutes, note, spent_on, created_at)` ·
`custom_fields(id, project_id NULL=global, name, field_type[text|number|date|select|checkbox|user], options_json, sort_order, archived, created_at)` ·
`task_custom_values(task_id, field_id, value)` ·
`notifications(id, user_id, actor_id, task_id, type, body, is_read, created_at)` ·
`comment_mentions(comment_id, user_id, created_at)` ·
`task_watchers(task_id, user_id, created_at)` ·
`reminders(id, task_id, user_id, remind_at, channel, sent_at, created_at)` ·
`comment_reactions(comment_id, user_id, emoji, created_at)`.
New `tasks` columns: `start_date DATE NULL`, `position DOUBLE NOT NULL DEFAULT 0`,
`milestone_id INT NULL`.

## Shared PHP helper (provided in `api/notify_lib.php`, owned by the lead)
```php
// Insert one in-app notification (no self-notify; dedupes obvious repeats is NOT required).
pm_notify(int $userId, ?int $actorId, ?int $taskId, string $type, string $body): void
// Recipients for a task = assignees ∪ watchers, minus the actor.
pm_task_recipients(int $taskId, ?int $excludeUserId = null): array  // returns int[] user ids
// Add watcher rows (INSERT IGNORE). $userIds int[].
pm_add_watchers(int $taskId, array $userIds): void
// Parse "@name" tokens in text → matched user ids (exact full-name match, case-insensitive; never bare initials).
pm_resolve_mentions(string $text): array  // returns int[] user ids
// Lazy sweep: send due reminders + due-soon notifications. Safe to call on any request; self-throttles.
pm_run_due_sweep(): void
```
`notification.type` ∈ `assigned | comment | mention | due_soon | reminder |
dependency | status | watching`. Call `require_once __DIR__.'/notify_lib.php';`
when you need these.

---

## Backend endpoints to BUILD

All require `pm_boot()` + `pm_require_auth()` unless noted. Return shapes use the
existing `pm_public_user()` style for any user objects.

### `api/notifications.php` (NEW) — owner: agent N
- `GET` → `{ notifications: [...], unread: <int> }`. Each notification:
  `{id, type, body, task_id, is_read, created_at, actor: {id,name,initials,color}|null}`.
  Most-recent first, limit 50. Also runs `pm_run_due_sweep()` at the top so the
  feed self-refreshes due reminders.
- `GET ?unread=1` → `{ unread: <int> }` (cheap count only; still call the sweep).
- `PATCH ?id=N` body `{is_read:true}` → `{ok:true}` (only own rows).
- `PATCH ?all=1` body `{is_read:true}` → `{ok:true, updated:<int>}` (mark all own read).
- `DELETE ?id=N` → `{ok:true}` (own rows only).

### `api/dependencies.php` (NEW) — owner: agent D
- `GET ?task_id=N` → `{ blocked_by:[taskMini...], blocks:[taskMini...] }` where
  taskMini = `{id, ref, title, status, project_id}`.
- `POST ?task_id=N` body `{depends_on_id:M}` → `{ok:true}`. **Reject** self-link and
  any link that would create a cycle (walk the graph in PHP); 400 with a clear error.
- `DELETE ?task_id=N&depends_on_id=M` → `{ok:true}`.

### `api/time.php` (NEW) — owner: agent TM
- `GET ?task_id=N` → `{ entries:[{id, minutes, note, spent_on, created_at, user:{id,name,initials,color}|null}], total_minutes }`.
- `POST ?task_id=N` body `{minutes:int>0, note?, spent_on?(YYYY-MM-DD, default today)}`
  → `{entry, total_minutes}`. `user_id` = current user.
- `DELETE ?id=N` → `{ok:true}` (own entry or admin).

### `api/milestones.php` (NEW) — owner: agent MS
- `GET` (optional `?project_id=N`) → `{ milestones:[{id,project_id,name,description,due,status,sort_order, task_count, done_count}] }`.
- `POST` (**admin**) body `{project_id,name,description?,due?,sort_order?}` → `{milestone}`.
- `PATCH ?id=N` (**admin**) → `{milestone}` (fields incl. `status`).
- `DELETE ?id=N` (**admin**) → `{ok:true}`. (Tasks keep `milestone_id`; on delete set their milestone_id NULL.)

### `api/custom_fields.php` (NEW) — owner: agent CF
- `GET` → `{ fields:[{id,project_id,name,field_type,options:[...],sort_order,archived}] }` (options decoded from options_json).
- `POST` (**admin**) body `{project_id?(null=global),name,field_type,options?[],sort_order?}` → `{field}`.
- `PATCH ?id=N` (**admin**) → `{field}` (incl. archived).
- `DELETE ?id=N` (**admin**) → `{ok:true}`.
- `PUT ?task_id=N&field_id=M` body `{value}` → `{ok:true}` (upsert one value; any auth user; empty value deletes the row).

### `api/attachments.php` + `api/attachments_lib.php` (HARDEN) — owner: agent AT
Keep all current behavior/return shapes. Add **only** security hardening:
- Server-side MIME sniff with `finfo` on upload; store the sniffed type, not the
  client-sent one. Keep an extension+mime allow-list (images, pdf, text, common
  office/zip); for anything else force `application/octet-stream`.
- On download, never echo client MIME for non-allowlisted types — send
  `application/octet-stream` (the `Content-Disposition: attachment` + nosniff stay).
- `DELETE`: allow if the current user is the uploader **or** an admin (else 403).
- Do not break `scripts/beta-smoke.sh` or the existing JS callers.

### `api/tasks.php` (EXTEND) — owner: agent T  ← single owner of this file
1. **New writable fields** in create + PATCH (validate types): `start_date`
   (YYYY-MM-DD or null), `position` (double), `milestone_id` (int or null).
   New tasks default `position = (MAX(position) of same project+status) + 1`.
2. **Enrich every task** returned by list (`pm_list_tasks`) AND single-get with
   these fields (batch-load, no N+1, mirror the existing label/assignee batching):
   - `start_date`, `position` (number), `milestone_id`
   - `watchers`: int[] of user ids
   - `blocked_by`: int[] task ids, `blocks`: int[] task ids
   - `time_logged`: int minutes (SUM of time_entries)
   - `custom`: object map `{ "<field_id>": "<value>" }`
3. **Sub-routes** (add to the existing query dispatch):
   - `?id=N&watch=1` `POST` → add current user as watcher `{ok,watchers}`;
     `DELETE` → remove `{ok,watchers}`.
   - `?id=N&activity=1` `GET` → `{activity:[...]}` task-scoped (last 50, join users), for the drawer timeline.
   - `?id=N&comments=1&comment_id=M&reaction=:emoji:` `POST`/`DELETE` → toggle a
     reaction `{ok}`. Also include `reactions` per comment in the comments GET:
     `[{emoji, count, mine:bool}]`, and include `mentions:[userId]` per comment.
4. **Triggers** (use notify_lib.php; never let a notify failure break the request —
   wrap in try/catch):
   - On create: add creator + assignees as watchers.
   - On assignee added (create or PATCH): `pm_notify(assignee, actor, taskId, 'assigned', ...)`.
   - On comment add: notify `pm_task_recipients()`; for each mention id from
     `pm_resolve_mentions(body)` insert a `comment_mentions` row + `mention` notify
     and add them as watchers.
   - On status → done: notify recipients with type `status`.
   - On a task with `blocks` completing: notify watchers of the unblocked tasks (`dependency`).
   Keep existing Slack/recurring behavior intact.

> Agent T: this is the ONLY file you edit. Other backend agents create separate
> files and never touch tasks.php. Dependencies/time/custom values are read by
> tasks.php for payload enrichment but written by their own endpoints.

### `api/bootstrap.php` + `api/auth.php` — owner: lead (already being done)
Adds `pm_csrf_check()` (lenient Origin/Referer check on mutating methods) and
`pm_rate_limit()` (file-based, used by login/register). Agents: ignore.

---

## api.js methods (provided by lead — call these from views)
```
// notifications
API.listNotifications()           -> {notifications, unread}
API.unreadCount()                 -> {unread}
API.markNotificationRead(id)      -> {ok}
API.markAllNotificationsRead()    -> {ok, updated}
API.deleteNotification(id)        -> {ok}
// dependencies
API.listDependencies(taskId)      -> {blocked_by, blocks}
API.addDependency(taskId, dependsOnId) -> {ok}
API.removeDependency(taskId, dependsOnId) -> {ok}
// time
API.listTime(taskId)              -> {entries, total_minutes}
API.addTime(taskId, {minutes, note, spent_on}) -> {entry, total_minutes}
API.deleteTime(entryId)           -> {ok}
// custom fields
API.listCustomFields()            -> {fields}
API.createCustomField(data) / updateCustomField(id, patch) / deleteCustomField(id)
API.setCustomValue(taskId, fieldId, value) -> {ok}
// milestones
API.listMilestones() / createMilestone(data) / updateMilestone(id, patch) / deleteMilestone(id)
// watchers / activity / reactions (task sub-routes)
API.watchTask(taskId) / API.unwatchTask(taskId) -> {ok, watchers}
API.taskActivity(taskId)          -> {activity}
API.addReaction(taskId, commentId, emoji) / API.removeReaction(taskId, commentId, emoji)
// reorder uses the existing updateTask:
API.updateTask(id, { status, position })   // and start_date, milestone_id
```

## window.state additions (provided by lead — views READ these)
```
state.notifications  : array   // current user's notifications
state.unread         : int     // unread count
state.milestones     : array   // [{id,project_id,name,due,status,...}]
state.customFields   : array   // [{id,project_id,name,field_type,options,...}]
state.theme          : 'dark' | 'light'
// view-local state LIFTED here so it survives re-render (NEW — use these):
state.ui = {
  list:     { groupBy:'status', sortBy:'priority', sortDir:'asc', collapsed:{}, selected:[] },
  calendar: { cursor:'<YYYY-MM-01>' },
  checklist:{ expanded:{}, showCompleted:false },
  kanban:   { swimlane:'none' },
  timeline: { zoom:'week', cursor:'<YYYY-MM-DD>' },
}
```
Views must read/write `state.ui.<view>.*` instead of module-local closures, so
state survives `renderApp()`. Helpers/handlers passed to views are unchanged plus:
`onReorder(id, {status, position})`, `onOpenTask`, and `state.ui` access.

## ui.js atoms to BUILD (owner: agent UI) — views/CSS depend on these names
```
relTime(iso)                      // "3m", "2h", "Apr 5" — MOVE here (was in dashboard.js)
fmtMinutes(min)                   // 90 -> "1h 30m"
confirmDialog({title, message, confirmText, danger}) -> Promise<bool>   // replaces confirm()
promptDialog({title, label, value, placeholder, multiline}) -> Promise<string|null> // replaces prompt()
modal({title, body, footer, width}) -> {el, close}  // generic accessible modal (role=dialog, focus trap, Esc, return focus)
datePickerPopover(anchor, value, onPick)   // calendar popover returning YYYY-MM-DD (uses ymd/parseISO)
mentionTextarea({value, onInput, onSubmit, placeholder}) -> textarea el with @-autocomplete against state.users
makeDraggable(el, { onStart, onMove, onDrop, handle })  // pointer-events (mouse+touch) drag helper; returns cleanup fn
sortableList(container, { itemSelector, onReorder })     // optional convenience over makeDraggable
emojiReactionBar(reactions, onToggle)      // small reaction row used by comments
ThemeToggle(onToggle)                       // sun/moon button (icon via Icon('sun'|'moon'))
miniTaskChip(task)                          // compact {ref,title,status-dot} chip for dep lists
```
`makeDraggable` MUST work with touch (pointer events, not HTML5 DnD) so Kanban/
Calendar/List reordering works on phones. Keep all existing ui.js exports.

## app.css classes to BUILD (owner: agent CSS) — views use these names
- **Theme:** keep dark as default in `:root`; add `:root[data-theme="light"]{...}`
  overrides + `@media (prefers-color-scheme: light){ :root:not([data-theme]){...} }`.
  Promote hardcoded status-text literals to tokens (`--green-fg`, `--amber-fg`,
  `--red-fg`, `--violet-fg`, `--cyan-fg`, `--pink-fg`). Add spacing
  (`--sp-1..6`), type (`--fs-xs..2xl`), and motion (`--ease`, `--dur-fast`, `--dur`)
  tokens; apply hover transitions to `.nav-item .nav-proj .chip .pop-item .cal-event .list-row`.
- **Mobile reflow** (the critical fixes): `@media (max-width:720px)` collapse
  `.list-row`/`.list-header` to a stacked card (give list cells class hooks via the
  list agent: `.col-id .col-labels .col-assignees .col-progress .col-actions`);
  `@media (max-width:640px)` turn `.cal-grid` into a single-column agenda; make
  the dashboard grid responsive (add `.dash-grid` wrapper class the dashboard agent will use).
- **New components (provide styles):** `.notif-panel`, `.notif-item`(+`.unread`),
  `.badge-count` (red bubble on the bell), `.dialog`(generic modal) reuse `.modal`,
  `.timeline`, `.tl-row`, `.tl-bar`(+status color), `.tl-grid`, `.tl-axis`,
  `.dep-pill`(+`.blocked`), `.time-entry`, `.reaction`(+`.mine`), `.cf-field`,
  `.mention` (highlighted @name in rendered comments), `.milestone-row`,
  `.drag-ghost`/`.dragging` for pointer-drag, `.empty-cta` (richer empty state w/ icon+button),
  `.density-compact` modifier on `.app`. Keep everything token-based and themable.

## Icons available (icons.js) — owner adds any missing
Existing set includes: search plus bell settings home inbox check checkSquare
kanban list calendar dashboard filter sort more chevronDown/Right/Left x user
users tag flag clock paperclip message alert trendUp trendDown star archive
folder link eye activity power zap sun logout trash. **Lead will add:** `moon`,
`gantt`/`timeline`, `play`, `pause`(exists? no), `dollar`/`timer`, `gitBranch`
(dependencies), `bellOff`, `smile` (reactions), `target` (milestone), `gripVertical`
(drag handle). If you need an icon not present, use the closest existing one and
note it.

## Views to BUILD (wave 2 — after foundation lands)
- `views/detail.js` (agent DETAIL): add to the drawer — **per-task activity
  timeline** (`API.taskActivity`), **@mentions** in the comment composer
  (`mentionTextarea`) + render `.mention` highlights + comment **reactions**
  (`emojiReactionBar`), **dependencies** section (blocked-by/blocks add+remove,
  cycle errors shown), **time tracking** (log time, list entries, show
  logged-vs-estimate), **watchers** (watch/unwatch + avatar list), **start date**
  + **milestone** pickers, **custom fields** editor. Replace `prompt()`/`confirm()`
  with `promptDialog`/`confirmDialog`. Add `role="dialog"` + focus trap (use modal
  helper patterns). Refetch comments on open (drop the stale cache).
- `views/kanban.js` (agent KANBAN): pointer/touch **drag-to-reorder within & across
  columns** using `makeDraggable` + `onReorder(id,{status,position})` (compute
  fractional position between neighbors); per-column **WIP count**; a card **status
  menu** (mobile/keyboard fallback); fix dragleave flicker; show blocked badge
  (task.blocked_by). Read `state.ui.kanban`.
- `views/list.js` (agent LIST): **inline editing** of status/priority/assignees/
  due/labels/milestone via existing pickers; **drag-to-reorder** (makeDraggable);
  **select-all + shift-range select**; real batch label calls; replace the
  `prompt()` set-due with `datePickerPopover`; add cell class hooks
  (`.col-id .col-labels .col-assignees .col-progress .col-actions`) for mobile CSS;
  read/write `state.ui.list` (grouping/sort/collapsed/selected survive re-render);
  per-row `more` menu (open, watch, delete).
- `views/calendar.js` (agent CAL): pointer/touch drag to reschedule
  (`onMoveTaskDate`); **click empty day to create** (`onAddTask` with that due);
  **drop affordance** (`.drag-over`); **persist month** in `state.ui.calendar.cursor`;
  show start→due **spanning bars** when start_date present; mobile agenda (CSS does
  layout — just ensure markup works); "unscheduled" rail to drag from.
- `views/dashboard.js` (agent DASH): **real metrics** (compute actual trend deltas
  vs last week instead of hardcoded 'up'); add **charts** (inline SVG: a 14-day
  completed-vs-created sparkline, time-logged bar); milestone progress; wrap root
  in `.dash-grid` for responsive CSS; keep `relTime` import from ui.js (now shared).
- `views/timeline.js` (NEW, agent TIMELINE): a **Gantt/timeline view**. Export
  `window.renderTimeline(tasks, handlers)`. Rows grouped by project (then milestone),
  horizontal bars from `start_date`→`due` (single-day if only due), drag bar to move
  dates (`onMoveTaskDate` / `updateTask`), draw dependency links where feasible,
  week/month zoom from `state.ui.timeline`. Add a `.tl-*` DOM matching the CSS
  classes above. Must be added to index.html script tags + the view switcher (lead wires that).

## Integration done by the LEAD (do not touch these)
`api.js`, `app.js` (state, handlers, sidebar/topbar notification bell + panel,
theme toggle, settings panels for milestones/custom fields, view switcher +
Timeline tab, PWA registration), `index.html`/`login.html`/`register.html`
(script tags, `?v=` bumps, theme-init inline script, manifest/SW), `manifest.json`,
`sw.js`, `notify_lib.php`, `bootstrap.php`, `auth.php`, `install.php`, `seed.php`, docs.
