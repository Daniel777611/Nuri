-- Migration: turn_routing_metrics_migration.sql
-- Run in the Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- Adds the router and search columns to chat_turn_logs. Written by
-- router.route_metrics() and the search step.
--
-- `route_reason` is the one that earns its keep. Testers reported that action
-- cards appear with "no rules" — which was accurate, because the main model set
-- a suggest_tasks boolean against four subjective sentences and left no trace of
-- why. With a logged reason on every turn, the criteria can be tuned against a
-- week of real conversations instead of guessed at.
--
-- `route_ok` matters for a different reason: a wrong ROUTER_MODEL degrades every
-- turn to "never search, never suggest tasks", which is indistinguishable from a
-- product decision unless the failure is recorded separately from the outcome.
-- This project has already shipped one feature that looked wired up and silently
-- did nothing (nuri_style_rules); this column is how that doesn't repeat.

-- ── Router ───────────────────────────────────────────────────────────────────
-- False when the router call failed and safe defaults were used. Expect this to
-- sit very close to 100% true; a sustained dip means the model name, the key or
-- the timeout is wrong, not that parents stopped asking questions.
alter table public.chat_turn_logs
  add column if not exists route_ok boolean;
alter table public.chat_turn_logs
  add column if not exists route_error text;
-- Short free text from the router, e.g. "纯情绪，不需要外部资料".
alter table public.chat_turn_logs
  add column if not exists route_reason text;
alter table public.chat_turn_logs
  add column if not exists route_ms integer;

-- ── Search ───────────────────────────────────────────────────────────────────
alter table public.chat_turn_logs
  add column if not exists needs_search boolean;
-- 'en' | 'zh' | 'both'
alter table public.chat_turn_logs
  add column if not exists search_scope text;
-- Medical/safety turns are confined to the `authority` tier of source_domains.
alter table public.chat_turn_logs
  add column if not exists is_medical boolean;
alter table public.chat_turn_logs
  add column if not exists search_ms integer;
-- Sources that survived ranking, i.e. what the model was actually offered.
-- A healthy needs_search rate with search_hits pinned at 0 means the provider
-- is answering but everything is being filtered out — a different bug from
-- the search failing outright, and invisible without both numbers.
alter table public.chat_turn_logs
  add column if not exists search_hits integer;
-- How many of those the reply actually cited. The gap between hits and
-- citations is the honest measure of whether searching was worth the latency.
alter table public.chat_turn_logs
  add column if not exists cited_sources integer;
-- Provider name, so a vendor switch is visible in the same table as its effect
-- on latency and citation rate.
alter table public.chat_turn_logs
  add column if not exists search_provider text;

-- Supports "show me the turns where routing failed" and the needs_search rate
-- over a time window, which are the two questions this table gets asked.
create index if not exists chat_turn_logs_route_idx
  on public.chat_turn_logs (route_ok, created_at desc);
