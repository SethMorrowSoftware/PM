<?php
require_once __DIR__ . '/bootstrap.php';
pm_boot();

$action = $_GET['action'] ?? '';

switch ($action) {
    case 'me':
        $u = pm_current_user();
        $cfg = pm_config();
        // pm_current_user() returns a fixed column set; the v3 extras (running
        // timer, email preference) are fetched here. try/catch keeps 'me'
        // working on installs that haven't run the v3 migration yet.
        $timer = null; $emailPref = null;
        if ($u) {
            try {
                $extra = pm_fetch_one(
                    'SELECT email_notifs, timer_task_id, timer_started_at FROM users WHERE id = ?',
                    [(int)$u['id']]);
                $emailPref = $extra['email_notifs'] ?? 'all';
                if ($extra && !empty($extra['timer_task_id']) && !empty($extra['timer_started_at'])) {
                    $tt = pm_fetch_one('SELECT id, ref, title FROM tasks WHERE id = ?', [(int)$extra['timer_task_id']]);
                    if ($tt) $timer = ['task_id' => (int)$tt['id'], 'ref' => $tt['ref'], 'title' => $tt['title'],
                                       'started_at' => $extra['timer_started_at']];
                }
            } catch (Throwable $_) { $emailPref = 'all'; }
        }
        pm_json([
            'user' => $u ? pm_public_user($u) : null,
            'allow_public_register' => !empty($cfg['allow_public_register']),
            'timer' => $timer,
            'email_notifs' => $emailPref,
        ]);

    case 'login': {
        if (pm_method() !== 'POST') pm_error('POST required', 405);
        // Match register's case-folding so 'Foo@bar.com' and 'foo@bar.com'
        // always land on the same row regardless of the DB column collation.
        $email = strtolower(trim((string)pm_param('email', '')));
        $pass  = (string)pm_param('password', '');
        if ($email === '' || $pass === '') pm_error('Email and password required');
        // Throttle brute-force / credential-stuffing: per (ip,email) and per ip.
        $ip = pm_client_ip();
        if (!pm_rate_limit('login:' . $ip . ':' . $email, 10, 900) ||
            !pm_rate_limit('loginip:' . $ip, 40, 900)) {
            pm_error('Too many sign-in attempts. Please wait a few minutes and try again.', 429);
        }
        $u = pm_fetch_one('SELECT * FROM users WHERE email = ?', [$email]);
        if (!$u || !password_verify($pass, $u['password_hash'])) {
            pm_error('Invalid email or password', 401);
        }
        session_regenerate_id(true);
        $_SESSION['uid'] = (int)$u['id'];
        pm_json(['user' => pm_public_user($u)]);
    }

    case 'logout':
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'] ?? '', $p['secure'], $p['httponly']);
        }
        session_destroy();
        pm_json(['ok' => true]);

    case 'register': {
        if (pm_method() !== 'POST') pm_error('POST required', 405);
        $cfg = pm_config();
        $me  = pm_current_user();
        $isAdmin = $me && !empty($me['is_admin']);
        if (!$isAdmin && empty($cfg['allow_public_register'])) {
            pm_error('Registration is disabled. Ask an admin to create your account.', 403);
        }
        // Throttle self-serve signups (admins creating accounts are exempt).
        if (!$isAdmin && !pm_rate_limit('register:' . pm_client_ip(), 8, 3600)) {
            pm_error('Too many sign-up attempts. Please try again later.', 429);
        }
        $email = strtolower(trim((string)pm_param('email', '')));
        $pass  = (string)pm_param('password', '');
        $name  = trim((string)pm_param('name', ''));
        $role  = trim((string)pm_param('role', ''));
        if ($email === '' || $pass === '' || $name === '') pm_error('Name, email and password required');
        if (strlen($pass) < 8) pm_error('Password must be at least 8 characters');
        // Bound the fields at the column widths declared in install.php so a
        // 5KB "name" doesn't get chopped server-side — or worse, surface a
        // raw PDOException about a length violation.
        if (mb_strlen($name)  > 120) pm_error('Name is too long');
        if (mb_strlen($role)  > 80)  pm_error('Role is too long');
        if (mb_strlen($email) > 255) pm_error('Email is too long');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) pm_error('Invalid email');
        $exists = pm_fetch_one('SELECT id FROM users WHERE email = ?', [$email]);
        if ($exists) pm_error('An account with that email already exists', 409);

        $initials = pm_make_initials($name);
        $color    = pm_pick_color();
        $hash     = password_hash($pass, PASSWORD_DEFAULT);
        pm_exec(
            'INSERT INTO users (email, password_hash, name, role, initials, color, is_admin) VALUES (?,?,?,?,?,?,0)',
            [$email, $hash, $name, $role ?: null, $initials, $color]
        );
        $newId = pm_last_id();
        if (!$isAdmin) {
            session_regenerate_id(true);
            $_SESSION['uid'] = $newId;
        }
        $u = pm_fetch_one('SELECT * FROM users WHERE id = ?', [$newId]);
        pm_json(['user' => pm_public_user($u)]);
    }

    case 'update_profile': {
        if (pm_method() !== 'POST') pm_error('POST required', 405);
        $uid = pm_require_auth();
        $name = trim((string)pm_param('name', ''));
        $role = trim((string)pm_param('role', ''));
        $color = trim((string)pm_param('color', ''));
        $pass  = (string)pm_param('password', '');
        $cur   = (string)pm_param('current_password', '');
        if ($name === '') pm_error('Name required');
        if (mb_strlen($name) > 120) pm_error('Name is too long');
        if (mb_strlen($role) > 80)  pm_error('Role is too long');
        if ($color !== '' && !preg_match('/^#[0-9A-Fa-f]{6}$/', $color)) pm_error('Invalid color');
        // Optional email-notification preference (kept separate from the
        // required fields so older clients that never send it are unaffected).
        $emailPref = (string)pm_param('email_notifs', '');
        if ($emailPref !== '' && in_array($emailPref, ['all', 'mentions', 'none'], true)) {
            try { pm_exec('UPDATE users SET email_notifs = ? WHERE id = ?', [$emailPref, $uid]); }
            catch (Throwable $_) { /* column may predate migration */ }
        }
        $initials = pm_make_initials($name);
        if ($pass !== '') {
            if (strlen($pass) < 8) pm_error('Password must be at least 8 characters');
            $row = pm_fetch_one('SELECT password_hash FROM users WHERE id = ?', [$uid]);
            if (!$row || !password_verify($cur, $row['password_hash'])) {
                pm_error('Current password is incorrect', 403);
            }
            pm_exec(
                'UPDATE users SET name=?, role=?, initials=?, color=?, password_hash=? WHERE id=?',
                [$name, $role ?: null, $initials, $color ?: '#3B82F6', password_hash($pass, PASSWORD_DEFAULT), $uid]
            );
        } else {
            pm_exec(
                'UPDATE users SET name=?, role=?, initials=?, color=? WHERE id=?',
                [$name, $role ?: null, $initials, $color ?: '#3B82F6', $uid]
            );
        }
        $u = pm_fetch_one('SELECT * FROM users WHERE id = ?', [$uid]);
        pm_json(['user' => pm_public_user($u)]);
    }

    default:
        pm_error('Unknown action', 404);
}

function pm_make_initials(string $name): string {
    $parts = preg_split('/\s+/', trim($name));
    if (!$parts) return '??';
    if (count($parts) === 1) return strtoupper(mb_substr($parts[0], 0, 2));
    return strtoupper(mb_substr($parts[0], 0, 1) . mb_substr(end($parts), 0, 1));
}

function pm_pick_color(): string {
    $colors = ['#3B82F6','#A855F7','#F59E0B','#22C55E','#EC4899','#06B6D4','#EF4444','#8B5CF6'];
    return $colors[array_rand($colors)];
}
