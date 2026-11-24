-- An account explicitly selects a city for local recommendations. The
-- database never receives GPS coordinates, a street address or device history.
create table public.local_activity_areas (
  user_id text primary key references public.users(id) on delete cascade,
  revision uuid not null,
  enabled boolean not null default false,
  city text,
  region text,
  country text,
  snapshot jsonb not null default '{}'::jsonb,
  refreshed_at timestamptz,
  next_search_at timestamptz not null default '-infinity',
  last_push_checked_at timestamptz,
  constraint local_activity_area_scope check (
    (enabled and city is not null and char_length(city) between 2 and 80
      and country is not null and country ~ '^[A-Z]{2}$'
      and (region is null or char_length(region) between 1 and 70))
    or
    (not enabled and city is null and region is null and country is null
      and snapshot = '{}'::jsonb and refreshed_at is null)
  )
);

create index local_activity_areas_push_scan_idx
  on public.local_activity_areas (last_push_checked_at asc nulls first, user_id)
  where enabled;

alter table public.local_activity_areas enable row level security;
revoke all on public.local_activity_areas from public, anon, authenticated;
grant select, insert, update, delete on public.local_activity_areas to service_role;
create policy local_activity_service_role on public.local_activity_areas
  for all to service_role using (true) with check (true);
