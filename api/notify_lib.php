<?php
// Shared notification / mention / watcher / reminder helpers (v2).
// In-app first; Slack remains handled separately in tasks.php via slack_client.
// All functions are best-effort: a failure here must never break the request.

require_once __DIR__ . '/db.php';
// Email mirroring (guarded so a partial deploy without the file is harmless).
if (is_file(__DIR__ . '/mail_lib.php')) require_once __DIR__ . '/mail_lib.php';
// Per-project access checks — guarded include + function_exists() at each call
// site, so an install without the file keeps the legacy open model (fail open).
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';

/** Insert one in-app notification. No self-notify. */
function pm_notify(int $userId, ?int $actorId, ?int $taskId, string $type, string $body): void {
    try {
        if ($userId <= 0) return;
        if ($actorId !== null && $actorId === $userId) return; // don't notify yourself
        // Never deliver task content across the private-project boundary: a
        // recipient who can't read the task gets no notification (and no email
        // mirror). This is the single choke point for every fan-out — assigned/
        // comment/mention/status/dependency and the reminder/due-soon sweep.
        if ($taskId !== null && function_exists('pm_can_read_task')
            && !pm_can_read_task($userId, $taskId)) return;
        pm_exec(
            'INSERT INTO notifications (user_id, actor_id, task_id, type, body, is_read)
             VALUES (?,?,?,?,?,0)',
            [$userId, $actorId, $taskId, substr($type, 0, 32), mb_substr($body, 0, 500)]
        );
        // Mirror to email per the user's preference (fail-silent inside).
        if (function_exists('pm_mail_notification')) {
            pm_mail_notification($userId, $type, $body, $taskId);
        }
    } catch (Throwable $_) { /* best effort */ }
}

/** Notify a list of user ids (deduped, excluding the actor). */
function pm_notify_users(array $userIds, ?int $actorId, ?int $taskId, string $type, string $body): void {
    $seen = [];
    foreach ($userIds as $uid) {
        $uid = (int)$uid;
        if ($uid <= 0 || isset($seen[$uid])) continue;
        $seen[$uid] = true;
        pm_notify($uid, $actorId, $taskId, $type, $body);
    }
}

/** Recipients for a task = assignees ∪ watchers, minus an excluded user. Returns int[]. */
function pm_task_recipients(int $taskId, ?int $excludeUserId = null): array {
    $ids = [];
    try {
        $rows = pm_fetch_all(
            'SELECT user_id FROM task_assignees WHERE task_id = ?
             UNION SELECT user_id FROM task_watchers WHERE task_id = ?',
            [$taskId, $taskId]
        );
        foreach ($rows as $r) {
            $uid = (int)$r['user_id'];
            if ($uid <= 0 || $uid === $excludeUserId) continue;
            // Drop stale subscribers who can no longer read the task (e.g. a
            // watcher row left over from before the project went private).
            if (function_exists('pm_can_read_task') && !pm_can_read_task($uid, $taskId)) continue;
            $ids[$uid] = true;
        }
    } catch (Throwable $_) { /* best effort */ }
    return array_keys($ids);
}

/** Add watcher rows (INSERT IGNORE). $userIds int[]. */
function pm_add_watchers(int $taskId, array $userIds): void {
    foreach ($userIds as $uid) {
        $uid = (int)$uid;
        if ($uid <= 0) continue;
        // Never subscribe someone who can't read the task — a stray @mention on
        // a private task would otherwise feed them every future comment.
        if (function_exists('pm_can_read_task') && !pm_can_read_task($uid, $taskId)) continue;
        try {
            pm_exec('INSERT IGNORE INTO task_watchers (task_id, user_id) VALUES (?,?)', [$taskId, $uid]);
        } catch (Throwable $_) { /* best effort */ }
    }
}

/**
 * Parse "@name" tokens in free text and resolve to user ids.
 * Matches a user's full name (case-insensitive) or a *unique* first name.
 * Never matches bare initials. Returns int[].
 */
function pm_resolve_mentions(string $text): array {
    if (strpos($text, '@') === false) return [];
    $hits = [];
    try {
        $users = pm_fetch_all('SELECT id, name FROM users');
        // Build first-name uniqueness map.
        $firstCounts = [];
        foreach ($users as $u) {
            $first = strtolower(trim(preg_split('/\s+/', (string)$u['name'])[0] ?? ''));
            if ($first !== '') $firstCounts[$first] = ($firstCounts[$first] ?? 0) + 1;
        }
        $lc = strtolower($text);
        foreach ($users as $u) {
            $name = strtolower(trim((string)$u['name']));
            if ($name === '') continue;
            $first = strtolower(preg_split('/\s+/', (string)$u['name'])[0] ?? '');
            $matched = strpos($lc, '@' . $name) !== false;
            if (!$matched && $first !== '' && ($firstCounts[$first] ?? 0) === 1) {
                // unique first name → allow "@First" with a word boundary after it
                if (preg_match('/@' . preg_quote($first, '/') . '\b/', $lc)) $matched = true;
            }
            if ($matched) $hits[(int)$u['id']] = true;
        }
    } catch (Throwable $_) { /* best effort */ }
    return array_keys($hits);
}

/**
 * Lazy background work: fire due reminders and due-soon notifications.
 * Safe to call on any authenticated request; self-throttles via app_settings.
 * No cron required — this is the "do background work on an HTTP request" model.
 */
function pm_run_due_sweep(): void {
    try {
        // Throttle: at most once per ~5 minutes per deployment. The claim must be
        // atomic — a read-check-then-write lets two concurrent requests both pass
        // the window and run the sweep together, double-sending reminders and
        // firing due_soon automations twice. A conditional UPDATE serialized by
        // the row lock guarantees exactly one winner per window.
        $now = time();
        pm_exec("INSERT IGNORE INTO app_settings (name, value) VALUES ('notify.last_sweep', '0')");
        $claimed = pm_exec(
            "UPDATE app_settings SET value = ?
             WHERE name = 'notify.last_sweep'
               AND ? - CAST(TRIM('\"' FROM value) AS UNSIGNED) >= 300",
            [json_encode($now), $now]
        );
        if ($claimed < 1) return; // another request already swept inside this window
    } catch (Throwable $_) { return; /* if settings table is unavailable, skip */ }

    // 1) Explicit reminders that have come due. remind_at stores the creator's
    // LOCAL wall-clock time verbatim (the datetime-local form posts no zone and
    // there is no per-user timezone), so compare against wall-clock "now" in
    // the site's timezone — NOT the UTC-pinned MySQL NOW(), which fires hours
    // early/late for any non-UTC team. Matches the frontend's local-wall-clock
    // convention for dates (see CLAUDE.md).
    try {
        $due = pm_fetch_all(
            "SELECT r.id, r.task_id, r.user_id, t.ref, t.title
             FROM reminders r JOIN tasks t ON t.id = r.task_id
             WHERE r.sent_at IS NULL AND r.remind_at <= ?
             LIMIT 200",
            [pm_local_now()]
        );
        foreach ($due as $r) {
            $taskId = (int)$r['task_id'];
            $body = 'Reminder: ' . $r['ref'] . ' ' . $r['title'];
            $targets = $r['user_id'] !== null ? [(int)$r['user_id']] : pm_task_recipients($taskId, null);
            pm_notify_users($targets, null, $taskId, 'reminder', $body);
            pm_exec('UPDATE reminders SET sent_at = NOW() WHERE id = ?', [(int)$r['id']]);
        }
    } catch (Throwable $_) { /* best effort */ }

    // 2) Due-soon: tasks due today/tomorrow, not done — notify assignees once/day.
    try {
        $soon = pm_fetch_all(
            "SELECT t.id, t.ref, t.title, t.due
             FROM tasks t
             WHERE t.status <> 'done' AND t.due IS NOT NULL
               AND t.due BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 1 DAY)
             LIMIT 500"
        );
        // due_soon automations fire once per task per day, tracked in a small
        // app_settings JSON map — NOT tied to the assignee notifications below,
        // which never exist for unassigned tasks (a due_soon rule's most
        // natural target: "when due soon → assign someone").
        $today = date('Y-m-d');
        $auto = [];
        $autoDirty = false;
        if (function_exists('pm_run_automations')) {
            $row = pm_fetch_one("SELECT value FROM app_settings WHERE name = 'notify.due_soon_auto'");
            $j = json_decode((string)($row['value'] ?? ''), true);
            if (is_array($j)) $auto = $j;
        }
        foreach ($soon as $t) {
            $taskId = (int)$t['id'];
            $when = ($t['due'] === date('Y-m-d')) ? 'due today' : 'due tomorrow';
            $body = $t['ref'] . ' ' . $t['title'] . ' is ' . $when;
            $assignees = pm_fetch_all('SELECT user_id FROM task_assignees WHERE task_id = ?', [$taskId]);
            foreach ($assignees as $a) {
                $uid = (int)$a['user_id'];
                if ($uid <= 0) continue;
                // Dedupe: one due_soon per task per user per calendar day.
                $exists = pm_fetch_one(
                    "SELECT id FROM notifications
                     WHERE user_id = ? AND task_id = ? AND type = 'due_soon'
                       AND created_at >= CURDATE() LIMIT 1",
                    [$uid, $taskId]
                );
                if (!$exists) pm_notify($uid, null, $taskId, 'due_soon', $body);
            }
            if (function_exists('pm_run_automations') && ($auto[(string)$taskId] ?? '') !== $today) {
                try { pm_run_automations('due_soon', $taskId); } catch (Throwable $_) { /* best effort */ }
                $auto[(string)$taskId] = $today;
                $autoDirty = true;
            }
        }
        if ($autoDirty) {
            // Keep only today's markers so the map never grows unbounded.
            foreach ($auto as $k => $d) { if ($d !== $today) unset($auto[$k]); }
            pm_exec(
                "INSERT INTO app_settings (name, value) VALUES ('notify.due_soon_auto', ?)
                 ON DUPLICATE KEY UPDATE value = ?",
                [json_encode($auto), json_encode($auto)]
            );
        }
    } catch (Throwable $_) { /* best effort */ }

    // 3) Morning email digests (once per user per day; no cron needed).
    if (function_exists('pm_mail_run_digests')) {
        try { pm_mail_run_digests(); } catch (Throwable $_) { /* best effort */ }
    }
}

/**
 * Wall-clock "now" for comparing against user-entered local times (reminders).
 * Uses the optional config key 'timezone' (e.g. 'America/New_York'); without it
 * this falls back to PHP's current default — pinned to UTC in pm_boot(), so
 * behavior is unchanged on installs that never set the key. Reminders are
 * stored as the creator's wall-clock time, so a configured site timezone makes
 * them fire on time for teams that don't live at UTC.
 */
function pm_local_now(): string {
    try {
        $tz = (string)(pm_config()['timezone'] ?? '');
        if ($tz !== '') return (new DateTime('now', new DateTimeZone($tz)))->format('Y-m-d H:i:s');
    } catch (Throwable $_) { /* invalid tz string — fall back to server clock */ }
    return date('Y-m-d H:i:s');
}

// Load the optional automation engine AFTER our helpers are defined, so its
// require_once of this file is already satisfied (no load-order fatal). Guarded
// so a partial deploy without the engine can't break notifications.
if (is_file(__DIR__ . '/automations_lib.php')) require_once __DIR__ . '/automations_lib.php';
