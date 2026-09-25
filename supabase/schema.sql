-- Team SOP Dashboard: Supabase schema
-- Run this once in Supabase dashboard -> SQL Editor -> New query -> Run.
-- It is safe to re-run.
--
-- Data model:
--   tasks         the standing task list for each employee (same every day)
--   task_entries  one row per task per day with that day's start/end times,
--                 so every date keeps its own history
--   notes         one notepad per employee per day

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  employee    text not null,
  title       text not null check (length(trim(title)) > 0),
  position    integer not null default 0,
  -- true for tasks that come from tasks-seed.js; false for tasks added from
  -- the dashboard (a reseed never removes those).
  from_seed   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Upgrade from the first version of this schema, where times lived on tasks.
alter table public.tasks add column if not exists from_seed boolean not null default false;
alter table public.tasks drop column if exists status;
alter table public.tasks drop column if exists start_time;
alter table public.tasks drop column if exists end_time;

create index if not exists tasks_employee_position_idx
  on public.tasks (employee, position);

create table if not exists public.task_entries (
  task_id     uuid not null references public.tasks (id) on delete cascade,
  work_date   date not null,
  start_time  time,
  end_time    time,
  -- How many items were finished that day (e.g. videos). Optional.
  quantity    integer check (quantity is null or quantity >= 0),
  -- Status is never set by hand; it is derived from the times.
  status      text generated always as (
                case
                  when end_time   is not null then 'done'
                  when start_time is not null then 'in_progress'
                  else 'todo'
                end
              ) stored,
  updated_at  timestamptz not null default now(),
  primary key (task_id, work_date)
);

alter table public.task_entries add column if not exists quantity integer
  check (quantity is null or quantity >= 0);

create index if not exists task_entries_work_date_idx
  on public.task_entries (work_date);

create table if not exists public.notes (
  employee    text not null,
  work_date   date not null,
  body        text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (employee, work_date)
);

-- Key/value store for app bookkeeping (currently just the seed version).
create table if not exists public.app_meta (
  key   text primary key,
  value text not null
);

-- Keep updated_at current.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

drop trigger if exists task_entries_touch_updated_at on public.task_entries;
create trigger task_entries_touch_updated_at
  before update on public.task_entries
  for each row execute function public.touch_updated_at();

drop trigger if exists notes_touch_updated_at on public.notes;
create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function public.touch_updated_at();

-- Start and end times are write-once: the dashboard only has Start / End
-- buttons, and once a time is recorded it can't be changed or cleared, even
-- through the API. A task also can't be ended before it is started.
-- (To correct a mistake, edit the row in the Supabase Table Editor after
-- temporarily disabling this trigger.)
create or replace function public.task_entries_lock_times()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    new.start_time := coalesce(old.start_time, new.start_time);
    new.end_time   := coalesce(old.end_time, new.end_time);
  end if;
  if new.end_time is not null and new.start_time is null then
    raise exception 'A task has to be started before it can be ended';
  end if;
  return new;
end $$;

drop trigger if exists task_entries_lock_times on public.task_entries;
create trigger task_entries_lock_times
  before insert or update on public.task_entries
  for each row execute function public.task_entries_lock_times();

-- ---------------------------------------------------------------------------
-- Seed versioning
--
-- The dashboard calls apply_seed(SEED_VERSION, tasks) on every load. If the
-- stored version is older, the seeded task list is brought in line with the
-- new one in a single transaction:
--   * seeded tasks no longer in the list are removed (with their history)
--   * tasks whose employee + title still exist keep their id and history,
--     and get the new position
--   * new tasks are added
--   * tasks added from the dashboard are left alone
-- ---------------------------------------------------------------------------

drop function if exists public.apply_seed(integer, jsonb);
create function public.apply_seed(p_version integer, p_tasks jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_version integer;
begin
  perform pg_advisory_xact_lock(hashtext('sop_dashboard_apply_seed'));

  select value::integer into current_version
  from app_meta where key = 'seed_version';

  if current_version is not null and current_version >= p_version then
    return false;
  end if;

  create temp table new_seed on commit drop as
    select * from jsonb_to_recordset(p_tasks) as t(employee text, title text, position integer);

  delete from tasks t
  where t.from_seed
    and not exists (select 1 from new_seed n where n.employee = t.employee and n.title = t.title);

  update tasks t
  set position = n.position, from_seed = true
  from new_seed n
  where n.employee = t.employee and n.title = t.title;

  insert into tasks (employee, title, position, from_seed)
  select n.employee, n.title, n.position, true
  from new_seed n
  where not exists (select 1 from tasks t where t.employee = n.employee and t.title = n.title);

  insert into app_meta (key, value) values ('seed_version', p_version::text)
  on conflict (key) do update set value = excluded.value;

  return true;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- For now the dashboard is one shared link: anyone with the link can read and
-- edit. When Supabase Auth is added, replace the write policies below with
-- ones restricted to `authenticated` (and to the task's own employee if
-- wanted), and revoke apply_seed from anon.
-- ---------------------------------------------------------------------------

alter table public.tasks        enable row level security;
alter table public.task_entries enable row level security;
alter table public.notes        enable row level security;
alter table public.app_meta     enable row level security;  -- no policies: only apply_seed touches it

do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'task_entries', 'notes'] loop
    execute format('drop policy if exists "%1$s: anyone can read"   on public.%1$I', t);
    execute format('drop policy if exists "%1$s: anyone can insert" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: anyone can update" on public.%1$I', t);
    execute format('drop policy if exists "%1$s: anyone can delete" on public.%1$I', t);
    execute format('create policy "%1$s: anyone can read"   on public.%1$I for select to anon, authenticated using (true)', t);
    execute format('create policy "%1$s: anyone can insert" on public.%1$I for insert to anon, authenticated with check (true)', t);
    execute format('create policy "%1$s: anyone can update" on public.%1$I for update to anon, authenticated using (true) with check (true)', t);
    execute format('create policy "%1$s: anyone can delete" on public.%1$I for delete to anon, authenticated using (true)', t);
  end loop;
end $$;

revoke all on function public.apply_seed(integer, jsonb) from public;
grant execute on function public.apply_seed(integer, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: push changes to every open dashboard.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['tasks', 'task_entries', 'notes'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
