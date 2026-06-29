<?php
// Lazy, no-cron automation engine (v2).
//
// Fires synchronously inside the request that triggers an event. The lead calls
// pm_run_automations() from tasks.php / notify_lib.php. Everything here is
// BEST-EFFORT: any failure is swallowed so it can never break the caller. A
// static re-entrancy guard prevents recursion (actions write via direct SQL,
// so nothing they touch re-triggers events anyway).

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/notify_lib.php';

if (!defined('PM_AUTOMATION_EVENTS')) {
    define('PM_AUTOMATION_EVENTS', ['task_created', 'task_completed', 'comment_added', 'due_soon']);
}
if (!defined('PM_AUTOMATION_STATUSES')) {
    define('PM_AUTOMATION_STATUSES', ['backlog', 'todo', 'in_progress', 'review', 'done']);
}
if (!defined('PM_AUTOMATION_ACTIONS')) {
    define('PM_AUTOMATION_ACTIONS', [
        'set_priority', 'set_status', 'add_label', 'assign',
        'add_watcher', 'notify', 'comment',
    ]);
}

/**
 * Run all enabled automation rules matching $event for task $taskId.
 *
 * @param string   $event   one of PM_AUTOMATION_EVENTS
 * @param int      $taskId  the task the event happened on
 * @param int|null $actorId the user who triggered it (null = system)
 */
function pm_run_automations(string $event, int $taskId, ?int $actorId = null): void {
    static $running = false;
    if ($running) return;          // re-entrancy guard: never recurse
    if ($taskId <= 0) return;
    if (!in_array($event, PM_AUTOMATION_EVENTS, true)) return;

    $running = true;
    try {
        $task = pm_fetch_one(
            'SELECT id, project_id, status, priority FROM tasks WHERE id = ?',
            [$taskId]
        );
        if (!$task) return;
        $projectId = (int)$task['project_id'];

        // Label ids on the task (only needed for label_id conditions; cheap).
        $labelIds = [];
        foreach (pm_fetch_all('SELECT label_id FROM task_labels WHERE task_id = ?', [$taskId]) as $r) {
            $labelIds[(int)$r['label_id']] = true;
        }

        $rules = pm_fetch_all(
            'SELECT * FROM automation_rules
             WHERE enabled = 1 AND trigger_event = ?
               AND (project_id IS NULL OR project_id = ?)',
            [$event, $projectId]
        );

        foreach ($rules as $rule) {
            try {
                if (!pm_automation_matches($rule, $task, $labelIds)) continue;
                pm_automation_apply($rule, $task, $taskId, $actorId);
                pm_exec(
                    'UPDATE automation_rules SET run_count = run_count + 1, last_run_at = NOW() WHERE id = ?',
                    [(int)$rule['id']]
                );
            } catch (Throwable $_) {
                // One bad rule must not stop the others.
            }
        }
    } catch (Throwable $_) {
        // Best effort: never propagate to the caller.
    } finally {
        $running = false;
    }
}

/** AND-match a rule's conditions_json against the task. Unknown/empty → matches. */
function pm_automation_matches(array $rule, array $task, array $labelIds): bool {
    $cond = json_decode((string)($rule['conditions_json'] ?? ''), true);
    if (!is_array($cond) || !$cond) return true;

    if (array_key_exists('priority', $cond) && $cond['priority'] !== null && $cond['priority'] !== '') {
        if ((int)$cond['priority'] !== (int)$task['priority']) return false;
    }
    if (array_key_exists('status', $cond) && $cond['status'] !== null && $cond['status'] !== '') {
        if ((string)$cond['status'] !== (string)$task['status']) return false;
    }
    if (array_key_exists('label_id', $cond) && $cond['label_id'] !== null && $cond['label_id'] !== '') {
        if (!isset($labelIds[(int)$cond['label_id']])) return false;
    }
    return true;
}

/** Apply each action in actions_json via DIRECT SQL (so nothing re-triggers). */
function pm_automation_apply(array $rule, array $task, int $taskId, ?int $actorId): void {
    $actions = json_decode((string)($rule['actions_json'] ?? ''), true);
    if (!is_array($actions)) return;

    foreach ($actions as $action) {
        if (!is_array($action)) continue;
        $type = $action['type'] ?? '';
        try {
            switch ($type) {
                case 'set_priority': {
                    $p = (int)($action['value'] ?? -1);
                    if ($p < 0 || $p > 3) break;
                    pm_exec('UPDATE tasks SET priority = ? WHERE id = ?', [$p, $taskId]);
                    break;
                }
                case 'set_status': {
                    $s = (string)($action['value'] ?? '');
                    if (!in_array($s, PM_AUTOMATION_STATUSES, true)) break;
                    pm_exec('UPDATE tasks SET status = ? WHERE id = ?', [$s, $taskId]);
                    break;
                }
                case 'add_label': {
                    $lid = (int)($action['label_id'] ?? 0);
                    if ($lid <= 0) break;
                    pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)', [$taskId, $lid]);
                    break;
                }
                case 'assign': {
                    $uid = (int)($action['user_id'] ?? 0);
                    if ($uid <= 0) break;
                    pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$taskId, $uid]);
                    pm_notify($uid, $actorId, $taskId, 'assigned', 'You were assigned to a task');
                    break;
                }
                case 'add_watcher': {
                    $uid = (int)($action['user_id'] ?? 0);
                    if ($uid <= 0) break;
                    pm_exec('INSERT IGNORE INTO task_watchers (task_id, user_id) VALUES (?,?)', [$taskId, $uid]);
                    break;
                }
                case 'notify': {
                    $uid = (int)($action['user_id'] ?? 0);
                    if ($uid <= 0) break;
                    $text = trim((string)($action['text'] ?? ''));
                    if ($text === '') $text = 'Automation update on a task you follow';
                    pm_notify($uid, $actorId, $taskId, 'automation', $text);
                    break;
                }
                case 'comment': {
                    $text = trim((string)($action['text'] ?? ''));
                    if ($text === '') break;
                    // System comment: user_id NULL, bot-prefixed body.
                    pm_exec(
                        'INSERT INTO comments (task_id, user_id, body) VALUES (?, NULL, ?)',
                        [$taskId, '🤖 ' . $text]
                    );
                    break;
                }
            }
        } catch (Throwable $_) {
            // Skip a single bad action, keep applying the rest.
        }
    }
}
