-- Run this in the Supabase SQL Editor for app login/profile persistence.
-- Secret values stay in backend environment variables; do not put them here.
-- The backend uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS.
-- The policies below are extra safety for any direct Postgres connections.

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

alter table public.users enable row level security;
alter table public.children enable row level security;

-- Allow the backend service role full access (service role bypasses RLS by default,
-- but explicit policies help when using Postgres direct connections).
do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'users' and policyname = 'service_role_all_users'
  ) then
    execute $p$
      create policy service_role_all_users on public.users
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies where tablename = 'children' and policyname = 'service_role_all_children'
  ) then
    execute $p$
      create policy service_role_all_children on public.children
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
