<?php
// Task templates. Each row is a reusable blueprint for creating a task
// (title/description/priority/estimate/status + default labels, assignees,
// and a checklist of subtasks). project_id NULL means the template is global.
//
// This endpoint is PURE CRUD. Applying a template to spawn a real task is done
// client-side by reusing the existing task-create endpoint, so there is no
// "apply" route here.
//
// All authenticated users can list templates; create/edit/delete are admin-only
// (templates are shared team config, like recurring rules).

require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
$uid = pm_require_auth();

$method = pm_method();
$id     = pm_int_param('id');

// Mirror recurring.php: the labels/assignees columns hold a JSON array of ints.
function pm_template_decode_ids($raw): array {
    if ($raw === null || $raw === '') return [];
    $decoded = json_decode((string)$raw, true);
    return is_array($decoded) ? array_values(array_map('intval', $decoded)) : [];
}

function pm_template_encode_ids($v): string {
    if (!is_array($v)) return '[]';
    $clean = array_values(array_unique(array_filter(
        array_map('intval', $v),
        static fn($n) => $n > 0
    )));
    return json_encode(array_values($clean));
}

// subtasks_json holds a JSON array of non-empty, trimmed title strings.
function pm_template_decode_subtasks($raw): array {
    if ($raw === null || $raw === '') return [];
    $decoded = json_decode((string)$raw, true);
    if (!is_array($decoded)) return [];
    $out = [];
    foreach ($decoded as $s) {
        $s = trim((string)$s);
        if ($s !== '') $out[] = $s;
    }
    return $out;
}

function pm_template_encode_subtasks($v): string {
    if (!is_array($v)) return '[]';
    $out = [];
    foreach ($v as $s) {
        $s = trim((string)$s);
        if ($s !== '') $out[] = $s;
    }
    return json_encode($out);
}

function pm_template_shape(array $r): array {
    return [
        'id'             => (int)$r['id'],
        'project_id'     => isset($r['project_id']) && $r['project_id'] !== null ? (int)$r['project_id'] : null,
        'name'           => $r['name'],
        'title'          => $r['title'],
        'description'    => $r['description'],
        'priority'       => (int)$r['priority'],
        'estimate'       => $r['estimate'],
        'default_status' => $r['default_status'],
        'labels'         => pm_template_decode_ids($r['labels'] ?? null),
        'assignees'      => pm_template_decode_ids($r['assignees'] ?? null),
        'subtasks'       => pm_template_decode_subtasks($r['subtasks_json'] ?? null),
    ];
}

// Tasks accept priority 0..3 (Urgent..Low). Clamp into range so applied
// templates don't carry values the UI can't render.
function pm_template_clamp_priority($v): int {
    return max(0, min(3, (int)$v));
}

function pm_template_scope_exists(?int $projectId): void {
    if ($projectId === null) return;
    $proj = pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$projectId]);
    if (!$proj) pm_error('Invalid project_id');
}

if ($method === 'GET' && $id === null) {
    // Hide templates scoped to private projects the caller can't read; global
    // (project_id IS NULL) templates stay visible.
    $params = [];
    $where = function_exists('pm_readable_project_where')
        ? pm_readable_project_where($uid, 'project_id', $params) : '';
    $sql = 'SELECT * FROM task_templates'
        . ($where !== '' ? " WHERE $where" : '')
        . ' ORDER BY name';
    $rows = pm_fetch_all($sql, $params);
    pm_json(['templates' => array_map('pm_template_shape', $rows)]);
}

if ($method === 'POST' && $id === null) {
    pm_require_admin();
    $body = pm_body();

    $name = trim((string)pm_param('name', ''));
    if ($name === '') pm_error('Name required');

    $projectId = pm_int_param('project_id');
    pm_template_scope_exists($projectId);

    $title         = isset($body['title']) ? (string)$body['title'] : '';
    $description   = $body['description'] ?? null;
    $priority      = pm_template_clamp_priority($body['priority'] ?? 2);
    $estimate      = isset($body['estimate']) && $body['estimate'] !== '' ? (string)$body['estimate'] : null;
    $defaultStatus = isset($body['default_status']) && trim((string)$body['default_status']) !== ''
        ? (string)$body['default_status'] : 'todo';

    pm_exec(
        'INSERT INTO task_templates
            (project_id, name, title, description, priority, estimate, default_status,
             labels, assignees, subtasks_json, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [
            $projectId, $name, $title, $description, $priority, $estimate, $defaultStatus,
            pm_template_encode_ids($body['labels'] ?? []),
            pm_template_encode_ids($body['assignees'] ?? []),
            pm_template_encode_subtasks($body['subtasks'] ?? []),
            pm_current_user_id(),
        ]
    );
    $row = pm_fetch_one('SELECT * FROM task_templates WHERE id = ?', [pm_last_id()]);
    pm_json(['template' => pm_template_shape($row)]);
}

if ($method === 'PATCH' && $id !== null) {
    pm_require_admin();
    $row = pm_fetch_one('SELECT id FROM task_templates WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);

    $body = pm_body();
    $f = []; $p = [];

    if (isset($body['name'])) {
        $name = trim((string)$body['name']);
        if ($name === '') pm_error('Name cannot be empty');
        $f[] = 'name = ?'; $p[] = $name;
    }
    if (array_key_exists('title', $body)) {
        $f[] = 'title = ?'; $p[] = (string)$body['title'];
    }
    if (array_key_exists('description', $body)) {
        $f[] = 'description = ?'; $p[] = $body['description'];
    }
    if (array_key_exists('priority', $body)) {
        $f[] = 'priority = ?'; $p[] = pm_template_clamp_priority($body['priority']);
    }
    if (array_key_exists('estimate', $body)) {
        $f[] = 'estimate = ?'; $p[] = ($body['estimate'] === null || $body['estimate'] === '') ? null : (string)$body['estimate'];
    }
    if (array_key_exists('default_status', $body)) {
        $ds = trim((string)$body['default_status']);
        if ($ds === '') pm_error('default_status cannot be empty');
        $f[] = 'default_status = ?'; $p[] = $ds;
    }
    if (array_key_exists('project_id', $body)) {
        $pid = $body['project_id'];
        if ($pid === null || $pid === '') {
            $f[] = 'project_id = NULL';
        } else {
            $pid = (int)$pid;
            pm_template_scope_exists($pid);
            $f[] = 'project_id = ?'; $p[] = $pid;
        }
    }
    if (array_key_exists('labels', $body)) {
        $f[] = 'labels = ?'; $p[] = pm_template_encode_ids($body['labels']);
    }
    if (array_key_exists('assignees', $body)) {
        $f[] = 'assignees = ?'; $p[] = pm_template_encode_ids($body['assignees']);
    }
    if (array_key_exists('subtasks', $body)) {
        $f[] = 'subtasks_json = ?'; $p[] = pm_template_encode_subtasks($body['subtasks']);
    }

    if (!$f) pm_error('Nothing to update');
    $p[] = $id;
    pm_exec('UPDATE task_templates SET ' . implode(',', $f) . ' WHERE id = ?', $p);
    $row = pm_fetch_one('SELECT * FROM task_templates WHERE id = ?', [$id]);
    pm_json(['template' => pm_template_shape($row)]);
}

if ($method === 'DELETE' && $id !== null) {
    pm_require_admin();
    pm_exec('DELETE FROM task_templates WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
