<?php
require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/slack_client.php';
require_once __DIR__ . '/attachments_lib.php';
require_once __DIR__ . '/notify_lib.php';
// Optional automation engine — guarded include so a partial file upload can't
// fatal the whole task API. Calls below are wrapped in function_exists().
if (is_file(__DIR__ . '/automations_lib.php')) require_once __DIR__ . '/automations_lib.php';
// Per-project access control. Guarded + function_exists()-checked at call sites
// so an old/partial install simply falls back to the open all-can-edit model.
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
pm_require_auth();

$id    = pm_int_param('id');
$subId = pm_int_param('subtask_id');
$commentId = pm_int_param('comment_id');
$method = pm_method();

// Per-project access gate for any operation on a specific task (the task itself
// and all its sub-resources: comments, subtasks, watch, reactions, activity).
// GET needs read access; any mutation needs write access. Open projects always
// pass; private projects enforce membership/role. Non-existent tasks pass here
// and 404 in their handler. Falls back to "allow" if access_lib is absent.
if ($id !== null && function_exists('pm_can_read_task')) {
    $accessUid = pm_current_user_id() ?? 0;
    $ok = $method === 'GET' ? pm_can_read_task($accessUid, $id) : pm_can_write_task($accessUid, $id);
    if (!$ok) pm_error('Forbidden', 403);
}

if (isset($_GET['bulk'])) {
    if ($method === 'PATCH') pm_bulk_update_tasks();
    pm_error('Method not allowed', 405);
}

// Server-side search / filter / pagination — scales past the bulk list. Returns
// a light shape (enough for a results list); opening a result fetches the full
// task via ?id=N. Access-aware (readable projects only).
if (isset($_GET['search'])) {
    if ($method === 'GET') pm_search_tasks();
    pm_error('Method not allowed', 405);
}

// Sub-routes
if ($id !== null && isset($_GET['comments'])) {
    // Reaction toggle lives under the comments namespace so it travels with the
    // comment it targets: ?id=N&comments=1&comment_id=M&reaction=:emoji:
    if ($commentId !== null && isset($_GET['reaction'])) {
        if ($method === 'POST')   pm_add_reaction($id, $commentId, (string)$_GET['reaction']);
        if ($method === 'DELETE') pm_remove_reaction($id, $commentId, (string)$_GET['reaction']);
        pm_error('Method not allowed', 405);
    }
    if ($method === 'GET')  pm_list_comments($id);
    if ($method === 'POST') pm_add_comment($id);
    if ($method === 'PATCH' && $commentId !== null) pm_update_comment($id, $commentId);
    if ($method === 'DELETE' && $commentId !== null) pm_delete_comment($id, $commentId);
    pm_error('Method not allowed', 405);
}

if ($id !== null && isset($_GET['watch'])) {
    if ($method === 'POST')   pm_watch_task($id);
    if ($method === 'DELETE') pm_unwatch_task($id);
    pm_error('Method not allowed', 405);
}

if ($id !== null && isset($_GET['activity'])) {
    if ($method === 'GET') pm_task_activity($id);
    pm_error('Method not allowed', 405);
}

if ($id !== null && isset($_GET['subtasks'])) {
    if ($method === 'POST') pm_add_subtask($id);
    pm_error('Method not allowed', 405);
}

// One-shot task actions: ?id=N&action=duplicate | ?id=N&action=promote_subtask&subtask_id=M
if ($id !== null && isset($_GET['action']) && $method === 'POST') {
    if ($_GET['action'] === 'duplicate') pm_duplicate_task($id);
    if ($_GET['action'] === 'promote_subtask' && $subId !== null) pm_promote_subtask($id, $subId);
    pm_error('Unknown action', 400);
}

if ($id !== null && $subId !== null) {
    if ($method === 'PATCH')  pm_update_subtask($id, $subId);
    if ($method === 'DELETE') pm_delete_subtask($id, $subId);
    pm_error('Method not allowed', 405);
}

// Core CRUD
if ($id !== null) {
    if ($method === 'GET')    pm_get_task($id);
    if ($method === 'PATCH')  pm_update_task($id);
    if ($method === 'DELETE') pm_delete_task($id);
    pm_error('Method not allowed', 405);
}

if ($method === 'GET')  pm_list_tasks();
if ($method === 'POST') pm_create_task();
pm_error('Method not allowed', 405);


// ----------- handlers -----------

// Status ids must match the frontend's STATUSES list (assets/js/ui.js). Keeping
// them as a whitelist here stops a malformed client (or a stale third-party
// integration) from persisting gibberish that later breaks filtering/kanban.
function pm_is_valid_status(string $s): bool {
    return in_array($s, ['backlog','todo','in_progress','review','done'], true);
}

// Accept YYYY-MM-DD. DATE columns will silently coerce weird input, so guard.
function pm_is_valid_date(string $d): bool {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) return false;
    [$y, $m, $day] = array_map('intval', explode('-', $d));
    return checkdate($m, $day, $y);
}

function pm_task_base_shape(array $t): array {
    return [
        'id'          => (int)$t['id'],
        'ref'         => $t['ref'],
        'title'       => $t['title'],
        'description' => $t['description'],
        'project'     => (int)$t['project_id'],
        'status'      => $t['status'],
        'priority'    => (int)$t['priority'],
        'due'         => $t['due'],
        'estimate'    => $t['estimate'],
        // v2 scheduling fields. position is a DOUBLE so the kanban/list views can
        // splice a task between two neighbours without renumbering everything.
        'start_date'  => $t['start_date'] ?? null,
        'position'    => isset($t['position']) ? (float)$t['position'] : 0.0,
        'milestone_id'=> isset($t['milestone_id']) && $t['milestone_id'] !== null
            ? (int)$t['milestone_id'] : null,
        'recurring_rule_id' => isset($t['recurring_rule_id']) && $t['recurring_rule_id'] !== null
            ? (int)$t['recurring_rule_id'] : null,
        'labels'      => [],
        'assignees'   => [],
        'subtasks'    => [],
        'comments'    => 0,
        'attachments' => 0,
        // v2 enrichment (filled by the batch loader / single-row loader).
        'watchers'    => [],
        'blocked_by'  => [],
        'blocks'      => [],
        'time_logged' => 0,
        'custom'      => (object)[],
        'created_at'  => $t['created_at'],
        'updated_at'  => $t['updated_at'],
        'can_write'   => function_exists('pm_can_write_project')
            ? pm_can_write_project(pm_current_user_id() ?? 0, (int)($t['project_id'] ?? 0))
            : true,
    ];
}

// Single-task version used after create/update. Does 4 small queries; cheap.
function pm_task_row_to_shape(array $t): array {
    $shape = pm_task_base_shape($t);
    $labels    = pm_fetch_all('SELECT label_id FROM task_labels WHERE task_id = ?', [$t['id']]);
    $assignees = pm_fetch_all('SELECT user_id  FROM task_assignees WHERE task_id = ?', [$t['id']]);
    $subs      = pm_fetch_all('SELECT id, text, done FROM subtasks WHERE task_id = ? ORDER BY sort_order, id', [$t['id']]);
    $cmtRow    = pm_fetch_one('SELECT COUNT(*) AS c FROM comments WHERE task_id = ?', [$t['id']]);
    $shape['labels']    = array_map(fn($r) => (int)$r['label_id'], $labels);
    $shape['assignees'] = array_map(fn($r) => (int)$r['user_id'],  $assignees);
    $shape['subtasks']  = array_map(fn($r) => [
        'id'   => (int)$r['id'],
        'text' => $r['text'],
        'done' => (bool)$r['done'],
    ], $subs);
    $shape['comments']  = (int)$cmtRow['c'];
    $attRow = pm_fetch_one('SELECT COUNT(*) AS c FROM task_attachments WHERE task_id = ?', [$t['id']]);
    $shape['attachments'] = (int)($attRow['c'] ?? 0);

    // v2 enrichment. Cheap single-row queries — this path is only hit after a
    // create/update/get of one task, not in the list loop.
    $tid = (int)$t['id'];
    $watchers = pm_fetch_all('SELECT user_id FROM task_watchers WHERE task_id = ?', [$tid]);
    $shape['watchers'] = array_map(fn($r) => (int)$r['user_id'], $watchers);
    // task_dependencies.task_id depends_on depends_on_id → this task is
    // blocked_by depends_on_id; rows where we are the depends_on are tasks we block.
    $blockedBy = pm_fetch_all('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?', [$tid]);
    $shape['blocked_by'] = array_map(fn($r) => (int)$r['depends_on_id'], $blockedBy);
    $blocks = pm_fetch_all('SELECT task_id FROM task_dependencies WHERE depends_on_id = ?', [$tid]);
    $shape['blocks'] = array_map(fn($r) => (int)$r['task_id'], $blocks);
    $timeRow = pm_fetch_one('SELECT COALESCE(SUM(minutes),0) AS m FROM time_entries WHERE task_id = ?', [$tid]);
    $shape['time_logged'] = (int)($timeRow['m'] ?? 0);
    $cvals = pm_fetch_all('SELECT field_id, value FROM task_custom_values WHERE task_id = ?', [$tid]);
    $custom = [];
    foreach ($cvals as $r) $custom[(string)(int)$r['field_id']] = $r['value'];
    $shape['custom'] = (object)$custom;
    return $shape;
}

function pm_list_tasks(): void {
    // Restrict to projects the user can read. null = no restriction (admin, or
    // there are no private projects) → keep the cheap unfiltered query.
    $readable = function_exists('pm_readable_project_ids')
        ? pm_readable_project_ids(pm_current_user_id() ?? 0) : null;
    if ($readable !== null) {
        if (!$readable) { pm_json(['tasks' => []]); return; }
        $ph = implode(',', array_fill(0, count($readable), '?'));
        $rows = pm_fetch_all("SELECT * FROM tasks WHERE project_id IN ($ph) ORDER BY id DESC", $readable);
    } else {
        $rows = pm_fetch_all('SELECT * FROM tasks ORDER BY id DESC');
    }
    if (!$rows) { pm_json(['tasks' => []]); return; }

    // Avoid N+1: pull related rows in one shot per table, then bucket in PHP.
    $ids = array_map(fn($r) => (int)$r['id'], $rows);
    $ph  = implode(',', array_fill(0, count($ids), '?'));

    $labelsByTask    = [];
    $assigneesByTask = [];
    $subsByTask      = [];
    $commentsByTask  = [];
    $attachmentsByTask = [];
    $watchersByTask  = [];
    $blockedByTask   = [];
    $blocksByTask    = [];
    $timeByTask      = [];
    $customByTask    = [];

    foreach (pm_fetch_all("SELECT task_id, label_id FROM task_labels WHERE task_id IN ($ph)", $ids) as $r) {
        $labelsByTask[(int)$r['task_id']][] = (int)$r['label_id'];
    }
    foreach (pm_fetch_all("SELECT task_id, user_id FROM task_assignees WHERE task_id IN ($ph)", $ids) as $r) {
        $assigneesByTask[(int)$r['task_id']][] = (int)$r['user_id'];
    }
    foreach (pm_fetch_all(
        "SELECT id, task_id, text, done FROM subtasks
         WHERE task_id IN ($ph) ORDER BY sort_order, id",
        $ids
    ) as $r) {
        $subsByTask[(int)$r['task_id']][] = [
            'id'   => (int)$r['id'],
            'text' => $r['text'],
            'done' => (bool)$r['done'],
        ];
    }
    foreach (pm_fetch_all("SELECT task_id, COUNT(*) AS c FROM comments WHERE task_id IN ($ph) GROUP BY task_id", $ids) as $r) {
        $commentsByTask[(int)$r['task_id']] = (int)$r['c'];
    }
    foreach (pm_fetch_all("SELECT task_id, COUNT(*) AS c FROM task_attachments WHERE task_id IN ($ph) GROUP BY task_id", $ids) as $r) {
        $attachmentsByTask[(int)$r['task_id']] = (int)$r['c'];
    }
    // v2 batched enrichment — one query per table, bucketed in PHP (no N+1).
    foreach (pm_fetch_all("SELECT task_id, user_id FROM task_watchers WHERE task_id IN ($ph)", $ids) as $r) {
        $watchersByTask[(int)$r['task_id']][] = (int)$r['user_id'];
    }
    // blocked_by: rows keyed on our task_id point at the task we depend on.
    foreach (pm_fetch_all("SELECT task_id, depends_on_id FROM task_dependencies WHERE task_id IN ($ph)", $ids) as $r) {
        $blockedByTask[(int)$r['task_id']][] = (int)$r['depends_on_id'];
    }
    // blocks: rows where we are the dependency point back at the dependent task.
    foreach (pm_fetch_all("SELECT task_id, depends_on_id FROM task_dependencies WHERE depends_on_id IN ($ph)", $ids) as $r) {
        $blocksByTask[(int)$r['depends_on_id']][] = (int)$r['task_id'];
    }
    foreach (pm_fetch_all("SELECT task_id, COALESCE(SUM(minutes),0) AS m FROM time_entries WHERE task_id IN ($ph) GROUP BY task_id", $ids) as $r) {
        $timeByTask[(int)$r['task_id']] = (int)$r['m'];
    }
    foreach (pm_fetch_all("SELECT task_id, field_id, value FROM task_custom_values WHERE task_id IN ($ph)", $ids) as $r) {
        $customByTask[(int)$r['task_id']][(string)(int)$r['field_id']] = $r['value'];
    }

    $out = [];
    foreach ($rows as $t) {
        $id = (int)$t['id'];
        $shape = pm_task_base_shape($t);
        $shape['labels']    = $labelsByTask[$id]    ?? [];
        $shape['assignees'] = $assigneesByTask[$id] ?? [];
        $shape['subtasks']  = $subsByTask[$id]      ?? [];
        $shape['comments']  = $commentsByTask[$id]  ?? 0;
        $shape['attachments'] = $attachmentsByTask[$id] ?? 0;
        $shape['watchers']    = $watchersByTask[$id]    ?? [];
        $shape['blocked_by']  = $blockedByTask[$id]     ?? [];
        $shape['blocks']      = $blocksByTask[$id]      ?? [];
        $shape['time_logged'] = $timeByTask[$id]        ?? 0;
        $shape['custom']      = (object)($customByTask[$id] ?? []);
        $out[] = $shape;
    }
    pm_json(['tasks' => $out]);
}

function pm_get_task(int $id): void {
    $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$id]);
    if (!$t) pm_error('Not found', 404);
    pm_json(['task' => pm_task_row_to_shape($t)]);
}

function pm_validate_label_ids_for_project(array $labelIds, int $projectId): array {
    $clean = array_values(array_unique(array_map('intval', $labelIds)));
    if (!$clean) return [];
    $ph = implode(',', array_fill(0, count($clean), '?'));
    $params = array_merge($clean, [$projectId]);
    $rows = pm_fetch_all(
        "SELECT id FROM labels
         WHERE id IN ($ph)
           AND archived = 0
           AND (project_id IS NULL OR project_id = ?)",
        $params
    );
    $ok = array_map(fn($r) => (int)$r['id'], $rows);
    sort($ok);
    $want = $clean;
    sort($want);
    if ($ok !== $want) {
        pm_error('One or more labels are invalid, archived, or out of project scope', 409);
    }
    return $clean;
}

function pm_validate_assignee_ids(array $assigneeIds): array {
    $clean = array_values(array_unique(array_map('intval', $assigneeIds)));
    if (!$clean) return [];
    $ph = implode(',', array_fill(0, count($clean), '?'));
    $rows = pm_fetch_all("SELECT id FROM users WHERE id IN ($ph)", $clean);
    $ok = array_map(fn($r) => (int)$r['id'], $rows);
    sort($ok);
    $want = $clean;
    sort($want);
    if ($ok !== $want) {
        pm_error('One or more assignees are invalid', 409);
    }
    return $clean;
}

function pm_search_tasks(): void {
    $uid = pm_current_user_id() ?? 0;
    $joins = '';
    $joinParams = [];
    $where = [];
    $whereParams = [];

    // Access: restrict to readable projects (null = no restriction).
    if (function_exists('pm_readable_project_ids')) {
        $readable = pm_readable_project_ids($uid);
        if ($readable !== null) {
            if (!$readable) { pm_json(['tasks' => [], 'total' => 0, 'has_more' => false]); return; }
            $ph = implode(',', array_fill(0, count($readable), '?'));
            $where[] = "t.project_id IN ($ph)";
            foreach ($readable as $r) $whereParams[] = (int)$r;
        }
    }

    $q = trim((string)pm_param('q', ''));
    if ($q !== '') {
        $where[] = '(t.title LIKE ? OR t.ref LIKE ?)';
        // Escape LIKE metacharacters so a query like "100%" or "a_b" matches
        // literally instead of acting as a wildcard (or forcing a full scan).
        $like = '%' . str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q) . '%';
        $whereParams[] = $like; $whereParams[] = $like;
    }
    $project = pm_int_param('project');
    if ($project) { $where[] = 't.project_id = ?'; $whereParams[] = $project; }
    $status = trim((string)pm_param('status', ''));
    if ($status !== '' && pm_is_valid_status($status)) { $where[] = 't.status = ?'; $whereParams[] = $status; }
    $assignee = pm_int_param('assignee');
    if ($assignee) { $joins .= ' JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = ?'; $joinParams[] = $assignee; }
    $label = pm_int_param('label');
    if ($label) { $joins .= ' JOIN task_labels tl ON tl.task_id = t.id AND tl.label_id = ?'; $joinParams[] = $label; }

    $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';
    $limit  = max(1, min(100, (int)pm_int_param('limit', 25)));
    $offset = max(0, (int)pm_int_param('offset', 0));
    $allParams = array_merge($joinParams, $whereParams);

    $countRow = pm_fetch_one("SELECT COUNT(DISTINCT t.id) AS c FROM tasks t$joins $whereSql", $allParams);
    $total = (int)($countRow['c'] ?? 0);

    // $limit/$offset are validated ints — safe to inline.
    $rows = pm_fetch_all(
        "SELECT DISTINCT t.* FROM tasks t$joins $whereSql ORDER BY t.id DESC LIMIT $limit OFFSET $offset",
        $allParams
    );

    // Batch-load assignees for all result rows in ONE query (was an N+1 loop —
    // up to `limit` extra queries per search) and bucket by task in PHP.
    $assigneesByTask = [];
    if ($rows) {
        $rowIds = array_map(fn($r) => (int)$r['id'], $rows);
        $ph = implode(',', array_fill(0, count($rowIds), '?'));
        foreach (pm_fetch_all("SELECT task_id, user_id FROM task_assignees WHERE task_id IN ($ph)", $rowIds) as $r) {
            $assigneesByTask[(int)$r['task_id']][] = (int)$r['user_id'];
        }
    }

    $tasks = array_map(function ($t) use ($uid, $assigneesByTask) {
        $tid = (int)$t['id'];
        return [
            'id'        => $tid,
            'ref'       => $t['ref'],
            'title'     => $t['title'],
            'status'    => $t['status'],
            'priority'  => (int)$t['priority'],
            'project'   => (int)$t['project_id'],
            'due'       => $t['due'],
            'assignees' => $assigneesByTask[$tid] ?? [],
            'can_write' => function_exists('pm_can_write_project')
                ? pm_can_write_project($uid, (int)$t['project_id']) : true,
        ];
    }, $rows);

    pm_json(['tasks' => $tasks, 'total' => $total, 'has_more' => ($offset + count($rows)) < $total]);
}

function pm_create_task(): void {
    $title = trim((string)pm_param('title', ''));
    if ($title === '') pm_error('Title required');
    // Bound to the column width declared in install.php so the DB doesn't
    // silently truncate, or — worse — surface a raw length-violation error.
    if (mb_strlen($title) > 500) pm_error('Title is too long (max 500 characters)');
    $project  = pm_int_param('project');
    if (!$project) pm_error('project required');
    $status   = (string)pm_param('status', 'todo');
    if (!pm_is_valid_status($status)) pm_error('Invalid status');
    $priority = (int)pm_param('priority', 2);
    if ($priority < 0 || $priority > 3) pm_error('Invalid priority');
    $due      = pm_param('due');
    if ($due !== null && $due !== '' && !pm_is_valid_date((string)$due)) pm_error('Invalid due date');
    $startDate = pm_param('start_date');
    if ($startDate !== null && $startDate !== '' && !pm_is_valid_date((string)$startDate)) pm_error('Invalid start date');
    $estimate = pm_param('estimate');
    if ($estimate !== null && mb_strlen((string)$estimate) > 32) pm_error('Estimate is too long');
    $desc     = pm_param('description');
    if ($desc !== null && mb_strlen((string)$desc) > 20000) pm_error('Description is too long');
    $labels   = (array)pm_param('labels', []);
    $assignees= (array)pm_param('assignees', []);

    $proj = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [$project]);
    if (!$proj) pm_error('Invalid project');
    if (!empty($proj['archived'])) pm_error('Cannot create tasks in an archived project', 409);
    if (function_exists('pm_can_write_project') && !pm_can_write_project(pm_current_user_id() ?? 0, $project)) {
        pm_error('Forbidden', 403);
    }

    // milestone_id: optional; must belong to the same project when supplied.
    $milestoneId = pm_milestone_id_for_project(pm_param('milestone_id'), $project);

    // position: explicit double if given, else next slot for this project+status.
    $positionRaw = pm_param('position');
    if ($positionRaw !== null && $positionRaw !== '') {
        $position = (float)$positionRaw;
    } else {
        $maxPos = pm_fetch_one(
            'SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE project_id = ? AND status = ?',
            [$project, $status]
        );
        $position = (float)($maxPos['m'] ?? 0) + 1;
    }

    $labels = pm_validate_label_ids_for_project($labels, $project);
    $assignees = pm_validate_assignee_ids($assignees);

    $prefix = $proj['key_prefix'] ?: pm_config()['project_key'];

    // Insert the task with a retry loop. Two concurrent creators can both read
    // the same MAX(ref)+1 and then collide on the UNIQUE(ref) constraint — on
    // collision we recompute and try again instead of bubbling a 500.
    $tid = null;
    $attempts = 0;
    while (true) {
        $maxRow = pm_fetch_one(
            "SELECT MAX(CAST(SUBSTRING_INDEX(ref, '-', -1) AS UNSIGNED)) AS m FROM tasks WHERE ref LIKE ?",
            [$prefix . '-%']
        );
        $next = ((int)($maxRow['m'] ?? 0)) + 1;
        if ($next < 100) $next = 100; // keep ids readable
        $ref = $prefix . '-' . $next;
        try {
            pm_exec(
                'INSERT INTO tasks (ref, project_id, status, title, description, priority, due, start_date, position, milestone_id, estimate, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                [$ref, $project, $status, $title, $desc ?: null, $priority, $due ?: null,
                 ($startDate !== null && $startDate !== '') ? $startDate : null,
                 $position, $milestoneId, $estimate ?: null, pm_current_user_id()]
            );
            $tid = pm_last_id();
            break;
        } catch (PDOException $e) {
            // 23000 = integrity constraint violation (duplicate ref).
            if ($e->getCode() !== '23000' || ++$attempts >= 5) {
                // Log server-side for ops; don't leak schema/constraint names
                // (and Slack-bound message text) back to the caller.
                error_log('pm_create_task insert failed: ' . $e->getMessage());
                pm_error('Failed to create task. Please try again.', 500);
            }
            // brief jitter so two racers don't lock-step forever
            usleep(random_int(1000, 5000));
        }
    }

    try {
        pm_db()->beginTransaction();
        foreach ($labels as $lid) {
            pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)', [$tid, (int)$lid]);
        }
        foreach ($assignees as $uid) {
            pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$tid, (int)$uid]);
        }
        pm_log_activity(pm_current_user_id(), $tid, 'created', $title);
        pm_db()->commit();
    } catch (Throwable $e) {
        if (pm_db()->inTransaction()) pm_db()->rollBack();
        pm_exec('DELETE FROM tasks WHERE id = ?', [$tid]);
        error_log('pm_create_task metadata failed: ' . $e->getMessage());
        pm_error('Failed to create task metadata.', 500);
    }
    $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$tid]);

    // v2 in-app notifications. Best-effort: a notify failure must never turn a
    // successful create into a 500, so each block is independently guarded.
    $actor = pm_current_user_id();
    try {
        pm_add_watchers($tid, array_merge([$actor], $assignees));
    } catch (Throwable $_) { /* best effort */ }
    foreach ($assignees as $uid) {
        try {
            if ((int)$uid === (int)$actor) continue;
            pm_notify((int)$uid, $actor, $tid, 'assigned',
                pm_assigned_body($actor, $t));
        } catch (Throwable $_) { /* best effort */ }
    }

    pm_slack_notify_task_event($t, $proj, 'task_created', 'created this task');
    try {
        if (function_exists('pm_run_automations')) pm_run_automations('task_created', $tid, $actor);
    } catch (Throwable $_) { /* best effort */ }
    $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$tid]) ?: $t;
    pm_json(['task' => pm_task_row_to_shape($t)]);
}

function pm_update_task(int $id): void {
    $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$id]);
    if (!$t) pm_error('Not found', 404);
    $body = pm_body();

    // Snapshot the old status so the post-update side effects (Slack ping,
    // recurring respawn) can detect a real *transition into* done and not fire
    // again every time an already-done task is re-saved with no status change.
    $prevStatus = (string)$t['status'];

    // Snapshot the old assignees so we can detect *newly added* ones and fire
    // a Slack task_assigned event for each, while avoiding duplicate pings to
    // someone who was already on the task.
    $prevAssignees = [];
    foreach (pm_fetch_all('SELECT user_id FROM task_assignees WHERE task_id = ?', [$id]) as $r) {
        $prevAssignees[] = (int)$r['user_id'];
    }

    // Validate per-column before touching the DB so callers get a clean 400
    // instead of a PDOException bubbled up as a 500.
    if (array_key_exists('title', $body)) {
        // Don't reassign $t — that's the task row we still need below for the
        // status-transition / activity-logging side effects. Trim the body
        // value in place so the UPDATE picks up the trimmed string.
        $newTitle = trim((string)$body['title']);
        if ($newTitle === '') pm_error('Title cannot be empty');
        if (mb_strlen($newTitle) > 500) pm_error('Title is too long (max 500 characters)');
        $body['title'] = $newTitle;
    }
    if (array_key_exists('status', $body) && !pm_is_valid_status((string)$body['status'])) {
        pm_error('Invalid status');
    }
    if (array_key_exists('due', $body) && $body['due'] !== null && $body['due'] !== '' && !pm_is_valid_date((string)$body['due'])) {
        pm_error('Invalid due date');
    }
    if (array_key_exists('start_date', $body) && $body['start_date'] !== null && $body['start_date'] !== '' && !pm_is_valid_date((string)$body['start_date'])) {
        pm_error('Invalid start date');
    }
    if (array_key_exists('estimate', $body) && $body['estimate'] !== null && mb_strlen((string)$body['estimate']) > 32) {
        pm_error('Estimate is too long');
    }
    if (array_key_exists('description', $body) && $body['description'] !== null && mb_strlen((string)$body['description']) > 20000) {
        pm_error('Description is too long');
    }
    if (array_key_exists('priority', $body)) {
        $p = (int)$body['priority'];
        if ($p < 0 || $p > 3) pm_error('Invalid priority');
    }

    $fields = [];
    $params = [];
    foreach (['title','description','status','estimate','due','start_date'] as $col) {
        if (array_key_exists($col, $body)) {
            $fields[] = "$col = ?";
            $params[] = $body[$col] === '' ? null : $body[$col];
        }
    }
    if (array_key_exists('priority', $body)) {
        $fields[] = 'priority = ?';
        $params[] = (int)$body['priority'];
    }
    if (array_key_exists('position', $body)) {
        $fields[] = 'position = ?';
        $params[] = (float)$body['position'];
    }
    // milestone_id: null clears it; otherwise must belong to the task's project
    // (or the project it's being moved into in the same PATCH).
    if (array_key_exists('milestone_id', $body)) {
        $msProject = array_key_exists('project', $body) ? (int)$body['project'] : (int)$t['project_id'];
        $fields[] = 'milestone_id = ?';
        $params[] = pm_milestone_id_for_project($body['milestone_id'], $msProject);
    }
    if (array_key_exists('project', $body)) {
        $nextProjectId = (int)$body['project'];
        $proj = pm_fetch_one('SELECT id, archived FROM projects WHERE id = ?', [$nextProjectId]);
        if (!$proj) pm_error('Invalid project', 409);
        if (!empty($proj['archived'])) pm_error('Cannot move tasks into an archived project', 409);
        if (function_exists('pm_can_write_project') && !pm_can_write_project(pm_current_user_id() ?? 0, $nextProjectId)) {
            pm_error('Forbidden', 403);
        }
        $fields[] = 'project_id = ?';
        $params[] = $nextProjectId;
    }
    if ($fields) {
        $params[] = $id;
        pm_exec('UPDATE tasks SET ' . implode(', ', $fields) . ' WHERE id = ?', $params);
    }

    if (array_key_exists('labels', $body) && is_array($body['labels'])) {
        $labelProject = array_key_exists('project', $body) ? (int)$body['project'] : (int)$t['project_id'];
        $validLabels = pm_validate_label_ids_for_project($body['labels'], $labelProject);
        pm_exec('DELETE FROM task_labels WHERE task_id = ?', [$id]);
        foreach ($validLabels as $lid) {
            pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)', [$id, (int)$lid]);
        }
    }
    $newlyAssigned = [];
    if (array_key_exists('assignees', $body) && is_array($body['assignees'])) {
        $validAssignees = pm_validate_assignee_ids($body['assignees']);
        pm_exec('DELETE FROM task_assignees WHERE task_id = ?', [$id]);
        foreach ($validAssignees as $uid) {
            pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$id, $uid]);
            if (!in_array($uid, $prevAssignees, true)) $newlyAssigned[] = $uid;
        }
    }

    // When a task changes project, its milestone and project-scoped labels may
    // no longer belong to the new project. If the caller didn't explicitly set
    // them in this PATCH, detach the stale ones so the task doesn't keep a
    // foreign milestone (corrupting that milestone's counts) or out-of-scope
    // labels (which would 409 the next label edit). Global labels are kept.
    if (array_key_exists('project', $body)) {
        $newProjectId = (int)$body['project'];
        if ($newProjectId !== (int)$t['project_id']) {
            if (!array_key_exists('milestone_id', $body)) {
                $curMs = pm_fetch_one('SELECT milestone_id FROM tasks WHERE id = ?', [$id]);
                $curMsId = ($curMs && $curMs['milestone_id'] !== null) ? (int)$curMs['milestone_id'] : null;
                if ($curMsId !== null) {
                    $stillValid = pm_fetch_one('SELECT id FROM milestones WHERE id = ? AND project_id = ?', [$curMsId, $newProjectId]);
                    if (!$stillValid) pm_exec('UPDATE tasks SET milestone_id = NULL WHERE id = ?', [$id]);
                }
            }
            if (!(array_key_exists('labels', $body) && is_array($body['labels']))) {
                pm_exec(
                    'DELETE tl FROM task_labels tl JOIN labels l ON l.id = tl.label_id
                     WHERE tl.task_id = ? AND l.project_id IS NOT NULL AND l.project_id <> ?',
                    [$id, $newProjectId]
                );
            }
        }
    }

    // Activity (light)
    if (isset($body['status']) && $body['status'] !== $t['status']) {
        pm_log_activity(pm_current_user_id(), $id, 'moved', $t['status'] . ' → ' . $body['status']);
        if ($body['status'] === 'done') {
            pm_log_activity(pm_current_user_id(), $id, 'completed', $t['title']);
        }
    }

    $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$id]);

    // Fire Slack + recurring-generation side effects once the write is stable.
    // Must be a *transition into* done — otherwise re-saving an already-done
    // task would fire another Slack message and spawn another recurring
    // instance on every save.
    if ($prevStatus !== 'done' && $t['status'] === 'done') {
        $proj = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [(int)$t['project_id']]);
        pm_slack_notify_task_event($t, $proj, 'task_completed', 'marked this task done');
        if (!empty($t['recurring_rule_id'])) {
            // Pass the completed task id so generation only fires for the current
            // tip of the chain (prevents duplicate spawns on reopen→re-complete).
            pm_generate_next_recurring_task((int)$t['recurring_rule_id'], $id);
        }
    }
    if ($newlyAssigned) {
        $proj = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [(int)$t['project_id']]);
        $names = [];
        foreach ($newlyAssigned as $uid) {
            $u = pm_fetch_one('SELECT name FROM users WHERE id = ?', [$uid]);
            if ($u) $names[] = $u['name'];
        }
        $verb = 'assigned ' . (count($names) ? implode(', ', $names) : 'someone');
        pm_slack_notify_task_event($t, $proj, 'task_assigned', $verb);
    }

    // v2 in-app notifications (best-effort; never break the PATCH).
    $actor = pm_current_user_id();
    // Newly assigned users become watchers and get an 'assigned' notification.
    foreach ($newlyAssigned as $uid) {
        try { pm_add_watchers($id, [(int)$uid]); } catch (Throwable $_) {}
        try {
            pm_notify((int)$uid, $actor, $id, 'assigned', pm_assigned_body($actor, $t));
        } catch (Throwable $_) {}
    }
    // Real transition into done: ping recipients, and surface to watchers of any
    // task this one was blocking (it's now potentially unblocked).
    if ($prevStatus !== 'done' && $t['status'] === 'done') {
        try {
            $doneBody = pm_actor_name($actor) . ' completed ' . $t['ref'] . ' ' . $t['title'];
            pm_notify_users(pm_task_recipients($id, $actor), $actor, $id, 'status', $doneBody);
        } catch (Throwable $_) {}
        try { pm_notify_unblocked($id, $actor); } catch (Throwable $_) {}
    }

    try {
        if (function_exists('pm_run_automations') && $prevStatus !== 'done' && $t['status'] === 'done') {
            pm_run_automations('task_completed', $id, $actor);
            $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$id]) ?: $t;
        }
    } catch (Throwable $_) { /* best effort */ }

    pm_json(['task' => pm_task_row_to_shape($t)]);
}

// Notify watchers of tasks that were blocked by $completedTaskId — those tasks
// may now be unblocked. We notify watchers (∪ assignees) of each dependent task.
function pm_notify_unblocked(int $completedTaskId, ?int $actorId): void {
    $deps = pm_fetch_all('SELECT task_id FROM task_dependencies WHERE depends_on_id = ?', [$completedTaskId]);
    foreach ($deps as $d) {
        $depTaskId = (int)$d['task_id'];
        if ($depTaskId <= 0) continue;
        // Only announce "no longer blocked" once EVERY blocker is done — a task
        // blocked by two tasks would otherwise fire this when just the first one
        // completes, while it's still genuinely blocked by the second.
        $remaining = pm_fetch_one(
            "SELECT COUNT(*) AS n
             FROM task_dependencies dd
             JOIN tasks bt ON bt.id = dd.depends_on_id
             WHERE dd.task_id = ? AND bt.status <> 'done'",
            [$depTaskId]
        );
        if ((int)($remaining['n'] ?? 0) > 0) continue;
        $dep = pm_fetch_one('SELECT ref, title FROM tasks WHERE id = ?', [$depTaskId]);
        if (!$dep) continue;
        $body = ($dep['ref'] ?? ('#' . $depTaskId)) . ' ' . ($dep['title'] ?? '') . ' is no longer blocked';
        pm_notify_users(pm_task_recipients($depTaskId, $actorId), $actorId, $depTaskId, 'dependency', $body);
    }
}

// Helper: human "<actor> assigned you <ref> <title>" body for assignment pings.
function pm_assigned_body(?int $actorId, array $task): string {
    return pm_actor_name($actorId) . ' assigned you ' . ($task['ref'] ?? ('#' . (int)$task['id'])) . ' ' . ($task['title'] ?? '');
}

function pm_actor_name(?int $actorId): string {
    if (!$actorId) return 'Someone';
    $u = pm_fetch_one('SELECT name FROM users WHERE id = ?', [$actorId]);
    return $u['name'] ?? 'Someone';
}

// Resolve+validate a milestone id against a project. Accepts null/'' → null.
// Rejects a milestone that doesn't exist or belongs to a different project.
function pm_milestone_id_for_project($raw, int $projectId): ?int {
    if ($raw === null || $raw === '') return null;
    $mid = (int)$raw;
    if ($mid <= 0) return null;
    $ms = pm_fetch_one('SELECT id FROM milestones WHERE id = ? AND project_id = ?', [$mid, $projectId]);
    if (!$ms) pm_error('Invalid milestone for this project', 409);
    return $mid;
}

function pm_delete_task(int $id): void {
    $t = pm_fetch_one('SELECT id, title FROM tasks WHERE id = ?', [$id]);
    if (!$t) pm_error('Not found', 404);
    $atts = pm_fetch_all('SELECT stored_name FROM task_attachments WHERE task_id = ?', [$id]);
    // Log before the delete so activity.task_id can still FK-resolve the
    // title in the listing, and so the entry survives the cascade.
    pm_log_activity(pm_current_user_id(), null, 'deleted', $t['title'] ?? '');
    pm_exec('DELETE FROM tasks WHERE id = ?', [$id]);
    foreach ($atts as $a) pm_attachment_delete_file((string)($a['stored_name'] ?? ''));
    pm_json(['ok' => true]);
}

// ---- subtasks ----
function pm_add_subtask(int $taskId): void {
    // Validate the parent task exists up-front. Without this, an INSERT for a
    // bogus task_id raises a FK violation and we'd surface a raw PDOException
    // (leaking schema) instead of a clean 404.
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);
    $text = trim((string)pm_param('text', ''));
    if ($text === '') pm_error('Text required');
    if (mb_strlen($text) > 500) pm_error('Subtask is too long (max 500 characters)');
    $maxRow = pm_fetch_one('SELECT COALESCE(MAX(sort_order), 0) AS m FROM subtasks WHERE task_id = ?', [$taskId]);
    $next = ((int)($maxRow['m'] ?? 0)) + 1;
    pm_exec('INSERT INTO subtasks (task_id, text, done, sort_order) VALUES (?,?,0,?)',
        [$taskId, $text, $next]);
    $sid = pm_last_id();
    $s = pm_fetch_one('SELECT id, text, done FROM subtasks WHERE id = ?', [$sid]);
    pm_json(['subtask' => [
        'id'=>(int)$s['id'],'text'=>$s['text'],'done'=>(bool)$s['done']
    ]]);
}

function pm_update_subtask(int $taskId, int $subId): void {
    // Verify the subtask actually belongs to this task before doing anything
    // else. The composite WHERE in the UPDATE already enforces that, but the
    // early check lets us distinguish 404 (not ours) from 200 with zero rows.
    $existing = pm_fetch_one('SELECT id FROM subtasks WHERE id = ? AND task_id = ?', [$subId, $taskId]);
    if (!$existing) pm_error('Subtask not found', 404);
    $body = pm_body();
    $fields = [];
    $params = [];
    if (array_key_exists('text', $body)) {
        $text = trim((string)$body['text']);
        if ($text === '') pm_error('Subtask text cannot be empty');
        if (mb_strlen($text) > 500) pm_error('Subtask is too long (max 500 characters)');
        $fields[] = 'text = ?';
        $params[] = $text;
    }
    if (array_key_exists('done', $body)) { $fields[] = 'done = ?'; $params[] = !empty($body['done']) ? 1 : 0; }
    if (!$fields) pm_error('Nothing to update');
    $params[] = $subId;
    $params[] = $taskId;
    pm_exec('UPDATE subtasks SET ' . implode(',', $fields) . ' WHERE id = ? AND task_id = ?', $params);
    $s = pm_fetch_one('SELECT id, text, done FROM subtasks WHERE id = ? AND task_id = ?', [$subId, $taskId]);
    if (!$s) pm_error('Subtask not found', 404);
    pm_json(['subtask' => [
        'id'=>(int)$s['id'],'text'=>$s['text'],'done'=>(bool)$s['done']
    ]]);
}

function pm_delete_subtask(int $taskId, int $subId): void {
    $n = pm_exec('DELETE FROM subtasks WHERE id = ? AND task_id = ?', [$subId, $taskId]);
    if ($n === 0) pm_error('Subtask not found', 404);
    pm_json(['ok' => true]);
}

// ---- watchers ----
function pm_watchers_for(int $taskId): array {
    $rows = pm_fetch_all('SELECT user_id FROM task_watchers WHERE task_id = ? ORDER BY user_id', [$taskId]);
    return array_map(fn($r) => (int)$r['user_id'], $rows);
}

function pm_watch_task(int $taskId): void {
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);
    pm_add_watchers($taskId, [pm_current_user_id()]);
    pm_json(['ok' => true, 'watchers' => pm_watchers_for($taskId)]);
}

function pm_unwatch_task(int $taskId): void {
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);
    pm_exec('DELETE FROM task_watchers WHERE task_id = ? AND user_id = ?', [$taskId, pm_current_user_id()]);
    pm_json(['ok' => true, 'watchers' => pm_watchers_for($taskId)]);
}

// ---- task-scoped activity (drawer timeline) ----
function pm_task_activity(int $taskId): void {
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);
    // Mirror api/activity.php's row shape, scoped to this task, newest first.
    $rows = pm_fetch_all(
        "SELECT a.id, a.action, a.detail, a.created_at,
                a.user_id, u.name AS user_name, u.initials, u.color,
                a.task_id, t.ref AS task_ref, t.title AS task_title
         FROM activity a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN tasks t ON t.id = a.task_id
         WHERE a.task_id = ?
         ORDER BY a.id DESC
         LIMIT 50",
        [$taskId]
    );
    pm_json(['activity' => array_map(fn($r) => [
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
    ], $rows)]);
}

// ---- comment reactions ----
// Reactions are toggled per (comment, user, emoji). The emoji is bounded to the
// VARCHAR(32) column so a malformed client can't overflow it.
function pm_validate_reaction_emoji(string $emoji): string {
    $emoji = trim($emoji);
    if ($emoji === '') pm_error('Emoji required');
    if (mb_strlen($emoji) > 32) pm_error('Emoji is too long');
    return $emoji;
}

function pm_assert_comment(int $taskId, int $commentId): void {
    $c = pm_fetch_one('SELECT id FROM comments WHERE id = ? AND task_id = ?', [$commentId, $taskId]);
    if (!$c) pm_error('Comment not found', 404);
}

function pm_add_reaction(int $taskId, int $commentId, string $emoji): void {
    $emoji = pm_validate_reaction_emoji($emoji);
    pm_assert_comment($taskId, $commentId);
    pm_exec(
        'INSERT IGNORE INTO comment_reactions (comment_id, user_id, emoji) VALUES (?,?,?)',
        [$commentId, pm_current_user_id(), $emoji]
    );
    pm_json(['ok' => true]);
}

function pm_remove_reaction(int $taskId, int $commentId, string $emoji): void {
    $emoji = pm_validate_reaction_emoji($emoji);
    pm_assert_comment($taskId, $commentId);
    pm_exec(
        'DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?',
        [$commentId, pm_current_user_id(), $emoji]
    );
    pm_json(['ok' => true]);
}

// ---- comments ----
function pm_comment_shape(array $r, array $reactions = [], array $mentions = []): array {
    return [
        'id'         => (int)$r['id'],
        'body'       => $r['body'],
        'created_at' => $r['created_at'],
        'updated_at' => $r['updated_at'] ?? null,
        'user'       => [
            'id'       => $r['user_id'] !== null ? (int)$r['user_id'] : null,
            'name'     => $r['name']     ?? 'Former teammate',
            'initials' => $r['initials'] ?? '??',
            'color'    => $r['color']    ?? '#64748B',
        ],
        'reactions'  => $reactions,
        'mentions'   => $mentions,
    ];
}

// Build [{emoji, count, mine}] for one comment from already-fetched reaction
// rows ([{emoji, user_id}, ...]). $me is the current user id for the `mine` flag.
function pm_shape_reactions(array $rows, int $me): array {
    $byEmoji = [];
    foreach ($rows as $r) {
        $emoji = (string)$r['emoji'];
        if (!isset($byEmoji[$emoji])) $byEmoji[$emoji] = ['emoji' => $emoji, 'count' => 0, 'mine' => false];
        $byEmoji[$emoji]['count']++;
        if ((int)$r['user_id'] === $me) $byEmoji[$emoji]['mine'] = true;
    }
    return array_values($byEmoji);
}

function pm_comments_have_updated_at(): bool {
    static $has = null;
    if ($has !== null) return $has;
    $row = pm_fetch_one(
        "SELECT 1 AS ok
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'comments'
           AND COLUMN_NAME = 'updated_at'
         LIMIT 1"
    );
    $has = (bool)$row;
    return $has;
}

function pm_list_comments(int $taskId): void {
    // Distinguish "task exists, has no comments" (200, []) from "task gone"
    // (404) so the drawer can show an accurate empty state vs. an error.
    $taskExists = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$taskExists) pm_error('Task not found', 404);
    $cols = pm_comments_have_updated_at()
        ? 'c.id, c.body, c.created_at, c.updated_at, c.user_id, u.name, u.initials, u.color'
        : 'c.id, c.body, c.created_at, NULL AS updated_at, c.user_id, u.name, u.initials, u.color';
    $rows = pm_fetch_all(
        "SELECT $cols
         FROM comments c LEFT JOIN users u ON u.id = c.user_id
         WHERE c.task_id = ? ORDER BY c.id ASC",
        [$taskId]
    );
    if (!$rows) { pm_json(['comments' => []]); return; }

    // Batch-load reactions + mentions for all comments at once (no N+1).
    $cids = array_map(fn($r) => (int)$r['id'], $rows);
    $ph = implode(',', array_fill(0, count($cids), '?'));
    $me = pm_current_user_id();
    $reactByComment = [];
    foreach (pm_fetch_all("SELECT comment_id, user_id, emoji FROM comment_reactions WHERE comment_id IN ($ph)", $cids) as $r) {
        $reactByComment[(int)$r['comment_id']][] = $r;
    }
    $mentByComment = [];
    foreach (pm_fetch_all("SELECT comment_id, user_id FROM comment_mentions WHERE comment_id IN ($ph)", $cids) as $r) {
        $mentByComment[(int)$r['comment_id']][] = (int)$r['user_id'];
    }
    $out = [];
    foreach ($rows as $r) {
        $cid = (int)$r['id'];
        $out[] = pm_comment_shape(
            $r,
            pm_shape_reactions($reactByComment[$cid] ?? [], $me),
            $mentByComment[$cid] ?? []
        );
    }
    pm_json(['comments' => $out]);
}

function pm_add_comment(int $taskId): void {
    // Confirm the task exists up-front; otherwise the INSERT will fail on the
    // FK with a schema-leaking 500 instead of a clean 404.
    $taskExists = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$taskExists) pm_error('Task not found', 404);
    $body = trim((string)pm_param('body', ''));
    if ($body === '') pm_error('Empty comment');
    // Bound the comment at a comfortable-but-sane size. The DB column is TEXT
    // (~65KB), but letting users paste multi-MB content degrades the rest of
    // the UI (and Slack post-truncation downstream) for everyone else.
    if (mb_strlen($body) > 5000) pm_error('Comment is too long (max 5000 characters)');
    pm_exec('INSERT INTO comments (task_id, user_id, body) VALUES (?,?,?)',
        [$taskId, pm_current_user_id(), $body]);
    // Capture the new comment id BEFORE logging activity — pm_log_activity does
    // its own INSERT, which advances the connection's lastInsertId(). On any
    // install where activity rows outnumber comments (i.e. every real one after
    // normal use), reading pm_last_id() after it would return the activity row
    // id and the comment fetch below would find nothing → 500.
    $cid = pm_last_id();
    pm_log_activity(pm_current_user_id(), $taskId, 'commented', mb_substr($body, 0, 200));
    $cols = pm_comments_have_updated_at()
        ? 'c.id, c.body, c.created_at, c.updated_at, c.user_id, u.name, u.initials, u.color'
        : 'c.id, c.body, c.created_at, NULL AS updated_at, c.user_id, u.name, u.initials, u.color';
    $r = pm_fetch_one(
        "SELECT $cols
         FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?",
        [$cid]
    );
    $task = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$taskId]);
    if ($task) {
        $proj = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [(int)$task['project_id']]);
        pm_slack_notify_task_event($task, $proj, 'comment_added', 'commented', $body);
        pm_notify_mentions($task, $proj, $body);
    }

    // v2 in-app notifications (best-effort).
    $actor = pm_current_user_id();
    $mentionIds = [];
    try { $mentionIds = pm_resolve_mentions($body); } catch (Throwable $_) {}
    try {
        // Notify task recipients (assignees ∪ watchers) minus the actor, and
        // minus anyone explicitly @-mentioned (they get a richer 'mention' ping).
        $recipients = array_values(array_diff(pm_task_recipients($taskId, $actor), $mentionIds));
        $cbody = pm_actor_name($actor) . ' commented on ' . ($task['ref'] ?? ('#' . $taskId)) . ': ' . mb_substr($body, 0, 200);
        pm_notify_users($recipients, $actor, $taskId, 'comment', $cbody);
    } catch (Throwable $_) {}
    foreach ($mentionIds as $uid) {
        $uid = (int)$uid;
        if ($uid <= 0) continue;
        try { pm_exec('INSERT IGNORE INTO comment_mentions (comment_id, user_id) VALUES (?,?)', [$cid, $uid]); } catch (Throwable $_) {}
        try {
            $mbody = pm_actor_name($actor) . ' mentioned you in ' . ($task['ref'] ?? ('#' . $taskId)) . ': ' . mb_substr($body, 0, 200);
            pm_notify($uid, $actor, $taskId, 'mention', $mbody);
        } catch (Throwable $_) {}
        try { pm_add_watchers($taskId, [$uid]); } catch (Throwable $_) {}
    }

    try {
        if (function_exists('pm_run_automations')) pm_run_automations('comment_added', $taskId, $actor);
    } catch (Throwable $_) { /* best effort */ }

    pm_json(['comment' => pm_comment_shape($r)]);
}

function pm_update_comment(int $taskId, int $commentId): void {
    $comment = pm_fetch_one('SELECT * FROM comments WHERE id = ? AND task_id = ?', [$commentId, $taskId]);
    if (!$comment) pm_error('Comment not found', 404);
    $me = pm_current_user();
    if (!$me) pm_error('Not authenticated', 401);
    $isOwner = (int)($comment['user_id'] ?? 0) === (int)$me['id'];
    if (!$isOwner && empty($me['is_admin'])) pm_error('Not allowed', 403);
    $body = trim((string)pm_param('body', ''));
    if ($body === '') pm_error('Empty comment');
    if (mb_strlen($body) > 5000) pm_error('Comment is too long (max 5000 characters)');
    if (pm_comments_have_updated_at()) {
        pm_exec('UPDATE comments SET body = ?, updated_at = NOW() WHERE id = ? AND task_id = ?', [$body, $commentId, $taskId]);
    } else {
        pm_exec('UPDATE comments SET body = ? WHERE id = ? AND task_id = ?', [$body, $commentId, $taskId]);
    }
    $cols = pm_comments_have_updated_at()
        ? 'c.id, c.body, c.created_at, c.updated_at, c.user_id, u.name, u.initials, u.color'
        : 'c.id, c.body, c.created_at, NULL AS updated_at, c.user_id, u.name, u.initials, u.color';
    $r = pm_fetch_one(
        "SELECT $cols
         FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.task_id = ?",
        [$commentId, $taskId]
    );
    $task = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$taskId]);
    if ($task) {
        $proj = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [(int)$task['project_id']]);
        pm_notify_mentions($task, $proj, $body);
    }
    pm_json(['comment' => pm_comment_shape($r)]);
}

function pm_delete_comment(int $taskId, int $commentId): void {
    $comment = pm_fetch_one('SELECT * FROM comments WHERE id = ? AND task_id = ?', [$commentId, $taskId]);
    if (!$comment) pm_error('Comment not found', 404);
    $me = pm_current_user();
    if (!$me) pm_error('Not authenticated', 401);
    $isOwner = (int)($comment['user_id'] ?? 0) === (int)$me['id'];
    if (!$isOwner && empty($me['is_admin'])) pm_error('Not allowed', 403);
    pm_exec('DELETE FROM comments WHERE id = ? AND task_id = ?', [$commentId, $taskId]);
    pm_json(['ok' => true]);
}

function pm_notify_mentions(array $task, ?array $project, string $text): void {
    // Resolve mentioned users through the SAME parser the in-app notifications
    // use (pm_resolve_mentions: full name or a unique first name, never bare
    // initials) so a comment's Slack ping and its in-app 'mention' notifications
    // target an identical set of people. Falls back to nothing if the lib is
    // absent (guarded include model).
    if (!function_exists('pm_resolve_mentions')) return;
    $ids = pm_resolve_mentions($text);
    if (!$ids) return;
    $ph = implode(',', array_fill(0, count($ids), '?'));
    $hits = pm_fetch_all("SELECT id, name FROM users WHERE id IN ($ph)", array_map('intval', $ids));
    if (!$hits) return;
    $actor = pm_current_user();
    $who = $actor['name'] ?? 'Someone';
    $mentioned = implode(', ', array_map(fn($u) => $u['name'], $hits));
    pm_log_activity(pm_current_user_id(), (int)$task['id'], 'mention', "{$who} mentioned {$mentioned}");
    if (!pm_slack_event_on('mention_added')) return;
    $channel = pm_slack_channel_for_project($project);
    if ($channel === '') return;
    $msg = pm_slack_format_task($task, "mentioned {$mentioned}", $actor, $project, $text);
    pm_slack_post($channel, $msg, ['event_key' => 'mention_added']);
}

function pm_bulk_update_tasks(): void {
    // Tasks are open to all authenticated users (see docs/regression-checklist
    // §6) so bulk operations need to mirror that. pm_require_auth() is enough
    // — every downstream branch only touches task rows, not workspace config.
    pm_require_auth();
    $body = pm_body();
    $ids = array_values(array_unique(array_map('intval', (array)($body['task_ids'] ?? []))));
    if (!$ids) pm_error('task_ids required');
    // Drop tasks the user can't write (private projects they aren't an editor of).
    if (function_exists('pm_can_write_task')) {
        $buid = pm_current_user_id() ?? 0;
        $ids = array_values(array_filter($ids, fn($tid) => pm_can_write_task($buid, $tid)));
        if (!$ids) pm_json(['ok' => true, 'updated' => 0]);
    }
    $patch = is_array($body['patch'] ?? null) ? $body['patch'] : [];
    if (!$patch) pm_error('patch required');
    // Reject bad patches once, before the loop — otherwise we'd partially
    // mutate the first N tasks and then bail on the N+1th with a mismatched
    // 400 that makes the rollback picture confusing for the caller.
    if (array_key_exists('title', $patch)) {
        $t = trim((string)$patch['title']);
        if ($t === '' || mb_strlen($t) > 500) pm_error('Invalid title');
    }
    if (array_key_exists('status', $patch) && !pm_is_valid_status((string)$patch['status'])) {
        pm_error('Invalid status');
    }
    if (array_key_exists('priority', $patch)) {
        $p = (int)$patch['priority'];
        if ($p < 0 || $p > 3) pm_error('Invalid priority');
    }
    if (array_key_exists('due', $patch) && $patch['due'] !== null && $patch['due'] !== '' && !pm_is_valid_date((string)$patch['due'])) {
        pm_error('Invalid due date');
    }
    if (array_key_exists('estimate', $patch) && $patch['estimate'] !== null && mb_strlen((string)$patch['estimate']) > 32) {
        pm_error('Estimate is too long');
    }
    if (array_key_exists('project', $patch)) {
        $np = (int)$patch['project'];
        $proj = pm_fetch_one('SELECT id, archived FROM projects WHERE id = ?', [$np]);
        if (!$proj) pm_error('Invalid project', 409);
        if (!empty($proj['archived'])) pm_error('Cannot move tasks into an archived project', 409);
        // Mirror the single-task path: forbid bulk-moving tasks INTO a private
        // project the caller can't write to (the single-task update guards this).
        if (function_exists('pm_can_write_project') && !pm_can_write_project(pm_current_user_id() ?? 0, $np)) {
            pm_error('Forbidden', 403);
        }
    }
    // Pre-validate the assignees list once so a bogus id doesn't get caught
    // mid-loop after we've already written to N tasks.
    $preValidatedAssignees = null;
    if (array_key_exists('assignees', $patch) && is_array($patch['assignees'])) {
        $preValidatedAssignees = pm_validate_assignee_ids($patch['assignees']);
    }
    $updated = 0;
    foreach ($ids as $id) {
        $task = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$id]);
        if (!$task) continue;
        $fields = [];
        $params = [];
        foreach (['title','description','status','estimate','due'] as $col) {
            if (array_key_exists($col, $patch)) {
                $fields[] = "$col = ?";
                $params[] = $patch[$col] === '' ? null : $patch[$col];
            }
        }
        if (array_key_exists('priority', $patch)) {
            $fields[] = 'priority = ?';
            $params[] = (int)$patch['priority'];
        }
        if (array_key_exists('project', $patch)) {
            $fields[] = 'project_id = ?';
            $params[] = (int)$patch['project'];
        }
        if ($fields) {
            $params[] = $id;
            pm_exec('UPDATE tasks SET ' . implode(', ', $fields) . ' WHERE id = ?', $params);
        }
        // Log status transitions to the activity feed so bulk moves aren't
        // invisible in the audit trail (bulk still intentionally skips the
        // heavier notify/recurring/automation side-effects of the single path).
        if (array_key_exists('status', $patch) && (string)$patch['status'] !== (string)$task['status']) {
            pm_log_activity(pm_current_user_id(), $id, 'moved', $task['status'] . ' → ' . $patch['status']);
            if ($patch['status'] === 'done') {
                pm_log_activity(pm_current_user_id(), $id, 'completed', $task['title']);
            }
        }
        if (array_key_exists('labels', $patch) && is_array($patch['labels'])) {
            $labelProject = array_key_exists('project', $patch) ? (int)$patch['project'] : (int)$task['project_id'];
            $valid = pm_validate_label_ids_for_project($patch['labels'], $labelProject);
            pm_exec('DELETE FROM task_labels WHERE task_id = ?', [$id]);
            foreach ($valid as $lid) pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)', [$id, (int)$lid]);
        }
        if ($preValidatedAssignees !== null) {
            pm_exec('DELETE FROM task_assignees WHERE task_id = ?', [$id]);
            foreach ($preValidatedAssignees as $uid) {
                pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$id, (int)$uid]);
            }
        }
        // Mirror the single-task path: when moving into a different project,
        // detach a now-foreign milestone and drop out-of-scope project labels
        // (unless the bulk patch set labels explicitly). Keeps milestone counts
        // honest and avoids un-editable label sets after a cross-project move.
        if (array_key_exists('project', $patch)) {
            $newProjectId = (int)$patch['project'];
            if ($newProjectId !== (int)$task['project_id']) {
                pm_exec('UPDATE tasks SET milestone_id = NULL WHERE id = ? AND milestone_id IS NOT NULL AND milestone_id NOT IN (SELECT id FROM milestones WHERE project_id = ?)', [$id, $newProjectId]);
                if (!(array_key_exists('labels', $patch) && is_array($patch['labels']))) {
                    pm_exec(
                        'DELETE tl FROM task_labels tl JOIN labels l ON l.id = tl.label_id
                         WHERE tl.task_id = ? AND l.project_id IS NOT NULL AND l.project_id <> ?',
                        [$id, $newProjectId]
                    );
                }
            }
        }
        $updated++;
    }
    pm_json(['ok' => true, 'updated' => $updated]);
}

function pm_log_activity(int $uid, ?int $taskId, string $action, ?string $detail = null): void {
    pm_exec('INSERT INTO activity (user_id, task_id, action, detail) VALUES (?,?,?,?)',
        [$uid, $taskId, $action, $detail]);
}

/**
 * Duplicate a task within its project: copies fields, labels, assignees,
 * custom-field values, and subtasks (reset to unchecked so the copy is a fresh
 * checklist). Comments, attachments, and time entries are NOT copied.
 */
function pm_duplicate_task(int $id): void {
    $uid = pm_current_user_id() ?? 0;
    $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$id]);
    if (!$t) pm_error('Not found', 404);

    $proj = pm_fetch_one('SELECT key_prefix FROM projects WHERE id = ?', [(int)$t['project_id']]);
    $prefix = ($proj['key_prefix'] ?? '') ?: pm_config()['project_key'];
    $title = mb_substr((string)$t['title'], 0, 491) . ' (copy)';

    $posRow = pm_fetch_one(
        'SELECT COALESCE(MAX(position),0) AS m FROM tasks WHERE project_id = ? AND status = ?',
        [(int)$t['project_id'], $t['status']]);
    $position = (float)($posRow['m'] ?? 0) + 1;

    $newId = null; $attempts = 0;
    while (true) {
        $maxRow = pm_fetch_one(
            "SELECT MAX(CAST(SUBSTRING_INDEX(ref,'-',-1) AS UNSIGNED)) AS m FROM tasks WHERE ref LIKE ?",
            [$prefix . '-%']);
        $n = max(100, ((int)($maxRow['m'] ?? 0)) + 1);
        try {
            pm_exec(
                'INSERT INTO tasks (ref, project_id, status, title, description, priority, due, start_date,
                                    estimate, position, milestone_id, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                [$prefix . '-' . $n, (int)$t['project_id'], $t['status'], $title, $t['description'],
                 (int)$t['priority'], $t['due'], $t['start_date'], $t['estimate'], $position,
                 $t['milestone_id'], $uid]);
            $newId = pm_last_id();
            break;
        } catch (PDOException $e) {
            if ($e->getCode() !== '23000' || ++$attempts >= 5) pm_error('Could not allocate a task ref', 500);
            usleep(random_int(1000, 5000));
        }
    }

    pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id)
             SELECT ?, label_id FROM task_labels WHERE task_id = ?', [$newId, $id]);
    pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id)
             SELECT ?, user_id FROM task_assignees WHERE task_id = ?', [$newId, $id]);
    pm_exec('INSERT INTO subtasks (task_id, text, done, sort_order)
             SELECT ?, text, 0, sort_order FROM subtasks WHERE task_id = ? ORDER BY sort_order', [$newId, $id]);
    try {
        pm_exec('INSERT INTO task_custom_values (task_id, field_id, value)
                 SELECT ?, field_id, value FROM task_custom_values WHERE task_id = ?', [$newId, $id]);
    } catch (Throwable $_) { /* optional table on older installs */ }

    pm_log_activity($uid, $newId, 'duplicated', 'Duplicated from ' . $t['ref']);
    pm_get_task($newId); // responds with the full new task
}

/**
 * Promote a subtask to a standalone task in the same project. The subtask row
 * is removed; its text becomes the new task's title.
 */
function pm_promote_subtask(int $taskId, int $subId): void {
    $uid = pm_current_user_id() ?? 0;
    $t = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$taskId]);
    if (!$t) pm_error('Not found', 404);
    $st = pm_fetch_one('SELECT * FROM subtasks WHERE id = ? AND task_id = ?', [$subId, $taskId]);
    if (!$st) pm_error('Subtask not found', 404);

    $proj = pm_fetch_one('SELECT key_prefix FROM projects WHERE id = ?', [(int)$t['project_id']]);
    $prefix = ($proj['key_prefix'] ?? '') ?: pm_config()['project_key'];

    $posRow = pm_fetch_one(
        "SELECT COALESCE(MAX(position),0) AS m FROM tasks WHERE project_id = ? AND status = 'todo'",
        [(int)$t['project_id']]);
    $position = (float)($posRow['m'] ?? 0) + 1;

    $newId = null; $attempts = 0;
    while (true) {
        $maxRow = pm_fetch_one(
            "SELECT MAX(CAST(SUBSTRING_INDEX(ref,'-',-1) AS UNSIGNED)) AS m FROM tasks WHERE ref LIKE ?",
            [$prefix . '-%']);
        $n = max(100, ((int)($maxRow['m'] ?? 0)) + 1);
        try {
            pm_exec(
                'INSERT INTO tasks (ref, project_id, status, title, description, priority, position, created_by)
                 VALUES (?,?,?,?,?,?,?,?)',
                [$prefix . '-' . $n, (int)$t['project_id'],
                 !empty($st['done']) ? 'done' : 'todo',
                 mb_substr((string)$st['text'], 0, 500),
                 'Promoted from a subtask of ' . $t['ref'] . ' "' . $t['title'] . '"',
                 (int)$t['priority'], $position, $uid]);
            $newId = pm_last_id();
            break;
        } catch (PDOException $e) {
            if ($e->getCode() !== '23000' || ++$attempts >= 5) pm_error('Could not allocate a task ref', 500);
            usleep(random_int(1000, 5000));
        }
    }

    pm_exec('DELETE FROM subtasks WHERE id = ?', [$subId]);
    pm_log_activity($uid, $newId, 'created', 'Promoted from a subtask of ' . $t['ref']);
    pm_log_activity($uid, $taskId, 'subtask_promoted', 'Subtask "' . mb_substr((string)$st['text'], 0, 100) . '" became ' . $prefix . '-' . $n);
    pm_get_task($newId);
}

// Best-effort Slack notification. Never bubbles errors up: the request-level
// write has already succeeded at this point, and a Slack outage shouldn't
// turn a successful save into a 500.
function pm_slack_notify_task_event(array $task, ?array $project, string $event, string $verb, ?string $extra = null): void {
    try {
        if (!pm_slack_event_on($event)) return;
        $channel = pm_slack_channel_for_project($project);
        if ($channel === '') return;
        $actor = pm_current_user();
        $fallback  = pm_slack_format_task($task, $verb, $actor, $project, $extra);
        $text = pm_slack_render_event_text($event, [
            'project' => $project['name'] ?? '',
            'ref' => $task['ref'] ?? ('#' . (int)$task['id']),
            'title' => $task['title'] ?? '',
            'actor' => $actor['name'] ?? 'Someone',
            'verb' => $verb,
            'extra' => $extra ?? '',
        ], $fallback);
        pm_slack_post($channel, $text, ['event_key' => $event]);
    } catch (Throwable $_) { /* silent */ }
}

// When a task tied to a recurring rule is completed, spawn the next instance.
// Missed runs (rule.next_run in the past) are "caught up" to today so we don't
// create a pile of back-dated tasks the moment someone finally checks in.
function pm_generate_next_recurring_task(int $ruleId, ?int $completedTaskId = null): void {
    try {
        $rule = pm_fetch_one('SELECT * FROM recurring_rules WHERE id = ?', [$ruleId]);
        if (!$rule) return;
        if (!empty($rule['paused'])) return;

        // Dedup guard: only the CURRENT tip of the chain may spawn a successor.
        // last_task_id points at the most recently generated instance; if the
        // task we just completed isn't it, a successor already exists. Without
        // this, reopening a recurring task and completing it again (a fresh
        // done-transition) spawned another instance every cycle.
        if ($completedTaskId !== null && $rule['last_task_id'] !== null
            && (int)$rule['last_task_id'] !== $completedTaskId) {
            return;
        }

        // Decide the date we'll schedule on.
        $base = $rule['next_run'] ?: date('Y-m-d');
        // If base is in the past, advance until it's >= today. The guard
        // counter prevents an infinite loop if pm_recurring_next_date ever
        // returns the same date (e.g. malformed rule with interval 0).
        $today = date('Y-m-d');
        $guard = 0;
        while ($base < $today && $guard++ < 3650) {
            $next = pm_recurring_next_date($base, $rule);
            if ($next <= $base) break;
            $base = $next;
        }
        $scheduleFor = $base;
        $nextAfter   = pm_recurring_next_date($scheduleFor, $rule);

        // End conditions: stop if ends_on already passed or occurrences exhausted.
        if (!empty($rule['ends_on']) && $scheduleFor > $rule['ends_on']) {
            pm_exec('UPDATE recurring_rules SET paused = 1 WHERE id = ?', [$ruleId]);
            return;
        }
        if ($rule['occurrences_left'] !== null && (int)$rule['occurrences_left'] <= 0) {
            pm_exec('UPDATE recurring_rules SET paused = 1 WHERE id = ?', [$ruleId]);
            return;
        }

        $proj = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [(int)$rule['project_id']]);
        if (!$proj) return;
        $prefix = $proj['key_prefix'] ?: pm_config()['project_key'];

        // Next position for this project+'todo' column so the spawned task lands
        // at the end instead of colliding at position 0 with everything else.
        $posRow = pm_fetch_one(
            'SELECT COALESCE(MAX(position),0) AS m FROM tasks WHERE project_id = ? AND status = ?',
            [(int)$rule['project_id'], 'todo']
        );
        $position = (float)($posRow['m'] ?? 0) + 1;

        // Same retry-on-collision loop as pm_create_task. Kept in autocommit so
        // each MAX(ref) read sees other committed inserts (a REPEATABLE-READ
        // snapshot inside a transaction would keep colliding on the same ref).
        $tid = null;
        $attempts = 0;
        while (true) {
            $maxRow = pm_fetch_one(
                "SELECT MAX(CAST(SUBSTRING_INDEX(ref, '-', -1) AS UNSIGNED)) AS m FROM tasks WHERE ref LIKE ?",
                [$prefix . '-%']
            );
            $next = ((int)($maxRow['m'] ?? 0)) + 1;
            if ($next < 100) $next = 100;
            $ref = $prefix . '-' . $next;
            try {
                pm_exec(
                    'INSERT INTO tasks (ref, project_id, status, title, description, priority, due, position, estimate, recurring_rule_id, created_by)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                    [
                        $ref, (int)$rule['project_id'], 'todo',
                        $rule['title'], $rule['description'],
                        (int)$rule['priority'], $scheduleFor, $position,
                        $rule['estimate'] ?: null,
                        $ruleId, pm_current_user_id(),
                    ]
                );
                $tid = pm_last_id();
                break;
            } catch (PDOException $e) {
                if ($e->getCode() !== '23000' || ++$attempts >= 5) return;
                usleep(random_int(1000, 5000));
            }
        }

        // Metadata + cursor advance in ONE transaction so a failure can't leave
        // the cursor un-advanced (which used to let the next completion spawn a
        // duplicate and overrun occurrences_left). On failure the whole spawn is
        // rolled back and the task row deleted, mirroring pm_create_task.
        $assignees = json_decode((string)($rule['assignees'] ?? ''), true);
        $labels    = json_decode((string)($rule['labels']    ?? ''), true);
        $occLeft   = $rule['occurrences_left'] === null ? null : max(0, (int)$rule['occurrences_left'] - 1);
        try {
            pm_db()->beginTransaction();
            if (is_array($assignees)) foreach ($assignees as $uid) {
                pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$tid, (int)$uid]);
            }
            if (is_array($labels)) foreach ($labels as $lid) {
                pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)', [$tid, (int)$lid]);
            }
            // Materialize the rule's checklist as fresh (unchecked) subtasks —
            // same format as recurring.php (JSON array of title strings).
            $stList = json_decode((string)($rule['subtasks_json'] ?? ''), true);
            if (is_array($stList)) {
                $order = 0;
                foreach ($stList as $stText) {
                    $stText = trim((string)$stText);
                    if ($stText === '') continue;
                    pm_exec('INSERT INTO subtasks (task_id, text, done, sort_order) VALUES (?,?,0,?)',
                        [$tid, mb_substr($stText, 0, 500), $order++]);
                }
            }
            pm_exec(
                'UPDATE recurring_rules SET next_run = ?, last_task_id = ?, occurrences_left = ? WHERE id = ?',
                [$nextAfter, $tid, $occLeft, $ruleId]
            );
            pm_db()->commit();
        } catch (Throwable $e) {
            if (pm_db()->inTransaction()) pm_db()->rollBack();
            pm_exec('DELETE FROM tasks WHERE id = ?', [$tid]);
            error_log('pm_generate_next_recurring_task metadata failed: ' . $e->getMessage());
            return;
        }

        pm_log_activity(pm_current_user_id() ?: 0, $tid, 'recurring_spawn', 'Generated from recurring rule');
        $created = pm_fetch_one('SELECT * FROM tasks WHERE id = ?', [$tid]);
        pm_slack_notify_task_event($created, $proj, 'task_created', 'scheduled a recurring task');
    } catch (Throwable $_) { /* best effort */ }
}

function pm_recurring_next_date(string $fromYmd, array $rule): string {
    $ts = strtotime($fromYmd . ' 00:00:00');
    if ($ts === false) $ts = time();
    $interval = max(1, (int)($rule['interval_n'] ?? 1));
    switch ($rule['cadence'] ?? 'weekly') {
        case 'daily':
            $ts = strtotime("+{$interval} day", $ts);
            break;
        case 'weekly':
            $ts = strtotime("+{$interval} week", $ts);
            if (array_key_exists('weekday', $rule) && $rule['weekday'] !== null) {
                $target = (int)$rule['weekday'];
                $cur = (int)date('w', $ts);
                $delta = ($target - $cur + 7) % 7;
                if ($delta) $ts = strtotime("+{$delta} day", $ts);
            }
            break;
        case 'monthly': {
            $y = (int)date('Y', $ts);
            $m = (int)date('m', $ts) + $interval;
            while ($m > 12) { $m -= 12; $y++; }
            $d = (array_key_exists('month_day', $rule) && $rule['month_day'] !== null)
                ? (int)$rule['month_day']
                : (int)date('d', $ts);
            $lastDay = (int)date('t', strtotime(sprintf('%04d-%02d-01', $y, $m)));
            $d = min($d, $lastDay);
            $ts = mktime(0, 0, 0, $m, $d, $y);
            break;
        }
        case 'yearly': {
            $y = (int)date('Y', $ts) + $interval;
            $m = (array_key_exists('month_of_year', $rule) && $rule['month_of_year'] !== null)
                ? (int)$rule['month_of_year']
                : (int)date('m', $ts);
            $d = (array_key_exists('month_day', $rule) && $rule['month_day'] !== null)
                ? (int)$rule['month_day']
                : (int)date('d', $ts);
            $lastDay = (int)date('t', strtotime(sprintf('%04d-%02d-01', $y, $m)));
            $d = min($d, $lastDay);
            $ts = mktime(0, 0, 0, $m, $d, $y);
            break;
        }
    }
    return date('Y-m-d', $ts);
}
