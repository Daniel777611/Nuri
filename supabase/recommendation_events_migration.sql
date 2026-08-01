-- Migration: recommendation_events_migration.sql
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- One immutable row per recommendation interaction. The previous rollout kept
-- the whole per-user event list in one app_settings JSON value; two Vercel
-- instances could read the same value and then overwrite each other's events.
-- A database uniqueness constraint now makes each append atomic and
-- idempotent across processes.
--
-- The backend physically removes rows older than 120 days and rows after each
-- user's newest 240 immediately after a successful append.  Cleanup is
-- deliberately implemented with ordinary indexed PostgREST queries, so this
-- migration does not depend on an RPC or an undeployed database function.
--
-- `event_data` contains only the backend's bounded recommendation metadata. It
-- must never contain chat text, resource titles, email addresses, or profile
-- fields.

create table if not exists public.recommendation_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  card_id text not null,
  occurred_at timestamptz not null,
  event_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint recommendation_events_user_event_key unique (user_id, event_id),
  constraint recommendation_events_event_id_length check (
    char_length(event_id) between 1 and 80
  ),
  constraint recommendation_events_card_id_length check (
    char_length(card_id) between 1 and 128
  )
);

-- Covers the only read path: one user's newest bounded interaction history.
create index if not exists recommendation_events_user_occurred_idx
  on public.recommendation_events (user_id, occurred_at desc);

comment on table public.recommendation_events is
  'Privacy-bounded recommendation feedback: newest 240 per user, maximum age 120 days.';
comment on column public.recommendation_events.event_data is
  'Bounded metadata only; never conversation text, profile fields, titles, or private URLs.';

alter table public.recommendation_events enable row level security;

-- Events are written and read only by the backend service role. Signed-in app
-- users reach them through authenticated API endpoints, never directly.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'recommendation_events'
      and policyname = 'srole_recommendation_events'
  ) then
    execute $p$
      create policy srole_recommendation_events
        on public.recommendation_events
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
