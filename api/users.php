<?php
require_once __DIR__ . '/bootstrap.php';
pm_boot();
pm_require_auth();

$method = pm_method();
$id = pm_int_param('id');

if ($method === 'GET' && $id === null) {
    // Expose email ONLY to admins (for the Team management panel). Non-admins
    // still get the email-free shape, preserving the no-enumeration posture.
    $me = pm_current_user();
    $isAdmin = $me && !empty($me['is_admin']);
    $cols = $isAdmin
        ? 'id, name, role, initials, color, is_admin, email'
        : 'id, name, role, initials, color, is_admin';
    $rows = pm_fetch_all("SELECT $cols FROM users ORDER BY name");
    pm_json(['users' => array_map('pm_public_user', $rows)]);
}

if ($method === 'DELETE' && $id !== null) {
    pm_require_admin();
    // Prevent deleting yourself
    if ($id === pm_current_user_id()) pm_error('Cannot delete yourself', 400);
    pm_exec('DELETE FROM users WHERE id = ?', [$id]);
    pm_json(['ok' => true]);
}

if ($method === 'PATCH' && $id !== null) {
    pm_require_admin();
    $body = pm_body();
    $f=[]; $p=[];
    if (isset($body['role']))    { $f[]='role = ?';    $p[]=(string)$body['role']; }
    if (isset($body['name'])) {
        $name = trim((string)$body['name']);
        if ($name === '') pm_error('Name cannot be empty');
        if (mb_strlen($name) > 120) pm_error('Name is too long');
        $initials = pm_make_initials($name);
        $f[]='name = ?';    $p[]=$name;
        $f[]='initials = ?'; $p[]=$initials;
    }
    if (isset($body['color'])) {
        $c = (string)$body['color'];
        if (!preg_match('/^#[0-9A-Fa-f]{6}$/', $c)) pm_error('Invalid color');
        $f[]='color = ?';   $p[]=$c;
    }
    if (isset($body['is_admin'])){
        // Don't let an admin demote themselves out of the last admin seat —
        // leaves the system with no one who can manage it.
        $wantAdmin = !empty($body['is_admin']) ? 1 : 0;
        if (!$wantAdmin && $id === pm_current_user_id()) {
            $otherAdmins = (int)(pm_fetch_one('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND id <> ?', [$id])['c'] ?? 0);
            if ($otherAdmins === 0) pm_error('Cannot remove the last admin');
        }
        $f[]='is_admin = ?'; $p[]=$wantAdmin;
    }
    if (!$f) pm_error('Nothing to update');
    $p[] = $id;
    pm_exec('UPDATE users SET ' . implode(',', $f) . ' WHERE id = ?', $p);
    $row = pm_fetch_one('SELECT id, name, role, initials, color, is_admin FROM users WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);
    pm_json(['user' => pm_public_user($row)]);
}

pm_error('Method not allowed', 405);

function pm_make_initials(string $name): string {
    $parts = preg_split('/\s+/', trim($name));
    if (!$parts) return '??';
    if (count($parts) === 1) return strtoupper(mb_substr($parts[0], 0, 2));
    return strtoupper(mb_substr($parts[0], 0, 1) . mb_substr(end($parts), 0, 1));
}
