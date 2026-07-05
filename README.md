# Project Manager (cPanel-friendly, no build step)

A multi-user project/task manager built for shared hosting.

This app is designed to run on typical **cPanel + PHP + MySQL/MariaDB** hosting with:

- No Node.js
- No Composer
- No daemon workers
- No shell requirement in production

It preserves the original design direction in `design/` while shipping a production-ready vanilla JS + PHP implementation.

## Current product status

The software has grown well past its first cut (see "What's new in v2" and
"Beyond v2" below — the codebase is at the v2.9 feature set). At its core it is
a full multi-view task manager with:

- Auth, profile updates, and admin/member permissions
- Project and label management (including archive + merge controls)
- Task CRUD with subtasks, comments, assignees, labels, due dates, priority, estimate
- Dashboard, Kanban, List, Checklist, and Calendar views
- Saved views and list bulk actions
- Recurring task rules API
- Task attachments with DB metadata + filesystem storage + upload/download/delete API
- Slack integration API with event toggles, templates, test delivery, and delivery history fields

## What's new in v2

A major upgrade toward Monday/Asana-grade depth, still 100% no-build / cPanel-friendly:

- **Collaboration** — in-app **notification center** (bell + unread badge,
  polled), **@mentions** with autocomplete, comment **reactions**, task
  **watchers/followers**, and a **per-task activity timeline** in the drawer.
- **Planning & scheduling** — manual **drag-to-reorder** (touch + mouse) on the
  Kanban board and List, **task dependencies** (blocked-by / blocks, cycle-safe),
  **start dates**, a new **Timeline / Gantt view**, and **milestones**.
- **Tracking & reporting** — **time logging** (vs. estimate), per-project
  **custom fields**, and a **dashboard** with honest week-over-week trends and
  inline throughput / time / milestone charts.
- **Polish** — **light & dark themes** (toggle + OS preference), an accessible
  dialog system (no more `prompt()`/`confirm()`), a refined design-token system,
  and **mobile-first** reflow (List/Calendar/Dashboard) with touch drag-and-drop.
- **Installable PWA** — `manifest.json` + service worker for an app-like,
  offline-tolerant shell (the API is always fetched live).
- **Hardening** — upload MIME sniffing + allow-list, attachment-delete
  ownership, a CSRF origin check, and login/registration rate limiting.

See `docs/V2-CONTRACT.md` for the full v2 implementation spec.

### Beyond v2

- **v2.1** — **automation rules** (when→then, fired lazily in-request), **task
  templates**, per-task **reminders**, and **CSV export**.
- **v2.2** — **command palette** (⌘K), a **Workload** view, and a paginated,
  filterable **Audit/Activity log**.
- **v2.3** — saved views capture full **layout** (grouping/sort/columns), a
  **compact/comfortable density** toggle, and a **keyboard-shortcuts help** (press `?`).
- **v2.4** — **Goals / OKRs** (link goals to projects, auto or manual progress).
- **v2.5** — **CSV import**, mobile **bottom-nav**, and task **duplicate**.
- **v2.6** — **per-project access control**: projects have a `visibility`
  (`open` — the legacy all-can-read/write default — or `private`), with
  `project_members` roles (`owner`/`editor`/`viewer`). See the Authorization
  model below and `api/access_lib.php`.
- **v2.7 / v2.8** — safe **Markdown** in descriptions/comments, full
  **read-only** affordances for `viewer`-role members, and private-project
  board locks.
- **v2.9** — attachment **image thumbnails + lightbox**, a **customizable
  dashboard**, and **server-side task search** (`tasks.php?search=`).

For release validation coverage, see `docs/regression-checklist.md`.

## Tech stack

| Layer | Implementation |
|---|---|
| Frontend | Vanilla ES2020 JS on the `window` global (plain `<script>` tags in a fixed load order — **no ES modules, no bundler**), plain CSS, inline SVG icon set |
| Backend | Plain PHP endpoints (`api/*.php`), session-based auth, PDO helpers |
| Database | MySQL/MariaDB (InnoDB, utf8mb4) |
| State | API-backed data + `localStorage` for persisted UI preferences |

## Core capabilities

### 1) Authentication and user profiles

- Session-based login/logout
- Registration flow (public registration toggle in `api/config.php`)
- Admin-created users through API
- Profile editing (name/role/color)
- Password change requiring current password confirmation

### 2) Task lifecycle

- Create/update/delete tasks
- Auto-generated project-key references (e.g. `CTT-104`)
- Status, priority, due date, estimate, description updates
- Multi-assignee and multi-label support
- Subtasks CRUD
- Comment thread CRUD (with moderation rules enforced server-side)
- Deep-linkable task drawer via URL hash (`#task=<id>`)

### 3) Views

- **Dashboard**: customizable summary cards, workload, activity feed, charts
- **Kanban**: drag/drop status movement + manual reorder
- **List**: grouping/sorting (incl. Manual/position) + bulk actions
- **Checklist (My tasks)**: assignee-focused personal queue
- **Calendar**: month view with drag-to-reschedule support
- **Timeline / Gantt**: start→due bars, dependencies, milestones
- **Workload**: per-assignee capacity view
- **Activity**: paginated, filterable audit log
- **Goals**: OKRs linked to projects

### 4) Filtering and productivity

- Project, assignee, and label filters
- Live global search (`Ctrl/Cmd + K`)
- Quick create (`Ctrl/Cmd + N`)
- Saved personal views (`saved_views` table + API)
- Persisted selected view + project filter in `localStorage`

### 5) Project administration

From the in-app **Admin settings** modal:

- Create/edit/archive/unarchive/delete projects
- Project metadata: name, key prefix, color, description
- Optional per-project Slack channel override
- Archived projects hidden from default sidebar/API listing

### 6) Label administration

From the in-app **Admin settings** modal:

- Create/edit/archive/unarchive/delete labels
- Global or project-scoped labels
- Duplicate prevention by scope (`name + scope`)
- Usage-aware safeguards (archive/delete conflict handling)
- Label merge operation to consolidate taxonomy

### 7) Slack integration

Admin-only Slack endpoints support:

- Save integration settings and token
- Enable/disable event types (`task_created`, `task_completed`, `task_assigned`, `comment_added`, `project_archived`, `mention_added`)
- Message template overrides per event
- Test message sending
- Last success/error telemetry and delivery history payload support

Slack settings are available in the in-app **Admin settings** modal and via `api/slack.php`.

### 8) Recurring tasks

Admin-only recurring rule endpoints support:

- Cadences: daily, weekly, monthly, yearly
- Interval and cadence-specific date fields (weekday/month day/month of year)
- End conditions (`ends_on`, `occurrences_left`)
- Pause/resume behavior
- Next-run date tracking and linkage via `tasks.recurring_rule_id`

Recurring rule management is available in the in-app **Admin settings** modal and via `api/recurring.php`.

## Repository layout

```text
.
├── api/
│   ├── auth.php            # login/logout/register/me/update_profile
│   ├── bootstrap.php       # session + auth + JSON helpers
│   ├── config.php          # environment config and feature flags
│   ├── db.php              # PDO and query helpers
│   ├── tasks.php           # task, subtask, comment CRUD + bulk patch
│   ├── projects.php        # project CRUD + archive semantics
│   ├── labels.php          # label CRUD + merge/archive governance
│   ├── recurring.php       # recurring rule CRUD (admin writes)
│   ├── slack.php           # Slack settings/test (admin-only)
│   ├── slack_client.php    # outbound Slack delivery helpers
│   ├── users.php           # user list/admin patch-delete
│   ├── activity.php        # activity feed endpoint
│   ├── saved_views.php     # per-user saved filter/view presets
│   └── settings.php        # app_settings table read/write helpers
├── assets/
│   ├── css/
│   │   ├── app.css
│   │   └── auth.css
│   └── js/
│       ├── app.js
│       ├── api.js
│       ├── ui.js
│       ├── icons.js
│       └── views/
│           ├── dashboard.js
│           ├── kanban.js
│           ├── list.js
│           ├── checklist.js
│           ├── calendar.js
│           └── detail.js
├── docs/
│   └── regression-checklist.md
├── design/                 # reference/mockup assets
├── index.html
├── login.html
├── register.html
├── manifest.json           # PWA manifest
├── sw.js                   # service worker (offline shell; never caches /api/)
├── storage/                # runtime data (attachments, ratelimit) — gitignored
├── install.php             # run once, then DELETE in deployed environments
├── seed.php                # optional demo-data seeder (admin-only) — DELETE in prod
├── PLAN.md                 # roadmap/progress document
└── README.md
```

> The `api/` and `assets/js/views/` trees above are abbreviated — the full v2
> build adds many more endpoints (`access_lib.php`, `project_members.php`,
> `milestones.php`, `custom_fields.php`, `time.php`, `dependencies.php`,
> `notifications.php`, `notify_lib.php`, `attachments.php`, `automations.php`,
> `templates.php`, `reminders.php`, `goals.php`, …) and views (`timeline.js`,
> `workload.js`, `activity.js`, `goals.js`, `import.js`, `command-palette.js`,
> `admin-extras.js`). See `CLAUDE.md` for the authoritative layout.

## Install and deploy (cPanel)

1. **Create DB + user in cPanel** with full privileges.
2. **Upload files** to your target web directory.
3. **Edit `api/config.php`** with DB credentials and desired flags.
4. Open **`/install.php`** and run schema + default seed.
5. Create the first admin account in installer UI.
6. **Delete `install.php`** (and `seed.php`, if uploaded) after successful setup.
7. Log in at `login.html`.

## Configuration

Edit `api/config.php`:

- Database connection values
- Session cookie settings (`cookie_secure`, `cookie_samesite`)
- `allow_public_register`
- App defaults (`app_name`, `project_key`)

## Database model highlights

Installer creates and migrates the following core tables:

- `users`
- `projects`
- `labels`
- `tasks`
- `subtasks`
- `task_assignees`
- `task_labels`
- `comments`
- `activity`
- `app_settings`
- `recurring_rules`
- `saved_views`

Plus the v2+ tables: `task_attachments`, `task_dependencies`, `milestones`,
`time_entries`, `custom_fields`, `task_custom_values`, `notifications`,
`comment_mentions`, `comment_reactions`, `task_watchers`, `reminders`,
`task_templates`, `automation_rules`, `goals`, `goal_projects`, and
`project_members`.

The installer includes additive migration helpers to backfill missing columns/indexes/FKs on older installs. Re-run `install.php` (then delete it again) to apply schema changes to an existing database.

## Authorization model

- All reads/writes require authentication; server-side checks are authoritative
  (UI hiding is never the only control).
- **Open projects** (the default `visibility` for every project, incl. all
  legacy ones): any authenticated user can read and write their tasks, labels,
  and project settings — the original team-collaboration behavior.
- **Private projects** (v2.6): only `project_members` can read; `owner`/`editor`
  can write; `viewer` is read-only. Global admins bypass all project
  restrictions. Enforcement is centralized in `api/access_lib.php` and applied
  across `tasks.php`, `projects.php`, and every task-scoped endpoint
  (attachments/time/dependencies/custom-values/reminders) as well as the list
  endpoints (milestones/labels/recurring/templates/custom_fields/automations),
  which filter out rows for private projects the caller can't read.
- **Admin only**: Slack settings, recurring rules, automation rules, task
  templates, **custom-field definitions**, **milestone create/edit/delete**,
  user role/admin mutations, project visibility/membership, and a project's
  Slack channel. Attachment/time-entry delete requires uploader/owner-or-admin.
- Project membership + visibility are managed in **Admin Settings → Project
  access** (`api/project_members.php`).

## Operational notes

- No build pipeline: file edits deploy directly.
- For cache busting, bump `?v=` query params in HTML script/link tags.
- If using HTTPS, set `cookie_secure` to `true`.
- Keep the `.htaccess` protections in place (`api/.htaccess` hides
  `config.php`; the root rules block `.git`/dotfiles and disable directory
  listings; `storage/.htaccess` denies direct access to uploads).
- **Delete `install.php` AND `seed.php` after setup.** Both are destructive,
  browser-run tools. `seed.php` wipes and reseeds all data and now requires an
  authenticated admin session (it will not run for an anonymous visitor).
- **Deploy without `.git`.** Copy the working tree (not the repository) into
  `public_html`, or the root `.htaccess` VCS block is your only protection.
  Don't commit real DB credentials into `api/config.php` — it's a placeholder
  template (see `.gitignore`).
- **Background work is lazy (no cron):** notifications/reminders/due-soon fire
  from `pm_run_due_sweep()` on notification polls, and recurring tasks spawn
  when the current instance is completed. On a very low-traffic site, a cPanel
  cron hitting `api/notifications.php` every few minutes makes delivery timely.
- **Storage growth:** uploaded attachments accumulate under
  `storage/attachments`; rate-limit files under `storage/ratelimit` are
  GC'd opportunistically. For attachment confidentiality on non-Apache
  (pure-Nginx) cPanel stacks, set `attachments_dir` in `config.php` to a path
  outside the web root. Take periodic DB + `storage/` backups.

## Regression and QA

Use `docs/regression-checklist.md` as release-gate verification for:

- Auth flows
- Task CRUD
- View consistency
- Filters/shortcuts
- Admin-only surfaces
- Permissions matrix
- Data integrity behaviors

## Known limitations / next recommended work

- No realtime push transport (polling/reload patterns currently used).
- No background worker process (intentional for shared-host compatibility).

## Compatibility target

- PHP 8+
- MySQL/MariaDB versions commonly available on cPanel shared hosting
- Modern evergreen browsers
