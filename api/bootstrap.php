<?php
// Shared bootstrap: starts session, parses JSON body, auth helpers, JSON responders.

require_once __DIR__ . '/db.php';

function pm_boot(): void {
    $c = pm_config();
    if (session_status() === PHP_SESSION_NONE) {
        session_name($c['session_name']);
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'secure'   => !empty($c['cookie_secure']),
            'httponly' => true,
            'samesite' => $c['cookie_samesite'] ?? 'Lax',
        ]);
        session_start();
    }
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    // Minimal hardening appropriate for JSON API responses. No CSP here —
    // it's delivered by the static HTML shells — but clickjacking/referrer
    // protection costs nothing and the API never intentionally renders HTML.
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    if (!empty($c['cookie_secure'])) {
        header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    }
    pm_csrf_check();
}

// Defense-in-depth CSRF guard. SameSite=Lax already blocks most cross-site
// POSTs; this rejects mutating requests whose Origin/Referer host clearly does
// not match the host we're served on. It is deliberately LENIENT: if neither
// header is present (some legitimate same-origin clients omit them) we allow,
// so this never breaks first-party use or the installer's form posts.
function pm_csrf_check(): void {
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if (in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) return;
    $host = $_SERVER['HTTP_HOST'] ?? '';
    if ($host === '') return;
    $candidate = $_SERVER['HTTP_ORIGIN'] ?? $_SERVER['HTTP_REFERER'] ?? '';
    if ($candidate === '') return; // lenient: no header to check
    $h = parse_url($candidate, PHP_URL_HOST);
    if ($h === null || $h === false) return;
    // Compare hosts (ignore port differences which proxies sometimes rewrite).
    $hostOnly = preg_replace('/:\d+$/', '', $host);
    if (strcasecmp($h, $hostOnly) !== 0) {
        pm_error('Cross-origin request blocked', 403);
    }
}

// Lightweight file-based rate limiter (no schema, no cron). Returns true if the
// caller is still under the limit (and records this attempt), false if blocked.
// Best-effort: any I/O problem fails OPEN so we never lock out real users.
function pm_rate_limit(string $key, int $max, int $window): bool {
    try {
        $dir = __DIR__ . '/../storage/ratelimit';
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        $file = $dir . '/' . sha1($key) . '.json';
        $now = time();
        $fp = @fopen($file, 'c+');
        if (!$fp) return true;
        @flock($fp, LOCK_EX);
        $raw = stream_get_contents($fp);
        $j = json_decode($raw ?: '', true);
        $data = (is_array($j) && isset($j['reset']) && (int)$j['reset'] > $now)
            ? $j : ['count' => 0, 'reset' => $now + $window];
        $data['count'] = (int)$data['count'] + 1;
        $allowed = $data['count'] <= $max;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, json_encode($data));
        @flock($fp, LOCK_UN);
        fclose($fp);
        return $allowed;
    } catch (Throwable $_) {
        return true;
    }
}

// Best-effort client IP for throttling keys.
function pm_client_ip(): string {
    return (string)($_SERVER['REMOTE_ADDR'] ?? 'cli');
}

function pm_method(): string {
    return $_SERVER['REQUEST_METHOD'] ?? 'GET';
}

function pm_body(): array {
    static $body = null;
    if ($body !== null) return $body;
    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') return $body = [];
    $j = json_decode($raw, true);
    return $body = (is_array($j) ? $j : []);
}

function pm_json($data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function pm_error(string $msg, int $status = 400): void {
    pm_json(['error' => $msg], $status);
}

function pm_current_user_id(): ?int {
    return isset($_SESSION['uid']) ? (int)$_SESSION['uid'] : null;
}

function pm_require_auth(): int {
    $uid = pm_current_user_id();
    if (!$uid) pm_error('Not authenticated', 401);
    return $uid;
}

function pm_current_user(): ?array {
    $uid = pm_current_user_id();
    if (!$uid) return null;
    return pm_fetch_one(
        'SELECT id, email, name, role, initials, color, is_admin FROM users WHERE id = ?',
        [$uid]
    );
}

function pm_require_admin(): array {
    $u = pm_current_user();
    if (!$u) pm_error('Not authenticated', 401);
    if (empty($u['is_admin'])) pm_error('Admin only', 403);
    return $u;
}

function pm_param(string $key, $default = null) {
    if (array_key_exists($key, $_GET)) return $_GET[$key];
    $b = pm_body();
    return $b[$key] ?? $default;
}

function pm_int_param(string $key, ?int $default = null): ?int {
    $v = pm_param($key, $default);
    return $v === null || $v === '' ? $default : (int)$v;
}

// Return an HTML-safe user display shape (for responses).
function pm_public_user(array $row): array {
    return [
        'id'       => (int)$row['id'],
        'name'     => $row['name'],
        'role'     => $row['role'],
        'initials' => $row['initials'],
        'color'    => $row['color'],
        'email'    => $row['email'] ?? null,
        'is_admin' => !empty($row['is_admin']),
    ];
}
