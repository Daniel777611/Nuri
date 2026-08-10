-- Migration: one_session_per_user_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: the statement is idempotent.
--
-- NURI's premise is that a parent has one continuous conversation — they should
-- be able to scroll back through everything they have ever said in the one
-- place. The schema never enforced that, and the data drifted a long way from
-- it: 49 sessions across 13 accounts, one account holding nine.
--
-- The cause was that `POST /chat/sessions` created a row unconditionally while
-- the client decided whether it needed one, by fetching the list and picking
-- the first session without a `source_card_id`. Two requests that raced, or one
-- that ran before the list arrived, each made another session. Every new
-- session also opened with a model-written greeting, so the duplicates were not
-- only confusing, they were billed: five greeting calls on gpt-5.5 in a single
-- afternoon, 42% of that day's tokens.
--
-- The route now returns the account's existing session instead of inserting a
-- second one. This index is the guarantee underneath that — the race it cannot
-- win on its own is resolved here, and the loser re-reads the winner's row.
--
-- IMPORTANT: existing duplicates must be merged before this will apply. If it
-- fails with a uniqueness violation, that merge has not been run yet.
--
-- `where user_id is not null` because anonymous sessions have no account to be
-- unique against. Postgres would not collide null user_ids in a plain unique
-- index anyway; the predicate states the intent and keeps the index small.

create unique index if not exists chat_sessions_one_per_user
  on public.chat_sessions (user_id)
  where user_id is not null;
