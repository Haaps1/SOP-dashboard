-- Team SOP Dashboard: Supabase schema
-- Run this once in Supabase dashboard -> SQL Editor -> New query -> Run.
-- It is safe to re-run.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  employee    text not null,
  title       text not null check (length(trim(title)) > 0),
  position    integer not null default 0,
  start_time  time,
  end_time    time,
  -- Status is never set by hand; it is derived from the times.
  status      text generated always as (
                case
                  when end_time   is not null then 'done'
                  when start_time is not null then 'in_progress'
                  else 'todo'
                end
              ) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists tasks_employee_position_idx
  on public.tasks (employee, position);

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

-- ---------------------------------------------------------------------------
-- Seed versioning
--
-- The dashboard calls apply_seed(SEED_VERSION, tasks) on every load. If the
-- stored version is older, the task list is replaced with the new one in a
-- single transaction (so two people opening the page at once can't double-seed).
-- Tasks whose employee + title still exist keep their start/end times.
-- ---------------------------------------------------------------------------

create or replace function public.apply_seed(p_version integer, p_tasks jsonb)
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

  with old as (
    delete from tasks where true
    returning employee, title, start_time, end_time
  )
  insert into tasks (employee, title, position, start_time, end_time)
  select t.employee, t.title, t.position, o.start_time, o.end_time
  from jsonb_to_recordset(p_tasks) as t(employee text, title text, position integer)
  left join lateral (
    select start_time, end_time from old
    where old.employee = t.employee and old.title = t.title
    limit 1
  ) o on true;

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

alter table public.tasks    enable row level security;
alter table public.app_meta enable row level security;  -- no policies: only apply_seed touches it

drop policy if exists "tasks: anyone can read"   on public.tasks;
drop policy if exists "tasks: anyone can insert" on public.tasks;
drop policy if exists "tasks: anyone can update" on public.tasks;
drop policy if exists "tasks: anyone can delete" on public.tasks;

create policy "tasks: anyone can read"   on public.tasks for select to anon, authenticated using (true);
create policy "tasks: anyone can insert" on public.tasks for insert to anon, authenticated with check (true);
create policy "tasks: anyone can update" on public.tasks for update to anon, authenticated using (true) with check (true);
create policy "tasks: anyone can delete" on public.tasks for delete to anon, authenticated using (true);

revoke all on function public.apply_seed(integer, jsonb) from public;
grant execute on function public.apply_seed(integer, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: push changes to every open dashboard.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;
