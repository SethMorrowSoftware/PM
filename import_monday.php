<?php
// =============================================================================
// import_monday.php — one-time migration: monday.com "Tech" board -> this app.
//
// Reads monday_export.json (must sit in the SAME directory as this file) and
// populates the database:
//   • creates any missing teammates (matched by email; random temp passwords)
//   • creates the target "Tech" project (once)
//   • RE-CREATES that project's milestones + tasks on every run (replace
//     semantics) so it is safe to run repeatedly — each run makes the "Tech"
//     project match the export exactly. It never touches your OTHER projects.
//   • imports subtasks, assignees, and the full comment history (author + date)
//
// Requirements: sign in as an ADMIN first (login.html), then open this file.
// AFTER a successful import: DELETE this file AND monday_export.json.
// =============================================================================

require_once __DIR__ . '/api/bootstrap.php';

header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const TARGET_PROJECT_NAME   = 'Tech';
const TARGET_PROJECT_PREFIX = 'TECH';           // must match ^[A-Z0-9]{1,8}$
const TARGET_PROJECT_COLOR  = '#3B82F6';
const EXPORT_FILE           = __DIR__ . '/monday_export.json';
const VALID_STATUSES        = ['backlog', 'todo', 'in_progress', 'review', 'done'];

$errors = [];
$ok     = [];
$summary = null;

// --- boot session so we can identify the signed-in admin -------------------
$cfg = null;
try { $cfg = pm_config(); } catch (Throwable $e) { $errors[] = $e->getMessage(); }
if (!$errors && session_status() === PHP_SESSION_NONE) {
    $c = pm_config();
    session_name($c['session_name']);
    session_set_cookie_params([
        'lifetime' => 0, 'path' => '/', 'secure' => !empty($c['cookie_secure']),
        'httponly' => true, 'samesite' => $c['cookie_samesite'] ?? 'Lax',
    ]);
    session_start();
}
$me = null;
if (!$errors) { try { $me = pm_current_user(); } catch (Throwable $e) { /* tables may be missing */ } }
$isAdmin = $me && !empty($me['is_admin']);

// --- load the export -------------------------------------------------------
$data = null;
if (!$errors) {
    if (!is_file(EXPORT_FILE)) {
        $errors[] = 'monday_export.json was not found next to this script. Upload it into the same folder.';
    } else {
        $data = json_decode((string) file_get_contents(EXPORT_FILE), true);
        if (!is_array($data) || !isset($data['tasks']) || !is_array($data['tasks'])) {
            $errors[] = 'monday_export.json is missing or malformed (no "tasks" array).';
        }
    }
}

$preview = null;
if ($data) {
    $subs = 0; $cmts = 0;
    foreach ($data['tasks'] as $t) {
        $subs += is_array($t['subtasks'] ?? null) ? count($t['subtasks']) : 0;
        $cmts += is_array($t['comments'] ?? null) ? count($t['comments']) : 0;
    }
    $preview = [
        'tasks'      => count($data['tasks']),
        'subtasks'   => $subs,
        'comments'   => $cmts,
        'milestones' => is_array($data['milestones'] ?? null) ? count($data['milestones']) : 0,
        'users'      => is_array($data['users'] ?? null) ? count($data['users']) : 0,
    ];
}

// --- run the import on confirmed POST --------------------------------------
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$errors) {
    if (!$isAdmin) {
        $errors[] = 'You must be signed in as an admin to run the import. Open login.html, sign in, then return here.';
    } elseif (trim((string) ($_POST['confirm'] ?? '')) !== 'IMPORT MONDAY') {
        $errors[] = 'Confirmation phrase mismatch. Type exactly: IMPORT MONDAY';
    } else {
        try {
            $summary = imp_run($data, (int) $me['id']);
            $ok[] = 'Import complete.';
        } catch (Throwable $e) {
            $errors[] = 'Import failed (nothing was changed): ' . $e->getMessage();
        }
    }
}

// ---------------------------------------------------------------------------
function imp_initials(string $name): string {
    $parts = preg_split('/\s+/', trim($name)) ?: [];
    if (!$parts || $parts[0] === '') return 'NA';
    if (count($parts) === 1) return strtoupper(mb_substr($parts[0], 0, 2));
    return strtoupper(mb_substr($parts[0], 0, 1) . mb_substr(end($parts), 0, 1));
}
function imp_color(): string {
    $c = ['#3B82F6','#A855F7','#F59E0B','#22C55E','#EC4899','#06B6D4','#EF4444','#8B5CF6'];
    return $c[array_rand($c)];
}
function imp_dt(?string $s): ?string {
    return (is_string($s) && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $s)) ? $s : null;
}

// ---- recurring-checklist conversion helpers --------------------------------
// monday groups that are really recurring routines become recurring RULES
// (spawning a fresh task with an unchecked subtask checklist each period)
// instead of a milestone full of never-finishing static tasks.

// Next calendar date (today or later) that falls on the given weekday, 0=Sun.
function imp_next_weekday(int $dow): string {
    for ($i = 0; $i < 8; $i++) {
        $d = strtotime("+$i day");
        if ((int) date('w', $d) === $dow) return date('Y-m-d', $d);
    }
    return date('Y-m-d');
}

// First occurrence for a cadence config; used as the rule's next_run AND the
// due date of the initial instance the importer spawns.
function imp_first_occurrence(array $rc): string {
    switch ($rc['cadence']) {
        case 'weekly':  return imp_next_weekday((int) ($rc['weekday'] ?? 1));
        case 'monthly': return date('Y-m-d', strtotime('first day of next month'));
        case 'yearly':  return date('Y-01-01', strtotime('+1 year'));
    }
    return date('Y-m-d');
}

// Advance one period past $ymd (interval is always 1 for imported rules).
function imp_advance(string $ymd, array $rc): string {
    $ts = strtotime($ymd) ?: time();
    switch ($rc['cadence']) {
        case 'weekly':  return date('Y-m-d', strtotime('+7 day', $ts));
        case 'monthly': {
            $t2 = strtotime('first day of next month', $ts);
            $md = (int) ($rc['month_day'] ?? (int) date('d', $ts));
            return date('Y-m-', $t2) . str_pad((string) min($md, (int) date('t', $t2)), 2, '0', STR_PAD_LEFT);
        }
        case 'yearly':  return date('Y-m-d', strtotime('+1 year', $ts));
    }
    return date('Y-m-d', strtotime('+7 day', $ts));
}

// Cadence for an item in the catch-all "Checklists" group, inferred from its
// title. Returns null when there is no schedule — those become on-demand task
// TEMPLATES instead (apply from the task-template picker whenever needed).
function imp_checklist_cadence(string $title): ?array {
    $t = mb_strtolower($title);
    if (str_contains($t, 'monthly')) return ['cadence' => 'monthly', 'month_day' => 1];
    if (str_contains($t, 'yearly'))  return ['cadence' => 'yearly', 'month_of_year' => 1, 'month_day' => 1];
    if (str_contains($t, 'weekend')) return ['cadence' => 'weekly', 'weekday' => 5];
    if (str_contains($t, 'week'))    return ['cadence' => 'weekly', 'weekday' => 1];
    return null;
}

/**
 * Runs the whole migration inside ONE transaction: if anything fails, the
 * database is left exactly as it was (safe to retry). Returns a summary.
 */
function imp_run(array $data, int $adminId): array {
    $pdo = pm_db();

    // Map existing users by lower(email).
    $emailToId = [];
    foreach (pm_fetch_all('SELECT id, LOWER(email) AS email FROM users') as $r) {
        if ($r['email'] !== null && $r['email'] !== '') $emailToId[$r['email']] = (int) $r['id'];
    }

    $pdo->beginTransaction();
    try {
        // 1) Create any missing teammates (match by email).
        $createdUsers = [];
        foreach (($data['users'] ?? []) as $u) {
            $email = strtolower(trim((string) ($u['email'] ?? '')));
            $name  = trim((string) ($u['name'] ?? ''));
            if ($email === '' || $name === '') continue;
            if (isset($emailToId[$email])) continue; // already exists — leave it (and its password) alone
            $pw = 'Castle-' . bin2hex(random_bytes(5));
            pm_exec(
                'INSERT INTO users (email, password_hash, name, role, initials, color, is_admin) VALUES (?,?,?,?,?,?,?)',
                [$email, password_hash($pw, PASSWORD_DEFAULT), $name, null, imp_initials($name), imp_color(), !empty($u['is_admin']) ? 1 : 0]
            );
            $id = pm_last_id();
            $emailToId[$email] = $id;
            $createdUsers[] = ['name' => $name, 'email' => $email, 'password' => $pw];
        }

        // 2) Find-or-create the target project (created once; reused on re-runs).
        $proj = pm_fetch_one('SELECT id FROM projects WHERE name = ? ORDER BY id LIMIT 1', [TARGET_PROJECT_NAME]);
        if ($proj) {
            $projectId = (int) $proj['id'];
        } else {
            $sortRow = pm_fetch_one('SELECT COALESCE(MAX(sort_order),0) AS m FROM projects');
            pm_exec(
                'INSERT INTO projects (name, color, key_prefix, description, sort_order) VALUES (?,?,?,?,?)',
                [TARGET_PROJECT_NAME, TARGET_PROJECT_COLOR, TARGET_PROJECT_PREFIX, 'Imported from monday.com', ((int) $sortRow['m']) + 1]
            );
            $projectId = pm_last_id();
        }

        // 3) Replace semantics: wipe THIS project's tasks, milestones, recurring
        //    rules, and task templates only. Deleting tasks cascades their
        //    subtasks/assignees/comments (FKs).
        pm_exec('DELETE FROM tasks WHERE project_id = ?', [$projectId]);
        pm_exec('DELETE FROM milestones WHERE project_id = ?', [$projectId]);
        pm_exec('DELETE FROM recurring_rules WHERE project_id = ?', [$projectId]);
        pm_exec('DELETE FROM task_templates WHERE project_id = ?', [$projectId]);

        // 3b) Classify monday groups. Not every group is a milestone:
        //     • recurring-routine groups  -> recurring RULES (fresh task each period)
        //     • the catch-all "Checklists" group -> rules (scheduled) or task
        //       TEMPLATES (unscheduled reference lists, applied on demand)
        //     • personal groups (Dylan/Seth/Izzy) -> plain tasks ASSIGNED to that
        //       person (that's what My Tasks is for), no milestone
        //     • everything else -> a milestone, as before
        $firstNameToUid = [];
        foreach (($data['users'] ?? []) as $u) {
            $email = strtolower(trim((string) ($u['email'] ?? '')));
            $first = strtolower((string) strtok(trim((string) ($u['name'] ?? '')), ' '));
            if ($first !== '' && isset($emailToId[$email])) $firstNameToUid[$first] = $emailToId[$email];
        }
        $recurringGroups = [
            'FRIDAY CHECKLIST'                => ['title_prefix' => 'Friday checklist', 'cadence' => 'weekly', 'weekday' => 5],
            'Weekly Facility Checks'          => ['title_prefix' => 'Weekly facility check', 'cadence' => 'weekly', 'weekday' => 1],
            'Izzy Saturday Morning Checklist' => ['title_prefix' => 'Saturday morning checklist', 'cadence' => 'weekly', 'weekday' => 6,
                                                  'assignee_uid' => $firstNameToUid['izzy'] ?? null],
        ];
        $checklistCatchall = 'Checklists';
        // A group named after a teammate's first name (Dylan / Seth / Izzy /
        // Mars…) is that person's to-do bucket, not a milestone.
        $personalGroups = [];
        foreach (($data['milestones'] ?? []) as $g) {
            $g = trim((string) $g);
            if ($g !== '' && isset($firstNameToUid[strtolower($g)])) $personalGroups[$g] = $firstNameToUid[strtolower($g)];
        }
        $nonMilestoneGroups = array_merge(array_keys($recurringGroups), [$checklistCatchall], array_keys($personalGroups));

        // 4) Recreate milestones for the remaining groups, preserving order.
        $msByTitle = [];
        $mi = 0;
        foreach (($data['milestones'] ?? []) as $title) {
            $title = trim((string) $title);
            if ($title === '' || isset($msByTitle[$title])) continue;
            if (in_array($title, $nonMilestoneGroups, true)) continue;
            pm_exec('INSERT INTO milestones (project_id, name, sort_order) VALUES (?,?,?)', [$projectId, $title, ++$mi]);
            $msByTitle[$title] = pm_last_id();
        }

        // 5) Tasks (+ subtasks, assignees, comments).
        $maxRow = pm_fetch_one("SELECT MAX(CAST(SUBSTRING_INDEX(ref,'-',-1) AS UNSIGNED)) AS m FROM tasks WHERE ref LIKE ?", [TARGET_PROJECT_PREFIX . '-%']);
        $refN = max(100, ((int) ($maxRow['m'] ?? 0)) + 1);

        $posByStatus = [];
        $tCount = $sCount = $cCount = $aCount = 0;
        $unmatchedAssignees = 0;
        $pendingRules = [];
        $pendingTemplates = [];
        $seenRuleKeys = [];

        foreach ($data['tasks'] as $t) {
            $title = trim((string) ($t['title'] ?? ''));
            if ($title === '') $title = 'Untitled';
            $title = mb_substr($title, 0, 500);

            $status = in_array($t['status'] ?? '', VALID_STATUSES, true) ? $t['status'] : 'todo';
            $prio   = is_numeric($t['priority'] ?? null) ? max(0, min(3, (int) $t['priority'])) : 2;
            $due    = (!empty($t['due']) && preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $t['due'])) ? $t['due'] : null;
            $desc   = trim((string) ($t['description'] ?? ''));
            $desc   = $desc === '' ? null : mb_substr($desc, 0, 20000);
            $grp    = trim((string) ($t['milestone'] ?? ''));

            // Recurring-routine groups: divert into a rule instead of a task.
            $ruleCfg = $recurringGroups[$grp] ?? null;
            if ($ruleCfg === null && $grp === $checklistCatchall) {
                $ruleCfg = imp_checklist_cadence($title);
                if ($ruleCfg !== null) {
                    // Standalone cadence words make bad task titles ("Monthly").
                    if (preg_match('/^(monthly|weekly|yearly)$/i', $title)) $title .= ' checklist';
                } else {
                    // Unscheduled reference checklist -> on-demand task template.
                    $pendingTemplates[] = [
                        'name'     => mb_substr($title, 0, 120),
                        'title'    => $title,
                        'desc'     => $desc,
                        'priority' => $prio,
                        'subtasks' => array_values(array_filter(array_map(
                            fn ($st) => trim((string) ($st['text'] ?? '')), $t['subtasks'] ?? []))),
                    ];
                    continue;
                }
            }
            if ($ruleCfg !== null) {
                $ruleTitle = isset($ruleCfg['title_prefix']) ? $ruleCfg['title_prefix'] . ' — ' . $title : $title;
                $key = strtolower($grp . '|' . $ruleTitle);
                if (isset($seenRuleKeys[$key])) continue;    // monday had a few duplicate rows
                $seenRuleKeys[$key] = true;
                $pendingRules[] = [
                    'title'    => mb_substr($ruleTitle, 0, 500),
                    'desc'     => $desc,
                    'priority' => $prio,
                    'cfg'      => $ruleCfg,
                    'assignees'=> !empty($ruleCfg['assignee_uid']) ? [(int) $ruleCfg['assignee_uid']] : [],
                    'subtasks' => array_values(array_filter(array_map(
                        fn ($st) => trim((string) ($st['text'] ?? '')), $t['subtasks'] ?? []))),
                ];
                continue;
            }

            // Personal groups: plain task assigned to that person, no milestone.
            $personalUid = $personalGroups[$grp] ?? null;
            $msId = ($personalUid === null && $grp !== '' && isset($msByTitle[$grp])) ? $msByTitle[$grp] : null;
            $pos    = ($posByStatus[$status] = ($posByStatus[$status] ?? 0) + 1);
            $created = imp_dt($t['created_at'] ?? null) ?? date('Y-m-d H:i:s');
            $ref    = TARGET_PROJECT_PREFIX . '-' . ($refN++);

            pm_exec(
                'INSERT INTO tasks (ref, project_id, status, title, description, priority, due, position, milestone_id, created_by, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                [$ref, $projectId, $status, $title, $desc, $prio, $due, $pos, $msId, $adminId, $created]
            );
            $taskId = pm_last_id();
            $tCount++;

            if ($personalUid !== null) {
                pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$taskId, $personalUid]);
                $aCount++;
            }

            $seenA = [];
            foreach (($t['assignee_emails'] ?? []) as $ae) {
                $ae = strtolower(trim((string) $ae));
                if ($ae === '' || isset($seenA[$ae])) continue;
                $seenA[$ae] = true;
                if (isset($emailToId[$ae])) {
                    pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$taskId, $emailToId[$ae]]);
                    $aCount++;
                } else {
                    $unmatchedAssignees++;
                }
            }

            $so = 0;
            foreach (($t['subtasks'] ?? []) as $st) {
                $txt = trim((string) ($st['text'] ?? ''));
                if ($txt === '') continue;
                pm_exec('INSERT INTO subtasks (task_id, text, done, sort_order) VALUES (?,?,?,?)',
                    [$taskId, mb_substr($txt, 0, 500), !empty($st['done']) ? 1 : 0, ++$so]);
                $sCount++;
            }

            foreach (($t['comments'] ?? []) as $c) {
                $body = trim((string) ($c['body'] ?? ''));
                if ($body === '') continue;
                $ce  = strtolower(trim((string) ($c['author_email'] ?? '')));
                $uid = ($ce !== '' && isset($emailToId[$ce])) ? $emailToId[$ce] : null;
                $ccAt = imp_dt($c['created_at'] ?? null) ?? date('Y-m-d H:i:s');
                pm_exec('INSERT INTO comments (task_id, user_id, body, created_at) VALUES (?,?,?,?)',
                    [$taskId, $uid, mb_substr($body, 0, 20000), $ccAt]);
                $cCount++;
            }
        }

        // 6) Create the recurring rules and spawn each rule's FIRST instance.
        //    (The app only auto-spawns on rule creation via the API or when a
        //    previous instance is completed — rules inserted here need their
        //    opening task or the chain would never start.)
        $ruleRows = [];
        foreach ($pendingRules as $pr) {
            $rc = $pr['cfg'];
            $firstDue = imp_first_occurrence($rc);
            pm_exec(
                'INSERT INTO recurring_rules
                    (project_id, title, description, priority, assignees, subtasks_json,
                     cadence, interval_n, weekday, month_day, month_of_year, next_run, created_by)
                 VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?)',
                [
                    $projectId, $pr['title'], $pr['desc'], $pr['priority'],
                    $pr['assignees'] ? json_encode($pr['assignees']) : null,
                    $pr['subtasks'] ? json_encode($pr['subtasks'], JSON_UNESCAPED_UNICODE) : null,
                    $rc['cadence'],
                    $rc['weekday'] ?? null, $rc['month_day'] ?? null, $rc['month_of_year'] ?? null,
                    $firstDue, $adminId,
                ]
            );
            $ruleId = pm_last_id();

            $pos = ($posByStatus['todo'] = ($posByStatus['todo'] ?? 0) + 1);
            $ref = TARGET_PROJECT_PREFIX . '-' . ($refN++);
            pm_exec(
                'INSERT INTO tasks (ref, project_id, status, title, description, priority, due, position, recurring_rule_id, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?)',
                [$ref, $projectId, 'todo', $pr['title'], $pr['desc'], $pr['priority'], $firstDue, $pos, $ruleId, $adminId]
            );
            $tid = pm_last_id();
            $so = 0;
            foreach ($pr['subtasks'] as $stText) {
                pm_exec('INSERT INTO subtasks (task_id, text, done, sort_order) VALUES (?,?,0,?)',
                    [$tid, mb_substr($stText, 0, 500), ++$so]);
                $sCount++;
            }
            foreach ($pr['assignees'] as $uid) {
                pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$tid, $uid]);
                $aCount++;
            }
            pm_exec('UPDATE recurring_rules SET next_run = ?, last_task_id = ? WHERE id = ?',
                [imp_advance($firstDue, $rc), $tid, $ruleId]);
            $tCount++;
            $ruleRows[] = ['title' => $pr['title'], 'cadence' => $rc['cadence'], 'first' => $firstDue,
                           'steps' => count($pr['subtasks'])];
        }

        // 7) On-demand reference checklists -> task templates.
        foreach ($pendingTemplates as $pt) {
            pm_exec(
                'INSERT INTO task_templates (project_id, name, title, description, priority, default_status, subtasks_json, created_by)
                 VALUES (?,?,?,?,?,?,?,?)',
                [
                    $projectId, $pt['name'], $pt['title'], $pt['desc'], $pt['priority'], 'todo',
                    $pt['subtasks'] ? json_encode($pt['subtasks'], JSON_UNESCAPED_UNICODE) : null,
                    $adminId,
                ]
            );
        }

        $pdo->commit();

        return [
            'project_id'          => $projectId,
            'tasks'               => $tCount,
            'subtasks'            => $sCount,
            'comments'            => $cCount,
            'assignees'           => $aCount,
            'unmatched_assignees' => $unmatchedAssignees,
            'milestones'          => count($msByTitle),
            'rules'               => $ruleRows,
            'templates'           => count($pendingTemplates),
            'created_users'       => $createdUsers,
        ];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

function e($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Import from monday.com · Castle Tech Tasks</title>
<style>
:root { color-scheme: dark; }
body { margin:0; background:#0b0f17; color:#e8ecf4; font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.wrap { max-width:820px; margin:32px auto; padding:0 16px; }
.card { background:#151b27; border:1px solid #222b3b; border-radius:12px; padding:18px; margin-bottom:16px; }
h1 { margin:0 0 6px; font-size:23px; } h2 { font-size:16px; margin:0 0 10px; }
.sub { color:#8a94a8; margin:0 0 14px; font-size:14px; }
.warn,.ok,.err { border-radius:8px; padding:10px 12px; margin-bottom:10px; font-size:14px; }
.warn { background:rgba(245,158,11,.1); border:1px solid rgba(245,158,11,.35); color:#fcd34d; }
.ok { background:rgba(34,197,94,.1); border:1px solid rgba(34,197,94,.35); color:#86efac; }
.err { background:rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.35); color:#fca5a5; }
input[type=text]{ width:100%; background:#1b2230; border:1px solid #2b354a; color:#e8ecf4; border-radius:8px; padding:10px 12px; box-sizing:border-box; }
button{ margin-top:12px; background:#3b82f6; border:0; color:#fff; border-radius:8px; padding:10px 16px; cursor:pointer; font-weight:600; }
button:hover{ background:#60a5fa; } button[disabled]{ opacity:.5; cursor:not-allowed; }
code{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; background:#1b2230; padding:2px 6px; border-radius:4px; }
.grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; }
.kpi{ background:#1b2230; border:1px solid #2b354a; border-radius:8px; padding:10px; } .kpi b{ display:block; font-size:20px; } .kpi small{ color:#8a94a8; }
table{ width:100%; border-collapse:collapse; font-size:13px; } td,th{ text-align:left; padding:6px 8px; border-bottom:1px solid #222b3b; }
a{ color:#7a90ff; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>Import from monday.com</h1>
    <p class="sub">Populates the <code><?= e(TARGET_PROJECT_NAME) ?></code> project from <code>monday_export.json</code>. Each run <strong>replaces</strong> that project's tasks &amp; milestones with the export (your other projects are untouched).</p>

    <?php foreach ($errors as $er): ?><div class="err"><?= e($er) ?></div><?php endforeach; ?>
    <?php foreach ($ok as $m): ?><div class="ok"><?= e($m) ?></div><?php endforeach; ?>

    <?php if (!$errors && !$isAdmin): ?>
      <div class="warn"><strong>Sign in required.</strong> Open <a href="login.html">login.html</a>, sign in as an admin, then reload this page. The importer will not run for a non-admin.</div>
    <?php endif; ?>

    <?php if ($preview && !$summary): ?>
      <h2>What will be imported</h2>
      <div class="grid" style="margin-bottom:14px">
        <div class="kpi"><b><?= (int) $preview['tasks'] ?></b><small>tasks</small></div>
        <div class="kpi"><b><?= (int) $preview['subtasks'] ?></b><small>subtasks</small></div>
        <div class="kpi"><b><?= (int) $preview['comments'] ?></b><small>comments</small></div>
        <div class="kpi"><b><?= (int) $preview['milestones'] ?></b><small>milestones</small></div>
        <div class="kpi"><b><?= (int) $preview['users'] ?></b><small>teammates</small></div>
      </div>
      <div class="warn">Running this will <strong>delete every task, milestone, recurring rule, and task template currently in the "<?= e(TARGET_PROJECT_NAME) ?>" project</strong> and replace them with the import. It does not affect any other project. Missing teammates are created with temporary passwords (shown after import).</div>
      <div class="warn">Checklist groups (Friday checklist, Weekly Facility Checks, Saturday morning, Monthly/Yearly…) are converted into <strong>recurring rules</strong> that spawn a fresh task with unchecked subtasks each period — they will NOT appear as milestones. The Dylan/Seth/Izzy groups become <strong>personal task assignments</strong> instead of milestones.</div>
      <?php if ($isAdmin): ?>
      <form method="post">
        <label>Type <code>IMPORT MONDAY</code> to confirm:</label>
        <input type="text" name="confirm" autocomplete="off" placeholder="IMPORT MONDAY" required>
        <button type="submit">Run import</button>
      </form>
      <?php endif; ?>
    <?php endif; ?>

    <?php if ($summary): ?>
      <h2>Done — here's what landed</h2>
      <div class="grid" style="margin-bottom:14px">
        <div class="kpi"><b><?= (int) $summary['tasks'] ?></b><small>tasks</small></div>
        <div class="kpi"><b><?= (int) $summary['subtasks'] ?></b><small>subtasks</small></div>
        <div class="kpi"><b><?= (int) $summary['comments'] ?></b><small>comments</small></div>
        <div class="kpi"><b><?= (int) $summary['assignees'] ?></b><small>assignments</small></div>
        <div class="kpi"><b><?= (int) $summary['milestones'] ?></b><small>milestones</small></div>
        <div class="kpi"><b><?= count($summary['rules'] ?? []) ?></b><small>recurring rules</small></div>
        <div class="kpi"><b><?= (int) ($summary['templates'] ?? 0) ?></b><small>task templates</small></div>
      </div>
      <?php if (!empty($summary['rules'])): ?>
        <h2>Recurring checklists created</h2>
        <p class="sub">Each spawns a fresh task (with its steps as unchecked subtasks) on schedule; the first instance is already on the board with the due date shown. Adjust any of these under Settings → Recurring rules.</p>
        <table style="margin-bottom:14px">
          <tr><th>Rule</th><th>Cadence</th><th>Steps</th><th>First due</th></tr>
          <?php foreach ($summary['rules'] as $r): ?>
            <tr><td><?= e($r['title']) ?></td><td><?= e($r['cadence']) ?></td><td><?= (int) $r['steps'] ?></td><td><code><?= e($r['first']) ?></code></td></tr>
          <?php endforeach; ?>
        </table>
      <?php endif; ?>
      <?php if (!empty($summary['created_users'])): ?>
        <div class="warn"><strong>New teammate accounts</strong> — share these temporary passwords; each person can change it under Profile after signing in.</div>
        <table>
          <tr><th>Name</th><th>Email (login)</th><th>Temp password</th></tr>
          <?php foreach ($summary['created_users'] as $u): ?>
            <tr><td><?= e($u['name']) ?></td><td><code><?= e($u['email']) ?></code></td><td><code><?= e($u['password']) ?></code></td></tr>
          <?php endforeach; ?>
        </table>
      <?php else: ?>
        <div class="ok">All monday owners matched existing users — no new accounts were created.</div>
      <?php endif; ?>
      <?php if (!empty($summary['unmatched_assignees'])): ?>
        <div class="warn"><?= (int) $summary['unmatched_assignees'] ?> assignment(s) referenced an owner with no matching app user and were skipped.</div>
      <?php endif; ?>
      <div class="ok" style="margin-top:12px">You can now open <a href="index.html">the app</a> and check the <strong><?= e(TARGET_PROJECT_NAME) ?></strong> project. Once you're happy, <strong>delete <code>import_monday.php</code> and <code>monday_export.json</code></strong> from the server.</div>
    <?php endif; ?>
  </div>
</div>
</body>
</html>
