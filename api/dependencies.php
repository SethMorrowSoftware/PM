<?php
require_once __DIR__ . '/bootstrap.php';
pm_boot();
pm_require_auth();

$method = pm_method();

// taskMini shape used by both blocked_by and blocks lists.
function pm_dep_task_mini(array $r): array {
    return [
        'id'         => (int)$r['id'],
        'ref'        => $r['ref'],
        'title'      => $r['title'],
        'status'     => $r['status'],
        'project_id' => $r['project_id'] === null ? null : (int)$r['project_id'],
    ];
}

// Confirm a task row exists (returns the id or aborts with 404/400).
function pm_dep_require_task(?int $id): int {
    if ($id === null) pm_error('task_id required');
    $row = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$id]);
    if (!$row) pm_error('Task not found', 404);
    return (int)$row['id'];
}

if ($method === 'GET') {
    $taskId = pm_dep_require_task(pm_int_param('task_id'));

    // blocked_by: tasks that task N depends on (depends_on_id where task_id = N).
    $blockedBy = pm_fetch_all(
        'SELECT t.id, t.ref, t.title, t.status, t.project_id
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_id
         WHERE d.task_id = ?
         ORDER BY t.id',
        [$taskId]
    );

    // blocks: tasks that depend on N (task_id where depends_on_id = N).
    $blocks = pm_fetch_all(
        'SELECT t.id, t.ref, t.title, t.status, t.project_id
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id
         WHERE d.depends_on_id = ?
         ORDER BY t.id',
        [$taskId]
    );

    pm_json([
        'blocked_by' => array_map('pm_dep_task_mini', $blockedBy),
        'blocks'     => array_map('pm_dep_task_mini', $blocks),
    ]);
}

if ($method === 'POST') {
    $taskId = pm_dep_require_task(pm_int_param('task_id'));
    $dependsOnId = pm_int_param('depends_on_id');
    if ($dependsOnId === null) {
        $b = pm_body();
        $dependsOnId = isset($b['depends_on_id']) ? (int)$b['depends_on_id'] : null;
    }
    if ($dependsOnId === null) pm_error('depends_on_id required');
    if ($dependsOnId === $taskId) pm_error('A task cannot depend on itself');
    $dependsOnId = pm_dep_require_task($dependsOnId);

    // Cycle check: adding taskId -> dependsOnId means taskId waits on
    // dependsOnId. If, starting from dependsOnId and following its own
    // depends_on edges transitively, we can already reach taskId, then the
    // new edge would close a loop.
    $visited = [];
    $stack = [$dependsOnId];
    while ($stack) {
        $cur = array_pop($stack);
        if ($cur === $taskId) pm_error('Adding this dependency would create a cycle');
        if (isset($visited[$cur])) continue;
        $visited[$cur] = true;
        $rows = pm_fetch_all(
            'SELECT depends_on_id FROM task_dependencies WHERE task_id = ?',
            [$cur]
        );
        foreach ($rows as $row) {
            $next = (int)$row['depends_on_id'];
            if (!isset($visited[$next])) $stack[] = $next;
        }
    }

    pm_exec(
        'INSERT IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)',
        [$taskId, $dependsOnId]
    );
    pm_json(['ok' => true]);
}

if ($method === 'DELETE') {
    $taskId = pm_dep_require_task(pm_int_param('task_id'));
    $dependsOnId = pm_int_param('depends_on_id');
    if ($dependsOnId === null) pm_error('depends_on_id required');
    pm_exec(
        'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?',
        [$taskId, $dependsOnId]
    );
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
