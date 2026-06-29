<?php
// Browser-run seed utility for Project Manager.
// WARNING: This script can wipe and repopulate all app data.
// Delete or protect this file after use in production.

require_once __DIR__ . '/api/bootstrap.php';

$errors = [];
$ok = [];
$summary = [];

// Ensure this endpoint renders as HTML when visited in a browser.
header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

// Boot the session before doing anything destructive. Without an authenticated
// admin in the session, the seeder must NOT execute — a wide-open destructive
// endpoint behind a "type the words on screen" prompt is not an auth boundary.
$cfg = null;
try { $cfg = pm_config(); } catch (Throwable $e) { $errors[] = $e->getMessage(); }

if (!$errors && session_status() === PHP_SESSION_NONE) {
    session_name($cfg['session_name']);
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => !empty($cfg['cookie_secure']),
        'httponly' => true,
        'samesite' => $cfg['cookie_samesite'] ?? 'Lax',
    ]);
    session_start();
}

try {
    pm_db();
} catch (Throwable $e) {
    $errors[] = 'Bootstrap/DB failed: ' . $e->getMessage();
}

// Determine whether anyone is logged in as admin. If no users table exists
// yet (fresh install) we treat that as "not locked" so the seeder is usable
// during initial setup; once an admin exists, only that admin can re-seed.
$adminExists = false;
$currentAdmin = null;
$tablesReady  = false;
if (!$errors) {
    try {
        $row = pm_fetch_one('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1');
        $adminExists = !empty($row) && (int)$row['c'] > 0;
        $tablesReady = true;
    } catch (Throwable $_) {
        // users table doesn't exist — install hasn't run yet.
        $adminExists = false;
    }
    if ($adminExists) {
        $currentAdmin = pm_current_user();
        if ($currentAdmin && empty($currentAdmin['is_admin'])) $currentAdmin = null;
    }
}

$seedLocked = $adminExists && !$currentAdmin;

function sp_make_initials(string $name): string {
    $parts = preg_split('/\s+/', trim($name));
    if (!$parts || $parts[0] === '') return 'NA';
    if (count($parts) === 1) return strtoupper(substr($parts[0], 0, 2));
    return strtoupper(substr($parts[0], 0, 1) . substr($parts[count($parts)-1], 0, 1));
}

function sp_seed_data(): array {
    $pdo = pm_db();

    $users = [
        ['Mike-admin', 'Admin',                '#3B82F6', 1, 'mike-admin@castle.local'],
        ['Dylan',      'Tech Manager',         '#22C55E', 0, 'dylan@castle.local'],
        ['Mars',       'Asst Tech Manager',    '#A855F7', 0, 'mars@castle.local'],
        ['Seth',       'Arcade Technician',    '#EF4444', 0, 'seth@castle.local'],
        ['Izze',       'Arcade Technician',    '#F59E0B', 0, 'izze@castle.local'],
    ];

        // Projects themed around Castle Fun Center (Chester, NY) attractions and facility ops.
    $projects = [
        ['Arcade Operations',       '#8B5CF6', 'ARC', 'Prize counters, game cabinets, card swipes, and redemption support.'],
        ['Roller Rink',             '#06B6D4', 'RNK', 'Floor care, skate rental fleet, lighting, and music/PA readiness.'],
        ['HVAC Systems',            '#F97316', 'HVC', 'Air handling, rooftop units, filters, comfort zoning, and controls.'],
        ['InflataPark & Ballocity', '#22C55E', 'INF', 'Inflatable blowers, sanitization, seam checks, and netting inspections.'],
        ['Bowling Lanes',           '#3B82F6', 'BWL', 'Pinsetters, approaches, lane oil patterns, and scoring systems.'],
        ['Axe Throwing',            '#EF4444', 'AXE', 'Lane safety barriers, target wear rotation, and waiver workflow.'],
        ['Go Karts & Outdoor',      '#84CC16', 'GKO', 'Karts, queue gates, barriers, ride controls, and seasonal readiness.'],
        ['Laser Tag / Attractions', '#EC4899', 'LZR', 'Vests, sensors, arena lighting, scoreboards, and mission resets.'],
    ];

    $labelsGlobal = [
        ['Safety', 'pink'], ['Preventive', 'green'], ['Urgent', 'amber'], ['Compliance', 'cyan'],
        ['Vendor', 'violet'], ['Electrical', 'blue'], ['Mechanical', 'slate'], ['Guest Impact', 'red'],
    ];

    $taskBlueprints = [
        'Arcade Operations' => [
            ['Audit swipe readers on top 25 cabinets', 'Verify card readers, firmware, and credit acceptance.', 'in_progress', 3, '+2 days', '6h', ['Preventive','Electrical']],
            ['Refill redemption stock (high-demand prizes)', 'Restock plush, novelty, and ticket bundles before weekend surge.', 'todo', 2, '+1 day', '3h', ['Guest Impact']],
            ['Patch leaderboard kiosk browser lockdown', 'Apply kiosk policy update and disable exit shortcuts.', 'review', 2, '+3 days', '2h', ['Compliance']],
        ],
        'Roller Rink' => [
            ['Resurface high-wear rink lane segments', 'Spot-repair floor areas near DJ booth and entrance.', 'todo', 3, '+5 days', '8h', ['Mechanical','Safety']],
            ['Inspect and sanitize rental skates', 'Pull damaged pairs, tag for parts, and sanitize all rentals.', 'in_progress', 2, '+1 day', '4h', ['Preventive']],
            ['Test emergency lighting + PA failover', 'Run monthly safety drill after close.', 'backlog', 1, '+8 days', '2h', ['Compliance','Safety']],
        ],
        'HVAC Systems' => [
            ['Replace rooftop RTU filters (Zone A/B)', 'Swap filters and log pressure drop readings.', 'todo', 3, '+2 days', '5h', ['Preventive','Mechanical']],
            ['Calibrate thermostat cluster near arcade mezzanine', 'Correct drift and align with occupancy schedule.', 'review', 2, '+4 days', '3h', ['Electrical']],
            ['Investigate humidity spikes in InflataPark', 'Track moisture events and inspect dehumidifier runtime.', 'in_progress', 3, '+1 day', '6h', ['Guest Impact','Urgent']],
        ],
        'InflataPark & Ballocity' => [
            ['Blower pressure and backup power validation', 'Run opening checklist for all blower circuits and backup transfer.', 'todo', 3, '+1 day', '4h', ['Safety','Electrical']],
            ['Inspect seam wear on obstacle modules', 'Tag any weak seams for vendor repair photos.', 'in_progress', 2, '+3 days', '5h', ['Vendor','Preventive']],
            ['Deep clean ball pit and sanitization log', 'Complete sanitation cycle and update health compliance sheet.', 'done', 2, '-1 day', '3h', ['Compliance']],
        ],
        'Bowling Lanes' => [
            ['Pinsetter jam trend analysis (Lanes 3-6)', 'Review fault counts and replace worn belts.', 'todo', 3, '+2 days', '5h', ['Mechanical','Urgent']],
            ['Lane oil pattern reset for weekend leagues', 'Apply standard house pattern and verify with lane reader.', 'review', 2, '+1 day', '2h', ['Preventive']],
            ['Scoring tablet firmware update', 'Apply vendor bundle and test score sync.', 'backlog', 1, '+9 days', '2h', ['Vendor','Electrical']],
        ],
        'Axe Throwing' => [
            ['Rotate target boards and inspect backing', 'Replace overused boards and verify secure mount points.', 'todo', 2, '+3 days', '3h', ['Safety']],
            ['Queue camera blind-spot correction', 'Adjust camera angle at lane 4 waiting area.', 'in_progress', 2, '+2 days', '2h', ['Compliance','Electrical']],
            ['Waiver tablet charging dock replacement', 'Replace failed dock and re-cable safely.', 'done', 1, '-2 days', '1h', ['Guest Impact']],
        ],
        'Go Karts & Outdoor' => [
            ['Track barrier integrity walkdown', 'Inspect bump sections and tighten loose mounts.', 'todo', 3, '+2 days', '4h', ['Safety','Mechanical']],
            ['Kart battery cycle test and swap plan', 'Load-test fleet packs and retire weak sets.', 'in_progress', 3, '+1 day', '6h', ['Electrical','Preventive']],
            ['Pre-rain drainage check around queue', 'Clear drains and place non-slip mats.', 'review', 2, '+4 days', '2h', ['Guest Impact']],
        ],
        'Laser Tag / Attractions' => [
            ['Vest sensor calibration (full set)', 'Recalibrate phasers/vests and confirm hit registration.', 'todo', 2, '+2 days', '4h', ['Preventive','Electrical']],
            ['Arena e-stop verification drill', 'Validate emergency stops and restart sequence.', 'backlog', 1, '+10 days', '2h', ['Safety','Compliance']],
            ['Replace failed blacklight fixtures', 'Swap tube set in corridor C and verify illumination.', 'in_progress', 2, '+1 day', '3h', ['Mechanical']],
        ],
    ];

    $defaultPassword = 'CastleSeed!2026';

    $pdo->beginTransaction();
    try {
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        $truncate = [
            // v2 tables first (children), then the original set.
            'comment_reactions','comment_mentions','notifications','reminders','task_watchers',
            'task_custom_values','custom_fields','time_entries','task_dependencies','milestones',
            'task_templates','automation_rules','goal_projects','goals',
            'task_attachments','saved_views','activity','comments','task_labels','task_assignees',
            'subtasks','tasks','recurring_rules','labels','projects','users','app_settings',
        ];
        foreach ($truncate as $tbl) {
            // Tolerate older installs that predate the v2 tables.
            try { $pdo->exec("TRUNCATE TABLE {$tbl}"); } catch (Throwable $_) {}
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');

        $userIds = [];
        foreach ($users as [$name, $role, $color, $isAdmin, $email]) {
            pm_exec(
                'INSERT INTO users (email, password_hash, name, role, initials, color, is_admin) VALUES (?,?,?,?,?,?,?)',
                [$email, password_hash($defaultPassword, PASSWORD_DEFAULT), $name, $role, sp_make_initials($name), $color, $isAdmin]
            );
            $userIds[$name] = pm_last_id();
        }

        $projectIds = [];
        foreach ($projects as $i => [$name, $color, $key, $desc]) {
            pm_exec(
                'INSERT INTO projects (name, color, key_prefix, description, sort_order, slack_channel) VALUES (?,?,?,?,?,?)',
                [$name, $color, $key, $desc, $i, '#castle-tech']
            );
            $projectIds[$name] = pm_last_id();
        }

        $labelIds = [];
        foreach ($labelsGlobal as [$name, $color]) {
            pm_exec('INSERT INTO labels (name, color, project_id, archived) VALUES (?,?,NULL,0)', [$name, $color]);
            $labelIds[$name] = pm_last_id();
        }

        // Per-project labels so filtering feels realistic in every view.
        foreach ($projectIds as $pName => $pid) {
            foreach ([['Inspection', 'blue'], ['Parts Needed', 'amber']] as [$lname, $lcol]) {
                pm_exec('INSERT INTO labels (name, color, project_id, archived) VALUES (?,?,?,0)', [$lname, $lcol, $pid]);
                $labelIds[$pName . '::' . $lname] = pm_last_id();
            }
        }

        $taskSeqByProject = [];
        $taskIds = [];
        $allTaskIds = [];
        foreach ($taskBlueprints as $projectName => $tasks) {
            $pid = $projectIds[$projectName];
            $pKey = pm_fetch_one('SELECT key_prefix FROM projects WHERE id=?', [$pid])['key_prefix'] ?? 'CTT';
            $taskSeqByProject[$pid] = 100;

            foreach ($tasks as $idx => [$title, $desc, $status, $priority, $offset, $estimate, $taskLabels]) {
                $seq = ++$taskSeqByProject[$pid];
                $ref = sprintf('%s-%d', $pKey, $seq);
                $due = (new DateTimeImmutable('today'))->modify($offset)->format('Y-m-d');

                $creator = $userIds['Mike-admin'];
                pm_exec(
                    'INSERT INTO tasks (ref, project_id, status, title, description, priority, due, estimate, created_by)
                     VALUES (?,?,?,?,?,?,?,?,?)',
                    [$ref, $pid, $status, $title, $desc, $priority, $due, $estimate, $creator]
                );
                $tid = pm_last_id();
                $taskIds[$projectName][] = $tid;
                $allTaskIds[] = $tid;

                // Assignees: primary rotating + Seth on safety/compliance style work.
                $rotation = ['Dylan','Mars','Izze','Seth'];
                $primaryName = $rotation[$idx % count($rotation)];
                pm_exec('INSERT INTO task_assignees (task_id, user_id) VALUES (?,?)', [$tid, $userIds[$primaryName]]);
                if (in_array('Safety', $taskLabels, true) || in_array('Compliance', $taskLabels, true)) {
                    pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$tid, $userIds['Seth']]);
                }

                foreach ($taskLabels as $tl) {
                    if (isset($labelIds[$tl])) {
                        pm_exec('INSERT INTO task_labels (task_id, label_id) VALUES (?,?)', [$tid, $labelIds[$tl]]);
                    }
                }
                $projInspectionKey = $projectName . '::Inspection';
                if (isset($labelIds[$projInspectionKey])) {
                    pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)', [$tid, $labelIds[$projInspectionKey]]);
                }

                foreach (['Confirm lockout/tagout prep', 'Perform task and collect readings', 'Attach photos + closeout notes'] as $sidx => $sub) {
                    $done = $status === 'done' ? 1 : (($status === 'review' && $sidx < 2) ? 1 : 0);
                    pm_exec('INSERT INTO subtasks (task_id, text, done, sort_order) VALUES (?,?,?,?)', [$tid, $sub, $done, $sidx]);
                }

                pm_exec('INSERT INTO comments (task_id, user_id, body) VALUES (?,?,?)', [$tid, $userIds['Mike-admin'], 'Please prioritize before weekend traffic at Castle Fun Center in Chester, NY.']);
                pm_exec('INSERT INTO comments (task_id, user_id, body) VALUES (?,?,?)', [$tid, $userIds[$primaryName], 'Acknowledged. Parts/tools check in progress.']);

                pm_exec('INSERT INTO activity (user_id, task_id, action, detail) VALUES (?,?,?,?)', [$creator, $tid, 'created', 'Seeded initial task']);
                pm_exec('INSERT INTO activity (user_id, task_id, action, detail) VALUES (?,?,?,?)', [$userIds[$primaryName], $tid, 'assigned', 'Assigned in seed scenario']);
            }
        }

        // Recurring preventive maintenance task templates (one per major project).
        foreach ($projectIds as $pName => $pid) {
            $assignees = json_encode([$userIds['Dylan'], $userIds['Izze']]);
            $labels = json_encode(array_values(array_filter([
                $labelIds['Preventive'] ?? null,
                $labelIds[$pName . '::Inspection'] ?? null,
            ])));
            pm_exec(
                'INSERT INTO recurring_rules (project_id, title, description, priority, estimate, assignees, labels, cadence, interval_n, weekday, next_run, created_by)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                [
                    $pid,
                    'Weekly safety walkdown',
                    'Auto-generated PM walkthrough for ' . $pName,
                    2,
                    '2h',
                    $assignees,
                    $labels,
                    'weekly',
                    1,
                    1,
                    (new DateTimeImmutable('next monday'))->format('Y-m-d'),
                    $userIds['Mike-admin'],
                ]
            );
        }

        // Saved views for each user so list/dashboard/checklist demos look populated.
        foreach ($userIds as $name => $uid) {
            $favoriteProject = array_key_first($projectIds);
            $projectFilter = $projectIds[$favoriteProject];
            pm_exec(
                'INSERT INTO saved_views (user_id, name, view_key, filters_json, is_default) VALUES (?,?,?,?,1)',
                [$uid, 'My Open Items', 'checklist', json_encode(['project' => null, 'assignee' => $uid, 'labels' => [], 'search' => ''])]
            );
            pm_exec(
                'INSERT INTO saved_views (user_id, name, view_key, filters_json, is_default) VALUES (?,?,?,?,0)',
                [$uid, 'High Priority Ops', 'list', json_encode(['project' => $projectFilter, 'assignee' => null, 'labels' => [$labelIds['Urgent'] ?? 0], 'search' => ''])]
            );
        }

        // App-level settings and integration placeholders.
        $settings = [
            'app.name' => 'Castle Fun Center Tech Tasks',
            'slack.enabled' => '0',
            'slack.channel_default' => '#castle-tech',
            'slack.events' => json_encode([
                'task_created' => true,
                'task_completed' => true,
                'task_assigned' => true,
                'comment_added' => true,
                'project_archived' => false,
                'mention_added' => true,
            ]),
            'seed.generated_at' => gmdate('c'),
            'seed.notes' => 'Data modeled for attractions and maintenance flows at Castle Fun Center in Chester, NY.',
        ];
        foreach ($settings as $k => $v) {
            pm_exec('INSERT INTO app_settings (name, value) VALUES (?,?)', [$k, $v]);
        }

        $pdo->commit();

        return [
            'users' => count($userIds),
            'projects' => count($projectIds),
            'labels' => (int)(pm_fetch_one('SELECT COUNT(*) c FROM labels')['c'] ?? 0),
            'tasks' => count($allTaskIds),
            'recurring_rules' => (int)(pm_fetch_one('SELECT COUNT(*) c FROM recurring_rules')['c'] ?? 0),
            'comments' => (int)(pm_fetch_one('SELECT COUNT(*) c FROM comments')['c'] ?? 0),
            'subtasks' => (int)(pm_fetch_one('SELECT COUNT(*) c FROM subtasks')['c'] ?? 0),
            'saved_views' => (int)(pm_fetch_one('SELECT COUNT(*) c FROM saved_views')['c'] ?? 0),
            'default_password' => $defaultPassword,
        ];
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$errors) {
    if ($seedLocked) {
        $errors[] = 'Seeder is locked: an admin already exists. Sign in as an admin on login.html before re-running, or delete seed.php.';
    } else {
        $confirm = trim((string)($_POST['confirm_phrase'] ?? ''));
        if ($confirm !== 'SEED CASTLE DATA') {
            $errors[] = 'Confirmation phrase mismatch. Type exactly: SEED CASTLE DATA';
        } else {
            try {
                $summary = sp_seed_data();
                $ok[] = 'Database reseeded successfully.';
                // The TRUNCATE wiped the users table — including the admin we
                // were running as — so drop the now-stale session pointer.
                if (isset($_SESSION['uid'])) unset($_SESSION['uid']);
            } catch (Throwable $e) {
                $errors[] = 'Seed failed: ' . $e->getMessage();
            }
        }
    }
}
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seed Castle Data · Project Manager</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; background: #0b0f17; color: #e8ecf4; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.wrap { max-width: 900px; margin: 32px auto; padding: 0 16px; }
.card { background: #151b27; border: 1px solid #222b3b; border-radius: 12px; padding: 18px; margin-bottom: 16px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.sub { color: #8a94a8; margin: 0 0 14px; }
.warn, .ok, .err { border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; font-size: 14px; }
.warn { background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.35); color: #fcd34d; }
.ok { background: rgba(34,197,94,.1); border: 1px solid rgba(34,197,94,.35); color: #86efac; }
.err { background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.35); color: #fca5a5; }
input[type=text] { width: 100%; background:#1b2230; border:1px solid #2b354a; color:#e8ecf4; border-radius:8px; padding:10px 12px; }
button { margin-top: 12px; background:#3b82f6; border:0; color:#fff; border-radius:8px; padding:10px 16px; cursor:pointer; font-weight:600; }
button:hover { background:#60a5fa; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:#1b2230; padding:2px 6px; border-radius:4px; }
ul { margin: 8px 0 0; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 10px; }
.kpi { background:#1b2230; border:1px solid #2b354a; border-radius:8px; padding:10px; }
.kpi b { display:block; font-size: 20px; }
</style>
</head>
<body>
<div class="wrap">
    <div class="card">
        <h1>Castle Data Seeder</h1>
        <p class="sub">This resets and repopulates users, projects, labels, tasks, subtasks, assignees, comments, activity, recurring rules, saved views, and app settings in one click.</p>
        <div class="warn"><strong>Danger:</strong> This script truncates most application tables before reseeding. Use on staging/new installs only, or backup first.</div>
        <div class="warn">Default seeded login password for all users: <code>CastleSeed!2026</code></div>

        <?php if ($seedLocked): ?>
        <div class="err"><strong>Seeder locked.</strong> An admin account already exists in this database, so the seeder will not run. <a href="login.html">Sign in as an admin</a> first if you really want to wipe and reseed, or — better — delete <code>seed.php</code> from the server.</div>
        <?php elseif ($tablesReady && $currentAdmin): ?>
        <div class="warn">Signed in as admin <strong><?= htmlspecialchars($currentAdmin['name'] ?? 'admin') ?></strong>. Reseeding will sign you out (your user row is recreated from the seed dataset).</div>
        <?php elseif (!$tablesReady): ?>
        <div class="warn">No users table found. Run <a href="install.php"><code>install.php</code></a> first; the seeder needs the schema in place before it can populate it.</div>
        <?php endif; ?>

        <?php foreach ($errors as $e): ?><div class="err"><?= htmlspecialchars($e) ?></div><?php endforeach; ?>
        <?php foreach ($ok as $m): ?><div class="ok"><?= htmlspecialchars($m) ?></div><?php endforeach; ?>

        <?php if (!$seedLocked): ?>
        <form method="post">
            <label for="confirm_phrase">Type <code>SEED CASTLE DATA</code> to confirm destructive reset:</label>
            <input id="confirm_phrase" name="confirm_phrase" type="text" required autocomplete="off" placeholder="SEED CASTLE DATA">
            <button type="submit"<?= $tablesReady ? '' : ' disabled style="opacity:.5;cursor:not-allowed"' ?>>Reset + Seed Database</button>
        </form>
        <?php endif; ?>
    </div>

    <div class="card">
        <h2>Seed profile</h2>
        <ul>
            <li>Users: Mike-admin (Admin), Dylan (Tech Manager), Mars (Asst Tech Manager), Seth + Izze (Arcade Technicians)</li>
            <li>Projects: Arcade, Roller Rink, HVAC, InflataPark/Ballocity, Bowling, Axe Throwing, Go Karts/Outdoor, Laser Tag</li>
            <li>Task mix: todo, in progress, review, backlog, done</li>
            <li>Location context: Castle Fun Center, Chester, NY</li>
            <li>Includes recurring weekly PM rules + saved views for each user</li>
        </ul>
    </div>

    <?php if ($summary): ?>
    <div class="card">
        <h2>Last seed result</h2>
        <div class="grid">
            <?php foreach ($summary as $k => $v): ?>
                <div class="kpi"><small><?= htmlspecialchars((string)$k) ?></small><b><?= htmlspecialchars((string)$v) ?></b></div>
            <?php endforeach; ?>
        </div>
    </div>
    <?php endif; ?>
</div>
</body>
</html>
