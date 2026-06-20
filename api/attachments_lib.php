<?php
require_once __DIR__ . '/bootstrap.php';

function pm_attachments_dir(): string {
    $cfg = pm_config();
    $raw = $cfg['attachments_dir'] ?? (__DIR__ . '/../storage/attachments');
    if (!is_string($raw) || $raw === '') {
        $raw = __DIR__ . '/../storage/attachments';
    }
    $resolved = realpath($raw);
    return $resolved !== false ? $resolved : $raw;
}

function pm_attachments_max_bytes(): int {
    $cfg = pm_config();
    $n = isset($cfg['attachments_max_bytes']) ? (int)$cfg['attachments_max_bytes'] : (10 * 1024 * 1024);
    return max(1024, $n);
}

function pm_ensure_attachments_dir(): string {
    $dir = pm_attachments_dir();
    if (!is_dir($dir)) {
        if (!@mkdir($dir, 0755, true) && !is_dir($dir)) {
            pm_error('Attachment storage is not writable', 500);
        }
    }
    if (!is_writable($dir)) {
        pm_error('Attachment storage is not writable', 500);
    }
    return $dir;
}

function pm_attachment_safe_ext(string $name): string {
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    if ($ext === '') return '';
    $ext = preg_replace('/[^a-z0-9]/', '', $ext);
    return mb_substr($ext, 0, 12);
}

/**
 * Allow-list of safe (extension => [accepted sniffed mime types]).
 * Note: svg is intentionally absent here — it is allowed to upload but is
 * always stored/served as application/octet-stream because it can script.
 */
function pm_attachment_allowlist(): array {
    return [
        // images
        'png'  => ['image/png'],
        'jpg'  => ['image/jpeg'],
        'jpeg' => ['image/jpeg'],
        'gif'  => ['image/gif'],
        'webp' => ['image/webp'],
        // documents
        'pdf'  => ['application/pdf'],
        // text
        'txt'  => ['text/plain'],
        'csv'  => ['text/plain', 'text/csv', 'application/csv'],
        'md'   => ['text/plain', 'text/markdown'],
        // office (OOXML are zip containers; finfo often reports the zip type)
        'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
        'xlsx' => ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'],
        'pptx' => ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip'],
        // archive
        'zip'  => ['application/zip', 'application/x-zip-compressed'],
    ];
}

/**
 * Sniff the real MIME of an uploaded temp file with finfo and reconcile it
 * against the extension allow-list. Returns the MIME to STORE: the sniffed
 * type when (ext, sniffed) is on the allow-list, otherwise
 * 'application/octet-stream'. SVG is always octet-stream (scriptable).
 */
function pm_attachment_sniff_mime(string $tmpPath, string $ext): string {
    $sniffed = '';
    if (function_exists('finfo_open')) {
        $fi = @finfo_open(FILEINFO_MIME_TYPE);
        if ($fi !== false) {
            $detected = @finfo_file($fi, $tmpPath);
            finfo_close($fi);
            if (is_string($detected) && $detected !== '') {
                $sniffed = strtolower(trim($detected));
            }
        }
    }

    $ext = strtolower($ext);
    if ($ext === 'svg') return 'application/octet-stream';

    $allow = pm_attachment_allowlist();
    if (isset($allow[$ext]) && $sniffed !== '' && in_array($sniffed, $allow[$ext], true)) {
        return $sniffed;
    }
    return 'application/octet-stream';
}

/**
 * Whether a stored mime type is safe to serve with its real Content-Type.
 * Anything not on the allow-list (and svg / octet-stream) is served as
 * application/octet-stream on download.
 */
function pm_attachment_is_serveable_mime(string $mime): bool {
    $mime = strtolower(trim($mime));
    if ($mime === '' || $mime === 'application/octet-stream') return false;
    if ($mime === 'image/svg+xml') return false;
    foreach (pm_attachment_allowlist() as $accepted) {
        if (in_array($mime, $accepted, true)) return true;
    }
    return false;
}

function pm_attachment_shape(array $row): array {
    return [
        'id' => (int)$row['id'],
        'task_id' => (int)$row['task_id'],
        'name' => $row['original_name'],
        'mime' => $row['mime_type'] ?: 'application/octet-stream',
        'size' => (int)$row['size_bytes'],
        'uploaded_by' => isset($row['uploaded_by']) && $row['uploaded_by'] !== null ? (int)$row['uploaded_by'] : null,
        'created_at' => $row['created_at'],
        'download_url' => 'api/attachments.php?id=' . (int)$row['id'] . '&download=1',
    ];
}

function pm_attachment_abs_path(string $storedName): string {
    return rtrim(pm_attachments_dir(), '/\\') . DIRECTORY_SEPARATOR . $storedName;
}

function pm_attachment_delete_file(string $storedName): void {
    if ($storedName === '') return;
    $path = pm_attachment_abs_path($storedName);
    if (is_file($path)) {
        @unlink($path);
    }
}
