<?php
// Per-project access control (v2.6). Backward-compatible by design:
//   - 'open' projects (the default for every existing project) behave EXACTLY
//     as before — any authenticated user can read & write.
//   - 'private' projects enforce membership: members read; 'editor'/'owner'
//     write; 'viewer' is read-only.
//   - Global admins (users.is_admin) bypass all project restrictions.
// All lookups are cached per-request and fail OPEN (never lock people out) if a
// table/column is missing on an older install.

require_once __DIR__ . '/db.php';

function pm_project_visibilities(): array {
    static $vis = null;
    if ($vis !== null) return $vis;
    $vis = [];
    try {
        foreach (pm_fetch_all('SELECT id, visibility FROM projects') as $r) {
            $vis[(int)$r['id']] = (string)($r['visibility'] ?? 'open');
        }
    } catch (Throwable $_) { /* visibility column absent on a very old install */ }
    return $vis;
}

function pm_project_visibility(int $projectId): string {
    $v = pm_project_visibilities();
    return $v[$projectId] ?? 'open';
}

/** map: project_id => role, for one user. */
function pm_user_memberships(int $uid): array {
    static $cache = [];
    if (isset($cache[$uid])) return $cache[$uid];
    $m = [];
    try {
        foreach (pm_fetch_all('SELECT project_id, role FROM project_members WHERE user_id = ?', [$uid]) as $r) {
            $m[(int)$r['project_id']] = (string)$r['role'];
        }
    } catch (Throwable $_) { /* table may not exist yet */ }
    return $cache[$uid] = $m;
}

function pm_user_is_admin_cached(int $uid): bool {
    static $cache = [];
    if (isset($cache[$uid])) return $cache[$uid];
    try {
        $r = pm_fetch_one('SELECT is_admin FROM users WHERE id = ?', [$uid]);
        return $cache[$uid] = (bool)($r && !empty($r['is_admin']));
    } catch (Throwable $_) { return $cache[$uid] = false; }
}

function pm_can_read_project(int $uid, int $projectId): bool {
    if (pm_user_is_admin_cached($uid)) return true;
    if (pm_project_visibility($projectId) !== 'private') return true; // open
    return isset(pm_user_memberships($uid)[$projectId]);
}

function pm_can_write_project(int $uid, int $projectId): bool {
    if (pm_user_is_admin_cached($uid)) return true;
    if (pm_project_visibility($projectId) !== 'private') return true; // open == legacy all-can-write
    $role = pm_user_memberships($uid)[$projectId] ?? null;
    return $role === 'owner' || $role === 'editor';
}

function pm_can_manage_project(int $uid, int $projectId): bool {
    if (pm_user_is_admin_cached($uid)) return true;
    return (pm_user_memberships($uid)[$projectId] ?? null) === 'owner';
}

/**
 * Read-accessible project ids for a user, or NULL meaning "no restriction"
 * (admin, or there are no private projects) so callers can skip the WHERE
 * clause entirely — keeping the all-open common case free.
 */
function pm_readable_project_ids(int $uid): ?array {
    if (pm_user_is_admin_cached($uid)) return null;
    $vis = pm_project_visibilities();
    $hasPrivate = false;
    foreach ($vis as $v) { if ($v === 'private') { $hasPrivate = true; break; } }
    if (!$hasPrivate) return null;
    $mine = pm_user_memberships($uid);
    $ids = [];
    foreach ($vis as $pid => $v) {
        if ($v !== 'private' || isset($mine[$pid])) $ids[] = (int)$pid;
    }
    return $ids;
}

/**
 * SQL helper for list endpoints that carry a project_id column and must hide
 * rows belonging to private projects the caller can't read. Returns a WHERE
 * fragment (referencing the trusted literal $col), or '' when there is no
 * restriction (admin / no private projects). Rows with a NULL project
 * (global/unscoped config) stay visible when $includeGlobal is true. Bound
 * params are appended to $params by reference.
 */
function pm_readable_project_where(int $uid, string $col, array &$params, bool $includeGlobal = true): string {
    $readable = pm_readable_project_ids($uid);
    if ($readable === null) return ''; // no restriction
    if (!$readable) return $includeGlobal ? "$col IS NULL" : '1=0';
    $ph = implode(',', array_fill(0, count($readable), '?'));
    foreach ($readable as $r) $params[] = (int)$r;
    return $includeGlobal ? "($col IS NULL OR $col IN ($ph))" : "$col IN ($ph)";
}

function pm_task_project_id(int $taskId): ?int {
    try {
        $r = pm_fetch_one('SELECT project_id FROM tasks WHERE id = ?', [$taskId]);
        return $r ? (int)$r['project_id'] : null;
    } catch (Throwable $_) { return null; }
}

function pm_can_read_task(int $uid, int $taskId): bool {
    $pid = pm_task_project_id($taskId);
    return $pid === null ? true : pm_can_read_project($uid, $pid);
}

function pm_can_write_task(int $uid, int $taskId): bool {
    $pid = pm_task_project_id($taskId);
    return $pid === null ? true : pm_can_write_project($uid, $pid);
}
