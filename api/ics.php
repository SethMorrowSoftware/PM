<?php
// Personal iCalendar feed: subscribe from Google/Apple/Outlook calendar so
// task due dates show up next to real-world appointments.
//
//   GET  ics.php?t=<token>      PUBLIC — the feed itself (token = capability).
//   GET  ics.php?action=mine    auth — return (minting if needed) my feed URL.
//   POST ics.php?action=reset   auth — rotate my token (old URL stops working).
//
// The feed is read-only and only exposes the token owner's open, due-dated
// tasks. Tokens are 48 hex chars minted from random_bytes.

require_once __DIR__ . '/bootstrap.php';
if (is_file(__DIR__ . '/mail_lib.php')) require_once __DIR__ . '/mail_lib.php'; // pm_app_url

// ---------- public feed (no session; the token IS the auth) ----------------
$feedToken = isset($_GET['t']) ? (string)$_GET['t'] : '';
if ($feedToken !== '') {
    if (!preg_match('/^[a-f0-9]{32,64}$/', $feedToken)) { http_response_code(404); exit('Not found'); }
    // Light rate limit so the endpoint can't be brute-forced for tokens.
    if (function_exists('pm_rate_limit')) {
        $ip = $_SERVER['REMOTE_ADDR'] ?? '0';
        if (!pm_rate_limit('ics:' . $ip, 60, 3600)) { http_response_code(429); exit('Too many requests'); }
    }
    $user = pm_fetch_one('SELECT id, name FROM users WHERE ics_token = ?', [$feedToken]);
    if (!$user) { http_response_code(404); exit('Not found'); }

    $rows = pm_fetch_all(
        "SELECT t.id, t.ref, t.title, t.due, t.start_date, t.status, t.priority, p.name AS project
           FROM tasks t
           JOIN task_assignees ta ON ta.task_id = t.id
           LEFT JOIN projects p ON p.id = t.project_id
          WHERE ta.user_id = ? AND t.status <> 'done' AND t.due IS NOT NULL
          ORDER BY t.due LIMIT 500",
        [(int)$user['id']]
    );

    $esc = function ($s) {
        $s = (string)$s;
        $s = str_replace(['\\', ';', ','], ['\\\\', '\\;', '\\,'], $s);
        return str_replace(["\r\n", "\n", "\r"], '\\n', $s);
    };
    $fold = function ($line) { // RFC 5545: fold lines longer than 75 octets
        $out = '';
        while (strlen($line) > 73) { $out .= substr($line, 0, 73) . "\r\n "; $line = substr($line, 73); }
        return $out . $line . "\r\n";
    };
    $host = preg_replace('/:\d+$/', '', (string)($_SERVER['HTTP_HOST'] ?? 'castle-tasks'));
    $app  = function_exists('pm_app_url') ? pm_app_url() : '';
    $stamp = gmdate('Ymd\THis\Z');
    $prio = ['Urgent', 'High', 'Medium', 'Low'];

    $ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Castle Tech Tasks//EN\r\n"
         . "CALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n"
         . $fold('X-WR-CALNAME:' . $esc('Castle Tech Tasks — ' . $user['name']));
    foreach ($rows as $r) {
        $due = (string)$r['due'];
        $d0  = str_replace('-', '', $due);
        $d1  = date('Ymd', strtotime($due . ' +1 day'));
        $ics .= "BEGIN:VEVENT\r\n"
              . 'UID:pm-task-' . (int)$r['id'] . '@' . $host . "\r\n"
              . 'DTSTAMP:' . $stamp . "\r\n"
              . 'DTSTART;VALUE=DATE:' . $d0 . "\r\n"
              . 'DTEND;VALUE=DATE:' . $d1 . "\r\n"
              . $fold('SUMMARY:' . $esc('[' . $r['ref'] . '] ' . $r['title']))
              . $fold('DESCRIPTION:' . $esc(
                    ($r['project'] ? 'Project: ' . $r['project'] . "\n" : '')
                    . 'Priority: ' . ($prio[(int)$r['priority']] ?? 'Medium')
                    . ($r['start_date'] ? "\nStarts: " . $r['start_date'] : '')))
              . ($app ? $fold('URL:' . $esc($app . '/index.html#task=' . (int)$r['id'])) : '')
              . "END:VEVENT\r\n";
    }
    $ics .= "END:VCALENDAR\r\n";

    header('Content-Type: text/calendar; charset=utf-8');
    header('Content-Disposition: inline; filename="castle-tasks.ics"');
    header('Cache-Control: private, max-age=300');
    header('X-Content-Type-Options: nosniff');
    echo $ics;
    exit;
}

// ---------- token management (signed-in user) --------------------------------
pm_boot();
$uid = pm_require_auth();
$action = isset($_GET['action']) ? (string)$_GET['action'] : '';

function pm_ics_url_for(string $token): string {
    $base = function_exists('pm_app_url') ? pm_app_url() : '';
    return $base . '/api/ics.php?t=' . $token;
}

if (pm_method() === 'GET' && $action === 'mine') {
    $u = pm_fetch_one('SELECT ics_token FROM users WHERE id = ?', [$uid]);
    $token = $u['ics_token'] ?? null;
    if (!$token) {
        $token = bin2hex(random_bytes(24));
        pm_exec('UPDATE users SET ics_token = ? WHERE id = ?', [$token, $uid]);
    }
    pm_json(['url' => pm_ics_url_for($token)]);
}

if (pm_method() === 'POST' && $action === 'reset') {
    $token = bin2hex(random_bytes(24));
    pm_exec('UPDATE users SET ics_token = ? WHERE id = ?', [$token, $uid]);
    pm_json(['url' => pm_ics_url_for($token)]);
}

pm_error('Method not allowed', 405);
