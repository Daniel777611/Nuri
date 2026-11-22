-- Accounts allowed to use the in-chat "#fix <feedback>" command.
--
-- backend/nuri_core/dialogue_reply.py:is_fix_reviewer and the admin
-- "fix reviewers" page have read and written this table since August, but it
-- was never in a migration and neither project had it, so #fix was off for
-- everyone and the admin list failed. Nobody becomes a reviewer until an admin
-- adds them.

create table if not exists public.fix_reviewers (
  user_id text primary key references public.users(id) on delete cascade,
  added_at timestamptz not null default now()
);

-- Only the backend (service role) reads or writes it.
alter table public.fix_reviewers enable row level security;
