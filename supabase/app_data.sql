-- Run this in the Supabase SQL Editor.
-- Safe to re-run: all statements are idempotent.

-- ── Users ─────────────────────────────────────────────────────────────────────
create table if not exists public.users (
  id text primary key,
  email text not null unique,
  nickname text not null,
  city text not null,
  parent_role text not null default 'mom',
  top_concerns text[] not null default '{}',
  hashed_password text not null,
  created_at timestamptz not null default now()
);

-- ── Children ──────────────────────────────────────────────────────────────────
create table if not exists public.children (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  nickname text not null,
  birth_date date not null,
  gender text not null default 'other',
  allergies text[] not null default '{}',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists children_user_created_idx
  on public.children (user_id, created_at);

-- ── Chat sessions ─────────────────────────────────────────────────────────────
create table if not exists public.chat_sessions (
  id text primary key,
  user_id text references public.users(id) on delete cascade,
  title text not null default '和NURI聊天',
  source_card_id text,
  script_key text not null default 'free',
  step integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists chat_sessions_user_idx
  on public.chat_sessions (user_id, created_at desc);

-- ── Chat messages ─────────────────────────────────────────────────────────────
create table if not exists public.chat_messages (
  id text primary key,
  session_id text not null references public.chat_sessions(id) on delete cascade,
  role text not null,
  text text not null default '',
  image_base64 text,
  quick_replies jsonb not null default '[]',
  transition jsonb,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_session_idx
  on public.chat_messages (session_id, created_at);

-- ── Tasks ─────────────────────────────────────────────────────────────────────
create table if not exists public.tasks (
  id text primary key,
  user_id text references public.users(id) on delete cascade,
  title text not null,
  scope text not null default 'today',
  source text not null default '',
  done boolean not null default false,
  progress_done integer not null default 0,
  progress_total integer not null default 7,
  reflection jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists tasks_user_scope_idx
  on public.tasks (user_id, scope, created_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.users enable row level security;
alter table public.children enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.tasks enable row level security;

-- service_role bypasses RLS by default; these policies protect direct DB access
do $$ begin
  if not exists (select 1 from pg_policies where tablename='users' and policyname='srole_users') then
    execute $p$ create policy srole_users on public.users for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='children' and policyname='srole_children') then
    execute $p$ create policy srole_children on public.children for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='chat_sessions' and policyname='srole_sessions') then
    execute $p$ create policy srole_sessions on public.chat_sessions for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='chat_messages' and policyname='srole_messages') then
    execute $p$ create policy srole_messages on public.chat_messages for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='tasks' and policyname='srole_tasks') then
    execute $p$ create policy srole_tasks on public.tasks for all to service_role using (true) with check (true) $p$;
  end if;
end $$;
