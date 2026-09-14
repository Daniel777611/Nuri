-- Migration: push_notifications.sql
-- Run in the Supabase SQL editor. Safe to re-run: every statement is idempotent.
--
-- The tables behind APNs delivery, from the iOS dynamic-notification handoff
-- (v1.0, 2026-09-04), §6.
--
-- The handoff writes `user_id uuid references auth.users(id)`, because it was
-- drafted against a Supabase-Auth project. NURI does not use Supabase Auth:
-- `public.users.id` is `text`, the bcrypt hash lives in the row, and tokens are
-- signed with JWT_SECRET by this backend. §6 anticipates exactly this — "生产可
-- 根据现有命名规范调整，但必须保留用户多设备、sandbox 与 production 分离、幂等
-- 去重、失效 token、偏好与投递审计" — so the column types follow this schema
-- while every invariant it names is kept:
--
--   * one user, many devices          -> push_devices.user_id is not unique
--   * sandbox and production separate -> apns_environment in the unique keys
--   * idempotent dedupe               -> notification_events.dedupe_key unique
--   * dead tokens                     -> is_active + invalidated_at
--   * preferences and delivery audit  -> notification_preferences, _deliveries
--
-- RLS is enabled with no policies, deliberately. There is no policy granting
-- anon or authenticated any access to these tables: an APNs token identifies a
-- device and must never be readable from a browser. Every read and write goes
-- through this backend using the service-role key, after it has verified the
-- caller's own token.

create extension if not exists pgcrypto;

-- ── Devices ───────────────────────────────────────────────────────────────────
create table if not exists public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  installation_id uuid not null,
  platform text not null check (platform = 'ios'),
  bundle_id text not null,
  apns_environment text not null
    check (apns_environment in ('sandbox', 'production')),
  apns_token text not null,
  token_hash text not null,
  app_version text,
  build_number text,
  locale text,
  time_zone text,
  permission_status text not null default 'not_determined'
    check (permission_status in
           ('not_determined', 'denied', 'authorized', 'provisional')),
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  invalidated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per install per environment, so an APNs token refresh overwrites
  -- the same record instead of accumulating a new one on every launch.
  unique (bundle_id, apns_environment, installation_id)
);

create index if not exists push_devices_user_active_idx
  on public.push_devices (user_id, is_active);

-- A live token belongs to exactly one installation. Re-registering the same
-- token under a different install must retire the old row, not duplicate it.
create unique index if not exists push_devices_active_token_uidx
  on public.push_devices (bundle_id, apns_environment, token_hash)
  where is_active = true;

-- ── Preferences ───────────────────────────────────────────────────────────────
create table if not exists public.notification_preferences (
  user_id text primary key references public.users(id) on delete cascade,
  enabled boolean not null default true,
  reminders_enabled boolean not null default true,
  chat_enabled boolean not null default true,
  -- Proactive care notifications are the one type that arrives without the
  -- parent having asked for anything, so it gets its own switch and defaults
  -- on only because §12 pairs it with a hard daily cap and quiet hours.
  care_enabled boolean not null default true,
  quiet_hours_start time default '21:00',
  quiet_hours_end time default '08:00',
  time_zone text not null default 'UTC',
  max_per_day integer not null default 4 check (max_per_day between 0 and 20),
  show_preview boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ── Events ────────────────────────────────────────────────────────────────────
create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  type text not null
    check (type in ('reminder', 'task', 'chat', 'follow_up', 'system')),
  title text not null,
  body text not null,
  route text not null,
  data jsonb not null default '{}'::jsonb,
  thread_id text,
  collapse_id text,
  dedupe_key text not null unique,
  scheduled_at timestamptz not null,
  expires_at timestamptz,
  status text not null default 'queued'
    check (status in
           ('queued', 'processing', 'sent', 'partial', 'failed', 'cancelled')),
  attempt_count integer not null default 0,
  last_error text,
  -- The body an APNs payload may not carry. §4.1 caps the payload at what a
  -- lock screen needs; the full text is read back through
  -- GET /api/notifications/{id} once the app is open and the user is known.
  full_content text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_events_due_idx
  on public.notification_events (status, scheduled_at)
  where status = 'queued';

create index if not exists notification_events_user_created_idx
  on public.notification_events (user_id, created_at desc);

-- ── Deliveries ────────────────────────────────────────────────────────────────
create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.notification_events(id) on delete cascade,
  device_id uuid not null references public.push_devices(id) on delete cascade,
  apns_id uuid,
  status text not null,
  http_status integer,
  error_reason text,
  latency_ms integer,
  attempt integer not null default 1,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  -- The second line of defence behind dedupe_key: even a duplicated dispatch
  -- cannot send the same event to the same device twice.
  unique (event_id, device_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Enabled with no policies. See the header: these tables are service-role only.
alter table public.push_devices enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_events enable row level security;
alter table public.notification_deliveries enable row level security;

-- ── Atomic claim ──────────────────────────────────────────────────────────────
-- §9.2: "领取队列必须使用数据库函数或 SELECT FOR UPDATE SKIP LOCKED 等原子机制。
-- 不要先 SELECT 再逐条 UPDATE，否则 Vercel 多实例并发可能重复发送。"
--
-- PostgREST cannot express SKIP LOCKED, and the dispatcher runs on a cron that
-- several Vercel instances can enter at once, so the claim lives here where the
-- lock and the update are one statement.
create or replace function public.claim_due_notifications(batch_size integer)
returns setof public.notification_events
language plpgsql
as $$
begin
  return query
  with due as (
    select id
    from public.notification_events
    where status = 'queued'
      and scheduled_at <= now()
      and (expires_at is null or expires_at > now())
    order by scheduled_at
    limit greatest(batch_size, 0)
    for update skip locked
  )
  update public.notification_events e
     set status = 'processing',
         attempt_count = e.attempt_count + 1,
         updated_at = now()
    from due
   where e.id = due.id
  returning e.*;
end;
$$;
