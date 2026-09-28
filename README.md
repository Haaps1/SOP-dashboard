# Team SOP Dashboard

A daily task tracker for the team that also serves as the SOP. It is plain HTML, CSS and JS with no build step. The data is stored in MySQL through a small PHP API (`api/`), so the whole thing runs on ordinary web hosting such as Hostinger. 

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
- **Sign-in on the team site (haaps.co.in):** a dashboard password first, then people pick their name and enter their own password. Admin isn't listed there.
- **Admin site (admin.haaps.co.in, or haaps.co.in/admin):** asks for the admin password only. It has its own sign-in, separate from the team site.
- **Header:** a greeting, a live clock, and a progress ring for today's daily tasks (your own, or the whole team's for the admin), with the pending count.
- **Employees see only their own work:** their tasks, times, video counts and notes. The server enforces this, so it can't be bypassed from the browser. Employees can start and end tasks, count videos, write notes, and add, delete, reorder and duplicate their own tasks in their Daily, Weekly and Monthly lists. Only the admin can assign tasks to other people, or edit and reassign tasks.
- **Admin:**
  - An **Overview** of everyone for the selected day: progress, what each person is working on now, time and videos.
  - **Assign a new task** to anyone.
  - **Reports** for today, this week, last 7 days, this month, last month or custom dates, with a CSV download.
  - A **Team** page to add or remove people and set their passwords.
  - A tab per employee with full control.
- **Each person has five sections:** Daily Tasks, Weekly Tasks, Monthly Tasks, Pending and Reminders.
  - **Daily** tasks happen every work day. The work days are set in `WORK_DAYS` in `tasks-seed.js` and default to Monday to Saturday.
  - **Weekly** tasks happen once a week and are due on a weekday, e.g. Monday.
  - **Monthly** tasks happen once a month and are due on a date, e.g. the 5th.
  - **Pending** lists daily tasks that weren't finished on their day, and weekly or monthly tasks not finished by their due day. An item stays there until it's finished (Start and End work straight from the Pending list, and the real day is recorded) or the admin **excuses** it, e.g. for a day off. Pending items older than 30 days drop off. Counting starts from the day this version was installed, so there's no backlog.
  - **Reminders** have a date and an optional time. They show as Overdue, Today, Upcoming or Done, and can be added by the person or by the admin.
- Start and End times come from the **server's clock**, so changing a computer's clock can't fake them.
- The admin can **edit any task**: rename it, change it between Daily, Weekly and Monthly, set the due day, or reassign it to someone else. Tasks named "(Weekly)" were switched to weekly, due Monday, automatically.
- The admin's Overview also shows **Pending work** grouped by person, and **Employee notes** for the selected day.
- Open dashboards check for changes every 15 seconds, and straight away when you return to the tab.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Dark theme and the phone layout |
| `app.js` | UI, sign-in and data layer (a PHP store, plus a local-only store for previews) |
| `tasks-seed.js` | Default task list per employee, `SEED_VERSION` and `DONE_COUNTERS` |
| `config.js` | Which backend to use (`php` or `local`) |
| `api/index.php` | PHP + MySQL API. It creates its own tables on first use. |
| `api/config.sample.php` | Template for `api/config.php`, which holds the database login and the dashboard/admin passwords. That file is not in git. |
| `favicon.ico`, `icons/` | HAAPS logo as the browser-tab and home-screen icon |
| `admin/` | The admin site: `admin/config.js` (admin mode) and `admin/api/index.php`, which reuses `api/` with admin-only sign-in. `build.sh` copies the rest of the page into `dist/admin/`. |
| `build.sh` | Builds `dist/`, the folder to upload to `public_html`. It never includes `api/config.php`. |
| `.htaccess` | Forces HTTPS, makes updates show immediately, and hides private files |

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
3. Set `site_password`, which everyone types to open the dashboard, and `admin_password`, the admin's own password.
4. Save the file.
5. Open the dashboard, choose **Admin**, and set each employee's password on the **Team** page. People without a password can't sign in.

### 4. Turn on SSL and open the site

In hPanel, open **Security → SSL** and make sure the domain or subdomain has an active certificate. Then open the address. If something is wrong with the database settings, a red bar at the top says what to fix.

### The admin site

Run `./build.sh` and upload the contents of `dist/`. That includes an `admin` folder, so **haaps.co.in/admin** works straight away.

For **admin.haaps.co.in**:
1. In hPanel, go to **Domains → Subdomains** and create the subdomain `admin`. If hPanel asks for a folder, use `public_html/admin`, the folder from the upload.
2. Turn on SSL for the subdomain under **Security → SSL**.

Both addresses use the same database and the same `api/config.php`, and they ask for `admin_password` only.

### Updating the site later

Upload the changed files again. **Don't overwrite `api/config.php`**, because it holds your database password.

Alternatively, use hPanel **Advanced → Git** to deploy straight from `https://github.com/Haaps1/SOP-dashboard.git`:
- For a private repository, add the SSH key Hostinger shows to GitHub under **Settings → Deploy keys**, and use `git@github.com:Haaps1/SOP-dashboard.git`.
- The target folder must be empty for the first deploy.
- After the first deploy, create `api/config.php` in File Manager as in step 3. Git deploys don't touch it, because it isn't in the repository.
- Optional: add the **Auto deployment** webhook URL to GitHub under **Settings → Webhooks**, so that every push updates the site.

### Backups

Everything is in the MySQL database. hPanel's **Backups** section includes databases, and you can also export it any time from **Databases → phpMyAdmin → Export**.

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

`api/index.php` creates and upgrades these tables automatically.

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
| `updated_at` | timestamptz | Maintained automatically |

A day with no entry for a task shows that task as **To Do**. Each new day therefore starts with everything To Do, and nothing has to be reset.

`notes` holds one notepad per employee per day (`employee`, `work_date`, `body`).

`tasks.frequency` is `daily`, `weekly` or `monthly`, and `tasks.due_day` is the weekday (1 = Monday) or day of the month. A weekly task's entries use the week's Monday as `work_date`, and a monthly task's use the 1st of the month. `task_entries.started_on` and `ended_on` record the real days the work happened, and `skipped` marks an item the admin excused. `reminders` holds reminders. `app_meta.tracking_start` is the day Pending counting began.

Start and end times are write-once, and an end time without a start time is refused. The API enforces this. To fix a genuine mistake, edit the row in phpMyAdmin.

`users` holds the team: name, hashed password, and whether the person is active. Removing someone makes them inactive, so their past work stays in the reports. `sessions` holds signed-in browsers; only a hash of each browser's token is stored, and sessions last 30 days. `login_attempts` limits wrong passwords: 20 per IP address per 15 minutes.

`app_meta` holds the current `seed_version`. Only the seeding step uses it.

## Security

- The dashboard password and the admin password live only in `api/config.php`, which is never served to visitors and never committed to git. Either one may be written as plain text or as a `password_hash()` value.
- Employee passwords are stored as hashes. Changing someone's password signs them out everywhere.
- Every request is checked on the server. An employee can't read or change another person's tasks, times or notes, even by calling the API directly.
- The sign-in cookie is `HttpOnly`, `Secure` on HTTPS and `SameSite=Lax`.
