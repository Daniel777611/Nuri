-- Migration: chat_turn_logs_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- One row per chat turn, for performance analysis. `normalized_inputs` already
-- records what the parent *said*; this records what it cost to answer — where
-- the wall time went, how big the prompt had grown, and how long the reply was.
--
-- Deliberately holds no message text. The prompt and reply are already in
-- chat_messages / normalized_inputs, and duplicating them here would turn a
-- metrics table into a second copy of the conversation.

create table if not exists public.chat_turn_logs (
  id text primary key,
  -- session_id is intentionally FK-free: a turn can be served from the
  -- in-memory session fallback, and a constraint violation there would drop the
  -- log for a turn that otherwise succeeded.
  session_id text,
  -- Cascades so deleting a test account from the admin page leaves nothing
  -- behind. Nullable, because anonymous sessions have no owner.
  user_id text references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),

  streamed boolean not null default false,
  model text not null default '',

  -- Latency breakdown. total_ms is the whole turn; the rest are the parts worth
  -- attributing separately, so a slow turn can be blamed on a specific stage.
  total_ms integer,
  context_ms integer,        -- parallel context assembly (memory/style/RAG/cards)
  model_ms integer,          -- the reply completion call
  first_token_ms integer,    -- streaming only: time to first visible character
  tasks_ms integer,          -- task-suggestion call, when it ran at all

  -- Sizes, in characters. Cheap to record and the fastest way to spot a prompt
  -- that has quietly grown past what the history window was meant to cap.
  system_chars integer,
  history_msgs integer,
  history_chars integer,
  reply_chars integer,

  -- Per-context-block sizes, so prompt bloat can be traced to a single source
  -- rather than guessed at.
  memory_chars integer,
  style_chars integer,
  internal_chars integer,
  profile_chars integer,
  card_chars integer,

  -- Real token counts from the API when it reports them.
  prompt_tokens integer,
  completion_tokens integer,

  suggested_tasks boolean not null default false,
  finish_reason text,
  -- ok | fallback (model failed, canned reply served) | error
  status text not null default 'ok',
  error text
);

create index if not exists chat_turn_logs_created_idx
  on public.chat_turn_logs (created_at desc);
create index if not exists chat_turn_logs_session_idx
  on public.chat_turn_logs (session_id, created_at);
create index if not exists chat_turn_logs_user_idx
  on public.chat_turn_logs (user_id, created_at desc);
-- Supports the summary endpoint's "slow or failed turns first" scans.
create index if not exists chat_turn_logs_status_idx
  on public.chat_turn_logs (status, created_at desc);

alter table public.chat_turn_logs enable row level security;

-- Service role only: these rows are written by the backend and read by the
-- admin page through it, never by a signed-in app user.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'chat_turn_logs' and policyname = 'srole_chat_turn_logs'
  ) then
    execute $p$
      create policy srole_chat_turn_logs on public.chat_turn_logs
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
