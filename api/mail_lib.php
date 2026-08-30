<?php
// Best-effort email delivery for notifications and the morning digest.
// cPanel hosts route PHP mail() through the local MTA, so there is nothing to
// configure for the common case. Every function here is fail-silent: email
// must never break the request that triggered it.
//
// Optional api/config.php keys (all have safe defaults):
//   'email_enabled'  => true,          // set false to disable all email
//   'mail_from'      => '',            // default: noreply@<host>
//   'app_url'        => '',            // absolute base URL for links in emails;
//                                      // default: derived from the request
//   'mail_debug_dir' => '',            // if set, write .eml files instead of
//                                      // sending (for local testing)
//   'digest_hour'    => 7,             // earliest hour (0-23) for the morning
//                                      // digest. PHP is pinned to UTC, so this
//                                      // is a UTC hour — e.g. a 7am US-Eastern
//                                      // digest needs 11 (EDT) / 12 (EST).

require_once __DIR__ . '/db.php';

function pm_mail_enabled(): bool {
    try { $c = pm_config(); } catch (Throwable $_) { return false; }
    return !array_key_exists('email_enabled', $c) || !empty($c['email_enabled']);
}

function pm_mail_from(): string {
    $c = pm_config();
    if (!empty($c['mail_from'])) return (string)$c['mail_from'];
    $host = preg_replace('/:\d+$/', '', (string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    return 'noreply@' . ($host !== '' ? $host : 'localhost');
}

/** Absolute base URL of the app (no trailing slash), for links inside emails. */
function pm_app_url(): string {
    $c = pm_config();
    if (!empty($c['app_url'])) return rtrim((string)$c['app_url'], '/');
    $https = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    $host  = (string)($_SERVER['HTTP_HOST'] ?? 'localhost');
    // API endpoints live one level below the app root.
    $base  = str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/')));
    $base  = preg_replace('#/api$#', '', $base);
    if ($base === '/' || $base === '.') $base = '';
    return ($https ? 'https' : 'http') . '://' . $host . $base;
}

/** Send one plain-text email. Fail-silent by design. */
function pm_send_mail(string $to, string $subject, string $bodyText, ?string $link = null): void {
    try {
        if (!pm_mail_enabled()) return;
        if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) return;
        $body = $bodyText;
        if ($link) $body .= "\n\nOpen: " . $link;
        $body .= "\n\n--\nCastle Tech Tasks · manage email preferences under Profile";
        $from = pm_mail_from();
        $headers = 'From: Castle Tech Tasks <' . $from . ">\r\n"
                 . "Content-Type: text/plain; charset=UTF-8\r\n"
                 . 'X-Mailer: castle-tech-tasks';
        $c = pm_config();
        if (!empty($c['mail_debug_dir'])) {
            // Test hook: capture instead of sending.
            @mkdir($c['mail_debug_dir'], 0700, true);
            @file_put_contents(
                rtrim($c['mail_debug_dir'], '/') . '/' . str_replace('.', '', (string)microtime(true))
                    . '-' . preg_replace('/[^a-zA-Z0-9]+/', '_', $to) . '.eml',
                "To: {$to}\r\nSubject: {$subject}\r\n{$headers}\r\n\r\n{$body}"
            );
            return;
        }
        @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, $headers);
    } catch (Throwable $_) { /* never break a request over email */ }
}

/**
 * Mirror an in-app notification to email, honoring the user's preference
 * (users.email_notifs: 'all' | 'mentions' | 'none'). Called from pm_notify().
 */
function pm_mail_notification(int $userId, string $type, string $body, ?int $taskId): void {
    try {
        $u = pm_fetch_one('SELECT email, email_notifs FROM users WHERE id = ?', [$userId]);
        if (!$u || empty($u['email'])) return;
        $pref = $u['email_notifs'] ?? 'all';
        if ($pref === 'none') return;
        if ($pref === 'mentions' && $type !== 'mention') return;
        $subjects = [
            'assigned'  => 'You were assigned a task',
            'mention'   => 'You were mentioned',
            'comment'   => 'New comment on a task you follow',
            'due_soon'  => 'Task due soon',
            'reminder'  => 'Task reminder',
            'intake'    => 'New request submitted',
            'automation'=> 'Automation update',
        ];
        $subject = ($subjects[$type] ?? 'Notification') . ' · Castle Tech Tasks';
        $link = $taskId ? pm_app_url() . '/index.html#task=' . $taskId : null;
        pm_send_mail((string)$u['email'], $subject, $body, $link);
    } catch (Throwable $_) { /* best effort */ }
}

/** Earliest UTC hour the digest may send (config 'digest_hour', default 7). */
function pm_mail_digest_hour(): int {
    try { $c = pm_config(); } catch (Throwable $_) { return 7; }
    $h = (int)($c['digest_hour'] ?? 7);
    return ($h >= 0 && $h <= 23) ? $h : 7;
}

/**
 * Morning digest: once per user per day (after the configured digest hour —
 * see 'digest_hour' above), email a short summary of overdue + due-today
 * tasks. Driven from pm_run_due_sweep() — no cron needed. Users with
 * email_notifs != 'all' are skipped.
 */
function pm_mail_run_digests(): void {
    try {
        if (!pm_mail_enabled() || (int)date('G') < pm_mail_digest_hour()) return;
        $users = pm_fetch_all(
            "SELECT id, email, name FROM users
             WHERE COALESCE(email_notifs,'all') = 'all'
               AND (last_digest IS NULL OR last_digest < CURDATE())
             LIMIT 50"
        );
        foreach ($users as $u) {
            $uid = (int)$u['id'];
            // Claim atomically so two concurrent sweeps can't double-send.
            $claimed = pm_exec(
                'UPDATE users SET last_digest = CURDATE()
                 WHERE id = ? AND (last_digest IS NULL OR last_digest < CURDATE())', [$uid]);
            if ($claimed < 1) continue;
            $rows = pm_fetch_all(
                "SELECT t.ref, t.title, t.due FROM tasks t
                 JOIN task_assignees ta ON ta.task_id = t.id
                 WHERE ta.user_id = ? AND t.status <> 'done' AND t.due IS NOT NULL
                   AND t.due <= CURDATE() ORDER BY t.due LIMIT 30", [$uid]);
            if (!$rows) continue; // nothing actionable — no noise
            $overdue = array_filter($rows, fn ($r) => $r['due'] < date('Y-m-d'));
            $today   = array_filter($rows, fn ($r) => $r['due'] === date('Y-m-d'));
            $lines = ['Good morning ' . (explode(' ', (string)$u['name'])[0] ?? '') . ' — your day at a glance:'];
            if ($today) {
                $lines[] = "\nDue today:";
                foreach ($today as $r) $lines[] = '  • ' . $r['ref'] . ' ' . $r['title'];
            }
            if ($overdue) {
                $lines[] = "\nOverdue:";
                foreach ($overdue as $r) $lines[] = '  • ' . $r['ref'] . ' ' . $r['title'] . ' (was due ' . $r['due'] . ')';
            }
            pm_send_mail((string)$u['email'],
                'Daily digest: ' . count($today) . ' due today, ' . count($overdue) . ' overdue · Castle Tech Tasks',
                implode("\n", $lines), pm_app_url() . '/index.html');
        }
    } catch (Throwable $_) { /* best effort */ }
}
