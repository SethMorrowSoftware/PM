<?php
// Per-task reminders. The reminders table ships in install.php; due reminders
// are delivered by pm_run_due_sweep() in notify_lib.php (lazy, no cron).
require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
$uid = pm_require_auth();

$method = pm_method();
$id      = pm_int_param('id');
$taskId  = pm_int_param('task_id');

function pm_reminder_norm_dt($v): ?string {
    $v = trim((string)$v);
    if ($v === '') return null;
    $v = str_replace('T', ' ', $v);
    if (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/', $v)) $v .= ':00';
    if (!preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $v)) return null;
    $ts = strtotime($v);
    return $ts === false ? null : date('Y-m-d H:i:s', $ts);
}

if ($method === 'GET') {
    if (!$taskId) pm_error('task_id required');
    if (function_exists('pm_can_read_task') && !pm_can_read_task($uid, $taskId)) pm_error('Forbidden', 403);
    $rows = pm_fetch_all(
        'SELECT id, task_id, user_id, remind_at, channel, sent_at, created_at
         FROM reminders WHERE task_id = ? ORDER BY remind_at ASC',
        [$taskId]
    );
    pm_json(['reminders' => array_map(function ($r) {
        return [
            'id'         => (int)$r['id'],
            'task_id'    => (int)$r['task_id'],
            'user_id'    => $r['user_id'] !== null ? (int)$r['user_id'] : null,
            'remind_at'  => $r['remind_at'],
            'channel'    => $r['channel'],
            'sent_at'    => $r['sent_at'],
            'created_at' => $r['created_at'],
        ];
    }, $rows)]);
}

if ($method === 'POST') {
    if (!$taskId) pm_error('task_id required');
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);
    if (function_exists('pm_can_write_task') && !pm_can_write_task($uid, $taskId)) pm_error('Forbidden', 403);
    $when = pm_reminder_norm_dt(pm_param('remind_at', ''));
    if ($when === null) pm_error('Valid remind_at (YYYY-MM-DD HH:MM) required');
    // user_id: default to me; allow null for "everyone on the task".
    $forAll = (string)pm_param('everyone', '') === '1';
    $targetUid = $forAll ? null : $uid;
    pm_exec(
        'INSERT INTO reminders (task_id, user_id, remind_at, channel) VALUES (?,?,?,?)',
        [$taskId, $targetUid, $when, 'inapp']
    );
    $newId = pm_last_id();
    $r = pm_fetch_one('SELECT id, task_id, user_id, remind_at, channel, sent_at, created_at FROM reminders WHERE id = ?', [$newId]);
    pm_json(['reminder' => [
        'id' => (int)$r['id'], 'task_id' => (int)$r['task_id'],
        'user_id' => $r['user_id'] !== null ? (int)$r['user_id'] : null,
        'remind_at' => $r['remind_at'], 'channel' => $r['channel'],
        'sent_at' => $r['sent_at'], 'created_at' => $r['created_at'],
    ]], 201);
}

if ($method === 'DELETE') {
    if (!$id) pm_error('id required');
    $row = pm_fetch_one('SELECT task_id, user_id FROM reminders WHERE id = ?', [$id]);
    if (!$row) pm_error('Reminder not found', 404);
    if (function_exists('pm_can_write_task') && !pm_can_write_task($uid, (int)$row['task_id'])) pm_error('Forbidden', 403);
    $me = pm_current_user();
    $isAdmin = $me && !empty($me['is_admin']);
    if ($row['user_id'] !== null && (int)$row['user_id'] !== $uid && !$isAdmin) {
        pm_error('Forbidden', 403);
    }
    pm_exec('DELETE FROM reminders WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
