<?php
// cPanel MySQL credentials.
// Fill these in with values from cPanel → MySQL Databases.
// The DB user must be attached to the database with ALL PRIVILEGES.

return [
    'db_host'     => 'localhost',
    'db_name'     => 'yourcpanel_pm',     // e.g. cpaneluser_pm
    'db_user'     => 'yourcpanel_pmuser', // e.g. cpaneluser_pmuser
    'db_pass'     => 'change-me',
    'db_charset'  => 'utf8mb4',

    // Security
    'session_name'   => 'pm_sid',
    'cookie_secure'  => false, // set true if site is HTTPS-only
    'cookie_samesite'=> 'Lax',

    // Feature flags
    'allow_public_register' => false, // if false, only admins can create users

    // App
    'app_name'    => 'Castle Tech Tasks',
    'project_key' => 'CTT',

    // Attachments
    // Keep this outside any publicly-browsable path when possible.
    // Default resolves to <repo>/storage/attachments.
    // 'attachments_dir' => __DIR__ . '/../storage/attachments',
    'attachments_max_bytes' => 10 * 1024 * 1024, // 10 MB per file

    // Email notifications (assignments, mentions, comments, daily digest).
    // Sent via PHP mail() — works out of the box on cPanel. Set
    // 'email_enabled' => false to silence all outgoing mail.
    'email_enabled' => true,
    'mail_from'     => '',   // default: noreply@<your-domain>
    'app_url'       => '',   // absolute base URL used in email links + calendar
                             // feeds, e.g. 'https://example.com/pm'. Leave empty
                             // to auto-detect from the request.
];
