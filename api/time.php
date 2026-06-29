<?php
// Time tracking: log + list + delete time_entries for a task.
require_once __DIR__ . '/bootstrap.php';
pm_boot();
$uid = pm_require_auth();

$method = pm_method();
$id = pm_int_param('id');

// Accept YYYY-MM-DD. DATE columns silently coerce weird input, so guard.
// (Mirrors pm_is_valid_date in tasks.php; redeclared because each endpoint
// is a standalone PHP entry point with no shared include beyond bootstrap.)
function pm_time_valid_date(string $d): bool {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) return false;
    [$y, $m, $day] = array_map('intval', explode('-', $d));
    return checkdate($m, $day, $y);
}

// Minimal user shape for time entries: {id, name, initials, color} | null.
// Intentionally narrower than pm_public_user (no email/role/is_admin) per the
// v2 contract's time-entry return shape.
function pm_time_entry_shape(array $r): array {
    $user = null;
    if ($r['user_id'] !== null) {
        $user = [
            'id'       => (int)$r['user_id'],
            'name'     => $r['user_name'],
            'initials' => $r['user_initials'],
            'color'    => $r['user_color'],
        ];
    }
    return [
        'id'         => (int)$r['id'],
        'minutes'    => (int)$r['minutes'],
        'note'       => $r['note'],
        'spent_on'   => $r['spent_on'],
        'created_at' => $r['created_at'],
        'user'       => $user,
    ];
}

function pm_time_total(int $taskId): int {
    $row = pm_fetch_one('SELECT COALESCE(SUM(minutes),0) AS total FROM time_entries WHERE task_id = ?', [$taskId]);
    return (int)($row['total'] ?? 0);
}

if ($method === 'GET') {
    $taskId = pm_int_param('task_id');
    if (!$taskId) pm_error('task_id is required');
    $rows = pm_fetch_all(
        'SELECT te.id, te.task_id, te.user_id, te.minutes, te.note, te.spent_on, te.created_at,
                u.name AS user_name, u.initials AS user_initials, u.color AS user_color
           FROM time_entries te
           LEFT JOIN users u ON u.id = te.user_id
          WHERE te.task_id = ?
          ORDER BY te.spent_on DESC, te.id DESC',
        [$taskId]
    );
    pm_json([
        'entries'       => array_map('pm_time_entry_shape', $rows),
        'total_minutes' => pm_time_total($taskId),
    ]);
}

if ($method === 'POST') {
    $taskId = pm_int_param('task_id');
    if (!$taskId) pm_error('task_id is required');
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);

    $body = pm_body();
    $minutes = (int)($body['minutes'] ?? 0);
    if ($minutes <= 0) pm_error('minutes must be greater than 0');

    $note = $body['note'] ?? null;
    if ($note !== null) {
        $note = mb_substr(trim((string)$note), 0, 255);
        if ($note === '') $note = null;
    }

    $spentOn = trim((string)($body['spent_on'] ?? ''));
    if ($spentOn === '') {
        $spentOn = date('Y-m-d');
    } elseif (!pm_time_valid_date($spentOn)) {
        pm_error('spent_on must be a valid YYYY-MM-DD date');
    }

    pm_exec('INSERT INTO time_entries (task_id, user_id, minutes, note, spent_on) VALUES (?,?,?,?,?)',
        [$taskId, $uid, $minutes, $note, $spentOn]);
    $newId = pm_last_id();
    $row = pm_fetch_one(
        'SELECT te.id, te.task_id, te.user_id, te.minutes, te.note, te.spent_on, te.created_at,
                u.name AS user_name, u.initials AS user_initials, u.color AS user_color
           FROM time_entries te
           LEFT JOIN users u ON u.id = te.user_id
          WHERE te.id = ?',
        [$newId]
    );
    if (!$row) pm_error('Time entry could not be created', 500);
    pm_json([
        'entry'         => pm_time_entry_shape($row),
        'total_minutes' => pm_time_total($taskId),
    ]);
}

if ($method === 'DELETE') {
    if (!$id) pm_error('id is required');
    $row = pm_fetch_one('SELECT id, user_id FROM time_entries WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);

    $me = pm_current_user();
    $isAdmin = $me && !empty($me['is_admin']);
    $isOwner = $row['user_id'] !== null && (int)$row['user_id'] === $uid;
    if (!$isOwner && !$isAdmin) pm_error('Forbidden', 403);

    pm_exec('DELETE FROM time_entries WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
