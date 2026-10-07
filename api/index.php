<?php
// Team SOP Dashboard: data API for PHP + MySQL hosting (e.g. Hostinger).
//
// Every request is a POST with a JSON body: { "action": "...", ...params }.
// Responses are JSON: { "data": ... } on success, { "error": "..." } otherwise.
// Tables are created automatically on first use.
//
// Access control (enforced here, not just in the page):
//   1. The site password opens the dashboard (step 1 of the sign-in screen).
//   2. Then a person picks their name and enters their own password, or picks
//      Admin and enters the admin password.
//   3. Employees can only read and change their own tasks, times and notes.
//      The admin can see everything, create/assign/delete tasks, manage the
//      team and run reports.
// The site and admin passwords live in api/config.php. Employee passwords are
// set by the admin and stored hashed in the database.
//
// There are two entrances, each with its own sign-in cookie:
//   - the team site (haaps.co.in): dashboard password, then pick your name
//     and enter your password. Admin can't sign in here.
//   - the admin site (admin.haaps.co.in or /admin): admin password only.
//     admin/api/index.php defines SOP_ADMIN_ENTRY and includes this file.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const SCHEMA_VERSION = 9;
// weekdays = set days of the week; due_day is then a bitmask (Mon = 1, Tue = 2,
// Wed = 4 ... Sun = 64) and the task is part of the daily list on those days.
// monthdays = set dates of the month; due_day is a bitmask of dates (1st = 1,
// 2nd = 2, 3rd = 4 ...). Dates on a Saturday or Sunday move to Friday or Monday.
// monthstart = done over the first working days of the month; due_day is how
// many Monday-Friday days (e.g. 6). It is in the daily list on each of those
// days and keeps one record for the whole month, so it doesn't reset daily.
const FREQUENCIES = ['daily', 'weekly', 'monthly', 'weekdays', 'monthdays', 'monthstart'];
define('ADMIN_ENTRY', defined('SOP_ADMIN_ENTRY') && SOP_ADMIN_ENTRY);
define('SESSION_COOKIE', ADMIN_ENTRY ? 'sop_admin_session' : 'sop_session');
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 20;   // per IP address (an office often shares one) ...
const FAILED_LOGIN_WINDOW = 15; // ... in this many minutes
const ADMIN_NAME = 'Admin';

function respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $status = 400, ?string $code = null): void
{
    respond($status, $code ? ['error' => $message, 'code' => $code] : ['error' => $message]);
}

set_exception_handler(function (Throwable $e) {
    error_log('SOP dashboard API: ' . $e->getMessage());
    fail('Server error. Please try again.', 500);
});

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail('Use POST.', 405);
}

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) {
    fail('Missing api/config.php. Copy api/config.sample.php to api/config.php and fill in your database details.', 500);
}
$config = require $configFile;
if (!is_array($config) || ($config['db_name'] ?? '') === '' || ($config['db_user'] ?? '') === '') {
    fail('Fill in your database details in api/config.php.', 500);
}
if (!is_string($config['admin_password'] ?? null) || $config['admin_password'] === '') {
    fail("Set 'admin_password' in api/config.php.", 500);
}
// The admin's username; optional 'admin_username' in config.php, default "admin".
define('ADMIN_USERNAME', is_string($config['admin_username'] ?? null) && trim($config['admin_username']) !== '' ? trim($config['admin_username']) : 'admin');
// Doctor videos: who shoots, who edits, who reviews (optional in config.php).
define('VIDEO_SHOOTER', is_string($config['video_shooter'] ?? null) ? $config['video_shooter'] : 'Harsha');
define('VIDEO_EDITORS', is_array($config['video_editors'] ?? null) ? array_values($config['video_editors']) : ['Harsha', 'Manju Designer']);
define('VIDEO_REVIEWER', is_string($config['video_reviewer'] ?? null) ? $config['video_reviewer'] : 'Madhu');
date_default_timezone_set($config['timezone'] ?? 'Asia/Kolkata');
// Sign people out after this many minutes without any activity (mouse,
// keyboard or touch in the page; the dashboard's background checks for
// updates don't count). Optional 'idle_minutes' in config.php, default 2 hours.
define('IDLE_MINUTES', max(5, (int) ($config['idle_minutes'] ?? 120)));

try {
    $db = new PDO(
        sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $config['db_host'] ?? 'localhost', (int) ($config['db_port'] ?? 3306), $config['db_name']),
        $config['db_user'],
        $config['db_pass'] ?? '',
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
    // Keep NOW() in the same timezone as PHP.
    $db->exec("SET time_zone = '" . (new DateTime())->format('P') . "'");
} catch (PDOException $e) {
    error_log('SOP dashboard API: ' . $e->getMessage());
    // Say which setting is wrong, without echoing any of the values.
    preg_match('/\[(\d{4})\]/', $e->getMessage(), $m);
    $hints = [
        '1044' => "the database user doesn't have access to this database. In hPanel's database list, make sure db_user belongs to db_name.",
        '1045' => "the username or password was refused. Check db_user (the full name with the u123..._ prefix) and db_pass.",
        '1049' => "no database with that name exists. Check db_name (the full name with the u123..._ prefix).",
        '2002' => "the database server couldn't be reached. Check db_host (normally localhost).",
        '2005' => "the database server name wasn't recognised. Check db_host (normally localhost).",
    ];
    $why = $hints[$m[1] ?? ''] ?? 'check the details in api/config.php.';
    fail("Can't connect to the database: " . $why, 500);
}

$input = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($input)) {
    fail('Send a JSON body.');
}
$action = (string) ($input['action'] ?? '');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function str_param(array $in, string $key, int $max): string
{
    $v = $in[$key] ?? null;
    if (!is_string($v) || trim($v) === '' || mb_strlen($v) > $max) {
        fail("Invalid $key.");
    }
    return trim($v);
}

function date_param(array $in, string $key): string
{
    $v = $in[$key] ?? null;
    if (!is_string($v) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) || !checkdate((int) substr($v, 5, 2), (int) substr($v, 8, 2), (int) substr($v, 0, 4))) {
        fail("Invalid $key.");
    }
    return $v;
}

// A task's active span: starts_on / ends_on dates, or null for open-ended.
function span_params(array $in, ?array $current = null): array
{
    $get = function (string $key) use ($in, $current) {
        if (!array_key_exists($key, $in)) {
            return $current[$key] ?? null;
        }
        return $in[$key] === null || $in[$key] === '' ? null : date_param($in, $key);
    };
    $startsOn = $get('starts_on');
    $endsOn = $get('ends_on');
    if ($startsOn !== null && $endsOn !== null && $endsOn < $startsOn) {
        fail('The last day must be after the first day.');
    }
    return [$startsOn, $endsOn];
}

function time_param(array $in, string $key): ?string
{
    $v = $in[$key] ?? null;
    if ($v === null) {
        return null;
    }
    if (!is_string($v) || !preg_match('/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/', $v)) {
        fail("Invalid $key.");
    }
    return strlen($v) === 5 ? "$v:00" : $v;
}

function id_param(array $in, string $key): string
{
    $v = $in[$key] ?? null;
    if (!is_string($v) || !preg_match('/^[0-9a-f-]{36}$/', $v)) {
        fail("Invalid $key.");
    }
    return $v;
}

function password_param(array $in, string $key = 'password'): string
{
    $v = $in[$key] ?? null;
    if (!is_string($v) || $v === '' || strlen($v) > 200) {
        fail('Enter a password.');
    }
    return $v;
}

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

// ---------------------------------------------------------------------------
// Schema (created on first use and upgraded when SCHEMA_VERSION changes)
// ---------------------------------------------------------------------------

function ensure_schema(PDO $db): void
{
    try {
        $v = $db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'schema_version'")->fetchColumn();
    } catch (PDOException $e) {
        $v = false;
    }
    if ($v !== false && (int) $v >= SCHEMA_VERSION) {
        return;
    }

    $opts = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    $db->exec("CREATE TABLE IF NOT EXISTS tasks (
        id CHAR(36) NOT NULL PRIMARY KEY,
        employee VARCHAR(100) NOT NULL,
        title VARCHAR(200) NOT NULL,
        position INT NOT NULL DEFAULT 0,
        from_seed TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY tasks_employee_position (employee, position)
    ) $opts");

    $db->exec("CREATE TABLE IF NOT EXISTS task_entries (
        task_id CHAR(36) NOT NULL,
        work_date DATE NOT NULL,
        start_time TIME NULL,
        end_time TIME NULL,
        quantity INT UNSIGNED NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (task_id, work_date),
        KEY task_entries_work_date (work_date),
        CONSTRAINT task_entries_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
    ) $opts");

    $db->exec("CREATE TABLE IF NOT EXISTS notes (
        employee VARCHAR(100) NOT NULL,
        work_date DATE NOT NULL,
        body MEDIUMTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (employee, work_date)
    ) $opts");

    $db->exec("CREATE TABLE IF NOT EXISTS app_meta (
        meta_key VARCHAR(50) NOT NULL PRIMARY KEY,
        meta_value VARCHAR(255) NOT NULL
    ) $opts");

    // Employees who can sign in. Their name matches tasks.employee.
    $db->exec("CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255) NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        position INT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY users_name (name)
    ) $opts");

    // Signed-in browsers. The cookie holds a random token; only its SHA-256
    // hash is stored, so a copy of the database can't be used to sign in.
    $db->exec("CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        site_ok TINYINT(1) NOT NULL DEFAULT 0,
        role VARCHAR(10) NULL,
        user_id INT UNSIGNED NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        KEY sessions_user (user_id),
        KEY sessions_expires (expires_at)
    ) $opts");

    $db->exec("CREATE TABLE IF NOT EXISTS login_attempts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY login_attempts_ip (ip, attempted_at)
    ) $opts");

    // v3: weekly/monthly tasks, pending work and reminders.
    add_column($db, 'tasks', 'frequency', "VARCHAR(10) NOT NULL DEFAULT 'daily'");
    add_column($db, 'tasks', 'due_day', 'TINYINT UNSIGNED NULL');
    add_column($db, 'task_entries', 'started_on', 'DATE NULL');
    add_column($db, 'task_entries', 'ended_on', 'DATE NULL');
    add_column($db, 'task_entries', 'skipped', 'TINYINT(1) NOT NULL DEFAULT 0');
    // v6: pause. worked_sec is the time worked in finished stretches;
    // resumed_at is when the current stretch began (NULL while paused).
    add_column($db, 'task_entries', 'worked_sec', 'INT UNSIGNED NULL');
    add_column($db, 'task_entries', 'resumed_at', 'DATETIME NULL');
    // v7: tasks for a set time (starts_on / ends_on, NULL = open), and
    // "delete for now": the task is hidden from from_date to to_date.
    add_column($db, 'tasks', 'starts_on', 'DATE NULL');
    add_column($db, 'tasks', 'ends_on', 'DATE NULL');
    // v8: own usernames, and tasks paused or cancelled by the admin.
    add_column($db, 'users', 'username', 'VARCHAR(100) NULL');
    add_column($db, 'tasks', 'state', 'VARCHAR(12) NULL');
    add_column($db, 'tasks', 'state_on', 'DATE NULL');
    // v9: doctor video shoots, the videos from each shoot, and approvals.
    $db->exec("CREATE TABLE IF NOT EXISTS video_shoots (
        id CHAR(36) NOT NULL PRIMARY KEY,
        client VARCHAR(200) NOT NULL,
        shoot_date DATE NOT NULL,
        raw_count INT UNSIGNED NOT NULL DEFAULT 0,
        created_by VARCHAR(100) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY video_shoots_date (shoot_date)
    ) $opts");
    $db->exec("CREATE TABLE IF NOT EXISTS videos (
        id CHAR(36) NOT NULL PRIMARY KEY,
        shoot_id CHAR(36) NOT NULL,
        topic VARCHAR(300) NOT NULL,
        position INT NOT NULL DEFAULT 0,
        editor VARCHAR(100) NULL,
        status VARCHAR(12) NOT NULL DEFAULT 'raw',
        started_at DATETIME NULL,
        submitted_at DATETIME NULL,
        approved_at DATETIME NULL,
        rounds INT UNSIGNED NOT NULL DEFAULT 0,
        note TEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY videos_shoot (shoot_id, position),
        CONSTRAINT videos_shoot FOREIGN KEY (shoot_id) REFERENCES video_shoots (id) ON DELETE CASCADE
    ) $opts");
    $db->exec("CREATE TABLE IF NOT EXISTS video_reviews (
        video_id CHAR(36) NOT NULL,
        approver VARCHAR(100) NOT NULL,
        decision VARCHAR(10) NOT NULL,
        comment TEXT NULL,
        decided_at DATETIME NOT NULL,
        PRIMARY KEY (video_id, approver),
        CONSTRAINT video_reviews_video FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE
    ) $opts");
    $db->exec("CREATE TABLE IF NOT EXISTS task_skips (
        task_id CHAR(36) NOT NULL,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        PRIMARY KEY (task_id, from_date, to_date),
        CONSTRAINT task_skips_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
    ) $opts");
    // v4: automatic sign-out after inactivity.
    add_column($db, 'sessions', 'last_active', 'DATETIME NULL');
    $db->exec("CREATE TABLE IF NOT EXISTS reminders (
        id CHAR(36) NOT NULL PRIMARY KEY,
        employee VARCHAR(100) NOT NULL,
        title VARCHAR(300) NOT NULL,
        due_date DATE NOT NULL,
        due_time TIME NULL,
        done_at DATETIME NULL,
        created_by VARCHAR(100) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY reminders_employee_due (employee, due_date)
    ) $opts");
    if ((int) $v < 3) {
        // Tasks already named "(Weekly)" become weekly tasks due on Monday.
        $db->exec("UPDATE tasks SET frequency = 'weekly', due_day = 1 WHERE frequency = 'daily' AND title LIKE '%(Weekly)%'");
    }
    if ((int) $v < 5) {
        // v5: set-dates tasks keep a bitmask of up to 31 dates.
        $db->exec('ALTER TABLE tasks MODIFY due_day INT UNSIGNED NULL');
    }
    // Pending work is only counted from the day this version went live.
    $db->prepare("INSERT IGNORE INTO app_meta (meta_key, meta_value) VALUES ('tracking_start', ?)")->execute([date('Y-m-d')]);

    $db->prepare("INSERT INTO app_meta (meta_key, meta_value) VALUES ('schema_version', ?)
                  ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)")->execute([(string) SCHEMA_VERSION]);
}

function add_column(PDO $db, string $table, string $column, string $ddl): void
{
    $q = $db->prepare('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?');
    $q->execute([$table, $column]);
    if (!$q->fetchColumn()) {
        $db->exec("ALTER TABLE `$table` ADD COLUMN `$column` $ddl");
    }
}

function meta(PDO $db, string $key): ?string
{
    $q = $db->prepare('SELECT meta_value FROM app_meta WHERE meta_key = ?');
    $q->execute([$key]);
    $v = $q->fetchColumn();
    return $v === false ? null : $v;
}

// Validate a task type and its due day: weekly tasks are due on a weekday
// (1 = Monday ... 7 = Sunday), monthly tasks on a day of the month (1-31).
function frequency_params(array $in, ?array $current = null): array
{
    $frequency = $in['frequency'] ?? ($current['frequency'] ?? 'daily');
    if (!in_array($frequency, FREQUENCIES, true)) {
        fail('Choose Daily, Weekly or Monthly.');
    }
    $due = $in['due_day'] ?? ($current && $current['frequency'] === $frequency ? $current['due_day'] : null);
    if ($frequency === 'daily') {
        return ['daily', null];
    }
    $due = $due === null ? 1 : (int) $due;
    $max = ['weekly' => 7, 'weekdays' => 127, 'monthly' => 31, 'monthdays' => 2147483647, 'monthstart' => 20][$frequency];
    if ($due < 1 || $due > $max) {
        fail($frequency === 'monthly' ? 'Choose a day of the month (1-31).' : 'Choose a weekday.');
    }
    return [$frequency, $due];
}

ensure_schema($db);

// ---------------------------------------------------------------------------
// Sessions and passwords
// ---------------------------------------------------------------------------

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

function set_session_cookie(string $token, int $expires): void
{
    setcookie(SESSION_COOKIE, $token, [
        'expires' => $expires,
        'path' => '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function load_session(PDO $db): ?array
{
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($token) || !preg_match('/^[a-f0-9]{64}$/', $token)) {
        return null;
    }
    $q = $db->prepare('SELECT s.token_hash, s.site_ok, s.role, s.user_id, s.expires_at, s.last_active, u.name AS user_name, u.active AS user_active
                       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
                       WHERE s.token_hash = ? AND s.expires_at > NOW()');
    $q->execute([hash('sha256', $token)]);
    $s = $q->fetch();
    if (!$s) {
        return null;
    }
    // Inactive too long: sign out (the whole session, like pressing Lock).
    if ($s['last_active'] !== null && strtotime($s['last_active']) < time() - IDLE_MINUTES * 60) {
        $db->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$s['token_hash']]);
        set_session_cookie('', time() - 3600);
        return null;
    }
    // The page sends X-User-Active: 1 when the person used it recently; the
    // background update checks send 0 and don't keep the session alive.
    $active = ($_SERVER['HTTP_X_USER_ACTIVE'] ?? '') === '1';
    if ($s['last_active'] === null || ($active && strtotime($s['last_active']) < time() - 60)) {
        $db->prepare('UPDATE sessions SET last_active = NOW() WHERE token_hash = ?')->execute([$s['token_hash']]);
    }
    // A removed employee is signed out.
    if ($s['role'] === 'employee' && (int) $s['user_active'] !== 1) {
        $db->prepare('UPDATE sessions SET role = NULL, user_id = NULL WHERE token_hash = ?')->execute([$s['token_hash']]);
        $s['role'] = null;
        $s['user_id'] = null;
        $s['user_name'] = null;
    }
    // Slide the expiry forward at most once a day.
    if (strtotime($s['expires_at']) - time() < (SESSION_DAYS - 1) * 86400) {
        $expires = time() + SESSION_DAYS * 86400;
        $db->prepare('UPDATE sessions SET expires_at = FROM_UNIXTIME(?) WHERE token_hash = ?')->execute([$expires, $s['token_hash']]);
        set_session_cookie($token, $expires);
    }
    return $s;
}

function load_session_by_hash(PDO $db, string $hash): ?array
{
    $q = $db->prepare('SELECT s.token_hash, s.site_ok, s.role, s.user_id, s.expires_at, u.name AS user_name, u.active AS user_active
                       FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?');
    $q->execute([$hash]);
    return $q->fetch() ?: null;
}

function create_session(PDO $db): array
{
    $token = bin2hex(random_bytes(32));
    $expires = time() + SESSION_DAYS * 86400;
    $db->prepare('INSERT INTO sessions (token_hash, site_ok, expires_at, last_active) VALUES (?, 1, FROM_UNIXTIME(?), NOW())')
        ->execute([hash('sha256', $token), $expires]);
    set_session_cookie($token, $expires);
    // Housekeeping.
    $db->exec('DELETE FROM sessions WHERE expires_at < NOW()');
    $db->exec('DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL 1 DAY');
    return ['token_hash' => hash('sha256', $token), 'site_ok' => 1, 'role' => null, 'user_id' => null, 'user_name' => null];
}

function client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 0, 45);
}

function check_rate_limit(PDO $db): void
{
    $q = $db->prepare('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND attempted_at > NOW() - INTERVAL ? MINUTE');
    $q->execute([client_ip(), FAILED_LOGIN_WINDOW]);
    if ((int) $q->fetchColumn() >= MAX_FAILED_LOGINS) {
        fail('Too many wrong passwords. Please wait ' . FAILED_LOGIN_WINDOW . ' minutes and try again.', 429);
    }
}

function record_failed_login(PDO $db): void
{
    $db->prepare('INSERT INTO login_attempts (ip) VALUES (?)')->execute([client_ip()]);
}

// Usernames match ignoring case and spaces ("Manju Designer" = "manjudesigner").
function same_username(string $a, string $b): bool
{
    $norm = fn($s) => mb_strtolower(preg_replace('/\s+/u', '', $s));
    return $norm($a) === $norm($b);
}

// The admin's sign-in: set from the Team page (stored in app_meta), else
// admin_username / admin_password from config.php.
function admin_username(PDO $db): string
{
    return meta($db, 'admin_username') ?? ADMIN_USERNAME;
}

function admin_password_ok(PDO $db, string $given, array $config): bool
{
    $hash = meta($db, 'admin_password_hash');
    return $hash !== null ? password_verify($given, $hash) : config_password_matches($given, $config['admin_password']);
}

function set_meta(PDO $db, string $key, string $value): void
{
    $db->prepare('INSERT INTO app_meta (meta_key, meta_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)')
        ->execute([$key, $value]);
}

// Passwords in config.php may be plain text or a password_hash() value.
function config_password_matches(string $given, string $configured): bool
{
    if (preg_match('/^\$(2y|argon2i|argon2id)\$/', $configured)) {
        return password_verify($given, $configured);
    }
    return hash_equals($configured, $given);
}

function user_list(PDO $db, bool $includeInactive = false): array
{
    $rows = $db->query('SELECT name, username, password_hash IS NOT NULL AS has_password, active, position FROM users'
        . ($includeInactive ? '' : ' WHERE active = 1') . ' ORDER BY position, name')->fetchAll();
    return array_map(fn($r) => [
        'name' => $r['name'],
        'username' => $r['username'] ?? $r['name'],
        'has_password' => (bool) $r['has_password'],
        'active' => (bool) $r['active'],
    ], $rows);
}

// Before the admin has ever signed in, fill the employee list from the
// existing tasks so people can pick their name.
function ensure_users(PDO $db): void
{
    if ((int) $db->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) {
        return;
    }
    $names = $db->query('SELECT employee FROM tasks GROUP BY employee ORDER BY MIN(created_at), employee')->fetchAll(PDO::FETCH_COLUMN);
    $ins = $db->prepare('INSERT IGNORE INTO users (name, position) VALUES (?, ?)');
    foreach ($names as $i => $name) {
        $ins->execute([$name, $i]);
    }
}

function session_payload(PDO $db, ?array $s): array
{
    // Sign-in is one step now (username + password), so there is no
    // separate dashboard password and no list of names.
    $siteOk = true;
    $user = null;
    if ($s && $s['role'] === 'admin' && ADMIN_ENTRY) {
        $user = ['role' => 'admin', 'name' => ADMIN_NAME];
    } elseif ($s && $s['role'] === 'employee' && $s['user_name'] !== null && !ADMIN_ENTRY) {
        $user = ['role' => 'employee', 'name' => $s['user_name']];
    }
    // The team site lists people to choose from (names only).
    $users = [];
    if (!ADMIN_ENTRY) {
        ensure_users($db);
        $users = array_map(fn($u) => ['name' => $u['name'], 'has_password' => $u['has_password']], user_list($db));
    }
    return [
        'site_ok' => $siteOk,
        'user' => $user,
        'users' => $users,
        'entry' => ADMIN_ENTRY ? 'admin' : 'team',
        'idle_minutes' => IDLE_MINUTES,
        'today' => date('Y-m-d'),
        'tracking_start' => $user ? (meta($db, 'tracking_start') ?? date('Y-m-d')) : null,
        'admin_username' => $user && $user['role'] === 'admin' ? admin_username($db) : null,
        'video' => $user ? ['shooter' => VIDEO_SHOOTER, 'editors' => VIDEO_EDITORS, 'reviewer' => VIDEO_REVIEWER] : null,
    ];
}

// ---------------------------------------------------------------------------
// Seeding (admin only): bring the seeded task list in line with tasks-seed.js
// when SEED_VERSION is newer than the stored one. Seeded tasks no longer
// listed are removed (with their history), matching tasks keep their id and
// history and get the new position, new tasks are added, and tasks added from
// the dashboard are left alone.
// ---------------------------------------------------------------------------

function apply_seed(PDO $db, int $version, array $seed): bool
{
    $db->query("SELECT GET_LOCK('sop_dashboard_apply_seed', 10)");
    try {
        $current = $db->query("SELECT meta_value FROM app_meta WHERE meta_key = 'seed_version'")->fetchColumn();
        if ($current !== false && (int) $current >= $version) {
            return false;
        }

        $rows = [];
        foreach ($seed as $s) {
            if (!is_array($s)) {
                fail('Invalid tasks.');
            }
            $weekly = stripos((string) ($s['title'] ?? ''), '(Weekly)') !== false;
            [$frequency, $dueDay] = isset($s['frequency'])
                ? frequency_params($s)
                : ($weekly ? ['weekly', 1] : ['daily', null]);
            $rows[] = [
                'employee' => str_param($s, 'employee', 100),
                'title' => str_param($s, 'title', 200),
                'position' => (int) ($s['position'] ?? 0),
                'frequency' => $frequency,
                'due_day' => $dueDay,
            ];
        }

        $db->beginTransaction();
        $existing = $db->query('SELECT id, employee, title, from_seed FROM tasks')->fetchAll();
        $key = fn($r) => $r['employee'] . "\x1F" . $r['title'];
        $seedKeys = [];
        foreach ($rows as $r) {
            $seedKeys[$key($r)] = $r;
        }
        $byKey = [];
        foreach ($existing as $t) {
            $byKey[$key($t)] = $t;
            if ((int) $t['from_seed'] === 1 && !isset($seedKeys[$key($t)])) {
                $db->prepare('DELETE FROM tasks WHERE id = ?')->execute([$t['id']]);
            }
        }
        $update = $db->prepare('UPDATE tasks SET position = ?, from_seed = 1 WHERE id = ?');
        $insert = $db->prepare('INSERT INTO tasks (id, employee, title, position, from_seed, frequency, due_day) VALUES (?, ?, ?, ?, 1, ?, ?)');
        foreach ($rows as $r) {
            if (isset($byKey[$key($r)])) {
                $update->execute([$r['position'], $byKey[$key($r)]['id']]);
            } else {
                $insert->execute([uuid4(), $r['employee'], $r['title'], $r['position'], $r['frequency'], $r['due_day']]);
            }
        }
        $db->prepare("INSERT INTO app_meta (meta_key, meta_value) VALUES ('seed_version', ?)
                      ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)")->execute([(string) $version]);
        $db->commit();
        return true;
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    } finally {
        $db->query("SELECT RELEASE_LOCK('sop_dashboard_apply_seed')");
    }
}

// Add employees from tasks-seed.js that aren't in the users table yet, and
// keep their order. Removed employees stay removed.
function sync_employees(PDO $db, array $names): void
{
    $ins = $db->prepare('INSERT INTO users (name, position) VALUES (?, ?) ON DUPLICATE KEY UPDATE position = VALUES(position)');
    foreach (array_values($names) as $i => $name) {
        if (is_string($name) && trim($name) !== '' && mb_strlen($name) <= 100 && strcasecmp(trim($name), ADMIN_NAME) !== 0) {
            $ins->execute([trim($name), $i]);
        }
    }
}

// ---------------------------------------------------------------------------
// Sign-in actions (no sign-in needed)
// ---------------------------------------------------------------------------

$session = load_session($db);

switch ($action) {
    case 'session':
        respond(200, ['data' => session_payload($db, $session)]);

    case 'siteLogin':
        check_rate_limit($db);
        if (!config_password_matches(password_param($input), $config['site_password'])) {
            record_failed_login($db);
            fail('Wrong password.', 401, 'wrong_password');
        }
        if (!$session) {
            $session = create_session($db);
        } else {
            $db->prepare('UPDATE sessions SET site_ok = 1 WHERE token_hash = ?')->execute([$session['token_hash']]);
            $session['site_ok'] = 1;
        }
        respond(200, ['data' => session_payload($db, $session)]);

    case 'adminLogin':
        // The admin site asks for the admin username and password.
        if (!ADMIN_ENTRY) {
            fail('Sign in as admin from the admin address.', 403);
        }
        check_rate_limit($db);
        $username = is_string($input['username'] ?? null) ? $input['username'] : '';
        $passOk = admin_password_ok($db, password_param($input), $config);
        if (!same_username($username, admin_username($db)) || !$passOk) {
            record_failed_login($db);
            fail('Wrong username or password.', 401, 'wrong_password');
        }
        if ($session) {
            $db->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$session['token_hash']]);
        }
        $session = create_session($db);
        $db->prepare("UPDATE sessions SET role = 'admin' WHERE token_hash = ?")->execute([$session['token_hash']]);
        $session = load_session_by_hash($db, $session['token_hash']);
        respond(200, ['data' => session_payload($db, $session)]);

    case 'userLogin':
        if (ADMIN_ENTRY) {
            fail('Please sign in.', 401, 'admin_login');
        }
        // Username (the person's name on the Team page) + their password.
        check_rate_limit($db);
        $name = str_param($input, 'name', 100);
        $password = password_param($input);
        ensure_users($db);
        $u = null;
        foreach ($db->query('SELECT id, name, username, password_hash FROM users WHERE active = 1')->fetchAll() as $row) {
            if (same_username($row['username'] ?? $row['name'], $name)) {
                $u = $row;
                break;
            }
        }
        // The name chosen on the sign-in screen must be the same person.
        $person = is_string($input['person'] ?? null) ? $input['person'] : null;
        if ($u && $person !== null && $person !== '' && $person !== $u['name']) {
            $u = null;
        }
        if (!$u || $u['password_hash'] === null || !password_verify($password, $u['password_hash'])) {
            record_failed_login($db);
            fail('Wrong username or password.', 401, 'wrong_password');
        }
        $role = 'employee';
        $userId = (int) $u['id'];
        // New token on every sign-in (prevents session fixation).
        if ($session) {
            $db->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$session['token_hash']]);
        }
        $session = create_session($db);
        $db->prepare('UPDATE sessions SET role = ?, user_id = ? WHERE token_hash = ?')->execute([$role, $userId, $session['token_hash']]);
        $session = load_session_by_hash($db, $session['token_hash']);
        respond(200, ['data' => session_payload($db, $session)]);

    case 'switchUser':
        if ($session) {
            $db->prepare('UPDATE sessions SET role = NULL, user_id = NULL WHERE token_hash = ?')->execute([$session['token_hash']]);
            $session['role'] = null;
            $session['user_id'] = null;
            $session['user_name'] = null;
        }
        respond(200, ['data' => session_payload($db, $session)]);

    case 'logout':
        if ($session) {
            $db->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([$session['token_hash']]);
        }
        set_session_cookie('', time() - 3600);
        respond(200, ['data' => session_payload($db, null)]);
}

// ---------------------------------------------------------------------------
// Everything below needs a signed-in person.
// ---------------------------------------------------------------------------

if (ADMIN_ENTRY && (!$session || $session['role'] !== 'admin')) {
    fail('Please sign in.', 401, 'admin_login');
}
if (!$session || (int) $session['site_ok'] !== 1) {
    fail('Please sign in.', 401, 'site_login');
}
if ($session['role'] === 'admin' && ADMIN_ENTRY) {
    $isAdmin = true;
    $me = null;
} elseif ($session['role'] === 'employee' && $session['user_name'] !== null) {
    $isAdmin = false;
    $me = $session['user_name'];
} else {
    fail('Please choose who you are.', 401, 'user_login');
}

function require_admin(bool $isAdmin): void
{
    if (!$isAdmin) {
        fail('Only the admin can do that.', 403);
    }
}

// Employees may only touch their own tasks.
function require_own_task(PDO $db, bool $isAdmin, ?string $me, string $taskId): array
{
    $q = $db->prepare('SELECT id, employee, title, position FROM tasks WHERE id = ?');
    $q->execute([$taskId]);
    $t = $q->fetch();
    if (!$t) {
        fail('That task no longer exists.', 404);
    }
    if (!$isAdmin && $t['employee'] !== $me) {
        fail('That task belongs to someone else.', 403);
    }
    return $t;
}

// ---- Doctor videos --------------------------------------------------------
// The shooter adds shoots and topics and assigns editing to one of the
// editors. An edited video needs approval from the reviewer and the other
// editor (both). Names can be changed in config.php.

function video_approvers(string $editor): array
{
    $others = array_filter(VIDEO_EDITORS, fn($e) => $e !== $editor);
    return array_values(array_unique(array_merge([VIDEO_REVIEWER], $others)));
}

function video_team_member(bool $isAdmin, ?string $me): bool
{
    return $isAdmin || in_array($me, array_merge([VIDEO_SHOOTER, VIDEO_REVIEWER], VIDEO_EDITORS), true);
}

function require_shooter(bool $isAdmin, ?string $me): void
{
    if (!$isAdmin && $me !== VIDEO_SHOOTER) {
        fail('Only ' . VIDEO_SHOOTER . ' or the admin can do that.', 403);
    }
}

function load_video(PDO $db, string $id): array
{
    $q = $db->prepare('SELECT * FROM videos WHERE id = ?');
    $q->execute([$id]);
    $v = $q->fetch();
    if (!$v) {
        fail('That video no longer exists.', 404);
    }
    return $v;
}

function topics_param(array $in): array
{
    $topics = $in['topics'] ?? [];
    if (!is_array($topics) || count($topics) > 200) {
        fail('Invalid topics.');
    }
    $out = [];
    foreach ($topics as $t) {
        if (!is_string($t)) {
            fail('Invalid topics.');
        }
        $t = trim($t);
        if ($t !== '') {
            $out[] = mb_substr($t, 0, 300);
        }
    }
    return $out;
}

function employee_exists(PDO $db, string $name): bool
{
    $q = $db->prepare('SELECT 1 FROM users WHERE name = ? AND active = 1');
    $q->execute([$name]);
    return (bool) $q->fetchColumn();
}

switch ($action) {
    case 'init':
        require_admin($isAdmin);
        $tasks = $input['tasks'] ?? null;
        $employees = $input['employees'] ?? [];
        if (!is_array($tasks) || !is_array($employees)) {
            fail('Invalid tasks.');
        }
        $changed = apply_seed($db, (int) ($input['version'] ?? 0), $tasks);
        ensure_users($db);
        sync_employees($db, $employees);
        respond(200, ['data' => $changed]);

    case 'listTasks':
        $cols = 'id, employee, title, position, frequency, due_day, starts_on, ends_on, state, state_on, created_at';
        if ($isAdmin) {
            $q = $db->query("SELECT $cols FROM tasks ORDER BY position, created_at");
        } else {
            $q = $db->prepare("SELECT $cols FROM tasks WHERE employee = ? ORDER BY position, created_at");
            $q->execute([$me]);
        }
        $rows = $q->fetchAll();
        foreach ($rows as &$r) {
            $r['position'] = (int) $r['position'];
            $r['due_day'] = $r['due_day'] === null ? null : (int) $r['due_day'];
            $r['skips'] = [];
        }
        unset($r);
        // Recent "delete for now" ranges, as [from, to] pairs on each task.
        $byId = [];
        foreach ($rows as $i => $r) {
            $byId[$r['id']] = $i;
        }
        $q = $db->prepare('SELECT task_id, from_date, to_date FROM task_skips WHERE to_date >= ?');
        $q->execute([date('Y-m-d', strtotime('-70 days'))]);
        foreach ($q->fetchAll() as $k) {
            if (isset($byId[$k['task_id']])) {
                $rows[$byId[$k['task_id']]]['skips'][] = [$k['from_date'], $k['to_date']];
            }
        }
        respond(200, ['data' => $rows]);

    case 'listEntries':
    case 'listEntriesRange':
        // listEntries: the given dates (a day, a week start, a month start).
        // listEntriesRange: every entry between two dates (for pending work).
        $cols = 'e.task_id, e.work_date, e.start_time, e.end_time, e.started_on, e.ended_on, e.quantity, e.skipped, e.worked_sec, e.resumed_at';
        if ($action === 'listEntries') {
            $dates = $input['dates'] ?? (isset($input['date']) ? [$input['date']] : null);
            if (!is_array($dates) || !$dates || count($dates) > 10) {
                fail('Invalid dates.');
            }
            $dates = array_values(array_unique(array_map(fn($d) => date_param(['d' => $d], 'd'), $dates)));
            $where = 'e.work_date IN (' . implode(',', array_fill(0, count($dates), '?')) . ')';
            $params = $dates;
        } else {
            $from = date_param($input, 'from');
            $to = date_param($input, 'to');
            if ((strtotime($to) - strtotime($from)) / 86400 > 200) {
                fail('Choose a shorter range.');
            }
            $where = 'e.work_date BETWEEN ? AND ?';
            $params = [$from, $to];
        }
        if (!$isAdmin) {
            $where .= ' AND t.employee = ?';
            $params[] = $me;
        }
        $q = $db->prepare("SELECT $cols FROM task_entries e JOIN tasks t ON t.id = e.task_id WHERE $where");
        $q->execute($params);
        $rows = $q->fetchAll();
        foreach ($rows as &$r) {
            $r['quantity'] = $r['quantity'] === null ? null : (int) $r['quantity'];
            $r['skipped'] = (bool) $r['skipped'];
            $r['worked_sec'] = $r['worked_sec'] === null ? null : (int) $r['worked_sec'];
        }
        respond(200, ['data' => $rows]);

    case 'listWorkDates':
        $employee = $isAdmin ? str_param($input, 'employee', 100) : $me;
        $q = $db->prepare('SELECT DISTINCT COALESCE(e.started_on, e.work_date) FROM task_entries e JOIN tasks t ON t.id = e.task_id
                           WHERE t.employee = ? AND COALESCE(e.started_on, e.work_date) BETWEEN ? AND ? AND e.start_time IS NOT NULL');
        $q->execute([$employee, date_param($input, 'from'), date_param($input, 'to')]);
        respond(200, ['data' => $q->fetchAll(PDO::FETCH_COLUMN)]);

    case 'listNotes':
        $date = date_param($input, 'date');
        if ($isAdmin) {
            $q = $db->prepare('SELECT employee, body FROM notes WHERE work_date = ?');
            $q->execute([$date]);
        } else {
            $q = $db->prepare('SELECT employee, body FROM notes WHERE work_date = ? AND employee = ?');
            $q->execute([$date, $me]);
        }
        respond(200, ['data' => $q->fetchAll()]);

    case 'insertTask':
        // The admin can create a task for anyone; employees only for themselves.
        $employee = $isAdmin ? str_param($input, 'employee', 100) : $me;
        if (!employee_exists($db, $employee)) {
            fail('Choose someone on the team to assign this task to.');
        }
        $title = str_param($input, 'title', 200);
        if (array_key_exists('position', $input) && $input['position'] !== null) {
            $position = (int) $input['position'];
        } else {
            $q = $db->prepare('SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE employee = ?');
            $q->execute([$employee]);
            $position = (int) $q->fetchColumn();
        }
        [$frequency, $dueDay] = frequency_params($input);
        [$startsOn, $endsOn] = span_params($input);
        $id = uuid4();
        $db->prepare('INSERT INTO tasks (id, employee, title, position, from_seed, frequency, due_day, starts_on, ends_on) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)')
            ->execute([$id, $employee, $title, $position, $frequency, $dueDay, $startsOn, $endsOn]);
        respond(200, ['data' => ['id' => $id]]);

    case 'updateTask':
        // Admin: rename, change Daily/Weekly/Monthly and due day, or reassign.
        require_admin($isAdmin);
        $t = require_own_task($db, true, null, id_param($input, 'id'));
        $q = $db->prepare('SELECT frequency, due_day, starts_on, ends_on FROM tasks WHERE id = ?');
        $q->execute([$t['id']]);
        $current = $q->fetch();
        [$startsOn, $endsOn] = span_params($input, $current);
        $title = isset($input['title']) ? str_param($input, 'title', 200) : $t['title'];
        [$frequency, $dueDay] = frequency_params($input, $current);
        $employee = isset($input['employee']) ? str_param($input, 'employee', 100) : $t['employee'];
        $position = (int) $t['position'];
        if ($employee !== $t['employee']) {
            if (!employee_exists($db, $employee)) {
                fail('Choose someone on the team to assign this task to.');
            }
            $q = $db->prepare('SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE employee = ?');
            $q->execute([$employee]);
            $position = (int) $q->fetchColumn();
        }
        $db->prepare('UPDATE tasks SET title = ?, frequency = ?, due_day = ?, starts_on = ?, ends_on = ?, employee = ?, position = ? WHERE id = ?')
            ->execute([$title, $frequency, $dueDay, $startsOn, $endsOn, $employee, $position, $t['id']]);
        respond(200, ['data' => true]);

    case 'duplicateTask':
        // Copy a task directly below the original, as "Title (2)", "(3)", ...
        $t = require_own_task($db, $isAdmin, $me, id_param($input, 'id'));
        $db->beginTransaction();
        $q = $db->prepare('SELECT id, title, frequency, due_day, starts_on, ends_on FROM tasks WHERE employee = ? ORDER BY position, created_at FOR UPDATE');
        $q->execute([$t['employee']]);
        $list = $q->fetchAll();
        $base = preg_replace('/ \(\d+\)$/', '', $t['title']);
        $max = 1;
        foreach ($list as $row) {
            if (preg_match('/^' . preg_quote($base, '/') . ' \((\d+)\)$/u', $row['title'], $m)) {
                $max = max($max, (int) $m[1]);
            }
        }
        $title = mb_substr($base, 0, 190) . ' (' . ($max + 1) . ')';
        $upd = $db->prepare('UPDATE tasks SET position = ? WHERE id = ?');
        $pos = 0;
        $newId = uuid4();
        foreach ($list as $row) {
            $upd->execute([$pos++, $row['id']]);
            if ($row['id'] === $t['id']) {
                $db->prepare('INSERT INTO tasks (id, employee, title, position, from_seed, frequency, due_day, starts_on, ends_on) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)')
                    ->execute([$newId, $t['employee'], $title, $pos++, $row['frequency'], $row['due_day'], $row['starts_on'], $row['ends_on']]);
            }
        }
        $db->commit();
        respond(200, ['data' => ['id' => $newId]]);

    case 'skipTask':
        // Admin, "Delete for now": hide a task for a day, a week or a month.
        // It comes back afterwards, and that time doesn't count as pending.
        require_admin($isAdmin);
        $t = require_own_task($db, true, null, id_param($input, 'id'));
        $from = date_param($input, 'from');
        $to = date_param($input, 'to');
        if ($to < $from || (strtotime($to) - strtotime($from)) / 86400 > 31) {
            fail('Invalid dates.');
        }
        $db->prepare('INSERT IGNORE INTO task_skips (task_id, from_date, to_date) VALUES (?, ?, ?)')->execute([$t['id'], $from, $to]);
        respond(200, ['data' => true]);

    case 'setTaskState':
        // Pause a task (until resumed) or cancel it (gone from tomorrow,
        // history kept). Employees can mark their own tasks; only the admin
        // can resume / restore one (state null).
        $t = require_own_task($db, $isAdmin, $me, id_param($input, 'id'));
        $state = $input['state'] ?? null;
        if ($state !== null && $state !== 'paused' && $state !== 'cancelled') {
            fail('Invalid state.');
        }
        if ($state === null) {
            require_admin($isAdmin);
        }
        $db->prepare('UPDATE tasks SET state = ?, state_on = ? WHERE id = ?')
            ->execute([$state, $state === null ? null : date('Y-m-d'), $t['id']]);
        respond(200, ['data' => true]);

    case 'removeTask':
        // Only the admin can delete tasks.
        require_admin($isAdmin);
        $t = require_own_task($db, true, null, id_param($input, 'id'));
        $db->prepare('DELETE FROM tasks WHERE id = ?')->execute([$t['id']]);
        respond(200, ['data' => true]);

    case 'setPositions':
        $updates = $input['updates'] ?? null;
        if (!is_array($updates) || count($updates) > 500) {
            fail('Invalid updates.');
        }
        $q = $db->prepare('UPDATE tasks SET position = ? WHERE id = ?');
        $db->beginTransaction();
        foreach ($updates as $u) {
            if (!is_array($u)) {
                fail('Invalid updates.');
            }
            $id = id_param($u, 'id');
            require_own_task($db, $isAdmin, $me, $id);
            $q->execute([(int) ($u['position'] ?? 0), $id]);
        }
        $db->commit();
        respond(200, ['data' => true]);

    case 'saveEntry':
        // Start, pause and finish times are write-once and come from the
        // server's clock: sending a start_time or end_time means "stamp it now"
        // if it's empty, and pause / resume stop and restart the clock in
        // between. An existing time is never changed or cleared, and a task
        // can't be finished before it is started. `date` is the task's day, or
        // the first day of its week/month for weekly and monthly tasks.
        $taskId = id_param($input, 'task_id');
        require_own_task($db, $isAdmin, $me, $taskId);
        $q = $db->prepare('SELECT state FROM tasks WHERE id = ?');
        $q->execute([$taskId]);
        $state = $q->fetchColumn();
        if ($state === 'paused' || $state === 'cancelled') {
            fail('This task was ' . $state . ' by the admin.', 409);
        }
        $date = date_param($input, 'date');
        $today = date('Y-m-d');
        if ($date > $today) {
            fail("That day hasn't started yet.");
        }
        $wantStart = ($input['start_time'] ?? null) !== null;
        $wantEnd = ($input['end_time'] ?? null) !== null;
        $wantPause = !empty($input['pause']);
        $wantResume = !empty($input['resume']);
        $qty = $input['quantity'] ?? null;
        if ($qty !== null && (!is_int($qty) || $qty < 0 || $qty > 100000)) {
            fail('Invalid quantity.');
        }
        $db->beginTransaction();
        $cur = $db->prepare('SELECT start_time, end_time, started_on, ended_on, worked_sec, resumed_at FROM task_entries WHERE task_id = ? AND work_date = ? FOR UPDATE');
        $cur->execute([$taskId, $date]);
        $row = $cur->fetch() ?: ['start_time' => null, 'end_time' => null, 'started_on' => null, 'ended_on' => null, 'worked_sec' => null, 'resumed_at' => null];
        $nowTs = time();
        $now = date('H:i:s', $nowTs);
        $nowDt = date('Y-m-d H:i:s', $nowTs);
        $start = $row['start_time'];
        $startedOn = $row['started_on'];
        $end = $row['end_time'];
        $endedOn = $row['ended_on'];
        $worked = $row['worked_sec'] === null ? null : (int) $row['worked_sec'];
        $resumed = $row['resumed_at'];
        // Seconds in the stretch that is running now. Entries started before
        // pause existed have no worked_sec: they have run since the start.
        $running = function () use (&$start, &$startedOn, &$worked, &$resumed, $nowTs, $date) {
            if ($worked === null) {
                return max(0, $nowTs - strtotime(($startedOn ?? $date) . ' ' . $start));
            }
            return $resumed === null ? 0 : max(0, $nowTs - strtotime($resumed));
        };
        if ($start === null && $wantStart) {
            $start = $now;
            $startedOn = $today;
            $worked = 0;
            $resumed = $nowDt;
        }
        if ($end === null && $start !== null && $wantPause && ($worked === null || $resumed !== null)) {
            $worked = ($worked === null ? 0 : $worked) + $running();
            $resumed = null;
        }
        if ($end === null && $start !== null && $wantResume && $worked !== null && $resumed === null) {
            $resumed = $nowDt;
        }
        if ($end === null && $wantEnd) {
            if ($start === null) {
                $db->rollBack();
                fail('A task has to be started before it can be finished.');
            }
            if ($worked !== null) {
                $worked += $running();
                $resumed = null;
            }
            $end = $now;
            $endedOn = $today;
        }
        $db->prepare('INSERT INTO task_entries (task_id, work_date, start_time, end_time, started_on, ended_on, quantity, worked_sec, resumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                      ON DUPLICATE KEY UPDATE start_time = VALUES(start_time), end_time = VALUES(end_time),
                          started_on = VALUES(started_on), ended_on = VALUES(ended_on), quantity = VALUES(quantity),
                          worked_sec = VALUES(worked_sec), resumed_at = VALUES(resumed_at)')
            ->execute([$taskId, $date, $start, $end, $startedOn, $endedOn, $qty, $worked, $resumed]);
        $db->commit();
        respond(200, ['data' => ['start_time' => $start, 'end_time' => $end, 'started_on' => $startedOn, 'ended_on' => $endedOn,
                                 'worked_sec' => $worked, 'resumed_at' => $resumed]]);

    case 'skipEntry':
        // Admin: excuse (or un-excuse) a missed task, e.g. for a day off.
        require_admin($isAdmin);
        $taskId = id_param($input, 'task_id');
        require_own_task($db, true, null, $taskId);
        $db->prepare('INSERT INTO task_entries (task_id, work_date, skipped) VALUES (?, ?, ?)
                      ON DUPLICATE KEY UPDATE skipped = VALUES(skipped)')
            ->execute([$taskId, date_param($input, 'date'), empty($input['skipped']) ? 0 : 1]);
        respond(200, ['data' => true]);

    case 'saveNote':
        $body = $input['body'] ?? null;
        if (!is_string($body) || strlen($body) > 100000) {
            fail('Invalid note.');
        }
        $employee = str_param($input, 'employee', 100);
        if (!$isAdmin && $employee !== $me) {
            fail("You can only write your own notes.", 403);
        }
        $db->prepare('INSERT INTO notes (employee, work_date, body) VALUES (?, ?, ?)
                      ON DUPLICATE KEY UPDATE body = VALUES(body)')
            ->execute([$employee, date_param($input, 'date'), $body]);
        respond(200, ['data' => true]);

    // ---- Admin: team ------------------------------------------------------

    case 'listUsers':
        require_admin($isAdmin);
        respond(200, ['data' => user_list($db)]);

    case 'addUser':
        require_admin($isAdmin);
        $name = str_param($input, 'name', 100);
        if (strcasecmp($name, ADMIN_NAME) === 0) {
            fail('"Admin" is reserved. Choose another name.');
        }
        $password = $input['password'] ?? '';
        if (!is_string($password) || ($password !== '' && strlen($password) < 4)) {
            fail('Use a password of at least 4 characters.');
        }
        $q = $db->prepare('SELECT id, active FROM users WHERE name = ?');
        $q->execute([$name]);
        $existing = $q->fetch();
        if ($existing && (int) $existing['active'] === 1) {
            fail($name . ' is already on the team.');
        }
        $position = (int) $db->query('SELECT COALESCE(MAX(position), -1) + 1 FROM users')->fetchColumn();
        $hash = $password === '' ? null : password_hash($password, PASSWORD_DEFAULT);
        if ($existing) {
            // Bring back someone who was removed earlier (their history is kept).
            $db->prepare('UPDATE users SET active = 1, position = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?')
                ->execute([$position, $hash, $existing['id']]);
        } else {
            $db->prepare('INSERT INTO users (name, password_hash, position) VALUES (?, ?, ?)')->execute([$name, $hash, $position]);
        }
        respond(200, ['data' => user_list($db)]);

    case 'setUserPassword':
        require_admin($isAdmin);
        $name = str_param($input, 'name', 100);
        $password = password_param($input);
        if (strlen($password) < 4) {
            fail('Use a password of at least 4 characters.');
        }
        $q = $db->prepare('SELECT id FROM users WHERE name = ? AND active = 1');
        $q->execute([$name]);
        $id = $q->fetchColumn();
        if ($id === false) {
            fail('That person is not on the team.', 404);
        }
        $db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $id]);
        // Sign them out everywhere so the new password takes effect.
        $db->prepare('UPDATE sessions SET role = NULL, user_id = NULL WHERE user_id = ?')->execute([$id]);
        respond(200, ['data' => user_list($db)]);

    case 'setUsername':
        // Admin: a person's sign-in username (their name if not set).
        require_admin($isAdmin);
        $name = str_param($input, 'name', 100);
        $username = trim(str_param($input, 'username', 100));
        if (mb_strlen($username) < 2) {
            fail('Use a username of at least 2 characters.');
        }
        $q = $db->prepare('SELECT id FROM users WHERE name = ? AND active = 1');
        $q->execute([$name]);
        $id = $q->fetchColumn();
        if ($id === false) {
            fail('That person is not on the team.', 404);
        }
        foreach ($db->query('SELECT id, name, username FROM users WHERE active = 1')->fetchAll() as $row) {
            if ((int) $row['id'] !== (int) $id && (same_username($row['username'] ?? $row['name'], $username) || same_username($row['name'], $username))) {
                fail('Someone else already uses that username.');
            }
        }
        if (same_username($username, admin_username($db))) {
            fail('That is the admin username.');
        }
        $db->prepare('UPDATE users SET username = ? WHERE id = ?')->execute([$username, $id]);
        respond(200, ['data' => user_list($db)]);

    case 'setAdminLogin':
        // Admin: change the admin username and/or password (needs the current one).
        require_admin($isAdmin);
        if (!admin_password_ok($db, is_string($input['current_password'] ?? null) ? $input['current_password'] : '', $config)) {
            fail('Your current password is wrong.', 403);
        }
        $username = trim(str_param($input, 'username', 100));
        if (mb_strlen($username) < 2) {
            fail('Use a username of at least 2 characters.');
        }
        foreach ($db->query('SELECT name, username FROM users WHERE active = 1')->fetchAll() as $row) {
            if (same_username($row['username'] ?? $row['name'], $username) || same_username($row['name'], $username)) {
                fail('A team member already uses that username.');
            }
        }
        $new = is_string($input['new_password'] ?? null) ? $input['new_password'] : '';
        if ($new !== '' && strlen($new) < 6) {
            fail('Use an admin password of at least 6 characters.');
        }
        set_meta($db, 'admin_username', $username);
        if ($new !== '') {
            set_meta($db, 'admin_password_hash', password_hash($new, PASSWORD_DEFAULT));
            // Sign out other admin browsers; this one stays signed in.
            $db->prepare("DELETE FROM sessions WHERE role = 'admin' AND token_hash <> ?")->execute([$session['token_hash']]);
        }
        respond(200, ['data' => ['admin_username' => $username]]);

    case 'removeUser':
        require_admin($isAdmin);
        $name = str_param($input, 'name', 100);
        $db->prepare('UPDATE users SET active = 0 WHERE name = ?')->execute([$name]);
        respond(200, ['data' => user_list($db)]);

    // ---- Doctor videos --------------------------------------------------------

    case 'listShoots':
        if (!video_team_member($isAdmin, $me)) {
            fail('Videos are for the video team.', 403);
        }
        // Recent shoots, plus any older one with videos still in progress.
        $q = $db->prepare("SELECT id, client, shoot_date, raw_count, created_by, created_at FROM video_shoots s
                           WHERE shoot_date >= ? OR EXISTS (SELECT 1 FROM videos v WHERE v.shoot_id = s.id AND v.status <> 'approved')
                           ORDER BY shoot_date DESC, created_at DESC");
        $q->execute([date('Y-m-d', strtotime('-120 days'))]);
        $shoots = $q->fetchAll();
        $byId = [];
        foreach ($shoots as $i => &$sh) {
            $sh['raw_count'] = (int) $sh['raw_count'];
            $sh['videos'] = [];
            $byId[$sh['id']] = $i;
        }
        unset($sh);
        if ($shoots) {
            $ids = array_keys($byId);
            $in = implode(',', array_fill(0, count($ids), '?'));
            $q = $db->prepare("SELECT id, shoot_id, topic, position, editor, status, started_at, submitted_at, approved_at, rounds, note
                               FROM videos WHERE shoot_id IN ($in) ORDER BY position, created_at");
            $q->execute($ids);
            $videos = $q->fetchAll();
            $reviews = [];
            if ($videos) {
                $vin = implode(',', array_fill(0, count($videos), '?'));
                $r = $db->prepare("SELECT video_id, approver, decision, comment, decided_at FROM video_reviews WHERE video_id IN ($vin)");
                $r->execute(array_column($videos, 'id'));
                foreach ($r->fetchAll() as $row) {
                    $reviews[$row['video_id']][] = $row;
                }
            }
            foreach ($videos as $v) {
                $v['position'] = (int) $v['position'];
                $v['rounds'] = (int) $v['rounds'];
                $v['reviews'] = $reviews[$v['id']] ?? [];
                $v['approvers'] = $v['editor'] !== null ? video_approvers($v['editor']) : [];
                $shoots[$byId[$v['shoot_id']]]['videos'][] = $v;
            }
        }
        respond(200, ['data' => $shoots]);

    case 'addShoot':
        require_shooter($isAdmin, $me);
        $client = trim(str_param($input, 'client', 200));
        if ($client === '') {
            fail('Enter the client or doctor name.');
        }
        $raw = (int) ($input['raw_count'] ?? 0);
        if ($raw < 0 || $raw > 1000) {
            fail('Enter how many raw videos were shot.');
        }
        $topics = topics_param($input);
        $id = uuid4();
        $db->beginTransaction();
        $db->prepare('INSERT INTO video_shoots (id, client, shoot_date, raw_count, created_by) VALUES (?, ?, ?, ?, ?)')
            ->execute([$id, $client, date_param($input, 'shoot_date'), $raw, $isAdmin ? ADMIN_NAME : $me]);
        $ins = $db->prepare('INSERT INTO videos (id, shoot_id, topic, position) VALUES (?, ?, ?, ?)');
        foreach ($topics as $i => $t) {
            $ins->execute([uuid4(), $id, $t, $i]);
        }
        $db->commit();
        respond(200, ['data' => ['id' => $id]]);

    case 'updateShoot':
        require_shooter($isAdmin, $me);
        $client = trim(str_param($input, 'client', 200));
        $raw = (int) ($input['raw_count'] ?? 0);
        if ($client === '' || $raw < 0 || $raw > 1000) {
            fail('Check the client name and raw video count.');
        }
        $db->prepare('UPDATE video_shoots SET client = ?, shoot_date = ?, raw_count = ? WHERE id = ?')
            ->execute([$client, date_param($input, 'shoot_date'), $raw, id_param($input, 'id')]);
        respond(200, ['data' => true]);

    case 'removeShoot':
        require_shooter($isAdmin, $me);
        $db->prepare('DELETE FROM video_shoots WHERE id = ?')->execute([id_param($input, 'id')]);
        respond(200, ['data' => true]);

    case 'addVideos':
        require_shooter($isAdmin, $me);
        $shootId = id_param($input, 'shoot_id');
        $q = $db->prepare('SELECT COALESCE(MAX(position), -1) + 1 FROM videos WHERE shoot_id = ?');
        $q->execute([$shootId]);
        $pos = (int) $q->fetchColumn();
        $ins = $db->prepare('INSERT INTO videos (id, shoot_id, topic, position) SELECT ?, id, ?, ? FROM video_shoots WHERE id = ?');
        foreach (topics_param($input) as $t) {
            $ins->execute([uuid4(), $t, $pos++, $shootId]);
        }
        respond(200, ['data' => true]);

    case 'updateVideo':
        require_shooter($isAdmin, $me);
        $topic = trim(str_param($input, 'topic', 300));
        if ($topic === '') {
            fail('Enter the video topic.');
        }
        $db->prepare('UPDATE videos SET topic = ? WHERE id = ?')->execute([$topic, id_param($input, 'id')]);
        respond(200, ['data' => true]);

    case 'removeVideo':
        require_shooter($isAdmin, $me);
        $db->prepare('DELETE FROM videos WHERE id = ?')->execute([id_param($input, 'id')]);
        respond(200, ['data' => true]);

    case 'assignVideo':
        // The shooter (or admin) picks who edits a video.
        require_shooter($isAdmin, $me);
        $v = load_video($db, id_param($input, 'id'));
        $editor = $input['editor'] ?? null;
        if ($editor !== null && !in_array($editor, VIDEO_EDITORS, true)) {
            fail('Videos can be edited by ' . implode(' or ', VIDEO_EDITORS) . '.');
        }
        if ($v['status'] === 'approved') {
            fail('This video is already approved.');
        }
        $db->prepare("UPDATE videos SET editor = ?, status = ?, started_at = NULL, submitted_at = NULL, note = NULL WHERE id = ?")
            ->execute([$editor, $editor === null ? 'raw' : 'assigned', $v['id']]);
        $db->prepare('DELETE FROM video_reviews WHERE video_id = ?')->execute([$v['id']]);
        respond(200, ['data' => true]);

    case 'startVideo':
    case 'submitVideo':
        // The editor starts editing, then sends the video for approval.
        $v = load_video($db, id_param($input, 'id'));
        if (!$isAdmin && $me !== $v['editor']) {
            fail('Only ' . ($v['editor'] ?? 'the editor') . ' can do that.', 403);
        }
        if (!in_array($v['status'], ['assigned', 'editing', 'changes'], true)) {
            fail('This video is not waiting for editing.', 409);
        }
        if ($action === 'startVideo') {
            $db->prepare("UPDATE videos SET status = 'editing', started_at = COALESCE(started_at, NOW()) WHERE id = ?")->execute([$v['id']]);
        } else {
            $db->prepare("UPDATE videos SET status = 'review', started_at = COALESCE(started_at, NOW()), submitted_at = NOW(), rounds = rounds + 1 WHERE id = ?")
                ->execute([$v['id']]);
            $db->prepare('DELETE FROM video_reviews WHERE video_id = ?')->execute([$v['id']]);
        }
        respond(200, ['data' => true]);

    case 'reviewVideo':
        // Approvers: the reviewer and the other editor. Both must approve.
        $v = load_video($db, id_param($input, 'id'));
        if ($v['status'] !== 'review') {
            fail('This video is not waiting for approval.', 409);
        }
        $approvers = video_approvers((string) $v['editor']);
        if ($isAdmin || !in_array($me, $approvers, true)) {
            fail('Only ' . implode(' and ', $approvers) . ' approve this video.', 403);
        }
        $decision = $input['decision'] ?? '';
        if ($decision !== 'approved' && $decision !== 'changes') {
            fail('Invalid decision.');
        }
        $comment = is_string($input['comment'] ?? null) ? trim(mb_substr($input['comment'], 0, 2000)) : '';
        if ($decision === 'changes' && $comment === '') {
            fail('Write what needs to change.');
        }
        $db->beginTransaction();
        $db->prepare('INSERT INTO video_reviews (video_id, approver, decision, comment, decided_at) VALUES (?, ?, ?, ?, NOW())
                      ON DUPLICATE KEY UPDATE decision = VALUES(decision), comment = VALUES(comment), decided_at = VALUES(decided_at)')
            ->execute([$v['id'], $me, $decision, $comment === '' ? null : $comment]);
        if ($decision === 'changes') {
            $db->prepare("UPDATE videos SET status = 'changes', note = ? WHERE id = ?")->execute([$me . ': ' . $comment, $v['id']]);
        } else {
            $q = $db->prepare("SELECT approver FROM video_reviews WHERE video_id = ? AND decision = 'approved'");
            $q->execute([$v['id']]);
            if (!array_diff($approvers, $q->fetchAll(PDO::FETCH_COLUMN))) {
                $db->prepare("UPDATE videos SET status = 'approved', approved_at = NOW(), note = NULL WHERE id = ?")->execute([$v['id']]);
            }
        }
        $db->commit();
        respond(200, ['data' => true]);

    // ---- Reminders ------------------------------------------------------------

    case 'listReminders':
        $sql = 'SELECT id, employee, title, due_date, due_time, done_at, created_by FROM reminders
                WHERE (done_at IS NULL OR done_at > NOW() - INTERVAL 14 DAY)';
        $params = [];
        if (!$isAdmin) {
            $sql .= ' AND employee = ?';
            $params[] = $me;
        }
        $q = $db->prepare($sql . ' ORDER BY due_date, due_time IS NULL, due_time, created_at');
        $q->execute($params);
        respond(200, ['data' => $q->fetchAll()]);

    case 'addReminder':
        $employee = $isAdmin ? str_param($input, 'employee', 100) : $me;
        if ($isAdmin && !employee_exists($db, $employee)) {
            fail('Choose someone on the team.');
        }
        $dueTime = time_param($input, 'due_time');
        $id = uuid4();
        $db->prepare('INSERT INTO reminders (id, employee, title, due_date, due_time, created_by) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$id, $employee, str_param($input, 'title', 300), date_param($input, 'due_date'), $dueTime, $isAdmin ? ADMIN_NAME : $me]);
        respond(200, ['data' => ['id' => $id]]);

    case 'setReminderDone':
    case 'removeReminder':
        $id = id_param($input, 'id');
        $q = $db->prepare('SELECT employee FROM reminders WHERE id = ?');
        $q->execute([$id]);
        $owner = $q->fetchColumn();
        if ($owner === false) {
            fail('That reminder no longer exists.', 404);
        }
        if (!$isAdmin && $owner !== $me) {
            fail('That reminder belongs to someone else.', 403);
        }
        if ($action === 'removeReminder') {
            $db->prepare('DELETE FROM reminders WHERE id = ?')->execute([$id]);
        } else {
            $db->prepare('UPDATE reminders SET done_at = ' . (empty($input['done']) ? 'NULL' : 'NOW()') . ' WHERE id = ?')->execute([$id]);
        }
        respond(200, ['data' => true]);

    // ---- Admin: reports -----------------------------------------------------

    case 'reportDetail':
        // Every recorded entry in a period (optionally for one person), with
        // its task, for the detailed reports page. Work is dated by the day it
        // was finished, else started, else its scheduled day.
        require_admin($isAdmin);
        $from = date_param($input, 'from');
        $to = date_param($input, 'to');
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        if ((strtotime($to) - strtotime($from)) / 86400 > 400) {
            fail('Choose a range of up to a year.');
        }
        $day = 'COALESCE(e.ended_on, e.started_on, e.work_date)';
        $sql = "SELECT t.employee, t.title, t.frequency, t.due_day, e.task_id, e.work_date, e.start_time, e.end_time,
                       e.started_on, e.ended_on, e.quantity, e.skipped, e.worked_sec, e.resumed_at
                FROM task_entries e JOIN tasks t ON t.id = e.task_id
                WHERE $day BETWEEN ? AND ? AND (e.start_time IS NOT NULL OR e.quantity > 0 OR e.skipped = 1)";
        $params = [$from, $to];
        $who = $input['employee'] ?? null;
        if (is_string($who) && $who !== '') {
            $sql .= ' AND t.employee = ?';
            $params[] = str_param($input, 'employee', 100);
        }
        $q = $db->prepare($sql . " ORDER BY $day DESC, e.start_time DESC LIMIT 20000");
        $q->execute($params);
        $rows = $q->fetchAll();
        foreach ($rows as &$r) {
            $r['due_day'] = $r['due_day'] === null ? null : (int) $r['due_day'];
            $r['quantity'] = $r['quantity'] === null ? null : (int) $r['quantity'];
            $r['skipped'] = (bool) $r['skipped'];
            $r['worked_sec'] = $r['worked_sec'] === null ? null : (int) $r['worked_sec'];
        }
        respond(200, ['data' => ['from' => $from, 'to' => $to, 'rows' => $rows]]);


    case 'report':
        require_admin($isAdmin);
        $from = date_param($input, 'from');
        $to = date_param($input, 'to');
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        if ((strtotime($to) - strtotime($from)) / 86400 > 400) {
            fail('Choose a range of up to a year.');
        }
        // Work is counted on the day it was finished (or started).
        $day = 'COALESCE(e.ended_on, e.started_on, e.work_date)';
        $q = $db->prepare("SELECT t.employee, $day AS work_date,
                SUM(e.start_time IS NOT NULL) AS tasks_started,
                SUM(e.end_time IS NOT NULL) AS tasks_done,
                SUM(CASE WHEN e.end_time IS NULL THEN 0
                         WHEN e.worked_sec IS NOT NULL THEN e.worked_sec
                         WHEN e.started_on IS NOT NULL AND e.ended_on IS NOT NULL
                         THEN TIMESTAMPDIFF(SECOND, TIMESTAMP(e.started_on, e.start_time), TIMESTAMP(e.ended_on, e.end_time))
                         ELSE MOD(TIME_TO_SEC(e.end_time) - TIME_TO_SEC(e.start_time) + 86400, 86400) END) DIV 60 AS minutes,
                SUM(COALESCE(e.quantity, 0)) AS quantity
            FROM task_entries e JOIN tasks t ON t.id = e.task_id
            WHERE $day BETWEEN ? AND ? AND (e.start_time IS NOT NULL OR e.quantity > 0)
            GROUP BY t.employee, $day
            ORDER BY $day, t.employee");
        $q->execute([$from, $to]);
        $rows = array_map(fn($r) => [
            'employee' => $r['employee'],
            'work_date' => $r['work_date'],
            'tasks_started' => (int) $r['tasks_started'],
            'tasks_done' => (int) $r['tasks_done'],
            'minutes' => (int) $r['minutes'],
            'quantity' => (int) $r['quantity'],
        ], $q->fetchAll());
        respond(200, ['data' => ['from' => $from, 'to' => $to, 'rows' => $rows]]);

    default:
        fail('Unknown action.');
}
