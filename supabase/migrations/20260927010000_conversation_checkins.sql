-- NURI之家: what NURI asks on Home once a conversation is over.
--
-- One row per parent message that ended a conversation (backend/feed/checkin.py).
-- Written the first time Home asks after the parent went quiet, then reused
-- until the parent says something new, so the model runs once per
-- conversation rather than once per Home visit.
--
-- `status` is 'ready' with a line, or 'none' when the conversation held no
-- real subject to follow up on (a language switch, a thank-you). `summary`
-- is what was going on and what was left open, kept for NURI. `opened_at`
-- is set when the parent tapped the card and the line entered the chat.
-- The row goes with the account (cascade) and with a privacy wipe.

create table if not exists public.conversation_checkins (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text,
  source_message_id text not null,
  status text not null check (status in ('ready', 'none')),
  topic text not null default '',
  summary text not null default '',
  line text not null default '',
  locale text,
  opened_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, source_message_id)
);

create index if not exists conversation_checkins_user_idx
  on public.conversation_checkins (user_id, created_at desc);

alter table public.conversation_checkins enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'conversation_checkins'
      and policyname = 'conversation_checkins_service_role'
  ) then
    create policy conversation_checkins_service_role on public.conversation_checkins
      for all to service_role using (true) with check (true);
  end if;
end $$;
