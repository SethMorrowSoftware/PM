# CLAUDE.md

Guidance for Claude Code (and future AI collaborators) when working in this
repo. Read this before touching code.

## What this project is

A multi-user project/task manager (Kanban / List / Calendar / Dashboard /
My-Tasks) that runs on a plain shared **cPanel** host. Hard constraints:

- **No build step, no bundler, no Node.js, no Composer, no shell access.**
  Files must be editable in cPanel's File Manager and take effect on the next
  page load.
- **PHP 8+** with **PDO** against **MySQL / MariaDB** only.
- **Vanilla ES-2020 JS** + plain CSS. No frameworks. No TypeScript. No transpile.
- Target user flow: drag-drop files into `public_html/pm/`, edit
  `api/config.php`, run `install.php`, delete it, sign in.

When you're tempted to add a dependency, a toolchain, or a migration system:
**stop**. The whole value prop is "this works on a $5/mo cPanel box in five
minutes". Any change that breaks that contract is a regression.

## Repository layout

```
/
├── index.html           main SPA shell (after login)
├── login.html           sign-in page
├── register.html        self-serve registration (gated by config flag)
├── install.php          one-time installer; DELETE after running
├── .htaccess            DirectoryIndex + hide dotfiles
├── api/
│   ├── config.php       DB creds + flags. Protected from direct HTTP.
│   ├── db.php           pm_db(), pm_fetch_all/one, pm_exec, pm_last_id
│   ├── bootstrap.php    session, JSON body parsing, auth guards
│   ├── auth.php         ?action=me|login|logout|register|update_profile
│   ├── tasks.php        tasks + subtasks + comments (sub-routed via query)
│   ├── projects.php     project CRUD (writes are admin-only)
│   ├── labels.php       label CRUD (writes are admin-only)
│   ├── users.php        list + PATCH + DELETE team members
│   ├── activity.php     last 40 activity rows
│   └── .htaccess        denies direct access to config.php
├── assets/
│   ├── css/app.css      token-based styling for the app
│   ├── css/auth.css     login / register styles
│   └── js/
│       ├── api.js       fetch wrapper + API.* methods
│       ├── icons.js     Lucide-style inline SVG factory
│       ├── ui.js        h() hyperscript + avatars, tags, pickers, popovers, toast
│       ├── app.js       shell: sidebar, topbar, filters, quick-add, profile
│       └── views/
│           ├── dashboard.js  stats + workload + activity feed
│           ├── kanban.js     drag-drop columns
│           ├── list.js       groupable + sortable table
│           ├── checklist.js  "My tasks" view
│           ├── calendar.js   month grid
│           └── detail.js     task drawer (inline edits, subtasks, comments)
├── docs/
│   └── regression-checklist.md  release-gate smoke tests + auth matrix
└── design/              original Claude Design HTML mockup (reference only)
```

## Tech stack boundaries

- **Backend**: one PHP file per REST resource. Sub-routes are dispatched via
  `?subtasks=1` / `?comments=1` / `?id=N&subtask_id=M` query params (see
  `api/tasks.php:10-26`). All DB access goes through PDO prepared statements
  (`pm_fetch_all`, `pm_fetch_one`, `pm_exec` in `api/db.php`).
- **Schema**: defined inline in `install.php:pm_install_schema`. InnoDB,
  `utf8mb4`. Tables: `users`, `projects`, `labels`, `tasks`, `subtasks`,
  `task_assignees`, `task_labels`, `comments`, `activity`. FKs cascade
  deletes except `comments.user_id` / `activity.user_id`, which go to
  `NULL` so the history survives a user deletion.
- **Auth**: PHP sessions (`pm_sid` cookie), HttpOnly, Lax. `is_admin` is a
  column on `users`. `pm_require_auth()` / `pm_require_admin()` guard
  endpoints server-side.
- **Frontend**: `<script src>` tags in `index.html` in strict load order —
  `icons.js` → `api.js` → `ui.js` → `views/*.js` → `app.js`. Everything is
  on `window`; there are no modules. The app uses a single mutable
  `window.state` object and re-renders by replacing the root on every
  change (see `renderApp()` in `assets/js/app.js`).
- **DOM helper**: `h(tag, props, ...children)` in `assets/js/ui.js:7`. No
  JSX, no templating. Read this helper before writing any view code — event
  handlers are `onClick` / `onInput` (camelCase, added via
  `addEventListener`), `class` sets `className`, `style` accepts an object.

## Conventions

### Backend (PHP)

- Every endpoint starts with `require_once __DIR__ . '/bootstrap.php'; pm_boot();`
  followed by `pm_require_auth()` (or `pm_require_admin()` for admin-only).
- Responses always go through `pm_json()` or `pm_error()`. Never `echo`
  directly; the boot step has already sent `Content-Type: application/json`
  and `X-Content-Type-Options: nosniff`.
- Read the request body with `pm_body()` (cached JSON decode), individual
  fields with `pm_param($key)` (checks GET then body) or `pm_int_param`.
- All SQL is parameterized. If you need a dynamic `IN (?,?,?)` list, build
  the placeholder string from `array_fill` (see `pm_list_tasks` in
  `api/tasks.php:81` for the canonical pattern).
- Task `ref` generation has a retry-on-23000 loop
  (`api/tasks.php:155-181`). Don't simplify it away — two concurrent
  creators can read the same `MAX(ref)+1` and collide on the UNIQUE index.
- New schema changes go into `pm_install_schema` as `CREATE TABLE IF NOT
  EXISTS`, plus (if the change affects existing installs) an idempotent
  `ALTER` helper modelled on `pm_migrate_comment_user_nullable`
  (`install.php:205-228`). There is no migration framework — installs
  re-run `install.php` manually.

### Frontend (JS)

- Add new API calls as methods on the `API` object in `assets/js/api.js`.
- New UI atoms go in `assets/js/ui.js`; new views get their own file under
  `assets/js/views/` and must be added to the `<script>` tags in
  `index.html` (and to `renderMain()`'s `switch` in `app.js` if it's a
  top-level view).
- Date math is local-wall-clock. Use `today()`, `ymd()`, `daysFromNow()`,
  `parseISO()` from `ui.js`. **Don't** use `toISOString()` for task dues —
  it shifts calendar days for anyone east of UTC.
- Cache-busting: there's no bundler, so after editing a JS/CSS file bump
  the `?v=N` query param on the `<script>` / `<link>` tag in
  `index.html` (and `login.html` / `register.html` if relevant). See
  README.md:97-102.

### Security

- Passwords: `password_hash(PASSWORD_DEFAULT)` + `password_verify`.
- Email is normalized to lowercase on both `register` and `login` so case
  differences land on the same row regardless of DB collation.
- `cookie_secure` is off by default (so local HTTP works); flip it on in
  `api/config.php` once the site is HTTPS-only.
- `api/.htaccess` denies direct HTTP reads of `config.php`. Do not remove.
- Admin-only writes (`projects.php`, `labels.php`, admin patches of
  `users.php`) check `is_admin` server-side. Don't rely on UI hiding.
- `install.php` self-locks once any admin exists, unless the caller is
  logged in as an admin. But the expected state in production is that the
  file is **deleted** after first run.

## Common tasks

### Adding a new API endpoint

1. Create `api/<resource>.php` following the pattern in
   `api/projects.php` or `api/labels.php`.
2. Dispatch on `pm_method()` + `pm_int_param('id')`.
3. Call `pm_require_admin()` before any write that mutates shared config.
4. Log user-visible activity with `pm_log_activity($uid, $taskId, $action,
   $detail)` (definition at `api/tasks.php:338`) when appropriate.
5. Add the matching method on `API` in `assets/js/api.js`.

### Adding a new view

1. New file under `assets/js/views/`. Export via `window.renderFooView = …`.
2. Add a `<script src>` for it to `index.html` **before** `app.js`.
3. Add it to the `viewDef` array in `renderFilters()` and the `switch` in
   `renderMain()` inside `assets/js/app.js`.
4. Persist with `localStorage.setItem('pm_view', state.view)`.

### Adding a schema change

1. Edit `pm_install_schema` in `install.php` to include the new column /
   table in the `CREATE TABLE IF NOT EXISTS` block.
2. If existing installs need the change, add an idempotent migration
   function called from `pm_install_schema`. Check
   `INFORMATION_SCHEMA.COLUMNS` before altering, like
   `pm_migrate_comment_user_nullable` does.
3. Document the re-run in the PR description — operators have to visit
   `install.php` again to apply it (and then delete it again).

## v2 capabilities (added on top of the original)

The app has grown well past its first cut. As of v2 it also ships:

- **In-app notifications** (`api/notifications.php`, `api/notify_lib.php`): bell +
  unread badge + dropdown, polled every 60s. Triggers live in `tasks.php`
  (assign / comment / mention / status-done / dependency-unblocked). A lazy
  due-soon + reminder **sweep** runs on requests (no cron) — `pm_run_due_sweep()`.
- **@mentions** in comments (`comment_mentions`), **reactions** on comments
  (`comment_reactions`), **watchers** (`task_watchers`).
- **Planning**: manual drag-ordering via `tasks.position` (Kanban + List,
  pointer/touch), **task dependencies** (`api/dependencies.php`, cycle-checked),
  **start dates** + a **Timeline/Gantt view** (`views/timeline.js`),
  **milestones** (`api/milestones.php`, admin-managed).
- **Time tracking** (`api/time.php`, `time_entries`) and **custom fields**
  (`api/custom_fields.php`, `custom_fields`/`task_custom_values`, admin-defined).
- **Light/dark theming** via `:root[data-theme]` + `prefers-color-scheme`, a
  topbar toggle, persisted in `localStorage.pm_theme` (also set pre-paint by an
  inline script in every HTML head).
- **PWA**: `manifest.json` + `sw.js` (offline shell, never caches `/api/`) +
  `assets/icon.svg`. Mobile: pointer/touch drag everywhere; List/Calendar/
  Dashboard reflow on phones.
- **Hardening**: upload MIME sniff + allow-list, attachment-delete ownership,
  lenient CSRF origin check + file-based login/register rate limiting
  (`pm_csrf_check` / `pm_rate_limit` in `bootstrap.php`).

(File attachments, an Admin Settings UI, and refresh-on-change already shipped
before v2; v2 adds light polling for notifications but still no SSE/websockets —
impractical on shared cPanel hosting.)

### v2 conventions worth knowing
- **View-local UI state lives in `window.state.ui.<view>`** (list grouping/sort/
  selection, calendar/timeline cursor, checklist expansion). This survives the
  coarse `renderApp()` re-render — do NOT put it back in module closures.
- Shared frontend atoms in `ui.js`: `relTime`, `fmtMinutes`,
  `confirmDialog`/`promptDialog`/`modal` (accessible — **use instead of
  `prompt()`/`confirm()`**), `datePickerPopover`, `mentionTextarea`,
  `makeDraggable` (pointer/touch — **not** HTML5 DnD), `emojiReactionBar`,
  `ThemeToggle`, `miniTaskChip`.
- `app.js` exposes `window.pmRefreshTasks / pmLoadNotifications /
  pmLoadMilestones / pmLoadCustomFields / pmToggleTheme` for views/the drawer.
- New notification triggers/recipients go through `api/notify_lib.php`
  (`pm_notify`, `pm_task_recipients`, `pm_add_watchers`, `pm_resolve_mentions`).
- Script load order now also includes `views/timeline.js` and
  `views/admin-extras.js` before `app.js`. The full v2 build spec is in
  `docs/V2-CONTRACT.md`.

## Authorization model (current)

All **authenticated** users may read/write tasks, projects, and labels (a
deliberate team-collaboration choice — see README + recent history; the
"writes are admin-only" lines earlier in this file describe the original
intent and are retained for context only). **Admin only**: Slack settings,
recurring rules, user role changes, **custom-field definitions, and milestone
create/edit/delete**. Attachment delete requires uploader-or-admin. Server-side
checks remain authoritative.

## Don'ts

- **Don't** introduce Composer, Node, a bundler, or a package manager.
- **Don't** switch to a framework (React, Vue, Tailwind, Laravel, etc.).
- **Don't** rely on browser modules (`import`/`export`) — this repo uses
  script tags on the `window` global and the hosting constraints mean we
  can't add a bundler to collapse modules for production.
- **Don't** assume CLI or cron access exists. If a feature needs
  background work, make it happen lazily on an HTTP request.
- **Don't** commit `api/config.php` with real credentials. The template
  values shipped in-tree are placeholders.
- **Don't** amend published commits or force-push `main`.

## Quick reference

- Start a session locally: any PHP 8 + MySQL setup works. Point a vhost at
  the repo root, create the DB, edit `api/config.php`, hit `/install.php`.
- Hard-reload after editing JS/CSS: `Ctrl+Shift+R`. For shared deploys,
  bump the `?v=` query string on `<script>` / `<link>` tags.
- Keyboard shortcuts: `Ctrl+K` (or `⌘K`) focuses global search; `Ctrl+N`
  (or `⌘N`) opens the quick-add modal.
- Direct-link to a task: `index.html#task=<id>`. `app.js` wires the hash
  in both directions (see `syncTaskFromHash()`).
