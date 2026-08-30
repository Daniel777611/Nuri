-- Migration: llm_call_logs_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- One row per OpenAI request, from every call site in the backend.
--
-- `chat_turn_logs` already records the reply model's usage, but that is one
-- call out of the dozen a single user action can trigger: the router, memory
-- extraction, task generation and — by far the largest — the feed's web-search
-- research passes all bill tokens that no table has ever seen. A quota can
-- therefore empty out while the turn-log page reports a few hundred thousand
-- tokens for the whole week.
--
-- This table is deliberately flat and call-site-oriented rather than
-- turn-oriented: the question it exists to answer is "which call site spent the
-- money", and that has to be answerable without knowing which feature a row
-- belongs to.
--
-- Holds no prompt or completion text, for the same reason chat_turn_logs
-- doesn't: a metrics table that accumulates conversation content becomes a
-- second copy of the conversation.

create table if not exists public.llm_call_logs (
  id text primary key,
  created_at timestamptz not null default now(),

  -- Dotted, coarse-to-fine, and stable: 'chat.reply', 'content_research.primary'.
  -- Grouping the summary by this column is the entire point of the table, so a
  -- renamed call site silently splits its own history — keep these fixed.
  call_site text not null,
  model text not null default '',
  -- Which SDK surface produced the usage numbers, because the two spell every
  -- field differently: 'chat' | 'responses' | 'embeddings'.
  api text not null default 'chat',

  -- FK-free and nullable on purpose. Background work (the daily push) and
  -- anonymous sessions both produce rows, and a constraint violation here would
  -- drop the very rows most likely to be the expensive ones.
  user_id text,
  -- Groups the several calls one HTTP request fans out into, so a single feed
  -- preparation can be costed as a unit rather than as nine unrelated rows.
  request_id text,

  duration_ms integer,

  -- Normalized across both APIs: chat's prompt/completion_tokens and responses'
  -- input/output_tokens land in the same two columns.
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  -- Billed as output but invisible in the reply, which is why a 500-character
  -- answer can report 2000 completion tokens.
  reasoning_tokens integer,
  -- Billed at a discount. The gap between prompt_tokens and this is what a
  -- rotating prefix actually costs.
  cached_prompt_tokens integer,

  -- Tool-augmented calls re-send the accumulated context once per round, so
  -- this is the multiplier on prompt_tokens, not a side detail.
  tool_calls integer,

  status text not null default 'ok',  -- ok | error
  error text
);

create index if not exists llm_call_logs_created_idx
  on public.llm_call_logs (created_at desc);
-- Supports the summary endpoint's group-by, which is always windowed by time.
create index if not exists llm_call_logs_site_idx
  on public.llm_call_logs (call_site, created_at desc);
create index if not exists llm_call_logs_user_idx
  on public.llm_call_logs (user_id, created_at desc);
create index if not exists llm_call_logs_request_idx
  on public.llm_call_logs (request_id);

alter table public.llm_call_logs enable row level security;

-- Service role only: written by the backend, read by the admin page through it.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'llm_call_logs' and policyname = 'srole_llm_call_logs'
  ) then
    execute $p$
      create policy srole_llm_call_logs on public.llm_call_logs
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
