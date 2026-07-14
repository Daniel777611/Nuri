-- Migration: memory_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
-- Adds normalized_inputs (canonical, auditable request log feeding the Router /
-- Context Builder) and user_memories (long-term profile facts extracted from
-- chat + task reflections).

-- ── Normalized inputs ─────────────────────────────────────────────────────────
create table if not exists public.normalized_inputs (
  id text primary key,
  user_id text references public.users(id) on delete cascade,
  child_id text references public.children(id) on delete cascade,
  session_id text references public.chat_sessions(id) on delete cascade,
  source text not null default 'chat',    -- chat | card_chat | upload | task_reflection
  raw_text text not null default '',
  normalized_text text not null default '',
  normalization_version text not null default 'v1',
  raw_image_base64 text,                  -- temporary: move to Storage + raw_image_url below
  raw_image_url text,
  raw_image_metadata jsonb,
  card_ref jsonb,
  context_hints jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists normalized_inputs_user_idx
  on public.normalized_inputs (user_id, created_at desc);
create index if not exists normalized_inputs_session_idx
  on public.normalized_inputs (session_id, created_at);

-- ── Long-term memory ──────────────────────────────────────────────────────────
create table if not exists public.user_memories (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  child_id text references public.children(id) on delete cascade,  -- null = family-wide
  category text not null,      -- preference | concern | child_state | fact | constraint
  key text not null,
  value text not null,
  confidence real not null default 0.7,
  source_type text not null,   -- chat | task_reflection
  source_id text,
  status text not null default 'active',   -- active | archived
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_confirmed_at timestamptz
);

-- Safety net against duplicate concurrent writes; the app itself upserts by
-- reading-then-writing so it can apply the confidence-gate rule below.
create unique index if not exists user_memories_upsert_key
  on public.user_memories (user_id, coalesce(child_id, ''), category, key);

create index if not exists user_memories_user_active_idx
  on public.user_memories (user_id, status, updated_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.normalized_inputs enable row level security;
alter table public.user_memories enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='normalized_inputs' and policyname='srole_normalized_inputs') then
    execute $p$ create policy srole_normalized_inputs on public.normalized_inputs for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='user_memories' and policyname='srole_user_memories') then
    execute $p$ create policy srole_user_memories on public.user_memories for all to service_role using (true) with check (true) $p$;
  end if;
end $$;
