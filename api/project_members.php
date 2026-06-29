<?php
require_once __DIR__ . '/bootstrap.php';
require_once __DIR__ . '/access_lib.php';
pm_boot();
$uid = pm_require_auth();

$method = pm_method();
$pid = pm_int_param('project_id');

if ($pid === null) pm_error('project_id required');
$project = pm_fetch_one('SELECT id FROM projects WHERE id = ?', [$pid]);
if (!$project) pm_error('Not found', 404);

// Shape a member's user for API responses. Mirrors the {id,name,initials,color}
// avatar fields the frontend expects elsewhere.
function pm_member_user_shape(array $r): array {
    return [
        'id'       => (int)$r['user_id'],
        'name'     => $r['name'],
        'initials' => $r['initials'],
        'color'    => $r['color'],
    ];
}

if ($method === 'GET') {
    if (!pm_can_read_project($uid, $pid)) pm_error('Forbidden', 403);
    $rows = pm_fetch_all(
        'SELECT pm.user_id, pm.role, u.name, u.initials, u.color
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ?
         ORDER BY u.name',
        [$pid]
    );
    $members = array_map(function ($r) {
        return [
            'user_id' => (int)$r['user_id'],
            'role'    => $r['role'],
            'user'    => pm_member_user_shape($r),
        ];
    }, $rows);
    pm_json([
        'visibility' => pm_project_visibility($pid),
        'members'    => $members,
    ]);
}

if ($method === 'POST') {
    if (!pm_can_manage_project($uid, $pid)) pm_error('Forbidden', 403);
    $memberId = (int)pm_param('user_id', 0);
    $role     = (string)pm_param('role', '');
    if ($memberId <= 0) pm_error('user_id required');
    if (!in_array($role, ['owner', 'editor', 'viewer'], true)) {
        pm_error('Invalid role (use owner, editor or viewer)');
    }
    $u = pm_fetch_one('SELECT id, name, initials, color FROM users WHERE id = ?', [$memberId]);
    if (!$u) pm_error('User not found', 404);
    pm_exec(
        'INSERT INTO project_members (project_id, user_id, role) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE role = VALUES(role)',
        [$pid, $memberId, $role]
    );
    pm_json(['member' => [
        'user_id' => $memberId,
        'role'    => $role,
        'user'    => [
            'id'       => (int)$u['id'],
            'name'     => $u['name'],
            'initials' => $u['initials'],
            'color'    => $u['color'],
        ],
    ]]);
}

if ($method === 'DELETE') {
    if (!pm_can_manage_project($uid, $pid)) pm_error('Forbidden', 403);
    $memberId = pm_int_param('user_id');
    if ($memberId === null) pm_error('user_id required');
    pm_exec('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [$pid, $memberId]);
    pm_json(['ok' => true]);
}

if ($method === 'PATCH') {
    if (!pm_can_manage_project($uid, $pid)) pm_error('Forbidden', 403);
    $visibility = (string)pm_param('visibility', '');
    if (!in_array($visibility, ['open', 'private'], true)) {
        pm_error('Invalid visibility (use open or private)');
    }
    pm_exec('UPDATE projects SET visibility = ? WHERE id = ?', [$visibility, $pid]);
    pm_json(['ok' => true, 'visibility' => $visibility]);
}

pm_error('Method not allowed', 405);
