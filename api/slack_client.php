<?php
// Slack Web API helper. All sends are non-blocking: failures are logged into
// app_settings (slack.last_error) so admins can see status, and return false
// instead of bubbling exceptions that would break user writes.

require_once __DIR__ . '/settings.php';

function pm_slack_settings(): array {
    $defaults = [
        'enabled'         => false,
        'bot_token'       => '',
        'default_channel' => '',
        'events'          => [
            'task_completed'  => true,
            'task_created'    => false,
            'task_assigned'   => false,
            'comment_added'   => true,
            'project_archived'=> false,
            'mention_added'   => false,
        ],
        'templates'       => [],
        'delivery_history' => [],
        'last_ok_at'      => null,
        'last_error'      => null,
        'last_error_at'   => null,
    ];
    $stored = pm_setting_get('slack', []);
    if (!is_array($stored)) $stored = [];
    return array_replace_recursive($defaults, $stored);
}

function pm_slack_is_enabled(): bool {
    $s = pm_slack_settings();
    return !empty($s['enabled']) && !empty($s['bot_token']);
}

function pm_slack_event_on(string $event): bool {
    $s = pm_slack_settings();
    return !empty($s['enabled']) && !empty($s['bot_token']) && !empty($s['events'][$event]);
}

// Resolve the channel to post into: explicit override > project override > default.
function pm_slack_channel_for_project(?array $project = null): string {
    $s = pm_slack_settings();
    if ($project && !empty($project['slack_channel'])) return (string)$project['slack_channel'];
    return (string)($s['default_channel'] ?? '');
}

// Non-blocking: returns true on OK, false on any failure. Stores last error.
function pm_slack_post(string $channel, string $text, array $opts = []): bool {
    if ($channel === '') {
        pm_slack_note_error('No channel configured');
        return false;
    }
    $s = pm_slack_settings();
    $token = (string)($s['bot_token'] ?? '');
    if ($token === '') {
        pm_slack_note_error('No bot token configured');
        return false;
    }
    $eventKey = (string)($opts['event_key'] ?? 'generic');
    unset($opts['event_key']);
    $payload = array_merge([
        'channel' => $channel,
        'text'    => $text,
    ], $opts);
    // Release the PHP session lock BEFORE the network round-trip. Slack sends run
    // inline on user writes; the default file session handler holds an exclusive
    // lock for the whole request, so without this a slow/unreachable Slack would
    // serialize every OTHER concurrent request from the same user (poll,
    // navigation) behind this call. Nothing below writes to $_SESSION.
    if (session_status() === PHP_SESSION_ACTIVE) { @session_write_close(); }
    // Bounded budget so a Slack outage adds at most a few seconds of latency to a
    // (already-succeeded) write: 2 attempts, short timeouts. The message is
    // best-effort — failures are logged to app_settings, not surfaced as errors.
    $maxAttempts = 2;
    $attempts = 0;
    $lastErr = '';
    while ($attempts < $maxAttempts) {
        $attempts++;
        $ch = curl_init('https://slack.com/api/chat.postMessage');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 3,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_HTTPHEADER     => [
                'Authorization: Bearer ' . $token,
                'Content-Type: application/json; charset=utf-8',
            ],
            CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
        ]);
        $body = curl_exec($ch);
        $err  = curl_error($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body === false) {
            $lastErr = 'Network error: ' . ($err ?: "HTTP $code");
            if ($attempts < $maxAttempts) usleep(100000 * $attempts);
            continue;
        }
        $decoded = json_decode((string)$body, true);
        $ok = is_array($decoded) && !empty($decoded['ok']);
        if ($ok) {
            pm_slack_note_ok();
            pm_slack_log_delivery($eventKey, $channel, true, null);
            return true;
        }
        $apiErr = is_array($decoded) ? ($decoded['error'] ?? 'Unknown Slack error') : 'Invalid response';
        $lastErr = 'Slack API: ' . $apiErr;
        $retryable = $code >= 500 || $code === 429 || in_array($apiErr, ['ratelimited','internal_error','fatal_error'], true);
        if (!$retryable || $attempts >= $maxAttempts) break;
        usleep(100000 * $attempts);
    }
    pm_slack_note_error($lastErr ?: 'Unknown error');
    pm_slack_log_delivery($eventKey, $channel, false, $lastErr ?: 'Unknown error');
    return false;
}

function pm_slack_note_error(string $msg): void {
    try {
        $s = pm_slack_settings();
        $s['last_error']    = mb_substr($msg, 0, 400);
        $s['last_error_at'] = date('Y-m-d H:i:s');
        pm_setting_set('slack', $s);
    } catch (Throwable $_) { /* ignore */ }
}

function pm_slack_note_ok(): void {
    try {
        $s = pm_slack_settings();
        $s['last_ok_at']  = date('Y-m-d H:i:s');
        $s['last_error']  = null;
        $s['last_error_at'] = null;
        pm_setting_set('slack', $s);
    } catch (Throwable $_) { /* ignore */ }
}

// Build the standard "task" Slack line. Caller provides the action verb.
function pm_slack_format_task(array $task, string $verb, ?array $actor = null, ?array $project = null, ?string $extra = null): string {
    $proj   = $project ? "[{$project['name']}] " : '';
    $ref    = $task['ref'] ?? ('#' . (int)($task['id'] ?? 0));
    $title  = $task['title'] ?? '';
    $who    = $actor ? ($actor['name'] ?? 'Someone') : 'Someone';
    $base   = "{$proj}*{$ref}* {$title}\n{$who} {$verb}";
    if ($extra !== null && $extra !== '') $base .= "\n> " . mb_substr($extra, 0, 400);
    return $base;
}

function pm_slack_log_delivery(string $event, string $channel, bool $ok, ?string $error): void {
    try {
        $s = pm_slack_settings();
        $history = is_array($s['delivery_history'] ?? null) ? $s['delivery_history'] : [];
        array_unshift($history, [
            'event' => $event,
            'channel' => $channel,
            'ok' => $ok,
            'error' => $error ? mb_substr($error, 0, 200) : null,
            'at' => date('Y-m-d H:i:s'),
        ]);
        $s['delivery_history'] = array_slice($history, 0, 30);
        pm_setting_set('slack', $s);
    } catch (Throwable $_) { /* ignore */ }
}

function pm_slack_render_event_text(string $event, array $vars, string $fallback): string {
    $s = pm_slack_settings();
    $tmpl = (string)($s['templates'][$event] ?? '');
    if ($tmpl === '') return $fallback;
    $out = $tmpl;
    foreach ($vars as $k => $v) {
        $out = str_replace('{' . $k . '}', (string)$v, $out);
    }
    return $out;
}
