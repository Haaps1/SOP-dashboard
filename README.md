# Team SOP Dashboard

A daily task tracker for the team that also serves as the SOP. It is plain HTML, CSS and JS with no build step. The data is stored in MySQL through a small PHP API (`api/`), so the whole thing runs on ordinary web hosting such as Hostinger. Supabase is supported as an alternative.

- Dark theme, with one tab per employee (Anil, Madhu, Manju, Harsha, Manju Designer)
- The date shown large in the top right, with a date switcher (previous and next day, a pop-up month calendar, and a Today button). Days with recorded work have a green dot in the calendar. Every day keeps its own record, so you can pick yesterday or any past date and see what was done.
- Manju Designer's tab has a **Videos Done** column (with − and + buttons) for each task, saved per day. The box under the date adds these up ("6 videos done today") and also shows how many tasks are finished. Which tabs get this is set in `DONE_COUNTERS` in `tasks-seed.js`.
- A **Time Taken** column (end time minus start time; while a task is running it shows the time so far), plus a total for each person
- Each task shows its name, start time, end time and status
- Times can't be typed in. Each task has a **Start** button, then an **End** button (End works only after Start). Each button records the current time once. After that the time is locked, and it can't be changed or cleared, even through the database API. Past days are view-only.
- A **notepad** under the task list for each employee, one per day. It saves automatically as you type.
- Status is set automatically from the times:
  - No start time: **To Do** (red)
  - Start time set, no end time: **In Progress** (orange)
  - End time set: **Done** (green)
- You can add, duplicate, reorder (up and down arrows) or delete tasks for each employee. A copy is placed directly below the original and named "Title (2)", "Title (3)" and so on.
- Any task that is in progress on the selected day is shown in a large card at the top of the list, with its start time and how long it has been running.
- Everyone shares the same data. Open dashboards check for changes every 15 seconds, and straight away when you return to the tab. With Supabase, changes appear instantly.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Dark theme and the phone layout |
| `app.js` | UI and data layer: a PHP store, a Supabase store, and a local-only store |
| `tasks-seed.js` | Default task list per employee, `SEED_VERSION` and `DONE_COUNTERS` |
| `config.js` | Which backend to use (`php`, `supabase` or `local`) |
| `api/index.php` | PHP + MySQL API. It creates its own tables on first use. |
| `api/config.sample.php` | Template for `api/config.php`, which holds the database login. That file is not in git. |
| `.htaccess` | Forces HTTPS, makes updates show immediately, and hides private files |
| `supabase/schema.sql` | Only needed if you use Supabase instead of PHP + MySQL |

## Setup on Hostinger (PHP + MySQL)

This works on any Hostinger web hosting plan that includes PHP and MySQL (Premium, Business, Cloud and similar).

### 1. Create the database

1. In hPanel, go to **Websites → Manage → Databases → Management** (called **MySQL Databases** on some plans).
2. Enter a database name, a username and a strong password, then click **Create**. Hostinger adds a prefix, e.g. `u123456789_sop`.
3. Note the full **database name**, **username** and **password**. The host is `localhost`.

You don't need phpMyAdmin. The dashboard creates its tables itself the first time it loads.

### 2. Upload the files

1. Choose where the dashboard will live:
   - A subdomain such as `tasks.yourdomain.com` (recommended): go to **Domains → Subdomains** and create it.
   - The main domain: use `public_html`. Only do this if nothing else is on that domain.
2. Open **Files → File Manager** and go to that folder.
3. Upload the site zip and choose **Extract**. The folder should then contain `index.html`, `styles.css`, `app.js`, `config.js`, `tasks-seed.js`, `.htaccess` and the `api/` folder.

### 3. Enter the database details

1. In File Manager, open `api/config.php`. If it isn't there, copy `api/config.sample.php` to `api/config.php`.
2. Fill in `db_name`, `db_user` and `db_pass` from step 1. Leave `db_host` as `localhost`.
3. Save the file.

### 4. Turn on SSL and open the site

In hPanel, open **Security → SSL** and make sure the domain or subdomain has an active certificate. Then open the address. If something is wrong with the database settings, a red bar at the top says what to fix.

### Updating the site later

Upload the changed files again. **Don't overwrite `api/config.php`**, because it holds your database password.

Alternatively, use hPanel **Advanced → Git** to deploy straight from `https://github.com/Haaps1/SOP-dashboard.git`:
- For a private repository, add the SSH key Hostinger shows to GitHub under **Settings → Deploy keys**, and use `git@github.com:Haaps1/SOP-dashboard.git`.
- The target folder must be empty for the first deploy.
- After the first deploy, create `api/config.php` in File Manager as in step 3. Git deploys don't touch it, because it isn't in the repository.
- Optional: add the **Auto deployment** webhook URL to GitHub under **Settings → Webhooks**, so that every push updates the site.

### Backups

Everything is in the MySQL database. hPanel's **Backups** section includes databases, and you can also export it any time from **Databases → phpMyAdmin → Export**.

## Using Supabase instead (optional)

1. Create a project at [supabase.com](https://supabase.com), open **SQL Editor**, and run all of `supabase/schema.sql`.
2. In `config.js`, set `backend: "supabase"` and paste the **Project URL** and **anon public** key from **Project Settings → API**. Never use the `service_role` key.
3. Upload the site as above. The `api/` folder isn't needed.

Set `backend: "local"` to try the dashboard with data saved only in your browser.

## Editing the default task list

1. Edit `tasks-seed.js`.
2. **Increase `SEED_VERSION` by one** (for example, `1` to `2`).
3. Deploy.

On the next page load, the database is rewritten to match the new list. The rewrite happens in one transaction inside the `apply_seed` database function, so two people opening the page at the same moment can't seed it twice.

- Tasks that are still in the list, with the same employee and title, keep their full daily history.
- Tasks taken out of `tasks-seed.js` are removed, together with their history.
- Tasks added from the dashboard are never touched by a reseed.
- The order of the seeded tasks is reset to the order in `tasks-seed.js`. Any reordering done on the dashboard is overwritten.

If you add or delete tasks from the dashboard and don't change `SEED_VERSION`, nothing is overwritten.

## Database

The PHP API (`api/index.php`) and `supabase/schema.sql` create the same tables. The column types below are the Supabase ones; MySQL uses the closest equivalents.

`tasks` is the standing task list. It is the same every day.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key |
| `employee` | text | `Anil`, `Madhu`, `Manju`, `Harsha`, `Manju Designer` |
| `title` | text | Task name |
| `position` | int | Sort order within an employee |
| `from_seed` | boolean | `true` if the task comes from `tasks-seed.js`, `false` if it was added from the dashboard |
| `created_at`, `updated_at` | timestamptz | `updated_at` is maintained by a trigger |

`task_entries` holds one row per task per day. This is the history the date switcher reads.

| Column | Type | Notes |
| --- | --- | --- |
| `task_id` | uuid | The task. Deleting the task deletes its entries. |
| `work_date` | date | The day. Together with `task_id`, this is the primary key. |
| `start_time` | time | Null means not started that day |
| `end_time` | time | Null means not finished that day |
| `quantity` | int | How many items were done that day (the Videos Done column). Null or 0 or more. |
| `status` | text | Supabase only. **Generated column**: `todo`, `in_progress` or `done`, calculated from the times. The dashboard works out status the same way. |
| `updated_at` | timestamptz | Maintained automatically |

A day with no entry for a task shows that task as **To Do**. Each new day therefore starts with everything To Do, and nothing has to be reset.

`notes` holds one notepad per employee per day (`employee`, `work_date`, `body`).

Start and end times are write-once, and an end time without a start time is refused. On PHP + MySQL, the API enforces this. To fix a genuine mistake, edit the row in phpMyAdmin. On Supabase, a trigger (`task_entries_lock_times`) enforces it; an admin can disable the trigger, edit the row, and turn it back on.

`app_meta` holds the current `seed_version`. Only the seeding step uses it.

## Security note, and the next step (logins)

At the moment, **anyone who has the link can view and edit** the dashboard. This matches the one-shared-link setup, but because clients will also get the link, the next step should be logins:

- **PHP + MySQL:** add a `users` table and a login page using PHP sessions (`password_hash` / `password_verify`). Have `api/index.php` refuse write actions unless the session belongs to staff, and optionally let clients view without logging in.
- **Supabase:** turn on Supabase Auth, and limit the insert, update and delete policies in `schema.sql` to `authenticated`.

The data layer in `app.js` is already split into store objects, so adding logins won't change the UI code.
