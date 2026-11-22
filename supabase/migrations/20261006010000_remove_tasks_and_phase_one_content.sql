-- Remove action cards (tasks) entirely.
--
-- The tasks tab, the in-chat plan card and the orchestration state behind
-- them are gone from the code. Their three tables and the per-conversation
-- state column are dropped.
--
-- This file first also cleared chat_messages.transition plan cards, every
-- feed_cards row and the favorites pointing at them. It was never run on
-- either project, and by 2026-11 feed_cards held cards made after phase one,
-- so that data cleanup was taken out: old plan-card transitions are ignored by
-- the clients, and the knowledge library keeps its current cards.

drop table if exists public.nuri_task_card_events;
drop table if exists public.nuri_task_cards;
drop table if exists public.tasks;

alter table if exists public.chat_sessions
  drop column if exists orchestration_state;
