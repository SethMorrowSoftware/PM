# Project Manager (cPanel-friendly, no build step)

A multi-user project/task manager built for shared hosting.

This app is designed to run on typical **cPanel + PHP + MySQL/MariaDB** hosting with:

- No Node.js
- No Composer
- No daemon workers
- No shell requirement in production

It preserves the original design direction in `design/` while shipping a production-ready vanilla JS + PHP implementation.

## Current product status (April 22, 2026)

The software is currently a full multi-view task manager with:

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

For release validation coverage, see `docs/regression-checklist.md`.

## Tech stack

| Layer | Implementation |
|---|---|
| Frontend | Vanilla ES modules via script tags (no bundler), plain CSS, inline SVG icon set |
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

- **Dashboard**: summary cards, workload, activity feed
- **Kanban**: drag/drop status movement
- **List**: grouping/sorting + bulk actions
- **Checklist (My tasks)**: assignee-focused personal queue
- **Calendar**: month view with drag-to-reschedule support

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
├── install.php             # run once, then delete in deployed environments
├── PLAN.md                 # roadmap/progress document
└── README.md
```

## Install and deploy (cPanel)

1. **Create DB + user in cPanel** with full privileges.
2. **Upload files** to your target web directory.
3. **Edit `api/config.php`** with DB credentials and desired flags.
4. Open **`/install.php`** and run schema + default seed.
5. Create the first admin account in installer UI.
6. **Delete `install.php`** after successful setup.
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

The installer includes additive migration helpers to backfill missing columns/indexes/FKs on older installs.

## Authorization model

- All task read/write operations require authentication.
- Project/label/task write operations are available to all authenticated users.
- Slack/recurring settings write operations require admin privileges.
- User role/admin mutations require admin privileges.
- Server-side checks are authoritative (UI visibility is not the only control).

## Operational notes

- No build pipeline: file edits deploy directly.
- For cache busting, bump `?v=` query params in HTML script/link tags.
- If using HTTPS, set `cookie_secure` to `true`.
- Keep `api/.htaccess` protections in place.

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
