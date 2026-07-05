<?php
// Automation rule CRUD. Lists are readable by any authenticated user (so the
// settings UI can show them); create/update/delete are admin-only, mirroring
// recurring rules and other shared-config endpoints.
//
// The engine that actually fires these rules lives in automations_lib.php and
// is invoked synchronously from tasks.php / notify_lib.php — not from here.

require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
$uid = pm_require_auth();

require_once __DIR__ . '/automations_lib.php'; // also provides PM_AUTOMATION_* vocab

$method = pm_method();
$id     = pm_int_param('id');

/** Public shape for one rule (decodes JSON columns to objects/arrays). */
function pm_automation_shape(array $r): array {
    $cond = json_decode((string)($r['conditions_json'] ?? ''), true);
    $acts = json_decode((string)($r['actions_json'] ?? ''), true);
    return [
        'id'            => (int)$r['id'],
        'project_id'    => $r['project_id'] === null ? null : (int)$r['project_id'],
        'name'          => $r['name'],
        'trigger_event' => $r['trigger_event'],
        'conditions'    => is_array($cond) ? $cond : (object)[],
        'actions'       => is_array($acts) ? array_values($acts) : [],
        'enabled'       => !empty($r['enabled']),
        'run_count'     => (int)$r['run_count'],
        'last_run_at'   => $r['last_run_at'],
        'created_at'    => $r['created_at'],
    ];
}

/** Normalize + validate a conditions object. Returns a clean assoc array (may be empty). */
function pm_automation_clean_conditions($raw): array {
    if (!is_array($raw)) return [];
    $out = [];
    if (array_key_exists('priority', $raw) && $raw['priority'] !== null && $raw['priority'] !== '') {
        $p = (int)$raw['priority'];
        if ($p < 0 || $p > 3) pm_error('Invalid condition priority (0-3)');
        $out['priority'] = $p;
    }
    if (array_key_exists('status', $raw) && $raw['status'] !== null && $raw['status'] !== '') {
        $s = (string)$raw['status'];
        if (!in_array($s, PM_AUTOMATION_STATUSES, true)) pm_error('Invalid condition status');
        $out['status'] = $s;
    }
    if (array_key_exists('label_id', $raw) && $raw['label_id'] !== null && $raw['label_id'] !== '') {
        $lid = (int)$raw['label_id'];
        if ($lid <= 0) pm_error('Invalid condition label_id');
        $out['label_id'] = $lid;
    }
    return $out;
}

/** Validate + normalize the actions array. Must be a non-empty list of valid actions. */
function pm_automation_clean_actions($raw): array {
    if (!is_array($raw) || $raw === [] || array_keys($raw) !== range(0, count($raw) - 1)) {
        pm_error('actions must be a non-empty array');
    }
    $out = [];
    foreach ($raw as $a) {
        if (!is_array($a)) pm_error('Each action must be an object');
        $type = $a['type'] ?? '';
        if (!in_array($type, PM_AUTOMATION_ACTIONS, true)) {
            pm_error('Invalid action type: ' . (is_string($type) ? $type : gettype($type)));
        }
        switch ($type) {
            case 'set_priority': {
                $p = (int)($a['value'] ?? -1);
                if ($p < 0 || $p > 3) pm_error('set_priority value must be 0-3');
                $out[] = ['type' => 'set_priority', 'value' => $p];
                break;
            }
            case 'set_status': {
                $s = (string)($a['value'] ?? '');
                if (!in_array($s, PM_AUTOMATION_STATUSES, true)) pm_error('set_status value invalid');
                $out[] = ['type' => 'set_status', 'value' => $s];
                break;
            }
            case 'add_label': {
                $lid = (int)($a['label_id'] ?? 0);
                if ($lid <= 0) pm_error('add_label requires a positive label_id');
                $out[] = ['type' => 'add_label', 'label_id' => $lid];
                break;
            }
            case 'assign': {
                $uid = (int)($a['user_id'] ?? 0);
                if ($uid <= 0) pm_error('assign requires a positive user_id');
                $out[] = ['type' => 'assign', 'user_id' => $uid];
                break;
            }
            case 'add_watcher': {
                $uid = (int)($a['user_id'] ?? 0);
                if ($uid <= 0) pm_error('add_watcher requires a positive user_id');
                $out[] = ['type' => 'add_watcher', 'user_id' => $uid];
                break;
            }
            case 'notify': {
                $uid = (int)($a['user_id'] ?? 0);
                if ($uid <= 0) pm_error('notify requires a positive user_id');
                $entry = ['type' => 'notify', 'user_id' => $uid];
                $text = trim((string)($a['text'] ?? ''));
                if ($text !== '') $entry['text'] = mb_substr($text, 0, 500);
                $out[] = $entry;
                break;
            }
            case 'comment': {
                $text = trim((string)($a['text'] ?? ''));
                if ($text === '') pm_error('comment requires non-empty text');
                $out[] = ['type' => 'comment', 'text' => mb_substr($text, 0, 2000)];
                break;
            }
        }
    }
    return $out;
}

/** Resolve + validate an optional project_id (null = global rule). */
function pm_automation_project_id($raw): ?int {
    if ($raw === null || $raw === '' || $raw === 0 || $raw === '0') return null;
    $pid = (int)$raw;
    if ($pid <= 0) return null;
    $proj = pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$pid]);
    if (!$proj) pm_error('Invalid project_id');
    return $pid;
}

// ---- GET (list) — any authenticated user; readable projects only ---------
if ($method === 'GET' && $id === null) {
    // Hide rules scoped to private projects the caller can't read (their
    // names/conditions/notify text can be sensitive); global rules stay visible.
    $params = [];
    $where = function_exists('pm_readable_project_where')
        ? pm_readable_project_where($uid, 'project_id', $params) : '';
    $sql = 'SELECT * FROM automation_rules'
        . ($where !== '' ? " WHERE $where" : '')
        . ' ORDER BY project_id IS NOT NULL, project_id, id';
    $rows = pm_fetch_all($sql, $params);
    pm_json(['rules' => array_map('pm_automation_shape', $rows)]);
}

if ($method === 'GET' && $id !== null) {
    $r = pm_fetch_one('SELECT * FROM automation_rules WHERE id = ?', [$id]);
    if (!$r) pm_error('Not found', 404);
    if ($r['project_id'] !== null && function_exists('pm_can_read_project')
        && !pm_can_read_project($uid, (int)$r['project_id'])) {
        pm_error('Not found', 404);
    }
    pm_json(['rule' => pm_automation_shape($r)]);
}

// ---- POST (create) — admin ----------------------------------------------
if ($method === 'POST' && $id === null) {
    pm_require_admin();
    $body = pm_body();

    $name = trim((string)($body['name'] ?? ''));
    if ($name === '') pm_error('name required');
    if (mb_strlen($name) > 120) pm_error('name too long (max 120)');

    $trigger = (string)($body['trigger_event'] ?? '');
    if (!in_array($trigger, PM_AUTOMATION_EVENTS, true)) {
        pm_error('Invalid trigger_event; use one of: ' . implode(', ', PM_AUTOMATION_EVENTS));
    }

    $projectId  = pm_automation_project_id($body['project_id'] ?? null);
    $conditions = pm_automation_clean_conditions($body['conditions'] ?? []);
    $actions    = pm_automation_clean_actions($body['actions'] ?? []);
    $enabled    = array_key_exists('enabled', $body) ? (!empty($body['enabled']) ? 1 : 0) : 1;

    pm_exec(
        'INSERT INTO automation_rules
            (project_id, name, trigger_event, conditions_json, actions_json, enabled, created_by)
         VALUES (?,?,?,?,?,?,?)',
        [
            $projectId, $name, $trigger,
            json_encode($conditions), json_encode($actions),
            $enabled, pm_current_user_id(),
        ]
    );
    $r = pm_fetch_one('SELECT * FROM automation_rules WHERE id = ?', [pm_last_id()]);
    pm_json(['rule' => pm_automation_shape($r)]);
}

// ---- PATCH (update) — admin ---------------------------------------------
if ($method === 'PATCH' && $id !== null) {
    pm_require_admin();
    $r = pm_fetch_one('SELECT * FROM automation_rules WHERE id = ?', [$id]);
    if (!$r) pm_error('Not found', 404);
    $body = pm_body();

    $set = [];
    $args = [];

    if (array_key_exists('name', $body)) {
        $name = trim((string)$body['name']);
        if ($name === '') pm_error('name cannot be empty');
        if (mb_strlen($name) > 120) pm_error('name too long (max 120)');
        $set[] = 'name = ?'; $args[] = $name;
    }
    if (array_key_exists('project_id', $body)) {
        $set[] = 'project_id = ?'; $args[] = pm_automation_project_id($body['project_id']);
    }
    if (array_key_exists('trigger_event', $body)) {
        $trigger = (string)$body['trigger_event'];
        if (!in_array($trigger, PM_AUTOMATION_EVENTS, true)) {
            pm_error('Invalid trigger_event; use one of: ' . implode(', ', PM_AUTOMATION_EVENTS));
        }
        $set[] = 'trigger_event = ?'; $args[] = $trigger;
    }
    if (array_key_exists('conditions', $body)) {
        $set[] = 'conditions_json = ?'; $args[] = json_encode(pm_automation_clean_conditions($body['conditions']));
    }
    if (array_key_exists('actions', $body)) {
        $set[] = 'actions_json = ?'; $args[] = json_encode(pm_automation_clean_actions($body['actions']));
    }
    if (array_key_exists('enabled', $body)) {
        $set[] = 'enabled = ?'; $args[] = !empty($body['enabled']) ? 1 : 0;
    }

    if (!$set) pm_error('Nothing to update');
    $args[] = $id;
    pm_exec('UPDATE automation_rules SET ' . implode(', ', $set) . ' WHERE id = ?', $args);

    $r = pm_fetch_one('SELECT * FROM automation_rules WHERE id = ?', [$id]);
    pm_json(['rule' => pm_automation_shape($r)]);
}

// ---- DELETE — admin -----------------------------------------------------
if ($method === 'DELETE' && $id !== null) {
    pm_require_admin();
    pm_exec('DELETE FROM automation_rules WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

pm_error('Method not allowed', 405);
