<?php
require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/slack_client.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
pm_require_auth();

$method = pm_method();
$id = pm_int_param('id');

// Shape a project row for API responses. Keeps optional columns (description,
// slack_channel, archived_at) safely optional so installs that haven't re-run
// install.php still serialize cleanly.
function pm_project_shape(array $r): array {
    return [
        'id'            => (int)$r['id'],
        'name'          => $r['name'],
        'color'         => $r['color'],
        'key_prefix'    => $r['key_prefix'],
        'description'   => $r['description']   ?? null,
        'slack_channel' => $r['slack_channel'] ?? null,
        'archived'      => !empty($r['archived']),
        'archived_at'   => $r['archived_at']   ?? null,
        'visibility'    => $r['visibility'] ?? (function_exists('pm_project_visibility') ? pm_project_visibility((int)$r['id']) : 'open'),
    ];
}

if ($method === 'GET' && $id === null) {
    // Visibility default is full workspace visibility: all authenticated users
    // can see all projects, including archived ones. Clients can still pass
    // only_active=1 when they intentionally want to hide archived projects.
    $onlyActive = !empty($_GET['only_active']);
    $sql = 'SELECT id, name, color, key_prefix, description, slack_channel, sort_order, archived, archived_at
            FROM projects'
         . ($onlyActive ? ' WHERE archived = 0' : '')
         . ' ORDER BY archived, sort_order, id';
    $rows = pm_fetch_all($sql);
    if (function_exists('pm_can_read_project')) {
        $ruid = pm_current_user_id() ?? 0;
        $rows = array_values(array_filter($rows, fn($r) => pm_can_read_project($ruid, (int)$r['id'])));
    }
    pm_json(['projects' => array_map('pm_project_shape', $rows)]);
}

if ($method === 'GET' && $id !== null) {
    $row = pm_fetch_one(
        'SELECT id, name, color, key_prefix, description, slack_channel, sort_order, archived, archived_at
         FROM projects WHERE id = ?',
        [$id]
    );
    if (!$row) pm_error('Not found', 404);
    // Read gate: the list path filters by pm_can_read_project, but this single
    // fetch must too — otherwise a non-member could read a private project's
    // name/description/slack_channel by guessing its id. 404 (not 403) so we
    // don't confirm the id exists.
    if (function_exists('pm_can_read_project') && !pm_can_read_project(pm_current_user_id() ?? 0, $id)) {
        pm_error('Not found', 404);
    }
    $taskCount = pm_fetch_one('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?', [$id]);
    $out = pm_project_shape($row);
    $out['task_count'] = (int)($taskCount['c'] ?? 0);
    pm_json(['project' => $out]);
}

if ($method === 'POST' && $id === null) {
    $name   = trim((string)pm_param('name', ''));
    $color  = (string)pm_param('color', '#3B82F6');
    $prefix = strtoupper(trim((string)pm_param('key_prefix', 'PRJ')));
    $desc   = pm_param('description');
    $slack  = pm_param('slack_channel');
    if ($name === '') pm_error('Name required');
    if (!preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) pm_error('Invalid color');
    if ($prefix === '' || !preg_match('/^[A-Z0-9]{1,8}$/', $prefix)) pm_error('Invalid key_prefix');
    if ($slack !== null && $slack !== '') {
        // The Slack channel routes a project's notifications, so restrict it to
        // admins (mirrors "Slack settings are admin-only"). Non-admins create
        // the project without a channel rather than being blocked entirely.
        $me = pm_current_user();
        if (empty($me['is_admin'])) { $slack = null; }
        elseif (!preg_match('/^[#@]?[A-Za-z0-9\-_.]{1,80}$/', (string)$slack)) {
            pm_error('Invalid Slack channel (use #channel or channel-id)');
        }
    }
    $sortRow = pm_fetch_one('SELECT COALESCE(MAX(sort_order),0) AS m FROM projects');
    $sort = ((int)($sortRow['m'] ?? 0)) + 1;
    pm_exec(
        'INSERT INTO projects (name, color, key_prefix, description, slack_channel, sort_order) VALUES (?,?,?,?,?,?)',
        [$name, $color, $prefix, $desc ?: null, $slack ?: null, $sort]
    );
    $nid = pm_last_id();
    pm_log_activity_maybe(pm_current_user_id(), null, 'project_created', $name);
    $row = pm_fetch_one(
        'SELECT id, name, color, key_prefix, description, slack_channel, sort_order, archived, archived_at
         FROM projects WHERE id = ?', [$nid]
    );
    pm_json(['project' => pm_project_shape($row)]);
}

if ($method === 'PATCH' && $id !== null) {
    $body = pm_body();
    // Private projects: only editors/owners (or admins) may edit settings.
    // Open projects pass (unchanged all-can-edit behavior).
    if (function_exists('pm_can_write_project') && !pm_can_write_project(pm_current_user_id() ?? 0, $id)) {
        pm_error('Forbidden', 403);
    }
    $f = []; $p = [];
    if (isset($body['name']))   {
        $n = trim((string)$body['name']);
        if ($n === '') pm_error('Name cannot be empty');
        $f[]='name = ?';   $p[]=$n;
    }
    if (isset($body['color']))  {
        $c = (string)$body['color'];
        if (!preg_match('/^#[0-9A-Fa-f]{6}$/', $c)) pm_error('Invalid color');
        $f[]='color = ?';  $p[]=$c;
    }
    if (isset($body['key_prefix'])) {
        $pref = strtoupper(trim((string)$body['key_prefix']));
        if (!preg_match('/^[A-Z0-9]{1,8}$/', $pref)) pm_error('Invalid key_prefix');
        $f[]='key_prefix = ?'; $p[]=$pref;
    }
    if (array_key_exists('description', $body)) {
        $d = $body['description'];
        $f[]='description = ?'; $p[]=$d === '' ? null : $d;
    }
    if (array_key_exists('slack_channel', $body)) {
        // Changing where a project's notifications are delivered is an admin
        // action (a low-priv user shouldn't be able to redirect them).
        $me = pm_current_user();
        if (empty($me['is_admin'])) pm_error('Only admins can change a project\'s Slack channel', 403);
        $s = $body['slack_channel'];
        if ($s !== null && $s !== '' && !preg_match('/^[#@]?[A-Za-z0-9\-_.]{1,80}$/', (string)$s)) {
            pm_error('Invalid Slack channel (use #channel or channel-id)');
        }
        $f[]='slack_channel = ?'; $p[]=$s === '' ? null : $s;
    }
    if (array_key_exists('sort_order', $body)) {
        $f[]='sort_order = ?'; $p[]=(int)$body['sort_order'];
    }
    if (array_key_exists('archived', $body)) {
        $archived = !empty($body['archived']) ? 1 : 0;
        $f[]='archived = ?';    $p[]=$archived;
        $f[]='archived_at = ?'; $p[]=$archived ? date('Y-m-d H:i:s') : null;
    }
    if (!$f) pm_error('Nothing to update');
    $p[] = $id;
    pm_exec('UPDATE projects SET ' . implode(',', $f) . ' WHERE id = ?', $p);
    $row = pm_fetch_one(
        'SELECT id, name, color, key_prefix, description, slack_channel, sort_order, archived, archived_at
         FROM projects WHERE id = ?', [$id]
    );
    if (!$row) pm_error('Not found', 404);
    if (array_key_exists('archived', $body)) {
        $nowArchived = !empty($body['archived']);
        pm_log_activity_maybe(pm_current_user_id(), null,
            $nowArchived ? 'project_archived' : 'project_unarchived',
            $row['name']);
        if ($nowArchived) {
            // Slack notice so anyone tracking the workspace channel knows the
            // project has been put to bed.
            try {
                if (pm_slack_event_on('project_archived')) {
                    $channel = pm_slack_channel_for_project($row);
                    if ($channel !== '') {
                        $actor = pm_current_user();
                        $who = $actor['name'] ?? 'An admin';
                        $fallback = ":package: {$who} archived project *{$row['name']}*.";
                        $text = pm_slack_render_event_text('project_archived', [
                            'project' => $row['name'],
                            'actor' => $who,
                        ], $fallback);
                        pm_slack_post($channel, $text, ['event_key' => 'project_archived']);
                    }
                }
            } catch (Throwable $_) { /* best effort */ }
        }
    }
    pm_json(['project' => pm_project_shape($row)]);
}

if ($method === 'DELETE' && $id !== null) {
    $row = pm_fetch_one('SELECT name FROM projects WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);
    // Deleting a private project requires owner/admin (open projects unchanged).
    if (function_exists('pm_project_visibility') && pm_project_visibility($id) === 'private'
        && function_exists('pm_can_manage_project') && !pm_can_manage_project(pm_current_user_id() ?? 0, $id)) {
        pm_error('Forbidden', 403);
    }
    // Guard hard delete: if any tasks (or recurring rules) reference the
    // project, require an explicit ?force=1 so a stray click can't wipe
    // history. Archive is the default advice.
    $force = !empty($_GET['force']);
    $taskCount = (int)(pm_fetch_one('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?', [$id])['c'] ?? 0);
    $ruleCount = (int)(pm_fetch_one('SELECT COUNT(*) AS c FROM recurring_rules WHERE project_id = ?', [$id])['c'] ?? 0);
    if (($taskCount > 0 || $ruleCount > 0) && !$force) {
        pm_json([
            'error'       => 'Project has existing work. Archive instead, or re-send with force=1.',
            'task_count'  => $taskCount,
            'rule_count'  => $ruleCount,
        ], 409);
    }
    pm_exec('DELETE FROM projects WHERE id = ?', [$id]);
    pm_log_activity_maybe(pm_current_user_id(), null, 'project_deleted', $row['name']);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);

// Activity logger that never blocks the request if the activity table has
// some structural mismatch. Matches the shape used in tasks.php.
function pm_log_activity_maybe(?int $uid, ?int $taskId, string $action, ?string $detail = null): void {
    try {
        pm_exec('INSERT INTO activity (user_id, task_id, action, detail) VALUES (?,?,?,?)',
            [$uid, $taskId, $action, $detail]);
    } catch (Throwable $_) { /* best effort */ }
}
