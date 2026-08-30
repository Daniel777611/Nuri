-- Migration: nuri_style_rules_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- This table was referenced by the backend but never actually created — no
-- migration for it existed anywhere in the repo. The result was a feature that
-- looked wired up and did nothing:
--
--   * every `#fix` in chat paid for a model call to distil the rule, then failed
--     on insert and answered "调整没能存上";
--   * `_get_style_rules_ctx()` errored on every chat turn, was caught, and
--     returned "" — so no accumulated rule ever reached the prompt;
--   * /admin/style-rules returned a 500 that the admin page swallowed, showing
--     "0 条生效" instead of an error.
--
-- Columns are derived from the code that uses them: the `#fix` insert in
-- _fix_reply, the admin create/patch endpoints (StyleRuleCreate /
-- StyleRuleUpdate), and the active-only ordered read in _get_style_rules_ctx.

create table if not exists public.nuri_style_rules (
  id text primary key,
  -- The distilled instruction that gets appended to NURI's system prompt.
  rule text not null,
  category text,
  -- The raw reviewer feedback the rule came from, kept so a surprising rule can
  -- be traced back to what someone actually said.
  source_note text,
  -- Inactive rules stay for reference but are left out of the prompt.
  active boolean not null default true,
  -- 'chat:#fix' for in-chat corrections, 'admin' for hand-written ones.
  created_by text,
  created_at timestamptz not null default now()
);

-- Matches the read in _get_style_rules_ctx: active rules, newest first.
create index if not exists nuri_style_rules_active_idx
  on public.nuri_style_rules (active, created_at desc);

alter table public.nuri_style_rules enable row level security;

-- Service role only: written by the backend, read by it when building prompts
-- and by the admin page through it. Never touched by a signed-in app user.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'nuri_style_rules' and policyname = 'srole_nuri_style_rules'
  ) then
    execute $p$
      create policy srole_nuri_style_rules on public.nuri_style_rules
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
