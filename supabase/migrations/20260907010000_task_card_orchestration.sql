-- Migration: task_card_orchestration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- Three things the Task/Card orchestration spec needs and this schema had no
-- room for.
--
-- 1. The decision has to survive the turn. A card is created when a *plan* has
--    been agreed to, and a plan is agreed to across several messages: the goal
--    is confirmed in one, the constraint arrives in another, the yes comes two
--    turns later. The old pipeline read one turn, which is why 「你一天挤几次？」
--    「三次。」 was enough to produce a card. `chat_sessions.orchestration_state`
--    is where that accumulates.
--
-- 2. A card is not a task. `tasks` holds one action with a due date; a card
--    holds a core goal, the tasks that serve it, the completion criteria, the
--    fallback and the review point (spec §10). Without the goal there is
--    nothing to deduplicate against, and "same goal, said differently" becomes
--    a second card — the fragmentation the spec is written against.
--
-- 3. The evaluation runner cannot read `task_created=true`. It has to tell a
--    create from an update, an update from a duplicate, and a suppression from
--    a turn that never got near a card. `nuri_task_card_events` is one row per
--    decision, including the decisions that wrote nothing.
--
-- Both new tables hold conversation-derived content, like chat_messages does.
-- They carry the same RLS shape and cascade from the session, so an account
-- deletion already covers them.

-- ── 1. the state that spans turns ────────────────────────────────────────────

alter table if exists public.chat_sessions
  add column if not exists orchestration_state jsonb;

comment on column public.chat_sessions.orchestration_state is
  'Task/Card orchestration state for this conversation (spec §13): stage, '
  'active topic, core goal and whether it is confirmed, decision-fact '
  'sufficiency, the plan candidate, and the acceptance signal with the message '
  'index it was read from. Absent means a conversation that has not reached a '
  'plan; the reply path treats that as the default state, never as an error.';


-- ── 2. cards ─────────────────────────────────────────────────────────────────

create table if not exists public.nuri_task_cards (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  session_id                  uuid references public.chat_sessions(id) on delete cascade,
  -- Stable across rewordings of the same goal: uuid5 of the normalised goal
  -- inside one conversation. This is the key the fragmentation metric counts.
  goal_id                     text not null,
  core_goal                   text not null,
  title                       text not null default '',
  status                      text not null default 'ACTIVE',
  tasks                       jsonb not null default '[]'::jsonb,
  completion_criteria         jsonb not null default '[]'::jsonb,
  fallback                    jsonb not null default '[]'::jsonb,
  review_at                   text,
  safety_notes                jsonb not null default '[]'::jsonb,
  assumptions                 jsonb not null default '[]'::jsonb,
  -- Which message the parent agreed in. A reviewer who disagrees with "the
  -- user accepted" has to be able to go and read it (spec §16).
  source_message_id           text,
  confirmation_message_index  integer,
  plan_version                integer not null default 1,
  -- conversation_id + confirmed_plan_version + action. A retry after a timeout
  -- lands on the row it already wrote instead of a second card (§15).
  idempotency_key             text not null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create unique index if not exists nuri_task_cards_idempotency_key_idx
  on public.nuri_task_cards (idempotency_key);

create index if not exists nuri_task_cards_open_idx
  on public.nuri_task_cards (user_id, session_id, status);

create index if not exists nuri_task_cards_goal_idx
  on public.nuri_task_cards (session_id, goal_id);

alter table public.nuri_task_cards enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'nuri_task_cards'
      and policyname = 'nuri_task_cards_owner'
  ) then
    create policy nuri_task_cards_owner on public.nuri_task_cards
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;


-- ── 3. one row per decision, including the ones that wrote nothing ───────────

create table if not exists public.nuri_task_card_events (
  event_id          uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  conversation_id   uuid references public.chat_sessions(id) on delete cascade,
  -- task_card.create | update | merge | proposed | suppressed | error | ...
  event_type        text not null,
  card_id           uuid references public.nuri_task_cards(id) on delete set null,
  goal_id           text,
  -- 1-based index of the assistant message this decision belongs to. Fixed by
  -- the backend's own message sequence: the spec forbids the judge inferring it.
  message_index     integer,
  title             text,
  content_summary   text,
  -- Set on an update, pointing at the event it supersedes, so a chain of
  -- adjustments to one plan is readable as a chain rather than as four cards.
  replaces_event_id uuid references public.nuri_task_card_events(event_id) on delete set null,
  trigger_reason    text,
  -- The five gates as they stood when this was decided. This is what turns
  -- "why was there no card" into an answer.
  readiness         jsonb not null default '{}'::jsonb,
  dedupe_result     text,
  prompt_version    text,
  pipeline_version  text,
  status            text not null default 'succeeded',
  created_at        timestamptz not null default now()
);

create index if not exists nuri_task_card_events_conversation_idx
  on public.nuri_task_card_events (conversation_id, created_at desc);

create index if not exists nuri_task_card_events_goal_idx
  on public.nuri_task_card_events (goal_id);

alter table public.nuri_task_card_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'nuri_task_card_events'
      and policyname = 'nuri_task_card_events_owner'
  ) then
    create policy nuri_task_card_events_owner on public.nuri_task_card_events
      for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

comment on table public.nuri_task_card_events is
  'One row per Task/Card decision, including suppressions. A log that records '
  'only task_created=true/false cannot tell a card that was correctly withheld '
  'from a card that should have existed — spec §16.';
