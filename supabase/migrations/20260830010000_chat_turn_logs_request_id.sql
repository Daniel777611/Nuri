-- Migration: chat_turn_logs_request_id.sql
-- Safe to re-run: the statement is idempotent.
--
-- One user action fans out into several provider calls. `llm_call_logs` has
-- recorded a shared `request_id` for them all along, and the chat response now
-- returns that id, so an outside report can quote it. `chat_turn_logs` was the
-- one table that could not be reached by it: given an id from a test run, the
-- provider calls were findable and the turn's own metrics — latency, pipeline,
-- routing, whether tasks were suggested — were not.
--
-- Joining the two by timestamp is guesswork under any concurrency, which is
-- exactly the condition a test run creates.

alter table if exists public.chat_turn_logs
  add column if not exists request_id text;

create index if not exists chat_turn_logs_request_id_idx
  on public.chat_turn_logs (request_id);

comment on column public.chat_turn_logs.request_id is
  'Shared id for every provider call this turn made; also returned to the client.';
