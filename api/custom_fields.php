<?php
require_once __DIR__ . '/bootstrap.php';
pm_boot();
pm_require_auth();

$method = pm_method();
$id     = pm_int_param('id');

// Field types the UI knows how to render. Anything else is rejected at the
// API boundary so we never persist a type a view can't display.
if (!defined('PM_CF_TYPES')) {
    define('PM_CF_TYPES', ['text', 'number', 'date', 'select', 'checkbox', 'user']);
}

function pm_cf_shape(array $r): array {
    $opts = [];
    if (isset($r['options_json']) && $r['options_json'] !== null && $r['options_json'] !== '') {
        $decoded = json_decode($r['options_json'], true);
        if (is_array($decoded)) $opts = array_values($decoded);
    }
    return [
        'id'         => (int)$r['id'],
        'project_id' => isset($r['project_id']) && $r['project_id'] !== null ? (int)$r['project_id'] : null,
        'name'       => $r['name'],
        'field_type' => $r['field_type'],
        'options'    => $opts,
        'sort_order' => isset($r['sort_order']) ? (int)$r['sort_order'] : 0,
        'archived'   => !empty($r['archived']),
    ];
}

// Normalize an incoming options value to a clean list of non-empty strings.
function pm_cf_normalize_options($raw): array {
    if (!is_array($raw)) return [];
    $out = [];
    foreach ($raw as $o) {
        if (is_string($o) || is_numeric($o)) {
            $s = trim((string)$o);
            if ($s !== '') $out[] = $s;
        }
    }
    return array_values($out);
}

function pm_cf_project_exists(?int $projectId): void {
    if ($projectId === null) return;
    $proj = pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$projectId]);
    if (!$proj) pm_error('Invalid project_id');
}

// ---- GET: list all field definitions (any authenticated user) ----------------
if ($method === 'GET' && $id === null) {
    $rows = pm_fetch_all(
        'SELECT id, project_id, name, field_type, options_json, sort_order, archived
         FROM custom_fields
         ORDER BY sort_order, name'
    );
    pm_json(['fields' => array_map('pm_cf_shape', $rows)]);
}

// ---- POST: create a field definition (admin) ---------------------------------
if ($method === 'POST' && $id === null) {
    pm_require_admin();
    $name      = trim((string)pm_param('name', ''));
    $fieldType = (string)pm_param('field_type', 'text');
    $projectId = pm_int_param('project_id');
    $sortOrder = pm_int_param('sort_order', 0);
    $options   = pm_cf_normalize_options(pm_param('options', []));

    if ($name === '') pm_error('Name required');
    if (!in_array($fieldType, PM_CF_TYPES, true)) {
        pm_error('Invalid field_type. Use one of: ' . implode(', ', PM_CF_TYPES));
    }
    if ($fieldType === 'select' && count($options) === 0) {
        pm_error('Select fields require at least one option');
    }
    pm_cf_project_exists($projectId);

    $optionsJson = count($options) ? json_encode($options, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null;

    pm_exec(
        'INSERT INTO custom_fields (project_id, name, field_type, options_json, sort_order) VALUES (?,?,?,?,?)',
        [$projectId, $name, $fieldType, $optionsJson, $sortOrder]
    );
    $nid = pm_last_id();
    $row = pm_fetch_one(
        'SELECT id, project_id, name, field_type, options_json, sort_order, archived FROM custom_fields WHERE id = ?',
        [$nid]
    );
    pm_json(['field' => pm_cf_shape($row)]);
}

// ---- PATCH ?id=N: update a field definition (admin) --------------------------
if ($method === 'PATCH' && $id !== null) {
    pm_require_admin();
    $body = pm_body();
    $f = []; $p = [];

    if (array_key_exists('name', $body)) {
        $name = trim((string)$body['name']);
        if ($name === '') pm_error('Name cannot be empty');
        $f[] = 'name = ?'; $p[] = $name;
    }
    if (array_key_exists('field_type', $body)) {
        $ft = (string)$body['field_type'];
        if (!in_array($ft, PM_CF_TYPES, true)) {
            pm_error('Invalid field_type. Use one of: ' . implode(', ', PM_CF_TYPES));
        }
        $f[] = 'field_type = ?'; $p[] = $ft;
    }
    if (array_key_exists('options', $body)) {
        $options = pm_cf_normalize_options($body['options']);
        $optionsJson = count($options) ? json_encode($options, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null;
        if ($optionsJson === null) {
            $f[] = 'options_json = NULL';
        } else {
            $f[] = 'options_json = ?'; $p[] = $optionsJson;
        }
    }
    if (array_key_exists('sort_order', $body)) {
        $f[] = 'sort_order = ?'; $p[] = (int)$body['sort_order'];
    }
    if (array_key_exists('archived', $body)) {
        $f[] = 'archived = ?'; $p[] = !empty($body['archived']) ? 1 : 0;
    }
    if (array_key_exists('project_id', $body)) {
        $pid = $body['project_id'];
        if ($pid === null || $pid === '') {
            $f[] = 'project_id = NULL';
        } else {
            $pid = (int)$pid;
            pm_cf_project_exists($pid);
            $f[] = 'project_id = ?'; $p[] = $pid;
        }
    }
    if (!$f) pm_error('Nothing to update');
    $p[] = $id;
    pm_exec('UPDATE custom_fields SET ' . implode(',', $f) . ' WHERE id = ?', $p);
    $row = pm_fetch_one(
        'SELECT id, project_id, name, field_type, options_json, sort_order, archived FROM custom_fields WHERE id = ?',
        [$id]
    );
    if (!$row) pm_error('Not found', 404);
    pm_json(['field' => pm_cf_shape($row)]);
}

// ---- DELETE ?id=N: remove a field definition (admin) -------------------------
// FK cascade on task_custom_values.field_id cleans up stored values.
if ($method === 'DELETE' && $id !== null) {
    pm_require_admin();
    pm_exec('DELETE FROM custom_fields WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

// ---- PUT ?task_id=N&field_id=M: set one task's value (any auth user) ----------
if ($method === 'PUT') {
    $taskId  = pm_int_param('task_id');
    $fieldId = pm_int_param('field_id');
    if (!$taskId || !$fieldId) pm_error('task_id and field_id required');

    $field = pm_fetch_one('SELECT id FROM custom_fields WHERE id = ?', [$fieldId]);
    if (!$field) pm_error('Field not found', 404);
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);

    $value = pm_param('value', null);
    if (is_array($value)) $value = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($value !== null) $value = (string)$value;

    if ($value === null || $value === '') {
        // Empty value clears the field rather than storing a blank row.
        pm_exec('DELETE FROM task_custom_values WHERE task_id = ? AND field_id = ?', [$taskId, $fieldId]);
    } else {
        pm_exec(
            'INSERT INTO task_custom_values (task_id, field_id, value) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE value = VALUES(value)',
            [$taskId, $fieldId, $value]
        );
    }
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
