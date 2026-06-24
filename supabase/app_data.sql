-- Run this in the Supabase SQL Editor for app login/profile persistence.
-- Secret values stay in backend environment variables; do not put them here.

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
