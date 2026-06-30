<?php
require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();

$method = pm_method();
$id = pm_int_param('id');

// Shape a milestone row for API responses. task_count / done_count are computed
// by the caller's query (LEFT JOIN aggregate) so there's no per-row N+1.
function pm_milestone_shape(array $r): array {
    return [
        'id'          => (int)$r['id'],
        'project_id'  => (int)$r['project_id'],
        'name'        => $r['name'],
        'description' => $r['description'] ?? null,
        'due'         => $r['due'] ?? null,
        'status'      => $r['status'] ?? 'open',
        'sort_order'  => (int)($r['sort_order'] ?? 0),
        'task_count'  => (int)($r['task_count'] ?? 0),
        'done_count'  => (int)($r['done_count'] ?? 0),
    ];
}

// Validate a YYYY-MM-DD date string. Returns true for a real calendar date.
function pm_milestone_valid_date(string $d): bool {
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $m)) return false;
    return checkdate((int)$m[2], (int)$m[3], (int)$m[1]);
}

// Load one milestone with its aggregate task counts, shaped for responses.
function pm_milestone_get(int $id): ?array {
    $row = pm_fetch_one(
        'SELECT m.id, m.project_id, m.name, m.description, m.due, m.status, m.sort_order,
                COUNT(t.id) AS task_count,
                SUM(CASE WHEN t.status = \'done\' THEN 1 ELSE 0 END) AS done_count
         FROM milestones m
         LEFT JOIN tasks t ON t.milestone_id = m.id
         WHERE m.id = ?
         GROUP BY m.id, m.project_id, m.name, m.description, m.due, m.status, m.sort_order',
        [$id]
    );
    return $row ? pm_milestone_shape($row) : null;
}

if ($method === 'GET' && $id === null) {
    $uid = pm_require_auth();
    // Aggregate task/done counts via a single LEFT JOIN + GROUP BY (no N+1).
    $projectId = pm_int_param('project_id');
    $where = [];
    $params = [];
    if ($projectId !== null) { $where[] = 'm.project_id = ?'; $params[] = $projectId; }
    // Restrict to readable projects so a non-member can't enumerate a private
    // project's milestones (names/due/completion). null = no private projects or
    // admin -> no restriction.
    if (function_exists('pm_readable_project_ids')) {
        $readable = pm_readable_project_ids($uid);
        if ($readable !== null) {
            if (!$readable) { pm_json(['milestones' => []]); }
            $ph = implode(',', array_fill(0, count($readable), '?'));
            $where[] = "m.project_id IN ($ph)";
            foreach ($readable as $r) $params[] = (int)$r;
        }
    }
    $whereSql = $where ? (' WHERE ' . implode(' AND ', $where)) : '';
    $sql = 'SELECT m.id, m.project_id, m.name, m.description, m.due, m.status, m.sort_order,
                   COUNT(t.id) AS task_count,
                   SUM(CASE WHEN t.status = \'done\' THEN 1 ELSE 0 END) AS done_count
            FROM milestones m
            LEFT JOIN tasks t ON t.milestone_id = m.id'
        . $whereSql
        . ' GROUP BY m.id, m.project_id, m.name, m.description, m.due, m.status, m.sort_order
            ORDER BY m.sort_order, m.id';
    $rows = pm_fetch_all($sql, $params);
    pm_json(['milestones' => array_map('pm_milestone_shape', $rows)]);
}

if ($method === 'GET' && $id !== null) {
    $uid = pm_require_auth();
    $out = pm_milestone_get($id);
    if (!$out) pm_error('Not found', 404);
    if (function_exists('pm_can_read_project') && !pm_can_read_project($uid, (int)$out['project_id'])) {
        pm_error('Not found', 404);
    }
    pm_json(['milestone' => $out]);
}

if ($method === 'POST' && $id === null) {
    pm_require_admin();
    $projectId = pm_int_param('project_id');
    $name = trim((string)pm_param('name', ''));
    $desc = pm_param('description');
    $due  = pm_param('due');
    if ($projectId === null) pm_error('project_id required');
    if ($name === '') pm_error('Name required');
    $project = pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$projectId]);
    if (!$project) pm_error('Project not found', 404);
    if ($due !== null && $due !== '') {
        if (!pm_milestone_valid_date((string)$due)) pm_error('Invalid due date (use YYYY-MM-DD)');
    } else {
        $due = null;
    }
    if (array_key_exists('sort_order', $_GET) || array_key_exists('sort_order', pm_body())) {
        $sort = (int)pm_param('sort_order', 0);
    } else {
        $sortRow = pm_fetch_one('SELECT COALESCE(MAX(sort_order),0) AS m FROM milestones WHERE project_id = ?', [$projectId]);
        $sort = ((int)($sortRow['m'] ?? 0)) + 1;
    }
    pm_exec(
        'INSERT INTO milestones (project_id, name, description, due, sort_order) VALUES (?,?,?,?,?)',
        [$projectId, $name, ($desc === '' ? null : $desc), $due, $sort]
    );
    $nid = pm_last_id();
    pm_json(['milestone' => pm_milestone_get($nid)]);
}

if ($method === 'PATCH' && $id !== null) {
    pm_require_admin();
    $existing = pm_fetch_one('SELECT id FROM milestones WHERE id = ?', [$id]);
    if (!$existing) pm_error('Not found', 404);
    $body = pm_body();
    $f = []; $p = [];
    if (isset($body['name'])) {
        $n = trim((string)$body['name']);
        if ($n === '') pm_error('Name cannot be empty');
        $f[] = 'name = ?'; $p[] = $n;
    }
    if (array_key_exists('description', $body)) {
        $d = $body['description'];
        $f[] = 'description = ?'; $p[] = ($d === '' ? null : $d);
    }
    if (array_key_exists('due', $body)) {
        $d = $body['due'];
        if ($d === null || $d === '') {
            $f[] = 'due = ?'; $p[] = null;
        } else {
            if (!pm_milestone_valid_date((string)$d)) pm_error('Invalid due date (use YYYY-MM-DD)');
            $f[] = 'due = ?'; $p[] = (string)$d;
        }
    }
    if (isset($body['status'])) {
        $s = (string)$body['status'];
        if ($s !== 'open' && $s !== 'done') pm_error('Invalid status (open|done)');
        $f[] = 'status = ?'; $p[] = $s;
    }
    if (array_key_exists('sort_order', $body)) {
        $f[] = 'sort_order = ?'; $p[] = (int)$body['sort_order'];
    }
    if (array_key_exists('project_id', $body)) {
        $pid = (int)$body['project_id'];
        $project = pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$pid]);
        if (!$project) pm_error('Project not found', 404);
        $f[] = 'project_id = ?'; $p[] = $pid;
    }
    if (!$f) pm_error('Nothing to update');
    $p[] = $id;
    pm_exec('UPDATE milestones SET ' . implode(',', $f) . ' WHERE id = ?', $p);
    $out = pm_milestone_get($id);
    if (!$out) pm_error('Not found', 404);
    pm_json(['milestone' => $out]);
}

if ($method === 'DELETE' && $id !== null) {
    pm_require_admin();
    $row = pm_fetch_one('SELECT id FROM milestones WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);
    // No FK enforces this relationship, so detach tasks first to avoid orphaned
    // milestone_id references pointing at a deleted milestone.
    pm_exec('UPDATE tasks SET milestone_id = NULL WHERE milestone_id = ?', [$id]);
    pm_exec('DELETE FROM milestones WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
