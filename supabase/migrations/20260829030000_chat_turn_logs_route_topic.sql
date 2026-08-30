-- Migration: chat_turn_logs_route_topic.sql
-- Safe to re-run: the statement is idempotent.
--
-- `route_topic` is written by router.route_metrics() (backend/router.py) on
-- every turn, but no checked-in migration ever created it. Production has the
-- column because someone added it by hand in the SQL editor; the repository
-- never learned about it.
--
-- That gap stayed invisible for as long as there was one database. Standing up
-- a second project surfaced it immediately: every turn logged
-- "Could not find the 'route_topic' column", the insert failed, and the retry
-- path failed with it — because that fallback only drops the four-model and
-- few-shot columns, and route_topic is neither. So the new environment
-- recorded no turn metrics at all while the conversation itself looked fine.
--
-- The topic is short by construction: router.route_turn() truncates it to 40
-- characters after redacting child identifiers, so it is a label ("进食抗拒与情
-- 绪反应"), never free text from the parent.
--
-- Not included here: `task_plan`, which also exists in production and which no
-- current code reads or writes. It is a leftover from an earlier version of the
-- task pipeline. Recreating a dead column in every new environment would spread
-- the confusion rather than end it; production can drop it when someone
-- confirms nothing external reads it.

alter table if exists public.chat_turn_logs
  add column if not exists route_topic text;

comment on column public.chat_turn_logs.route_topic is
  'Short redacted topic label from the per-turn router. Written by router.route_metrics().';
