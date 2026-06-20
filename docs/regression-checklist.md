# Regression checklist

Release-gate smoke tests. Run these in order before merging a PR that
touches shared surfaces (API, schema, core JS/CSS) or before deploying a
new build to shared hosting. Each step lists the expected pass signal;
fail = block the release.

If a step needs database state, use the **Known-good seed** recipe in
`§7` below. All steps assume the app is served at `/pm/` (adjust paths
as needed).

---

## 0. Pre-flight

- [ ] Run `./scripts/beta-smoke.sh` and confirm `beta-smoke: OK`.
- [ ] `api/config.php` has real DB credentials on target host.
- [ ] `/install.php` is deleted from the deploy target (or re-added
  just-in-time for a planned schema re-run and deleted again).
- [ ] Hard-reload: `Ctrl+Shift+R` / `Cmd+Shift+R`, or bump the `?v=` on
  the `<script>` / `<link>` tags in `index.html`, `login.html`, and
  `register.html`.

## 1. Authentication

| # | Action | Expected |
|---|---|---|
| 1.1 | Hit `index.html` with no session | Redirects to `login.html`. |
| 1.2 | Log in with valid admin creds | Lands on `index.html`, sidebar loads, dashboard renders. |
| 1.3 | Log in with wrong password | Inline error, no redirect. |
| 1.4 | Log in with varying email case (e.g. `ADMIN@x.com` vs `admin@x.com`) | Both resolve to the same user. |
| 1.5 | Reload `index.html` after login | Stays logged in (session cookie persisted). |
| 1.6 | Click Profile, change name/role/avatar color, save | Toast "Profile updated", sidebar footer reflects new name. |
| 1.7 | Profile: change password with wrong current password | Inline error, password not changed. |
| 1.8 | Profile: change password correctly, log out, log back in with new password | Succeeds. |
| 1.9 | `register.html` when `allow_public_register = false` | API rejects with 403; form surfaces the error. |
| 1.10 | `register.html` when `allow_public_register = true` | New member account created; login works. |
| 1.11 | Click "Log out" | Session ends; next request redirects to login. |

## 2. Task CRUD

| # | Action | Expected |
|---|---|---|
| 2.1 | Quick-add via `Ctrl+N`/`⌘N` (or New task button), title only | Task created, drawer opens on new task. |
| 2.2 | Quick-add with project/priority/assignee/labels pre-selected | All metadata saved; card reflects them in list/kanban. |
| 2.3 | Open existing task, edit title inline | Saves on blur; updated across views. |
| 2.4 | Change status from drawer, from kanban drag-drop, and from list status pill | All three paths persist and produce an `activity` row. |
| 2.5 | Change assignees (add + remove) | New assignees receive Slack event if enabled; removed assignees get no ping. |
| 2.6 | Set due date to today, yesterday, and a week out | Due chip colorises correctly (today = amber, overdue = red, distant = neutral). |
| 2.7 | Add 3 subtasks, toggle one done, delete one | All three operations reflect in task payload without a page refresh. |
| 2.8 | Delete a task | Removed from all views; drawer closes; hash cleared. |
| 2.9 | `index.html#task=<id>` deep-link with valid id | Drawer opens to that task. |
| 2.10 | `index.html#task=99999999` (bogus id) | Hash is cleared and drawer stays closed without error. |

## 3. Views

| # | Action | Expected |
|---|---|---|
| 3.1 | Dashboard | Stat tiles, workload bars, and activity feed render; counts match visible tasks. |
| 3.2 | Kanban | Five columns render. Drag a card across columns; status persists on reload. |
| 3.3 | List | Grouping + sorting controls work; comment count badge shows on tasks with comments. |
| 3.4 | Checklist ("My tasks") | Only tasks assigned to me show; count in sidebar matches. |
| 3.5 | Calendar | Month grid renders; task dots appear on due dates; navigation forward/back works. |
| 3.6 | Task detail drawer | Opens, lets me edit each field, close via X or Esc. |

## 4. Filters, search, shortcuts

| # | Action | Expected |
|---|---|---|
| 4.1 | Click a project in sidebar | Project filter pill applied; task count in topbar drops. |
| 4.2 | Assignee + labels filter combined | Tasks matching all three constraints shown. Count updates. |
| 4.3 | Clear filters button | All filters removed; full list restored. |
| 4.4 | `Ctrl+K` / `⌘K` outside a modal/input | Global search input focused. |
| 4.5 | Typing in search | Filters tasks live by title + ref. |
| 4.6 | `Ctrl+N` / `⌘N` outside modals/inputs | Quick-add modal opens. |
| 4.6a | `Ctrl+N`/`Ctrl+K` while a modal is open (detail drawer, quick-add, profile, settings) or while focus is inside any `<input>`/`<textarea>` | Shortcut is ignored; the keystroke reaches the focused field normally. |
| 4.7 | `Esc` inside quick-add / profile / detail | Closes the modal cleanly, no orphan scrim. |
| 4.8 | Reload page after selecting a view + project filter | View + project filter restored from `localStorage`. |

## 5. Projects, labels, recurring, Slack (admin-only surfaces)

These require an admin session. Most flows are now reachable from Admin
Settings UI; API/curl checks remain useful as backend validation.

| # | Action | Expected |
|---|---|---|
| 5.1 | Admin: create project via API (`POST /api/projects.php`) | New project appears in sidebar and project picker. |
| 5.2 | Admin: archive a project | Project hidden from default project list; task deletion guard kicks in if tasks exist and `force=1` is not passed. |
| 5.3 | Member: attempt to create a project | HTTP 403, no row written. |
| 5.4 | Admin: create a label (global + project-scoped) | Both appear in label picker filtered by project. |
| 5.5 | Admin: create a duplicate label name in same scope | HTTP 409 with useful error. |
| 5.6 | Admin: archive a label in use | HTTP 409 unless `force=1`; prompt lists `use_count`. |
| 5.7 | Admin: create recurring rule (daily/weekly/monthly/yearly) | Rule stored; `next_run` populated. |
| 5.8 | Mark a recurring-spawned task done | Next instance appears at `next_run`. |
| 5.9 | Recurring: past `ends_on` or exhausted `occurrences_left` | Rule auto-pauses on next spawn attempt. |
| 5.10 | Admin: Slack `POST /api/slack.php?action=save` with a bogus token | Rejected with "Token should start with xoxb- or xoxp-". |
| 5.11 | Admin: Slack `?action=test` with default channel | Posts a test message; `last_ok_at` updates. Bad channel → 502 + `last_error` updated. |
| 5.12 | Complete a task with `task_completed` event enabled and a channel set | Slack receives a formatted notice. App still returns 200 even if Slack is unreachable. |

## 6. Authorization matrix

Spot-check the key "member vs admin" boundaries. The table lists the
expected HTTP status for an authenticated **member** (non-admin). Admin
always gets 2xx if the payload is valid.

| Endpoint | Method | Member expected |
|---|---|---|
| `/api/projects.php` | `GET` | 200 |
| `/api/projects.php` | `POST` | 403 |
| `/api/projects.php?id=N` | `PATCH` | 403 |
| `/api/projects.php?id=N` | `DELETE` | 403 |
| `/api/labels.php` | `GET` | 200 |
| `/api/labels.php` | `POST` | 403 |
| `/api/labels.php?id=N` | `PATCH` | 403 |
| `/api/labels.php?id=N` | `DELETE` | 403 |
| `/api/users.php` | `GET` | 200 |
| `/api/users.php?id=N` | `PATCH` | 403 |
| `/api/users.php?id=N` | `DELETE` | 403 |
| `/api/slack.php` | `GET` | 403 |
| `/api/slack.php` | `POST` | 403 |
| `/api/recurring.php` | `GET` | 200 |
| `/api/recurring.php` | `POST` | 403 |
| `/api/recurring.php?id=N` | `PATCH` | 403 |
| `/api/recurring.php?id=N` | `DELETE` | 403 |
| `/api/tasks.php` | `GET/POST/PATCH/DELETE` | 200 (all authenticated users) |

A simple way to run this is `curl -b cookie.txt -X <METHOD> .../api/...`
after logging in with `curl -c cookie.txt -d '...' .../api/auth.php?action=login`.

## 7. Data integrity

| # | Action | Expected |
|---|---|---|
| 7.1 | Delete a user who authored comments and activity rows | Comments survive with "Former teammate"; activity rows keep `user_id = NULL`. |
| 7.2 | Delete a project with cascade | Tasks, task_labels, task_assignees, subtasks, comments for those tasks all removed. |
| 7.3 | Delete a label in use with `force=1` | `task_labels` rows for that label disappear; tasks survive. |
| 7.4 | Re-run `/install.php` on an existing database | No destructive changes; idempotent `pm_migrate_*` helpers only add missing columns/indexes. |
| 7.5 | PATCH a task with both `title` and `status` in the same body | Activity log records `old → new` with the *real* old status, not a stray character of the new title. |
| 7.6 | Member (non-admin) selects rows in List and clicks "Mark done" / "Set due" | Bulk update succeeds (200); affected tasks reflect the change after refresh. |
| 7.7 | Open recurring rule editor, save with priority "Urgent" | Stored value is `0` (matches task priority semantics); spawned task shows the Urgent flag. |
| 7.8 | Hit `/seed.php` while signed out (after install) | Form is hidden behind a "Seeder locked" notice; submitting still 403s. |
| 7.9 | View dashboard activity feed five minutes after creating a task | "5m ago" label is correct regardless of cPanel host time zone. |

## 8. Known-good seed data recipe

When a tester needs a clean-ish state, run this once:

1. On a throwaway database, run `/install.php` → Run install → Create first admin.
2. Log in as admin.
3. Create three extra users via `POST /api/auth.php?action=register` (flip
   `allow_public_register` temporarily or call as admin).
4. Create two extra projects via API, one archived.
5. Create six tasks spanning all five statuses and at least two projects.
   Add a couple of subtasks, assign multiple people, slap on a label.
6. Post two comments on one of the tasks.
7. Optional: configure Slack with a sandbox workspace bot token; fire a
   test message to confirm plumbing.

This dataset is enough to exercise every view, every filter, the
permission matrix above, and the Slack/recurring paths.

---

## 9. v2 features (collaboration / planning / tracking / mobile / theme)

Run after upgrading an existing install (re-run `install.php` to apply the
additive migrations, then delete it). Each row: member vs admin where relevant.

### 9.1 Notifications & collaboration
- Assign a teammate to a task → they see a bell badge + a notification; clicking
  it opens the task and marks it read. "Mark all read" clears the badge.
- Comment with `@Name` → that user gets a `mention` notification; the rendered
  comment highlights the mention. Non-mentioned watchers/assignees get a
  `comment` notification (not the mentioned user twice).
- React to a comment (emoji) → count updates, toggling off removes your reaction.
- Watch/unwatch a task → you start/stop receiving its notifications.
- Per-task **activity timeline** in the drawer shows status/assignee/comment history.
- Due-soon: a task due today/tomorrow generates one `due_soon` notification per
  assignee per day (lazy sweep on request; no cron).

### 9.2 Planning & scheduling
- Drag a card to reorder within/across Kanban columns (mouse AND touch); order
  persists across reload (`tasks.position`). Same for List drag handle.
- Add a dependency (blocked-by) in the drawer; attempting a self-link or a cycle
  is rejected with a clear message.
- Set a start date + due; the task renders as a **bar** on the Timeline view;
  drag the bar to shift dates. Milestone (admin-created) groups tasks.

### 9.3 Tracking & reporting
- Log time on a task; total shows vs estimate; delete your own entry (admin can
  delete any). Dashboard shows real week-over-week trends + charts.
- Admin defines a custom field (e.g. select); it appears in the drawer and its
  value persists. Non-admins can set values but not define fields (expect 403 on
  POST `custom_fields.php`).

### 9.4 Mobile, theme, PWA, security
- On a phone width: List/Calendar/Dashboard reflow (no horizontal overflow);
  Kanban/Calendar drag works by touch.
- Theme toggle switches light/dark and persists; no flash on reload; auth pages
  honor it. `prefers-color-scheme` applies when no explicit choice.
- App is installable (manifest + service worker); offline shows the shell; API
  calls are never served stale from cache.
- Upload a `.svg`/unknown file → it downloads as `application/octet-stream`
  (not rendered). Deleting an attachment you didn't upload → 403 unless admin.
- Rapid wrong-password logins eventually return HTTP 429.

---

## Phase tracking

Each numbered phase in `PLAN.md` §15 adds specific coverage here:

- **Phase 0 (this file)**: regression checklist baseline.
- **Phase 1**: Admin Settings UI. Once it lands, §5 rows are reachable
  from the UI and should be re-verified there — not just via curl.
- **Phase 2**: Comment edit/delete/mentions. Adds rows under a new
  "Collaboration" section.
- **Phase 3**: Slack diagnostics + retries + per-project overrides. Adds
  rows to §5 and a "Diagnostics" column.
- **Phase 4**: Saved views / bulk ops / drag-to-reschedule / templates.
  Adds rows to §3 and §4.
- **Phase 5**: Reporting + automations + recurring reminders. Adds rows
  for scheduled-window delivery and automation rule firings.

Update this file alongside each PR. If a new test is painful to run, it
is a bug, not a testing problem — fix the bug.
