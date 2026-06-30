<?php
require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
$uid = pm_require_auth();

$method = pm_method();
$id = pm_int_param('id');
$action = (string)pm_param('action', '');

function pm_label_shape(array $r): array {
    return [
        'id'           => (int)$r['id'],
        'name'         => $r['name'],
        'color'        => $r['color'],
        'project_id'   => isset($r['project_id']) && $r['project_id'] !== null ? (int)$r['project_id'] : null,
        'scope'        => isset($r['project_id']) && $r['project_id'] !== null ? 'project' : 'global',
        'archived'     => !empty($r['archived']),
        'usage_count'  => isset($r['usage_count']) ? (int)$r['usage_count'] : 0,
        'safe_archive' => isset($r['usage_count']) ? ((int)$r['usage_count'] === 0) : null,
    ];
}

// The UI only styles these eight named colors. Anything else would render as
// an unstyled ghost tag, so reject it at the API boundary.
if (!defined('PM_LABEL_COLORS')) {
    define('PM_LABEL_COLORS', ['red','blue','amber','green','violet','slate','pink','cyan']);
}

function pm_label_scope_exists(?int $projectId): void {
    if ($projectId === null) return;
    $proj = pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$projectId]);
    if (!$proj) pm_error('Invalid project_id');
}

function pm_label_dup_exists(string $name, ?int $projectId, ?int $exceptId = null): bool {
    $dupWhere = 'LOWER(name) = LOWER(?) AND archived = 0 AND ';
    $dupParams = [trim($name)];
    if ($projectId === null) {
        $dupWhere .= 'project_id IS NULL';
    } else {
        $dupWhere .= 'project_id = ?';
        $dupParams[] = $projectId;
    }
    if ($exceptId !== null) {
        $dupWhere .= ' AND id <> ?';
        $dupParams[] = $exceptId;
    }
    $dup = pm_fetch_one("SELECT id FROM labels WHERE $dupWhere LIMIT 1", $dupParams);
    return !!$dup;
}

function pm_label_effective_scope(int $id, array $body): ?int {
    if (array_key_exists('project_id', $body)) {
        $pid = $body['project_id'];
        if ($pid === null || $pid === '') return null;
        return (int)$pid;
    }
    $cur = pm_fetch_one('SELECT project_id FROM labels WHERE id = ?', [$id]);
    if (!$cur) pm_error('Not found', 404);
    return isset($cur['project_id']) && $cur['project_id'] !== null ? (int)$cur['project_id'] : null;
}

if ($method === 'GET' && $id === null) {
    $includeArchived = !empty($_GET['include_archived']);
    $projectId       = pm_int_param('project_id');
    $where = [];
    $params = [];
    if (!$includeArchived) $where[] = 'l.archived = 0';
    if ($projectId !== null) {
        // Scope lookup: return labels that apply to this project
        // (either global project_id IS NULL or matching project_id).
        $where[]  = '(l.project_id IS NULL OR l.project_id = ?)';
        $params[] = $projectId;
    }
    // Don't expose project-scoped labels for private projects the caller can't
    // read. Global labels (project_id IS NULL) stay visible to everyone. null =
    // no private projects or admin -> no restriction.
    if (function_exists('pm_readable_project_ids')) {
        $readable = pm_readable_project_ids($uid);
        if ($readable !== null) {
            if ($readable) {
                $ph = implode(',', array_fill(0, count($readable), '?'));
                $where[] = "(l.project_id IS NULL OR l.project_id IN ($ph))";
                foreach ($readable as $r) $params[] = (int)$r;
            } else {
                $where[] = 'l.project_id IS NULL';
            }
        }
    }
    $sql = 'SELECT l.id, l.name, l.color, l.project_id, l.archived, COUNT(tl.task_id) AS usage_count
            FROM labels l
            LEFT JOIN task_labels tl ON tl.label_id = l.id';
    if ($where) $sql .= ' WHERE ' . implode(' AND ', $where);
    $sql .= ' GROUP BY l.id, l.name, l.color, l.project_id, l.archived';
    $sql .= ' ORDER BY l.project_id IS NOT NULL, l.name';
    $rows = pm_fetch_all($sql, $params);
    pm_json(['labels' => array_map('pm_label_shape', $rows)]);
}

if ($method === 'POST' && $id === null && $action !== 'merge') {
    $name      = trim((string)pm_param('name', ''));
    $color     = (string)pm_param('color', 'slate');
    $projectId = pm_int_param('project_id');
    if ($name === '') pm_error('Name required');
    if (!in_array($color, PM_LABEL_COLORS, true)) pm_error('Invalid color. Use one of: ' . implode(', ', PM_LABEL_COLORS));

    pm_label_scope_exists($projectId);
    if (pm_label_dup_exists($name, $projectId)) {
        pm_error('A label with that name already exists in this scope', 409);
    }

    pm_exec('INSERT INTO labels (name, color, project_id) VALUES (?,?,?)',
        [$name, $color, $projectId]);
    $nid = pm_last_id();
    $row = pm_fetch_one('SELECT id, name, color, project_id, archived, 0 AS usage_count FROM labels WHERE id = ?', [$nid]);
    pm_json(['label' => pm_label_shape($row)]);
}

if ($method === 'POST' && $id !== null && $action === 'merge') {
    pm_require_admin();
    $targetId = pm_int_param('target_id');
    if (!$targetId || $targetId === $id) pm_error('target_id must be another label id');

    $src = pm_fetch_one('SELECT id, name, project_id FROM labels WHERE id = ?', [$id]);
    $dst = pm_fetch_one('SELECT id, name, project_id FROM labels WHERE id = ?', [$targetId]);
    if (!$src || !$dst) pm_error('Label not found', 404);

    $srcScope = $src['project_id'] !== null ? (int)$src['project_id'] : null;
    $dstScope = $dst['project_id'] !== null ? (int)$dst['project_id'] : null;
    if ($srcScope !== $dstScope) {
        pm_error('Labels can only be merged within the same scope', 409);
    }

    pm_exec('UPDATE IGNORE task_labels SET label_id = ? WHERE label_id = ?', [$targetId, $id]);
    pm_exec('DELETE FROM labels WHERE id = ?', [$id]);

    $row = pm_fetch_one(
        'SELECT l.id, l.name, l.color, l.project_id, l.archived, COUNT(tl.task_id) AS usage_count
         FROM labels l
         LEFT JOIN task_labels tl ON tl.label_id = l.id
         WHERE l.id = ?
         GROUP BY l.id, l.name, l.color, l.project_id, l.archived',
        [$targetId]
    );
    pm_json([
        'ok' => true,
        'merged_from' => (int)$id,
        'merged_into' => (int)$targetId,
        'label' => $row ? pm_label_shape($row) : null,
    ]);
}

if ($method === 'PATCH' && $id !== null) {
    $body = pm_body();
    $f = []; $p = [];

    $nextName = null;
    if (isset($body['name'])) {
        $nextName = trim((string)$body['name']);
        if ($nextName === '') pm_error('Name cannot be empty');
    }
    $nextScope = pm_label_effective_scope($id, $body);
    if ($nextName !== null && pm_label_dup_exists($nextName, $nextScope, $id)) {
        pm_error('A label with that name already exists in this scope', 409);
    }

    if ($nextName !== null) {
        $f[]='name = ?';  $p[]=$nextName;
    }
    if (isset($body['color'])) {
        $c = (string)$body['color'];
        if (!in_array($c, PM_LABEL_COLORS, true)) pm_error('Invalid color. Use one of: ' . implode(', ', PM_LABEL_COLORS));
        $f[]='color = ?'; $p[]=$c;
    }
    if (array_key_exists('project_id', $body)) {
        $pid = $body['project_id'];
        if ($pid === null || $pid === '') {
            $f[]='project_id = NULL';
        } else {
            $pid = (int)$pid;
            pm_label_scope_exists($pid);
            $f[]='project_id = ?'; $p[]=$pid;
        }
    }
    if (array_key_exists('archived', $body)) {
        $f[]='archived = ?'; $p[]=!empty($body['archived']) ? 1 : 0;
    }
    if (!$f) pm_error('Nothing to update');
    $p[] = $id;
    pm_exec('UPDATE labels SET ' . implode(',', $f) . ' WHERE id = ?', $p);
    $row = pm_fetch_one(
        'SELECT l.id, l.name, l.color, l.project_id, l.archived, COUNT(tl.task_id) AS usage_count
         FROM labels l
         LEFT JOIN task_labels tl ON tl.label_id = l.id
         WHERE l.id = ?
         GROUP BY l.id, l.name, l.color, l.project_id, l.archived',
        [$id]
    );
    if (!$row) pm_error('Not found', 404);
    pm_json(['label' => pm_label_shape($row)]);
}

if ($method === 'DELETE' && $id !== null) {
    $force = !empty($_GET['force']);
    $useCount = (int)(pm_fetch_one('SELECT COUNT(*) AS c FROM task_labels WHERE label_id = ?', [$id])['c'] ?? 0);
    if ($useCount > 0 && !$force) {
        pm_json([
            'error'     => 'Label is in use on ' . $useCount . ' task' . ($useCount === 1 ? '' : 's') . '. Archive instead, or re-send with force=1.',
            'use_count' => $useCount,
        ], 409);
    }
    pm_exec('DELETE FROM labels WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
