-- Migration: conversation_state_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- A rolling summary of one chat session, so the prompt can stop replaying the
-- conversation verbatim.
--
-- Every turn used to resend the last twenty messages in full. Measured over the
-- Track D sweep that produced 2,687 prompt tokens against 235 completion — and
-- the ratio is structural, not a bad week: the window replays NURI's own long
-- replies alongside the parent's, and it grows with the conversation while the
-- answer does not.
--
-- The summary carries everything the recent window drops. It is refreshed only
-- when the dropped part exceeds CONTEXT_STATE_REFRESH_TOKENS (3,500 by
-- default), so a short conversation never pays for a summary of itself, and a
-- long one pays for one summarisation per few thousand tokens instead of
-- resending those tokens on every single turn.
--
-- Unlike chat_turn_logs and llm_call_logs, this DOES hold conversation content
-- — that is its purpose. It lives on chat_sessions and inherits that table's
-- RLS and its ON DELETE CASCADE, so "delete my data" already covers it and no
-- new deletion path is needed.

alter table if exists public.chat_sessions
  add column if not exists state_summary text,
  -- What the summary was built from, so a refresh knows how much of the
  -- conversation is already accounted for without re-reading every message.
  add column if not exists state_covered_tokens integer not null default 0,
  add column if not exists state_updated_at timestamptz;

comment on column public.chat_sessions.state_summary is
  'Rolling summary of everything older than the recent-message window. Capped '
  'at CONTEXT_STATE_TOKEN_LIMIT (600 tokens) — a summary allowed to grow is '
  'just the transcript again.';

comment on column public.chat_sessions.state_covered_tokens is
  'Estimated token count of the conversation the current summary covers. The '
  'refresh trigger compares against this so the same span is not summarised '
  'twice.';
