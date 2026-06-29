<?php
// Shared notification / mention / watcher / reminder helpers (v2).
// In-app first; Slack remains handled separately in tasks.php via slack_client.
// All functions are best-effort: a failure here must never break the request.

require_once __DIR__ . '/db.php';

/** Insert one in-app notification. No self-notify. */
function pm_notify(int $userId, ?int $actorId, ?int $taskId, string $type, string $body): void {
    try {
        if ($userId <= 0) return;
        if ($actorId !== null && $actorId === $userId) return; // don't notify yourself
        pm_exec(
            'INSERT INTO notifications (user_id, actor_id, task_id, type, body, is_read)
             VALUES (?,?,?,?,?,0)',
            [$userId, $actorId, $taskId, substr($type, 0, 32), mb_substr($body, 0, 500)]
        );
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
            if ($uid > 0 && $uid !== $excludeUserId) $ids[$uid] = true;
        }
    } catch (Throwable $_) { /* best effort */ }
    return array_keys($ids);
}

/** Add watcher rows (INSERT IGNORE). $userIds int[]. */
function pm_add_watchers(int $taskId, array $userIds): void {
    foreach ($userIds as $uid) {
        $uid = (int)$uid;
        if ($uid <= 0) continue;
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
        // Throttle: at most once per ~5 minutes per deployment.
        $last = pm_fetch_one("SELECT value FROM app_settings WHERE name = 'notify.last_sweep'");
        $now = time();
        if ($last && is_numeric(trim((string)$last['value'], '"'))) {
            $ts = (int)trim((string)$last['value'], '"');
            if ($now - $ts < 300) return;
        }
        pm_exec(
            "INSERT INTO app_settings (name, value) VALUES ('notify.last_sweep', ?)
             ON DUPLICATE KEY UPDATE value = VALUES(value)",
            [json_encode($now)]
        );
    } catch (Throwable $_) { return; /* if settings table is unavailable, skip */ }

    // 1) Explicit reminders that have come due.
    try {
        $due = pm_fetch_all(
            "SELECT r.id, r.task_id, r.user_id, t.ref, t.title
             FROM reminders r JOIN tasks t ON t.id = r.task_id
             WHERE r.sent_at IS NULL AND r.remind_at <= NOW()
             LIMIT 200"
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
        foreach ($soon as $t) {
            $taskId = (int)$t['id'];
            $when = ($t['due'] === date('Y-m-d')) ? 'due today' : 'due tomorrow';
            $body = $t['ref'] . ' ' . $t['title'] . ' is ' . $when;
            $assignees = pm_fetch_all('SELECT user_id FROM task_assignees WHERE task_id = ?', [$taskId]);
            $isNew = false;
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
                if (!$exists) { pm_notify($uid, null, $taskId, 'due_soon', $body); $isNew = true; }
            }
            // Fire due_soon automations at most once per task per day (tied to the
            // newly-created daily notification, so actions don't repeat every sweep).
            if ($isNew && function_exists('pm_run_automations')) {
                try { pm_run_automations('due_soon', $taskId); } catch (Throwable $_) { /* best effort */ }
            }
        }
    } catch (Throwable $_) { /* best effort */ }
}

// Load the optional automation engine AFTER our helpers are defined, so its
// require_once of this file is already satisfied (no load-order fatal). Guarded
// so a partial deploy without the engine can't break notifications.
if (is_file(__DIR__ . '/automations_lib.php')) require_once __DIR__ . '/automations_lib.php';
