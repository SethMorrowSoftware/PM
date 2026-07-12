<?php
// Recurring task templates. Each row describes a cadence that spawns real
// task rows. Generation is lazy: when a generated task is marked done
// (tasks.php), the next instance is created based on the rule's next_run.
//
// Admins or the rule's creator can edit/delete. All authenticated users can
// list so the sidebar/settings view can surface them.

require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
$uid = pm_require_auth();

$method = pm_method();
$id     = pm_int_param('id');

if (!defined('PM_RECUR_CADENCES')) {
    define('PM_RECUR_CADENCES', ['daily','weekly','monthly','yearly']);
}

function pm_recurring_shape(array $r): array {
    return [
        'id'                => (int)$r['id'],
        'project_id'        => (int)$r['project_id'],
        'title'             => $r['title'],
        'description'       => $r['description'],
        'priority'          => (int)$r['priority'],
        'estimate'          => $r['estimate'],
        'assignees'         => pm_decode_id_list($r['assignees']),
        'labels'            => pm_decode_id_list($r['labels']),
        'subtasks'          => pm_recurring_decode_subtasks($r['subtasks_json'] ?? null),
        'cadence'           => $r['cadence'],
        'interval_n'        => max(1, (int)$r['interval_n']),
        'weekday'           => $r['weekday']       === null ? null : (int)$r['weekday'],
        'month_day'         => $r['month_day']     === null ? null : (int)$r['month_day'],
        'month_of_year'     => $r['month_of_year'] === null ? null : (int)$r['month_of_year'],
        'next_run'          => $r['next_run'],
        'ends_on'           => $r['ends_on'],
        'occurrences_left'  => $r['occurrences_left'] === null ? null : (int)$r['occurrences_left'],
        'paused'            => !empty($r['paused']),
        'last_task_id'      => $r['last_task_id'] === null ? null : (int)$r['last_task_id'],
    ];
}

function pm_decode_id_list($raw): array {
    if ($raw === null || $raw === '') return [];
    $decoded = json_decode((string)$raw, true);
    return is_array($decoded) ? array_values(array_map('intval', $decoded)) : [];
}

function pm_encode_id_list($v): ?string {
    if (!is_array($v)) return null;
    $clean = array_values(array_unique(array_map('intval', $v)));
    return $clean ? json_encode($clean) : null;
}

// Checklist carried onto every spawned instance. Stored as a JSON array of
// non-empty trimmed title strings (same format as task_templates.subtasks_json).
function pm_recurring_decode_subtasks($raw): array {
    if ($raw === null || $raw === '') return [];
    $decoded = json_decode((string)$raw, true);
    if (!is_array($decoded)) return [];
    $out = [];
    foreach ($decoded as $t) {
        $t = trim((string)$t);
        if ($t !== '') $out[] = mb_substr($t, 0, 500);
    }
    return $out;
}

function pm_recurring_encode_subtasks($v): ?string {
    if (!is_array($v)) return null;
    $clean = [];
    foreach ($v as $t) {
        $t = trim((string)$t);
        if ($t !== '') $clean[] = mb_substr($t, 0, 500);
    }
    return $clean ? json_encode($clean, JSON_UNESCAPED_UNICODE) : null;
}

function pm_validate_cadence_fields(array &$r): void {
    if (!in_array($r['cadence'], PM_RECUR_CADENCES, true)) {
        pm_error('Invalid cadence; use one of: ' . implode(', ', PM_RECUR_CADENCES));
    }
    $r['interval_n'] = max(1, (int)($r['interval_n'] ?? 1));
    if ($r['cadence'] === 'weekly' && $r['weekday'] !== null) {
        $r['weekday'] = max(0, min(6, (int)$r['weekday']));
    }
    if ($r['cadence'] === 'monthly' && $r['month_day'] !== null) {
        $r['month_day'] = max(1, min(31, (int)$r['month_day']));
    }
    if ($r['cadence'] === 'yearly') {
        if ($r['month_of_year'] !== null) $r['month_of_year'] = max(1, min(12, (int)$r['month_of_year']));
        if ($r['month_day']     !== null) $r['month_day']     = max(1, min(31, (int)$r['month_day']));
    }
    // Catch malformed date strings before they hit the DATE column — MariaDB
    // silently zeroes invalid dates under some sql_modes, which would then
    // loop forever in pm_recurring_spawn_now's catch-up advance.
    if (!empty($r['next_run']) && !pm_is_ymd_date((string)$r['next_run'])) {
        pm_error('Invalid next_run date (use YYYY-MM-DD)');
    }
    if (!empty($r['ends_on']) && !pm_is_ymd_date((string)$r['ends_on'])) {
        pm_error('Invalid ends_on date (use YYYY-MM-DD)');
    }
    if (!empty($r['ends_on']) && !empty($r['next_run']) && $r['ends_on'] < $r['next_run']) {
        pm_error('ends_on cannot be before next_run');
    }
}

function pm_is_ymd_date(string $d): bool {
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) return false;
    [$y, $m, $day] = array_map('intval', explode('-', $d));
    return checkdate($m, $day, $y);
}

function pm_recurring_spawn_now(array $rule): ?int {
    if (!empty($rule['paused'])) return null;
    $ruleId = (int)($rule['id'] ?? 0);
    $scheduleFor = $rule['next_run'] ?: date('Y-m-d');
    $today = date('Y-m-d');
    $guard = 0;
    while ($scheduleFor < $today && $guard++ < 3650) {
        $next = pm_recurring_next_date($scheduleFor, $rule);
        if ($next <= $scheduleFor) break;
        $scheduleFor = $next;
    }
    if (!empty($rule['ends_on']) && $scheduleFor > $rule['ends_on']) {
        if ($ruleId > 0) pm_exec('UPDATE recurring_rules SET paused = 1 WHERE id = ?', [$ruleId]);
        return null;
    }
    if ($rule['occurrences_left'] !== null && (int)$rule['occurrences_left'] <= 0) {
        if ($ruleId > 0) pm_exec('UPDATE recurring_rules SET paused = 1 WHERE id = ?', [$ruleId]);
        return null;
    }

    $proj = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [(int)$rule['project_id']]);
    if (!$proj) return null;
    $prefix = $proj['key_prefix'] ?: pm_config()['project_key'];

    // Next position for the project's 'todo' column so the initial instance
    // lands at the end instead of colliding at position 0.
    $posRow = pm_fetch_one(
        'SELECT COALESCE(MAX(position),0) AS m FROM tasks WHERE project_id = ? AND status = ?',
        [(int)$rule['project_id'], 'todo']
    );
    $position = (float)($posRow['m'] ?? 0) + 1;

    $tid = null;
    $attempts = 0;
    while (true) {
        $maxRow = pm_fetch_one(
            "SELECT MAX(CAST(SUBSTRING_INDEX(ref, '-', -1) AS UNSIGNED)) AS m FROM tasks WHERE ref LIKE ?",
            [$prefix . '-%']
        );
        $nextRef = ((int)($maxRow['m'] ?? 0)) + 1;
        if ($nextRef < 100) $nextRef = 100;
        $ref = $prefix . '-' . $nextRef;
        try {
            pm_exec(
                'INSERT INTO tasks (ref, project_id, status, title, description, priority, due, position, estimate, recurring_rule_id, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                [
                    $ref, (int)$rule['project_id'], 'todo',
                    $rule['title'], $rule['description'], (int)$rule['priority'],
                    $scheduleFor, $position, $rule['estimate'] ?: null, (int)$rule['id'], pm_current_user_id(),
                ]
            );
            $tid = pm_last_id();
            break;
        } catch (PDOException $e) {
            if ($e->getCode() !== '23000' || ++$attempts >= 5) return null;
            usleep(random_int(1000, 5000));
        }
    }

    foreach (pm_decode_id_list($rule['assignees'] ?? null) as $uid) {
        pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$tid, (int)$uid]);
    }
    foreach (pm_decode_id_list($rule['labels'] ?? null) as $lid) {
        pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)', [$tid, (int)$lid]);
    }
    // Materialize the rule's checklist as fresh (unchecked) subtasks.
    $order = 0;
    foreach (pm_recurring_decode_subtasks($rule['subtasks_json'] ?? null) as $stText) {
        pm_exec('INSERT INTO subtasks (task_id, text, done, sort_order) VALUES (?,?,0,?)', [$tid, $stText, $order++]);
    }

    $nextRun = pm_recurring_next_date($scheduleFor, $rule);
    $occLeft = $rule['occurrences_left'] === null ? null : max(0, (int)$rule['occurrences_left'] - 1);
    pm_exec(
        'UPDATE recurring_rules SET next_run = ?, last_task_id = ?, occurrences_left = ? WHERE id = ?',
        [$nextRun, $tid, $occLeft, $ruleId]
    );
    pm_exec('INSERT INTO activity (user_id, task_id, action, detail) VALUES (?,?,?,?)',
        [pm_current_user_id() ?: 0, $tid, 'recurring_spawn', 'Generated from recurring rule']);
    return $tid;
}

// Advance a date one step according to the rule. If after advancing we land on
// an invalid calendar day (e.g. "31st of Feb"), clamp to the month's last day.
function pm_recurring_next_date(string $fromYmd, array $rule): string {
    $ts = strtotime($fromYmd . ' 00:00:00');
    if ($ts === false) $ts = time();
    $interval = max(1, (int)$rule['interval_n']);
    switch ($rule['cadence']) {
        case 'daily':
            $ts = strtotime("+{$interval} day", $ts);
            break;
        case 'weekly':
            // "Every N weeks on <weekday>". When the base date is already on the
            // target weekday, advance a full N-week interval (stays on it). When
            // the base is misaligned (a manually-set next_run whose weekday
            // differs), snap forward to the NEXT target weekday only — the old
            // code jumped N weeks AND then snapped, overshooting the first
            // occurrence by up to 6 days. Once it lands on the weekday, later
            // runs start aligned and take the full-interval branch.
            if ($rule['weekday'] !== null) {
                $target = (int)$rule['weekday'];
                $cur = (int)date('w', $ts);
                $delta = ($target - $cur + 7) % 7;
                $ts = $delta === 0
                    ? strtotime("+{$interval} week", $ts)
                    : strtotime("+{$delta} day", $ts);
            } else {
                $ts = strtotime("+{$interval} week", $ts);
            }
            break;
        case 'monthly': {
            $y = (int)date('Y', $ts);
            $m = (int)date('m', $ts);
            $m += $interval;
            while ($m > 12) { $m -= 12; $y++; }
            $d = $rule['month_day'] !== null ? (int)$rule['month_day'] : (int)date('d', $ts);
            $lastDay = (int)date('t', strtotime(sprintf('%04d-%02d-01', $y, $m)));
            $d = min($d, $lastDay);
            $ts = mktime(0, 0, 0, $m, $d, $y);
            break;
        }
        case 'yearly': {
            $y = (int)date('Y', $ts) + $interval;
            $m = $rule['month_of_year'] !== null ? (int)$rule['month_of_year'] : (int)date('m', $ts);
            $d = $rule['month_day']     !== null ? (int)$rule['month_day']     : (int)date('d', $ts);
            $lastDay = (int)date('t', strtotime(sprintf('%04d-%02d-01', $y, $m)));
            $d = min($d, $lastDay);
            $ts = mktime(0, 0, 0, $m, $d, $y);
            break;
        }
    }
    return date('Y-m-d', $ts);
}

// Shared writer used by POST (create) and PATCH (update).
function pm_recurring_save(array $input, ?int $existingId = null): int {
    $title     = trim((string)($input['title'] ?? ''));
    if ($title === '') pm_error('Title required');
    if (mb_strlen($title) > 500) pm_error('Title is too long (max 500 characters)');
    $projectId = (int)($input['project_id'] ?? 0);
    if (!$projectId) pm_error('project_id required');
    $proj = pm_fetch_one('SELECT id, archived FROM projects WHERE id = ?', [$projectId]);
    if (!$proj) pm_error('Invalid project_id');
    if (!empty($proj['archived'])) pm_error('Cannot target an archived project', 409);

    // Tasks accept priority 0..3 (Urgent..Low). Reject anything outside that
    // range so spawned tasks don't end up with values the UI can't render.
    $priority = isset($input['priority']) ? (int)$input['priority'] : 2;
    if ($priority < 0 || $priority > 3) pm_error('Invalid priority');

    $shape = [
        'project_id'       => $projectId,
        'title'            => $title,
        'description'      => $input['description'] ?? null,
        'priority'         => $priority,
        'estimate'         => isset($input['estimate']) ? (string)$input['estimate'] : null,
        'assignees'        => pm_encode_id_list($input['assignees'] ?? []),
        'labels'           => pm_encode_id_list($input['labels'] ?? []),
        'subtasks_json'    => pm_recurring_encode_subtasks($input['subtasks'] ?? []),
        'cadence'          => strtolower((string)($input['cadence'] ?? 'weekly')),
        'interval_n'       => (int)($input['interval_n'] ?? 1),
        'weekday'          => isset($input['weekday'])       && $input['weekday'] !== ''       ? (int)$input['weekday']       : null,
        'month_day'        => isset($input['month_day'])     && $input['month_day'] !== ''     ? (int)$input['month_day']     : null,
        'month_of_year'    => isset($input['month_of_year']) && $input['month_of_year'] !== '' ? (int)$input['month_of_year'] : null,
        'next_run'         => !empty($input['next_run']) ? (string)$input['next_run'] : date('Y-m-d'),
        'ends_on'          => !empty($input['ends_on']) ? (string)$input['ends_on'] : null,
        'occurrences_left' => isset($input['occurrences_left']) && $input['occurrences_left'] !== '' ? (int)$input['occurrences_left'] : null,
        'paused'           => !empty($input['paused']) ? 1 : 0,
    ];
    pm_validate_cadence_fields($shape);

    if ($existingId) {
        pm_exec(
            'UPDATE recurring_rules SET
                project_id=?, title=?, description=?, priority=?, estimate=?,
                assignees=?, labels=?, subtasks_json=?, cadence=?, interval_n=?, weekday=?,
                month_day=?, month_of_year=?, next_run=?, ends_on=?, occurrences_left=?, paused=?
             WHERE id=?',
            [
                $shape['project_id'], $shape['title'], $shape['description'], $shape['priority'], $shape['estimate'],
                $shape['assignees'], $shape['labels'], $shape['subtasks_json'], $shape['cadence'], $shape['interval_n'], $shape['weekday'],
                $shape['month_day'], $shape['month_of_year'], $shape['next_run'], $shape['ends_on'],
                $shape['occurrences_left'], $shape['paused'], $existingId
            ]
        );
        return $existingId;
    }
    pm_exec(
        'INSERT INTO recurring_rules
            (project_id, title, description, priority, estimate, assignees, labels, subtasks_json,
             cadence, interval_n, weekday, month_day, month_of_year,
             next_run, ends_on, occurrences_left, paused, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [
            $shape['project_id'], $shape['title'], $shape['description'], $shape['priority'], $shape['estimate'],
            $shape['assignees'], $shape['labels'], $shape['subtasks_json'], $shape['cadence'], $shape['interval_n'], $shape['weekday'],
            $shape['month_day'], $shape['month_of_year'], $shape['next_run'], $shape['ends_on'],
            $shape['occurrences_left'], $shape['paused'], pm_current_user_id(),
        ]
    );
    return pm_last_id();
}

if ($method === 'GET' && $id === null) {
    // Hide rules for private projects the caller can't read (rules always have a
    // project, so global rows don't apply here → includeGlobal = false).
    $params = [];
    $where = function_exists('pm_readable_project_where')
        ? pm_readable_project_where($uid, 'project_id', $params, false) : '';
    $sql = 'SELECT * FROM recurring_rules'
        . ($where !== '' ? " WHERE $where" : '')
        . ' ORDER BY project_id, id';
    $rows = pm_fetch_all($sql, $params);
    pm_json(['rules' => array_map('pm_recurring_shape', $rows)]);
}

if ($method === 'GET' && $id !== null) {
    $r = pm_fetch_one('SELECT * FROM recurring_rules WHERE id = ?', [$id]);
    if (!$r) pm_error('Not found', 404);
    if (function_exists('pm_can_read_project') && !pm_can_read_project($uid, (int)$r['project_id'])) {
        pm_error('Not found', 404);
    }
    pm_json(['rule' => pm_recurring_shape($r)]);
}

if ($method === 'POST' && $id === null) {
    pm_require_admin();
    $body = pm_body();
    $nid = pm_recurring_save($body, null);
    $createInitial = !array_key_exists('create_initial_task', $body) || !empty($body['create_initial_task']);
    if ($createInitial) {
        $created = pm_fetch_one('SELECT * FROM recurring_rules WHERE id = ?', [$nid]);
        if ($created) pm_recurring_spawn_now($created);
    }
    $r = pm_fetch_one('SELECT * FROM recurring_rules WHERE id = ?', [$nid]);
    pm_json(['rule' => pm_recurring_shape($r)]);
}

if ($method === 'PATCH' && $id !== null) {
    pm_require_admin();
    $r = pm_fetch_one('SELECT * FROM recurring_rules WHERE id = ?', [$id]);
    if (!$r) pm_error('Not found', 404);
    // Merge incoming over existing so partial updates are supported.
    $body = pm_body();
    $merged = array_merge(pm_recurring_shape($r), $body);
    pm_recurring_save($merged, $id);
    $r = pm_fetch_one('SELECT * FROM recurring_rules WHERE id = ?', [$id]);
    pm_json(['rule' => pm_recurring_shape($r)]);
}

if ($method === 'DELETE' && $id !== null) {
    pm_require_admin();
    pm_exec('DELETE FROM recurring_rules WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
