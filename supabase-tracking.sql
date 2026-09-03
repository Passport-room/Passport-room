-- Passport Room — anonymous device tracking (FIX / RE-RUN SAFE)
-- Run this WHOLE file in the Supabase SQL editor of project ejyazkthqukoubfwindh.
--
-- Why the tables stayed empty: the public (anon) key was blocked by row level
-- security — every insert came back with
--   42501 "new row violates row-level security policy for table visitors".
-- This script removes every old policy on the two tables and recreates the
-- correct anon INSERT policies plus the required grants.
--
-- Security model is unchanged: anon may ONLY insert rows and update
-- visitors.last_seen_at. There is NO select policy, so the public key can
-- never read visit history back. You read the data in the dashboard.

create sequence if not exists public.customer_code_seq start 1001;

create table if not exists public.visitors (
  device_id text primary key,
  customer_code text not null unique default ('PR-' || nextval('public.customer_code_seq')),
  device_type text,
  browser text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.visitor_events (
  id bigserial primary key,
  device_id text not null references public.visitors(device_id) on delete cascade,
  event_type text not null check (event_type in ('visit', 'photo_created')),
  created_at timestamptz not null default now()
);

create index if not exists visitor_events_device_idx on public.visitor_events (device_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 1. Grants (Data API cannot see a table without these)
-- ---------------------------------------------------------------------------
grant usage on schema public to anon;
grant insert on public.visitors to anon;
grant update (last_seen_at) on public.visitors to anon;
grant insert on public.visitor_events to anon;
grant usage, select on sequence public.customer_code_seq to anon;
grant usage, select on sequence public.visitor_events_id_seq to anon;
grant all on public.visitors to service_role;
grant all on public.visitor_events to service_role;
grant all on sequence public.customer_code_seq to service_role;
grant all on sequence public.visitor_events_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 2. Wipe every existing policy on the two tables, then recreate the right ones
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in
    select policyname, tablename
      from pg_policies
     where schemaname = 'public'
       and tablename in ('visitors', 'visitor_events')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.visitors enable row level security;
alter table public.visitor_events enable row level security;

create policy "anon can insert visitors"
  on public.visitors for insert to anon, authenticated with check (true);

create policy "anon can touch last_seen"
  on public.visitors for update to anon, authenticated using (true) with check (true);

create policy "anon can insert events"
  on public.visitor_events for insert to anon, authenticated with check (true);

-- No SELECT policy and no SELECT grant on purpose: reads are denied to the
-- public key. Read your visitors from the Supabase Table editor.

-- ---------------------------------------------------------------------------
-- 3. Quick self-test (should insert one row and then remove it)
-- ---------------------------------------------------------------------------
-- set local role anon;
-- insert into public.visitors (device_id, device_type, browser)
--   values ('self-test', 'desktop', 'Chrome');
-- reset role;
-- delete from public.visitors where device_id = 'self-test';
