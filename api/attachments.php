<?php
require_once __DIR__ . '/attachments_lib.php';
if (is_file(__DIR__ . '/access_lib.php')) require_once __DIR__ . '/access_lib.php';
pm_boot();
$uid = pm_require_auth();

$method = pm_method();
$taskId = pm_int_param('task_id');
$id = pm_int_param('id');

if ($method === 'GET' && $id !== null && (isset($_GET['download']) || isset($_GET['inline']))) pm_download_attachment($id);
if ($method === 'GET' && $taskId !== null) pm_list_attachments($taskId);
if ($method === 'POST' && $taskId !== null) pm_upload_attachment($taskId);
if ($method === 'DELETE' && $id !== null) pm_delete_attachment($id);

pm_error('Method not allowed', 405);

function pm_list_attachments(int $taskId): void {
    global $uid;
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);
    if (function_exists('pm_can_read_task') && !pm_can_read_task($uid, $taskId)) pm_error('Forbidden', 403);
    $rows = pm_fetch_all(
        'SELECT id, task_id, original_name, mime_type, size_bytes, uploaded_by, created_at
         FROM task_attachments
         WHERE task_id = ?
         ORDER BY id DESC',
        [$taskId]
    );
    pm_json(['attachments' => array_map('pm_attachment_shape', $rows)]);
}

function pm_upload_attachment(int $taskId): void {
    global $uid;
    $task = pm_fetch_one('SELECT id FROM tasks WHERE id = ?', [$taskId]);
    if (!$task) pm_error('Task not found', 404);
    if (function_exists('pm_can_write_task') && !pm_can_write_task($uid, $taskId)) pm_error('Forbidden', 403);
    if (!isset($_FILES['file'])) {
        $maxBytes = pm_ini_bytes((string)ini_get('post_max_size'));
        $contentLength = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
        if ($maxBytes > 0 && $contentLength > $maxBytes) {
            pm_error('Upload exceeds server post_max_size limit', 413);
        }
        pm_error('file is required');
    }
    $f = $_FILES['file'];
    if (!is_array($f)) pm_error('Invalid upload payload');
    $err = (int)($f['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($err !== UPLOAD_ERR_OK) {
        if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
            pm_error('File exceeds server upload limit', 413);
        }
        pm_error('Upload failed', 400);
    }

    $tmp = (string)($f['tmp_name'] ?? '');
    $orig = trim((string)($f['name'] ?? ''));
    $size = (int)($f['size'] ?? 0);
    if ($orig === '') $orig = 'attachment';
    if ($size <= 0) pm_error('File is empty', 400);
    if ($size > pm_attachments_max_bytes()) pm_error('File is too large', 413);
    if (!is_uploaded_file($tmp)) pm_error('Invalid upload', 400);

    $dir = pm_ensure_attachments_dir();
    // Keep the real extension only to reconcile the sniffed MIME below — do NOT
    // persist it in the on-disk name. Storing e.g. "shell.php"/"x.svg" would make
    // the storage/.htaccess deny rule the *only* thing preventing direct execution
    // or inline rendering; a deploy that doesn't honor .htaccess (nginx, wrong
    // AllowOverride) would then serve an attacker-named file. A fixed ".bin"
    // extension removes that dependency. The original name is preserved in
    // `original_name` for the download Content-Disposition, so nothing is lost.
    $ext = pm_attachment_safe_ext($orig);
    $stored = bin2hex(random_bytes(16)) . '.bin';
    $dest = rtrim($dir, '/\\') . DIRECTORY_SEPARATOR . $stored;

    if (!move_uploaded_file($tmp, $dest)) {
        pm_error('Could not persist uploaded file', 500);
    }

    // Sniff the real MIME from the stored bytes; ignore the client-sent type.
    // Non-allowlisted (or svg) content is recorded as application/octet-stream.
    $mime = pm_attachment_sniff_mime($dest, $ext);
    if ($mime === '') $mime = 'application/octet-stream';

    try {
        pm_exec(
            'INSERT INTO task_attachments (task_id, stored_name, original_name, mime_type, size_bytes, uploaded_by)
             VALUES (?,?,?,?,?,?)',
            [$taskId, $stored, mb_substr($orig, 0, 255), mb_substr($mime, 0, 120), $size, pm_current_user_id()]
        );
    } catch (Throwable $e) {
        @unlink($dest);
        error_log('pm_upload_attachment metadata failed: ' . $e->getMessage());
        pm_error('Could not save attachment metadata', 500);
    }

    $row = pm_fetch_one(
        'SELECT id, task_id, original_name, mime_type, size_bytes, uploaded_by, created_at
         FROM task_attachments WHERE id = ?',
        [pm_last_id()]
    );
    pm_json(['attachment' => pm_attachment_shape($row)], 201);
}

function pm_ini_bytes(string $val): int {
    $v = trim($val);
    if ($v === '') return 0;
    $n = (int)$v;
    $u = strtolower(substr($v, -1));
    if ($u === 'g') return $n * 1024 * 1024 * 1024;
    if ($u === 'm') return $n * 1024 * 1024;
    if ($u === 'k') return $n * 1024;
    return $n;
}

function pm_download_attachment(int $id): void {
    global $uid;
    $row = pm_fetch_one('SELECT * FROM task_attachments WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);
    $taskId = (int)$row['task_id'];
    if (function_exists('pm_can_read_task') && !pm_can_read_task($uid, $taskId)) pm_error('Forbidden', 403);
    $path = pm_attachment_abs_path((string)$row['stored_name']);
    if (!is_file($path)) pm_error('File missing on disk', 410);

    // Only echo the stored MIME for allow-listed, safe types. Everything else
    // (unknown, svg, octet-stream) is forced to octet-stream so the browser
    // can't be tricked into rendering/executing it inline.
    $stored = (string)($row['mime_type'] ?: '');
    // Inline display is permitted ONLY for allow-listed RASTER images (never
    // svg/html/unknown — the uploader already records those as octet-stream).
    $isImage = pm_attachment_is_serveable_mime($stored) && strpos($stored, 'image/') === 0;
    $inline = isset($_GET['inline']) && $isImage;
    $serveType = $inline ? $stored : (pm_attachment_is_serveable_mime($stored) ? $stored : 'application/octet-stream');

    while (ob_get_level() > 0) ob_end_clean();
    http_response_code(200);
    header('Content-Type: ' . $serveType);
    header('X-Content-Type-Options: nosniff');
    header('Content-Length: ' . (string)filesize($path));
    header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . pm_content_disposition_name((string)$row['original_name']) . '"');
    header('Cache-Control: private, no-store');
    readfile($path);
    exit;
}

function pm_delete_attachment(int $id): void {
    $row = pm_fetch_one('SELECT id, task_id, stored_name, uploaded_by FROM task_attachments WHERE id = ?', [$id]);
    if (!$row) pm_error('Not found', 404);

    $uid = pm_current_user_id();
    $taskId = (int)$row['task_id'];
    if (function_exists('pm_can_write_task') && !pm_can_write_task($uid, $taskId)) pm_error('Forbidden', 403);
    $uploader = ($row['uploaded_by'] !== null) ? (int)$row['uploaded_by'] : null;
    $me = pm_current_user();
    $isAdmin = $me && !empty($me['is_admin']);
    if (!$isAdmin && ($uploader === null || $uploader !== $uid)) {
        pm_error('Forbidden', 403);
    }

    pm_exec('DELETE FROM task_attachments WHERE id = ?', [$id]);
    pm_attachment_delete_file((string)$row['stored_name']);
    pm_json(['ok' => true]);
}

function pm_content_disposition_name(string $name): string {
    $name = str_replace(["\r", "\n", '"'], ['', '', "'"], $name);
    if ($name === '') return 'attachment';
    return $name;
}
