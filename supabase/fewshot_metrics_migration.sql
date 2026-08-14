-- Migration: fewshot_metrics_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- Splits the few-shot exemplar pairs out of the prompt-size columns added by
-- chat_turn_logs_migration.sql. The pairs sit between the system message and
-- the real conversation, so without these they would land in history_chars —
-- the one number the history window is tuned against, and the reason that
-- window was halved from 40 to 20.
--
-- The backend tolerates their absence: a turn logged before this runs simply
-- drops these two values rather than the row (see _FEWSHOT_COLUMNS in
-- backend/main.py).

alter table public.chat_turn_logs
  add column if not exists fewshot_msgs integer,
  add column if not exists fewshot_chars integer;
