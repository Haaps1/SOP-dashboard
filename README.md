# Team SOP Dashboard

A daily task tracker for the team that also serves as the SOP. It is a static site (plain HTML, CSS and JS with no build step) backed by Supabase, so it can be hosted on your own domain.

- Dark theme, with one tab per employee (Anil, Madhu, Manju, Harsha, Manju Designer)
- The date shown large in the top right, with a date switcher (previous and next day, a calendar, and a Today button). Every day keeps its own record, so you can pick yesterday or any past date and see what was done.
- Manju Designer's tab has a **Videos Done** column (with − and + buttons) for each task, saved per day. The box under the date adds these up ("6 videos done today") and also shows how many tasks are finished. Which tabs get this is set in `DONE_COUNTERS` in `tasks-seed.js`.
- A **Time Taken** column (end time minus start time; while a task is running it shows the time so far), plus a total for each person
- Each task shows its name, start time, end time and status
- Status is set automatically from the times:
  - No start time: **To Do** (red)
  - Start time set, no end time: **In Progress** (orange)
  - End time set: **Done** (green)
- You can add, duplicate, reorder (up and down arrows) or delete tasks for each employee. A copy is placed directly below the original and named "Title (2)", "Title (3)" and so on.
- Any task that is in progress on the selected day is shown in a large card at the top of the list, with its start time and how long it has been running.
- Changes appear live on every open copy of the dashboard (Supabase Realtime)

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page markup |
| `styles.css` | Dark theme and the phone layout |
| `app.js` | UI and data layer (Supabase store, plus a local-only fallback store) |
| `tasks-seed.js` | Default task list per employee, and `SEED_VERSION` |
| `config.js` | Supabase Project URL and anon key |
| `supabase/schema.sql` | Tables, RLS policies, the `apply_seed` function and Realtime setup |

## Setup

### 1. Create the Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project (the free tier is enough).
2. Open **SQL Editor**, then **New query**. Paste in all of `supabase/schema.sql` and click **Run**. The script is safe to run again.
3. Open **Project Settings**, then **API**. Copy the **Project URL** and the **anon public** key.

### 2. Connect the dashboard

Paste both values into `config.js`:

```js
window.SOP_CONFIG = {
  supabaseUrl: "https://xxxxxxxx.supabase.co",
  supabaseAnonKey: "eyJhbGciOi...",
};
```

The anon key is meant to be public, and it is fine to commit it. Row Level Security in `schema.sql` decides what it is allowed to do. **Never** put the `service_role` key in this file.

The first time the page loads, it fills the `tasks` table from `tasks-seed.js`.

If `config.js` is left empty, the dashboard runs in **local mode**: a yellow banner appears and data is saved only in that browser. This is handy for trying it out.

### 3. Host it on your domain

The files are all static, so any static host works. Upload the repo folder as it is.

- **Netlify / Cloudflare Pages / Vercel:** connect this GitHub repo. There is no build command, and the publish directory is the repo root. Then add your custom domain in the host's domain settings.
- **GitHub Pages:** open Settings, then Pages, deploy from the branch root, and set the custom domain.

To preview it on your own computer, run `python3 -m http.server` in this folder and open http://localhost:8000.

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
| `status` | text | **Generated column**: `todo`, `in_progress` or `done`, calculated from the times. It is never written directly. |
| `updated_at` | timestamptz | Maintained by a trigger |

A day with no entry for a task shows that task as **To Do**. Each new day therefore starts with everything To Do, and nothing has to be reset.

`app_meta` holds the current `seed_version`. Browsers can't read or write this table. Only `apply_seed` uses it.

## Security note, and the next step (logins)

At the moment, **anyone who has the link can view and edit** the dashboard. This matches the one-shared-link setup, but because clients will also get the link, the next step should be Supabase Auth. The rough plan:

1. Turn on **Authentication**, then **Providers**, then Email (or Google) in Supabase.
2. Add a login screen to `app.js` using `supabase.auth.signInWithOtp` or `signInWithPassword`.
3. In `schema.sql`, change the insert, update and delete policies from `anon, authenticated` to `authenticated` only (optionally also limiting each employee to their own rows). Then run `revoke execute on function apply_seed from anon;`.
4. Keep the `select` policy open to `anon` if clients should still be able to view without logging in.

The data layer in `app.js` is already split into a store object (`createSupabaseStore`), so adding auth won't touch the UI code.
