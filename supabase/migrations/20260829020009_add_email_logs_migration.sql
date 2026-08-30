-- Run this in the Supabase SQL Editor.
-- Creates the email_logs table used to track daily push history per user.
-- Safe to re-run: all statements are idempotent.

create table if not exists public.email_logs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  email text not null,
  card_id text not null,
  sent_at timestamptz not null default now()
);

create index if not exists email_logs_user_sent_idx
  on public.email_logs (user_id, sent_at desc);

alter table public.email_logs enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'email_logs' and policyname = 'srole_email_logs'
  ) then
    execute $p$
      create policy srole_email_logs on public.email_logs
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
