-- Migration: follow_ups_migration.sql
-- Run in the Supabase SQL editor. Safe to re-run: idempotent.
--
-- Things to come back to. Deliberately separate from user_memories, which
-- answers "what is this family like" — a stable profile that should not expire.
-- A follow-up answers "on this date, ask about this", which is the opposite:
-- it has a deadline, it gets asked once, and then it is finished. Folding the
-- two together would make memories expire and follow-ups accumulate forever.
--
-- The transcript this came from is full of them: 9/1 托嬰, 7/30 簽約,
-- 兩週後回診, 下週滿兩歲. Every one is a date the parent mentioned in passing
-- and would be quietly impressed to be asked about later.

create table if not exists public.follow_ups (
  id text primary key,
  user_id  text not null references public.users(id) on delete cascade,
  -- Nullable: some follow-ups are about the parent, not a child.
  child_id text,

  -- Short handle for the thing to ask about, e.g. "托嬰適應" or "副食品重試".
  topic text not null,
  -- What to actually say — enough context that the question doesn't read as a
  -- form letter. "9/1 開始托嬰，想問適應得如何" beats "關於托嬰".
  note  text not null default '',

  -- When to raise it. Set from a date the parent gave when there is one, and
  -- otherwise inferred from the topic — see FOLLOW_UP_INTERVALS in main.py.
  due_at timestamptz not null,
  -- Whether due_at came from the parent or from us. Worth separating: an
  -- inferred date being wrong is a tuning problem, a stated date being wrong
  -- is a bug.
  due_source text not null default 'inferred',   -- stated | inferred

  source_session_id text,
  source_message_id text,

  -- pending → asked once it has been raised → done when the parent responds
  -- or the matter closes → expired when it aged out unasked.
  status   text not null default 'pending',
  asked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The scheduler's only query: this user's due, unasked items, oldest first.
create index if not exists follow_ups_due_idx
  on public.follow_ups (status, due_at);
create index if not exists follow_ups_user_idx
  on public.follow_ups (user_id, status, due_at);

-- One live follow-up per topic per child. Without this, a parent who mentions
-- 托嬰 across four turns collects four reminders and gets asked four times.
create unique index if not exists follow_ups_unique_open
  on public.follow_ups (user_id, coalesce(child_id, ''), topic)
  where status = 'pending';

alter table public.follow_ups enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'follow_ups' and policyname = 'srole_follow_ups'
  ) then
    execute $p$
      create policy srole_follow_ups on public.follow_ups
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
