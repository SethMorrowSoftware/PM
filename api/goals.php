<?php
require_once __DIR__ . '/bootstrap.php';
pm_boot();

$method = pm_method();
$id = pm_int_param('id');

// Allowed enum sets, mirrored from the goals table definition.
const PM_GOAL_STATUSES = ['on_track', 'at_risk', 'off_track', 'done'];
const PM_GOAL_MODES    = ['auto', 'manual'];

// Validate a YYYY-MM-DD date string. Returns true for a real calendar date.
function pm_goal_valid_date(string $d): bool {
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $d, $m)) return false;
    return checkdate((int)$m[2], (int)$m[3], (int)$m[1]);
}

// Clamp an int into the inclusive [0,100] percentage range.
function pm_goal_clamp_pct($v): int {
    $n = (int)$v;
    if ($n < 0) return 0;
    if ($n > 100) return 100;
    return $n;
}

// Compute progress for one goal from its mode + manual/auto inputs.
function pm_goal_progress(string $mode, int $manualPct, int $taskTotal, int $taskDone): int {
    if ($mode === 'manual') return pm_goal_clamp_pct($manualPct);
    return $taskTotal > 0 ? (int)round($taskDone / $taskTotal * 100) : 0;
}

// Shape one goal row for API responses. $projectIds is the list of linked
// project ids; $counts is ['total'=>int,'done'=>int]; $owner is the resolved
// owner object (or null). All aggregates are pre-fetched by the caller so
// there is no per-goal N+1.
function pm_goal_shape(array $r, array $projectIds, array $counts, ?array $owner): array {
    $mode   = in_array($r['progress_mode'] ?? 'auto', PM_GOAL_MODES, true) ? $r['progress_mode'] : 'auto';
    $manual = pm_goal_clamp_pct($r['manual_pct'] ?? 0);
    $total  = (int)($counts['total'] ?? 0);
    $done   = (int)($counts['done'] ?? 0);
    return [
        'id'            => (int)$r['id'],
        'name'          => $r['name'],
        'description'   => $r['description'] ?? null,
        'due'           => $r['due'] ?? null,
        'status'        => $r['status'] ?? 'on_track',
        'progress_mode' => $mode,
        'manual_pct'    => $manual,
        'owner_id'      => $r['owner_id'] !== null ? (int)$r['owner_id'] : null,
        'owner'         => $owner,
        'project_ids'   => array_values(array_map('intval', $projectIds)),
        'progress'      => pm_goal_progress($mode, $manual, $total, $done),
        'task_total'    => $total,
        'task_done'     => $done,
    ];
}

// Resolve owner objects ({id,name,initials,color}) for a set of user ids in
// one query. Returns a map keyed by user id.
function pm_goal_owner_map(array $ownerIds): array {
    $ownerIds = array_values(array_unique(array_filter(array_map('intval', $ownerIds))));
    if (!$ownerIds) return [];
    $ph = implode(',', array_fill(0, count($ownerIds), '?'));
    $rows = pm_fetch_all(
        "SELECT id, name, initials, color FROM users WHERE id IN ($ph)",
        $ownerIds
    );
    $map = [];
    foreach ($rows as $u) {
        $map[(int)$u['id']] = [
            'id'       => (int)$u['id'],
            'name'     => $u['name'],
            'initials' => $u['initials'] ?? '??',
            'color'    => $u['color']    ?? '#64748B',
        ];
    }
    return $map;
}

// Fetch linked project ids for a set of goal ids in one query. Returns a map
// of goal_id => [project_id, ...].
function pm_goal_project_map(array $goalIds): array {
    $goalIds = array_values(array_unique(array_map('intval', $goalIds)));
    if (!$goalIds) return [];
    $ph = implode(',', array_fill(0, count($goalIds), '?'));
    $rows = pm_fetch_all(
        "SELECT goal_id, project_id FROM goal_projects WHERE goal_id IN ($ph) ORDER BY project_id",
        $goalIds
    );
    $map = [];
    foreach ($rows as $r) {
        $map[(int)$r['goal_id']][] = (int)$r['project_id'];
    }
    return $map;
}

// Fetch task totals/done counts across each goal's linked projects in one
// grouped query (goal_projects -> tasks). Returns goal_id => ['total','done'].
// Avoids N+1 by aggregating server-side and folding into PHP.
function pm_goal_count_map(array $goalIds): array {
    $goalIds = array_values(array_unique(array_map('intval', $goalIds)));
    if (!$goalIds) return [];
    $ph = implode(',', array_fill(0, count($goalIds), '?'));
    $rows = pm_fetch_all(
        "SELECT gp.goal_id,
                COUNT(t.id) AS task_total,
                SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS task_done
         FROM goal_projects gp
         LEFT JOIN tasks t ON t.project_id = gp.project_id
         WHERE gp.goal_id IN ($ph)
         GROUP BY gp.goal_id",
        $goalIds
    );
    $map = [];
    foreach ($rows as $r) {
        $map[(int)$r['goal_id']] = [
            'total' => (int)($r['task_total'] ?? 0),
            'done'  => (int)($r['task_done'] ?? 0),
        ];
    }
    return $map;
}

// Load one goal fully shaped (project_ids + counts + owner), or null.
function pm_goal_get(int $id): ?array {
    $row = pm_fetch_one(
        'SELECT id, name, description, due, status, progress_mode, manual_pct, owner_id, sort_order
         FROM goals WHERE id = ?',
        [$id]
    );
    if (!$row) return null;
    $projectIds = pm_goal_project_map([$id])[$id] ?? [];
    $counts     = pm_goal_count_map([$id])[$id] ?? ['total' => 0, 'done' => 0];
    $ownerMap   = $row['owner_id'] !== null ? pm_goal_owner_map([(int)$row['owner_id']]) : [];
    $owner      = $row['owner_id'] !== null ? ($ownerMap[(int)$row['owner_id']] ?? null) : null;
    return pm_goal_shape($row, $projectIds, $counts, $owner);
}

// Validate + normalize a list of project ids from request input: every id must
// reference a real project. Returns a de-duplicated list of ints.
function pm_goal_validate_projects($raw): array {
    $ids = array_values(array_unique(array_map('intval', (array)$raw)));
    $ids = array_values(array_filter($ids, fn($v) => $v > 0));
    if (!$ids) return [];
    $ph = implode(',', array_fill(0, count($ids), '?'));
    $rows = pm_fetch_all("SELECT id FROM projects WHERE id IN ($ph)", $ids);
    $found = array_map(fn($r) => (int)$r['id'], $rows);
    foreach ($ids as $pid) {
        if (!in_array($pid, $found, true)) pm_error("Project not found: $pid", 404);
    }
    return $ids;
}

if ($method === 'GET' && $id === null) {
    pm_require_auth();
    $goals = pm_fetch_all(
        'SELECT id, name, description, due, status, progress_mode, manual_pct, owner_id, sort_order
         FROM goals ORDER BY sort_order, id'
    );
    $goalIds  = array_map(fn($g) => (int)$g['id'], $goals);
    $projects = pm_goal_project_map($goalIds);
    $counts   = pm_goal_count_map($goalIds);
    $owners   = pm_goal_owner_map(array_map(fn($g) => $g['owner_id'], $goals));
    $out = [];
    foreach ($goals as $g) {
        $gid    = (int)$g['id'];
        $owner  = $g['owner_id'] !== null ? ($owners[(int)$g['owner_id']] ?? null) : null;
        $out[]  = pm_goal_shape(
            $g,
            $projects[$gid] ?? [],
            $counts[$gid] ?? ['total' => 0, 'done' => 0],
            $owner
        );
    }
    pm_json(['goals' => $out]);
}

if ($method === 'GET' && $id !== null) {
    pm_require_auth();
    $out = pm_goal_get($id);
    if (!$out) pm_error('Not found', 404);
    pm_json(['goal' => $out]);
}

if ($method === 'POST' && $id === null) {
    pm_require_admin();
    $body = pm_body();

    $name = trim((string)pm_param('name', ''));
    if ($name === '') pm_error('Name required');

    $desc = pm_param('description');
    $desc = ($desc === '' || $desc === null) ? null : (string)$desc;

    $due = pm_param('due');
    if ($due === null || $due === '') {
        $due = null;
    } elseif (!pm_goal_valid_date((string)$due)) {
        pm_error('Invalid due date (use YYYY-MM-DD)');
    } else {
        $due = (string)$due;
    }

    $status = (string)pm_param('status', 'on_track');
    if (!in_array($status, PM_GOAL_STATUSES, true)) {
        pm_error('Invalid status (' . implode('|', PM_GOAL_STATUSES) . ')');
    }

    $mode = (string)pm_param('progress_mode', 'auto');
    if (!in_array($mode, PM_GOAL_MODES, true)) {
        pm_error('Invalid progress_mode (' . implode('|', PM_GOAL_MODES) . ')');
    }

    $manual = pm_goal_clamp_pct(pm_param('manual_pct', 0));

    $ownerId = null;
    $ownerRaw = pm_param('owner_id');
    if ($ownerRaw !== null && $ownerRaw !== '') {
        $ownerId = (int)$ownerRaw;
        $u = pm_fetch_one('SELECT id FROM users WHERE id = ?', [$ownerId]);
        if (!$u) pm_error('Owner not found', 404);
    }

    $projectIds = pm_goal_validate_projects($body['project_ids'] ?? pm_param('project_ids', []));

    // Goal + its junction rows must land together (mirror saved_views): a crash
    // between the INSERT and the goal_projects writes would leave a goal with no
    // links even though the request asked for some.
    $pdo = pm_db();
    $pdo->beginTransaction();
    try {
        pm_exec(
            'INSERT INTO goals (name, description, due, status, progress_mode, manual_pct, owner_id)
             VALUES (?,?,?,?,?,?,?)',
            [$name, $desc, $due, $status, $mode, $manual, $ownerId]
        );
        $newId = pm_last_id();
        foreach ($projectIds as $pid) {
            pm_exec('INSERT INTO goal_projects (goal_id, project_id) VALUES (?,?)', [$newId, $pid]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        error_log('goals POST failed: ' . $e->getMessage());
        pm_error('Goal could not be created', 500);
    }

    $out = pm_goal_get($newId);
    if (!$out) pm_error('Goal could not be created', 500);
    pm_json(['goal' => $out]);
}

if ($method === 'PATCH' && $id !== null) {
    pm_require_admin();
    $existing = pm_fetch_one('SELECT id FROM goals WHERE id = ?', [$id]);
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
        $f[] = 'description = ?'; $p[] = ($d === '' || $d === null) ? null : (string)$d;
    }
    if (array_key_exists('due', $body)) {
        $d = $body['due'];
        if ($d === null || $d === '') {
            $f[] = 'due = ?'; $p[] = null;
        } elseif (!pm_goal_valid_date((string)$d)) {
            pm_error('Invalid due date (use YYYY-MM-DD)');
        } else {
            $f[] = 'due = ?'; $p[] = (string)$d;
        }
    }
    if (isset($body['status'])) {
        $s = (string)$body['status'];
        if (!in_array($s, PM_GOAL_STATUSES, true)) {
            pm_error('Invalid status (' . implode('|', PM_GOAL_STATUSES) . ')');
        }
        $f[] = 'status = ?'; $p[] = $s;
    }
    if (isset($body['progress_mode'])) {
        $m = (string)$body['progress_mode'];
        if (!in_array($m, PM_GOAL_MODES, true)) {
            pm_error('Invalid progress_mode (' . implode('|', PM_GOAL_MODES) . ')');
        }
        $f[] = 'progress_mode = ?'; $p[] = $m;
    }
    if (array_key_exists('manual_pct', $body)) {
        $f[] = 'manual_pct = ?'; $p[] = pm_goal_clamp_pct($body['manual_pct']);
    }
    if (array_key_exists('owner_id', $body)) {
        $o = $body['owner_id'];
        if ($o === null || $o === '') {
            $f[] = 'owner_id = ?'; $p[] = null;
        } else {
            $oid = (int)$o;
            $u = pm_fetch_one('SELECT id FROM users WHERE id = ?', [$oid]);
            if (!$u) pm_error('Owner not found', 404);
            $f[] = 'owner_id = ?'; $p[] = $oid;
        }
    }
    if (array_key_exists('sort_order', $body)) {
        $f[] = 'sort_order = ?'; $p[] = (int)$body['sort_order'];
    }

    // project_ids, if present, fully replaces the junction (delete-then-insert).
    $replaceProjects = array_key_exists('project_ids', $body);
    $projectIds = $replaceProjects ? pm_goal_validate_projects($body['project_ids']) : [];

    if (!$f && !$replaceProjects) pm_error('Nothing to update');

    // Column updates + junction replacement run together so a partial failure
    // can't leave the goal's project links out of sync with its other fields.
    $pdo = pm_db();
    $pdo->beginTransaction();
    try {
        if ($f) {
            $params = $p;
            $params[] = $id;
            pm_exec('UPDATE goals SET ' . implode(', ', $f) . ' WHERE id = ?', $params);
        }
        if ($replaceProjects) {
            pm_exec('DELETE FROM goal_projects WHERE goal_id = ?', [$id]);
            foreach ($projectIds as $pid) {
                pm_exec('INSERT INTO goal_projects (goal_id, project_id) VALUES (?,?)', [$id, $pid]);
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        error_log('goals PATCH failed: ' . $e->getMessage());
        pm_error('Goal could not be updated', 500);
    }

    $out = pm_goal_get($id);
    if (!$out) pm_error('Not found', 404);
    pm_json(['goal' => $out]);
}

if ($method === 'DELETE' && $id !== null) {
    pm_require_admin();
    $row = pm_fetch_one('SELECT id FROM goals WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);
    // goal_projects rows are removed by the FK ON DELETE CASCADE.
    pm_exec('DELETE FROM goals WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
