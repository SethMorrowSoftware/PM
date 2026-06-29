<?php
require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
$viewerUid = pm_require_auth();

// Pagination (defaults preserve the original "last 40" behavior for the
// dashboard feed, which calls this with no params).
$limit  = max(1, min(200, (int)pm_int_param('limit', 40)));
$offset = max(0, (int)pm_int_param('offset', 0));

// Optional filters for the audit-log view.
$where = [];
$params = [];
if ($uid = pm_int_param('user_id')) { $where[] = 'a.user_id = ?'; $params[] = $uid; }
if ($tid = pm_int_param('task_id')) { $where[] = 'a.task_id = ?'; $params[] = $tid; }
$action = trim((string)pm_param('action', ''));
if ($action !== '') { $where[] = 'a.action = ?'; $params[] = $action; }
$q = trim((string)pm_param('q', ''));
if ($q !== '') {
    $where[] = '(a.detail LIKE ? OR t.title LIKE ? OR t.ref LIKE ?)';
    $like = '%' . $q . '%';
    array_push($params, $like, $like, $like);
}
// Hide activity rows whose task is in a private project the viewer can't read.
// null = no restriction (admin / no private projects) → keep it cheap.
if (function_exists('pm_readable_project_ids')) {
    $readable = pm_readable_project_ids($viewerUid);
    if ($readable !== null) {
        if ($readable) {
            $ph = implode(',', array_fill(0, count($readable), '?'));
            $where[] = "(a.task_id IS NULL OR t.project_id IN ($ph))";
            foreach ($readable as $rid) $params[] = $rid;
        } else {
            $where[] = 'a.task_id IS NULL';
        }
    }
}
$whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

// $limit/$offset are validated ints — safe to inline. Fetch one extra row to
// know whether a next page exists.
$fetch = $limit + 1;
$rows = pm_fetch_all(
    "SELECT a.id, a.action, a.detail, a.created_at,
            a.user_id, u.name AS user_name, u.initials, u.color,
            a.task_id, t.ref AS task_ref, t.title AS task_title
     FROM activity a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN tasks t ON t.id = a.task_id
     $whereSql
     ORDER BY a.id DESC
     LIMIT $fetch OFFSET $offset",
    $params
);
$hasMore = count($rows) > $limit;
if ($hasMore) array_pop($rows);

pm_json([
    'activity' => array_map(fn($r) => [
        'id'         => (int)$r['id'],
        'action'     => $r['action'],
        'detail'     => $r['detail'],
        'created_at' => $r['created_at'],
        'user'       => [
            'id'       => $r['user_id'] !== null ? (int)$r['user_id'] : null,
            'name'     => $r['user_name'] ?? 'Former teammate',
            'initials' => $r['initials']  ?? '??',
            'color'    => $r['color']     ?? '#64748B',
        ],
        'task' => $r['task_id'] ? [
            'id'    => (int)$r['task_id'],
            'ref'   => $r['task_ref'],
            'title' => $r['task_title'],
        ] : null,
    ], $rows),
    'has_more' => $hasMore,
    'offset'   => $offset,
    'limit'    => $limit,
]);
