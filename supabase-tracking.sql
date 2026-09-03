-- Anonymous device tracking schema for Passport Room.
-- Run once in the Supabase SQL editor of project ejyazkthqukoubfwindh.
--
-- Security model: the anon key may ONLY insert rows and update visitors.last_seen_at.
-- There is deliberately NO select policy on either table, so the public key
-- cannot read any visit history back.

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

-- Grants: insert only for anon (+ the narrow update below). No select, no delete.
grant insert on public.visitors to anon;
grant update (last_seen_at) on public.visitors to anon;
grant insert on public.visitor_events to anon;
grant usage on sequence public.customer_code_seq to anon;
grant usage on sequence public.visitor_events_id_seq to anon;
grant all on public.visitors to service_role;
grant all on public.visitor_events to service_role;
grant all on sequence public.customer_code_seq to service_role;
grant all on sequence public.visitor_events_id_seq to service_role;

alter table public.visitors enable row level security;
alter table public.visitor_events enable row level security;

drop policy if exists "anon can insert visitors" on public.visitors;
create policy "anon can insert visitors"
  on public.visitors for insert to anon with check (true);

drop policy if exists "anon can touch last_seen" on public.visitors;
create policy "anon can touch last_seen"
  on public.visitors for update to anon using (true) with check (true);

drop policy if exists "anon can insert events" on public.visitor_events;
create policy "anon can insert events"
  on public.visitor_events for insert to anon with check (true);

-- No SELECT policy and no SELECT grant on purpose: reads are denied to anon.
-- Read your data from the Supabase dashboard or with the service role key.
