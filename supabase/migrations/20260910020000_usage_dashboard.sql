-- The /admin usage dashboard: who is online, how long, and which accounts count
-- as testers.
--
-- Conversation counts and topics already exist (chat_messages, chat_turn_logs).
-- Presence never did: nothing recorded when a parent had the app open, so
-- "online time" and "how often they come back" had no source at all. That
-- history can't be reconstructed; it starts the day this ships.

-- ── 1. user_visits ───────────────────────────────────────────────────────────
-- One row per visit. The app sends a heartbeat every minute while it is in
-- the foreground and the parent has touched it recently; the server extends
-- the visit's last_seen_at, or starts a new visit once the gap since the last
-- beat exceeds a few minutes. Duration is last_seen_at - started_at. Visit ids
-- are issued by the server, so a client can only ever extend its own.
create table if not exists public.user_visits (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  platform text
);

create index if not exists user_visits_user_started_idx
  on public.user_visits (user_id, started_at desc);
create index if not exists user_visits_last_seen_idx
  on public.user_visits (last_seen_at desc);

alter table public.user_visits enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'user_visits'
      and policyname = 'user_visits_service_role'
  ) then
    create policy user_visits_service_role on public.user_visits
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- ── 2. users.is_internal ─────────────────────────────────────────────────────
-- Team and scripted accounts, left out of the tester count by default. The
-- dashboard can flip it per account; /admin/test-accounts sets it on creation.
alter table public.users
  add column if not exists is_internal boolean not null default false;

-- The placeholder addresses scripts and the team have used so far. Nobody real
-- registers at example.com or x.com, and since email verification those
-- domains can't register at all.
update public.users
   set is_internal = true
 where is_internal = false
   and (
        email ilike '%@example.com'
     or email ilike '%@example.org'
     or email ilike '%@example.net'
     or email ilike '%@x.com'
     or email ilike 'automated\_test\_%'
     or email ilike 'test\_%'
   );
