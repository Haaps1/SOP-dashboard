<?php
// Team SOP Dashboard: data API for PHP + MySQL hosting (e.g. Hostinger).
//
// Every request is a POST with a JSON body: { "action": "...", ...params }.
// Responses are JSON: { "data": ... } on success, { "error": "..." } otherwise.
// Tables are created automatically on first use.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $status = 400): void
{
    respond($status, ['error' => $message]);
}

set_exception_handler(function (Throwable $e) {
    error_log('SOP dashboard API: ' . $e->getMessage());
    fail('Server error. Check the database settings in api/config.php.', 500);
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
date_default_timezone_set($config['timezone'] ?? 'Asia/Kolkata');

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

function uuid4(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
}

// ---------------------------------------------------------------------------
// Schema (created on first use; safe to run repeatedly)
// ---------------------------------------------------------------------------

function ensure_schema(PDO $db): void
{
    $db->exec("CREATE TABLE IF NOT EXISTS tasks (
        id CHAR(36) NOT NULL PRIMARY KEY,
        employee VARCHAR(100) NOT NULL,
        title VARCHAR(200) NOT NULL,
        position INT NOT NULL DEFAULT 0,
        from_seed TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY tasks_employee_position (employee, position)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $db->exec("CREATE TABLE IF NOT EXISTS notes (
        employee VARCHAR(100) NOT NULL,
        work_date DATE NOT NULL,
        body MEDIUMTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (employee, work_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    $db->exec("CREATE TABLE IF NOT EXISTS app_meta (
        meta_key VARCHAR(50) NOT NULL PRIMARY KEY,
        meta_value VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

// Bring the seeded task list in line with tasks-seed.js when SEED_VERSION is
// newer than the stored one. Same rules as apply_seed() in supabase/schema.sql:
// seeded tasks no longer listed are removed (with their history), matching
// tasks keep their id and history and get the new position, new tasks are
// added, and tasks added from the dashboard are left alone.
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
            $rows[] = [
                'employee' => str_param($s, 'employee', 100),
                'title' => str_param($s, 'title', 200),
                'position' => (int) ($s['position'] ?? 0),
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
        $insert = $db->prepare('INSERT INTO tasks (id, employee, title, position, from_seed) VALUES (?, ?, ?, ?, 1)');
        foreach ($rows as $r) {
            if (isset($byKey[$key($r)])) {
                $update->execute([$r['position'], $byKey[$key($r)]['id']]);
            } else {
                $insert->execute([uuid4(), $r['employee'], $r['title'], $r['position']]);
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

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

switch ($action) {
    case 'init':
        ensure_schema($db);
        $tasks = $input['tasks'] ?? null;
        if (!is_array($tasks)) {
            fail('Invalid tasks.');
        }
        respond(200, ['data' => apply_seed($db, (int) ($input['version'] ?? 0), $tasks)]);

    case 'listTasks':
        $rows = $db->query('SELECT id, employee, title, position, created_at FROM tasks ORDER BY position, created_at')->fetchAll();
        foreach ($rows as &$r) {
            $r['position'] = (int) $r['position'];
        }
        respond(200, ['data' => $rows]);

    case 'listEntries':
        $q = $db->prepare('SELECT task_id, start_time, end_time, quantity FROM task_entries WHERE work_date = ?');
        $q->execute([date_param($input, 'date')]);
        $rows = $q->fetchAll();
        foreach ($rows as &$r) {
            $r['quantity'] = $r['quantity'] === null ? null : (int) $r['quantity'];
        }
        respond(200, ['data' => $rows]);

    case 'listWorkDates':
        $q = $db->prepare('SELECT DISTINCT e.work_date FROM task_entries e JOIN tasks t ON t.id = e.task_id
                           WHERE t.employee = ? AND e.work_date BETWEEN ? AND ? AND e.start_time IS NOT NULL');
        $q->execute([str_param($input, 'employee', 100), date_param($input, 'from'), date_param($input, 'to')]);
        respond(200, ['data' => $q->fetchAll(PDO::FETCH_COLUMN)]);

    case 'listNotes':
        $q = $db->prepare('SELECT employee, body FROM notes WHERE work_date = ?');
        $q->execute([date_param($input, 'date')]);
        respond(200, ['data' => $q->fetchAll()]);

    case 'insertTask':
        $id = uuid4();
        $db->prepare('INSERT INTO tasks (id, employee, title, position, from_seed) VALUES (?, ?, ?, ?, 0)')
            ->execute([$id, str_param($input, 'employee', 100), str_param($input, 'title', 200), (int) ($input['position'] ?? 0)]);
        respond(200, ['data' => ['id' => $id]]);

    case 'removeTask':
        $db->prepare('DELETE FROM tasks WHERE id = ?')->execute([id_param($input, 'id')]);
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
            $q->execute([(int) ($u['position'] ?? 0), id_param($u, 'id')]);
        }
        $db->commit();
        respond(200, ['data' => true]);

    case 'saveEntry':
        // Start and end times are write-once: an existing time is never
        // changed or cleared, and a task can't be ended before it is started.
        $taskId = id_param($input, 'task_id');
        $date = date_param($input, 'date');
        $start = time_param($input, 'start_time');
        $end = time_param($input, 'end_time');
        $qty = $input['quantity'] ?? null;
        if ($qty !== null && (!is_int($qty) || $qty < 0 || $qty > 100000)) {
            fail('Invalid quantity.');
        }
        $db->beginTransaction();
        $cur = $db->prepare('SELECT start_time, end_time FROM task_entries WHERE task_id = ? AND work_date = ? FOR UPDATE');
        $cur->execute([$taskId, $date]);
        $row = $cur->fetch() ?: ['start_time' => null, 'end_time' => null];
        $start = $row['start_time'] ?? $start;
        $end = $row['end_time'] ?? $end;
        if ($end !== null && $start === null) {
            $db->rollBack();
            fail('A task has to be started before it can be ended.');
        }
        try {
            $db->prepare('INSERT INTO task_entries (task_id, work_date, start_time, end_time, quantity) VALUES (?, ?, ?, ?, ?)
                          ON DUPLICATE KEY UPDATE start_time = VALUES(start_time), end_time = VALUES(end_time), quantity = VALUES(quantity)')
                ->execute([$taskId, $date, $start, $end, $qty]);
        } catch (PDOException $e) {
            $db->rollBack();
            if ($e->getCode() === '23000') {
                fail('That task no longer exists.', 404);
            }
            throw $e;
        }
        $db->commit();
        respond(200, ['data' => true]);

    case 'saveNote':
        $body = $input['body'] ?? null;
        if (!is_string($body) || strlen($body) > 100000) {
            fail('Invalid note.');
        }
        $db->prepare('INSERT INTO notes (employee, work_date, body) VALUES (?, ?, ?)
                      ON DUPLICATE KEY UPDATE body = VALUES(body)')
            ->execute([str_param($input, 'employee', 100), date_param($input, 'date'), $body]);
        respond(200, ['data' => true]);

    default:
        fail('Unknown action.');
}
