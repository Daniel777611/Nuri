-- Migration: task_topic_budget_migration.sql
-- Run in the Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- Task cards used to be capped at one set per conversation. Because the home
-- tab reuses a single NURI session forever, that meant one set *ever* — a
-- parent who came back a week later with a new worry could never get cards
-- again. The cap is now per topic per day, with a budget that tapers across the
-- day (main.py: TASK_CARDS_BY_TOPIC) and offers a swap once it is spent.
--
-- These two columns are what make that tunable against real conversations
-- rather than guessed at, in the same spirit as route_reason.

-- The router's short label for what a turn is about ("睡眠倒退", "辅食添加").
-- Budget is spent per topic per day, so this is also the column that shows
-- whether the labels are stable enough for that to work: a day of turns about
-- one concern that carries three different topics here means the dedup in
-- _same_topic is being defeated and the taper is leaking.
alter table public.chat_turn_logs
  add column if not exists route_topic text;

-- Why the turn did or did not draw cards, e.g. "topic 2/3: 夜醒",
-- "already covered today: 辅食添加", "over budget, offers swap". The router's
-- own reason says whether the *moment* was right; this says what the day's
-- budget then did with that, which is the half a parent actually experiences.
alter table public.chat_turn_logs
  add column if not exists task_plan text;
