<?php
require_once __DIR__ . '/bootstrap.php';
pm_boot();
$uid = pm_require_auth();

require_once __DIR__ . '/notify_lib.php';
// Per-project access (guarded; notify_lib already includes it, kept explicit).
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';

$method = pm_method();
$id = pm_int_param('id');

// Self-refresh: fire any due reminders / due-soon notifications before reading.
// Best-effort and self-throttled inside notify_lib, so it's cheap on every hit.
pm_run_due_sweep();

// Hide notifications about tasks in private projects the user can't read —
// covers rows created before a project went private (new leaks are blocked at
// the source in pm_notify). Task-less rows and rows whose task was deleted
// stay visible, matching the existing orphan behavior.
$notifWhere = '';
$notifParams = [$uid];
if (function_exists('pm_readable_project_ids')) {
    $readable = pm_readable_project_ids($uid);
    if ($readable !== null) {
        if ($readable) {
            $ph = implode(',', array_fill(0, count($readable), '?'));
            $notifWhere = " AND (n.task_id IS NULL OR t.id IS NULL OR t.project_id IN ($ph))";
            foreach ($readable as $rid) $notifParams[] = (int)$rid;
        } else {
            $notifWhere = ' AND (n.task_id IS NULL OR t.id IS NULL)';
        }
    }
}

if ($method === 'GET') {
    // Cheap unread-count-only path (still ran the sweep above).
    if (pm_param('unread') !== null) {
        $row = pm_fetch_one(
            "SELECT COUNT(*) AS c FROM notifications n
             LEFT JOIN tasks t ON t.id = n.task_id
             WHERE n.user_id = ? AND n.is_read = 0$notifWhere",
            $notifParams
        );
        pm_json(['unread' => (int)($row['c'] ?? 0)]);
    }

    $rows = pm_fetch_all(
        "SELECT n.id, n.type, n.body, n.task_id, n.is_read, n.created_at,
                n.actor_id, u.name AS actor_name, u.initials AS actor_initials, u.color AS actor_color
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         LEFT JOIN tasks t ON t.id = n.task_id
         WHERE n.user_id = ?$notifWhere
         ORDER BY n.id DESC
         LIMIT 50",
        $notifParams
    );

    $unreadRow = pm_fetch_one(
        "SELECT COUNT(*) AS c FROM notifications n
         LEFT JOIN tasks t ON t.id = n.task_id
         WHERE n.user_id = ? AND n.is_read = 0$notifWhere",
        $notifParams
    );

    pm_json([
        'notifications' => array_map(fn($r) => [
            'id'         => (int)$r['id'],
            'type'       => $r['type'],
            'body'       => $r['body'],
            'task_id'    => $r['task_id'] !== null ? (int)$r['task_id'] : null,
            'is_read'    => (int)$r['is_read'] === 1,
            'created_at' => $r['created_at'],
            'actor'      => $r['actor_id'] !== null ? [
                'id'       => (int)$r['actor_id'],
                'name'     => $r['actor_name'] ?? 'Former teammate',
                'initials' => $r['actor_initials'] ?? '??',
                'color'    => $r['actor_color'] ?? '#64748B',
            ] : null,
        ], $rows),
        'unread' => (int)($unreadRow['c'] ?? 0),
    ]);
}

if ($method === 'PATCH') {
    $body = pm_body();
    $isRead = !empty($body['is_read']) ? 1 : 0;

    // Mark all of the current user's notifications.
    if (pm_param('all') !== null) {
        $updated = pm_exec(
            'UPDATE notifications SET is_read = ? WHERE user_id = ?',
            [$isRead, $uid]
        );
        pm_json(['ok' => true, 'updated' => $updated]);
    }

    // Mark a single own row.
    if ($id !== null) {
        pm_exec(
            'UPDATE notifications SET is_read = ? WHERE id = ? AND user_id = ?',
            [$isRead, $id, $uid]
        );
        pm_json(['ok' => true]);
    }

    pm_error('Notification id is required');
}

if ($method === 'DELETE') {
    if ($id === null) pm_error('Notification id is required');
    pm_exec('DELETE FROM notifications WHERE id = ? AND user_id = ?', [$id, $uid]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
