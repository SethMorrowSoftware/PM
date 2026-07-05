<?php
// Intake forms (admin CRUD). The public submission page is /form.php?f=<token>.
// A form is a capability URL that lets anyone (no account) file a task into a
// chosen project — print it as a QR code and stick it on the arcade wall.
require_once __DIR__ . '/bootstrap.php';
pm_boot();
$uid = pm_require_auth();
pm_require_admin();

$method = pm_method();
$id     = pm_int_param('id');

function pm_intake_shape(array $r): array {
    return [
        'id'               => (int)$r['id'],
        'project_id'       => (int)$r['project_id'],
        'token'            => $r['token'],
        'name'             => $r['name'],
        'description'      => $r['description'],
        'default_status'   => $r['default_status'],
        'default_priority' => (int)$r['default_priority'],
        'default_label_id' => $r['default_label_id'] === null ? null : (int)$r['default_label_id'],
        'default_assignees'=> json_decode((string)($r['default_assignees'] ?? ''), true) ?: [],
        'enabled'          => !empty($r['enabled']),
        'submissions'      => (int)$r['submissions'],
        'created_at'       => $r['created_at'],
    ];
}

if ($method === 'GET') {
    $rows = pm_fetch_all('SELECT * FROM intake_forms ORDER BY id');
    pm_json(['forms' => array_map('pm_intake_shape', $rows)]);
}

if ($method === 'POST' && $id === null) {
    $b = pm_body();
    $projectId = (int)($b['project_id'] ?? 0);
    if (!$projectId || !pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$projectId])) {
        pm_error('A valid project_id is required');
    }
    $name = mb_substr(trim((string)($b['name'] ?? '')), 0, 200);
    if ($name === '') pm_error('Name is required');
    $prio = isset($b['default_priority']) ? max(0, min(3, (int)$b['default_priority'])) : 2;
    $labelId = !empty($b['default_label_id']) ? (int)$b['default_label_id'] : null;
    $assignees = [];
    foreach (($b['default_assignees'] ?? []) as $a) { $a = (int)$a; if ($a > 0) $assignees[] = $a; }
    pm_exec(
        'INSERT INTO intake_forms (project_id, token, name, description, default_priority, default_label_id, default_assignees, created_by)
         VALUES (?,?,?,?,?,?,?,?)',
        [
            $projectId, bin2hex(random_bytes(24)), $name,
            trim((string)($b['description'] ?? '')) ?: null,
            $prio, $labelId,
            $assignees ? json_encode(array_values(array_unique($assignees))) : null,
            $uid,
        ]
    );
    $row = pm_fetch_one('SELECT * FROM intake_forms WHERE id = ?', [pm_last_id()]);
    pm_json(['form' => pm_intake_shape($row)]);
}

if ($method === 'PATCH' && $id !== null) {
    $row = pm_fetch_one('SELECT * FROM intake_forms WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);
    $b = pm_body();
    $fields = []; $params = [];
    if (array_key_exists('name', $b)) {
        $name = mb_substr(trim((string)$b['name']), 0, 200);
        if ($name === '') pm_error('Name cannot be empty');
        $fields[] = 'name = ?'; $params[] = $name;
    }
    if (array_key_exists('description', $b)) {
        $fields[] = 'description = ?'; $params[] = trim((string)$b['description']) ?: null;
    }
    if (array_key_exists('enabled', $b)) { $fields[] = 'enabled = ?'; $params[] = !empty($b['enabled']) ? 1 : 0; }
    if (array_key_exists('default_priority', $b)) {
        $fields[] = 'default_priority = ?'; $params[] = max(0, min(3, (int)$b['default_priority']));
    }
    if (array_key_exists('default_label_id', $b)) {
        $fields[] = 'default_label_id = ?'; $params[] = !empty($b['default_label_id']) ? (int)$b['default_label_id'] : null;
    }
    if (array_key_exists('default_assignees', $b)) {
        $assignees = [];
        foreach ((array)$b['default_assignees'] as $a) { $a = (int)$a; if ($a > 0) $assignees[] = $a; }
        $fields[] = 'default_assignees = ?';
        $params[] = $assignees ? json_encode(array_values(array_unique($assignees))) : null;
    }
    if ($fields) {
        $params[] = $id;
        pm_exec('UPDATE intake_forms SET ' . implode(', ', $fields) . ' WHERE id = ?', $params);
    }
    $row = pm_fetch_one('SELECT * FROM intake_forms WHERE id = ?', [$id]);
    pm_json(['form' => pm_intake_shape($row)]);
}

if ($method === 'DELETE' && $id !== null) {
    pm_exec('DELETE FROM intake_forms WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
