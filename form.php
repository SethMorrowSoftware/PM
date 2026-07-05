<?php
// Public intake form: /form.php?f=<token>
// Lets anyone with the link (no account) file a request into the form's
// project. Defense: capability token, per-IP + per-form rate limits, honeypot
// field, hard length caps. Created tasks are attributed in the description and
// the activity log; default assignees get an in-app + email notification.
require_once __DIR__ . '/api/bootstrap.php';
if (is_file(__DIR__ . '/api/notify_lib.php')) require_once __DIR__ . '/api/notify_lib.php';

$token = isset($_GET['f']) ? (string)$_GET['f'] : '';
$form = null; $project = null; $err = ''; $created = null;

if (preg_match('/^[a-f0-9]{32,64}$/', $token)) {
    try {
        $form = pm_fetch_one('SELECT * FROM intake_forms WHERE token = ? AND enabled = 1', [$token]);
        if ($form) $project = pm_fetch_one('SELECT * FROM projects WHERE id = ?', [(int)$form['project_id']]);
    } catch (Throwable $_) { /* render the not-found card below */ }
}
if ($form && !$project) $form = null;

if ($form && ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '0';
    $title    = mb_substr(trim((string)($_POST['title'] ?? '')), 0, 500);
    $details  = mb_substr(trim((string)($_POST['details'] ?? '')), 0, 5000);
    $reporter = mb_substr(trim((string)($_POST['reporter'] ?? '')), 0, 120);
    $honeypot = trim((string)($_POST['website'] ?? ''));   // bots fill this; humans never see it

    if ($honeypot !== '') {
        $created = 'REQ-SPAM'; // pretend success; don't create anything
    } elseif ($title === '') {
        $err = 'Please describe the problem in the title field.';
    } elseif ($reporter === '') {
        $err = 'Please add your name so the team can follow up.';
    } elseif (!pm_rate_limit('intake-ip:' . $ip, 10, 3600) || !pm_rate_limit('intake-form:' . $form['id'], 40, 3600)) {
        $err = 'Too many submissions right now — please try again in a little while.';
    } else {
        try {
            $projectId = (int)$form['project_id'];
            $prefix = $project['key_prefix'] ?: 'PRJ';
            $desc = $details !== '' ? $details : null;
            $suffix = "\n\n— Submitted by " . $reporter . ' via intake form "' . $form['name'] . '"';
            $desc = ($desc ?? '') . $suffix;

            $posRow = pm_fetch_one(
                "SELECT COALESCE(MAX(position),0) AS m FROM tasks WHERE project_id = ? AND status = 'todo'",
                [$projectId]);
            $position = (float)($posRow['m'] ?? 0) + 1;

            // Same retry-on-23000 ref loop as tasks.php (two writers can race MAX+1).
            $tid = null; $attempts = 0;
            while (true) {
                $maxRow = pm_fetch_one(
                    "SELECT MAX(CAST(SUBSTRING_INDEX(ref,'-',-1) AS UNSIGNED)) AS m FROM tasks WHERE ref LIKE ?",
                    [$prefix . '-%']);
                $n = max(100, ((int)($maxRow['m'] ?? 0)) + 1);
                try {
                    pm_exec(
                        'INSERT INTO tasks (ref, project_id, status, title, description, priority, position, created_by)
                         VALUES (?,?,?,?,?,?,?,?)',
                        [$prefix . '-' . $n, $projectId, 'todo', $title, $desc,
                         (int)$form['default_priority'], $position, $form['created_by'] ?: null]);
                    $tid = pm_last_id();
                    $created = $prefix . '-' . $n;
                    break;
                } catch (PDOException $e) {
                    if ($e->getCode() !== '23000' || ++$attempts >= 5) throw $e;
                    usleep(random_int(1000, 5000));
                }
            }

            if (!empty($form['default_label_id'])) {
                pm_exec('INSERT IGNORE INTO task_labels (task_id, label_id) VALUES (?,?)',
                    [$tid, (int)$form['default_label_id']]);
            }
            $assignees = json_decode((string)($form['default_assignees'] ?? ''), true) ?: [];
            foreach ($assignees as $a) {
                pm_exec('INSERT IGNORE INTO task_assignees (task_id, user_id) VALUES (?,?)', [$tid, (int)$a]);
            }
            pm_exec('UPDATE intake_forms SET submissions = submissions + 1 WHERE id = ?', [(int)$form['id']]);
            pm_exec('INSERT INTO activity (user_id, task_id, action, detail) VALUES (?,?,?,?)',
                [(int)($form['created_by'] ?: 0), $tid, 'intake',
                 'Submitted by ' . $reporter . ' via form "' . $form['name'] . '"']);
            if (function_exists('pm_notify_users')) {
                $targets = $assignees;
                if (!$targets) { // nobody preset — tell the admins
                    foreach (pm_fetch_all('SELECT id FROM users WHERE is_admin = 1') as $r) $targets[] = (int)$r['id'];
                }
                pm_notify_users($targets, null, $tid, 'intake',
                    $created . ' ' . $title . ' — reported by ' . $reporter);
            }
        } catch (Throwable $e) {
            $err = 'Something went wrong saving your request. Please try again.';
            $created = null;
        }
    }
}

function fe($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; base-uri 'self'; form-action 'self'; object-src 'none'">
<title><?= $form ? fe($form['name']) : 'Form not found' ?> · Castle Tech Tasks</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/app.css?v=29">
<link rel="stylesheet" href="assets/css/auth.css?v=29">
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<script>try{var t=localStorage.getItem('pm_theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}</script>
<style>
.hp-field{position:absolute;left:-9999px;top:-9999px;opacity:0;height:0;overflow:hidden}
/* auth.css only styles .field input — give the textarea the same treatment */
.field textarea{width:100%;background:var(--bg-3);border:1px solid var(--line-2);border-radius:8px;
  padding:9px 11px;color:var(--fg-0);outline:none;font-size:13.5px;font-family:inherit;resize:vertical;
  transition:border-color 0.12s, box-shadow 0.12s;box-sizing:border-box}
.field textarea:focus{border-color:var(--acc-border);box-shadow:0 0 0 3px var(--acc-soft)}
</style>
</head>
<body class="auth-body">
<div class="auth-card" style="max-width:520px">
    <div class="auth-brand">
        <div class="brand-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px">
                <path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-7h6v7"/><path d="M3 10h4M17 10h4M3 15h4M17 15h4"/>
            </svg>
        </div>
        <div>
            <div class="brand-name">Castle Tech Tasks</div>
            <div class="brand-sub">report an issue</div>
        </div>
    </div>

    <?php if (!$form): ?>
        <h1>Form not available</h1>
        <p class="sub">This link is invalid or the form has been turned off. Ask a Castle Tech admin for a current link.</p>

    <?php elseif ($created): ?>
        <h1>Thanks<?= $reporter !== '' ? ', ' . fe(explode(' ', $reporter)[0]) : '' ?>!</h1>
        <p class="sub">Your request is in the queue as <strong style="font-family:var(--font-mono)"><?= fe($created) ?></strong>.
        The tech team has been notified.</p>
        <a class="btn btn-primary" href="form.php?f=<?= fe($token) ?>" style="display:inline-flex">Report another issue</a>

    <?php else: ?>
        <h1><?= fe($form['name']) ?></h1>
        <p class="sub"><?= $form['description'] !== null && $form['description'] !== ''
            ? fe($form['description'])
            : 'Spotted a problem? Describe it below and it goes straight onto the tech team\'s board.' ?></p>

        <?php if ($err): ?><div class="auth-err" role="alert"><?= fe($err) ?></div><?php endif; ?>

        <form method="post" action="form.php?f=<?= fe($token) ?>">
            <div class="hp-field" aria-hidden="true">
                <label>Leave this empty<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
            </div>
            <div class="field">
                <label for="reporter">Your name</label>
                <input id="reporter" name="reporter" type="text" required maxlength="120"
                       value="<?= fe($_POST['reporter'] ?? '') ?>" placeholder="e.g. Jamie at the info booth">
            </div>
            <div class="field">
                <label for="title">What's the problem?</label>
                <input id="title" name="title" type="text" required maxlength="500"
                       value="<?= fe($_POST['title'] ?? '') ?>" placeholder="e.g. Skee-Ball lane 3 not counting points">
            </div>
            <div class="field">
                <label for="details">Details (optional)</label>
                <textarea id="details" name="details" rows="4" maxlength="5000"
                          placeholder="Where is it, what's it doing, since when?"><?= fe($_POST['details'] ?? '') ?></textarea>
            </div>
            <button class="btn btn-primary" type="submit">Send to the tech team</button>
        </form>
    <?php endif; ?>
</div>
</body>
</html>
