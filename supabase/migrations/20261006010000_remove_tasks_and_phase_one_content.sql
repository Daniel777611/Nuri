-- Remove action cards (tasks) entirely, and clear the phase-one content that
-- the knowledge library still showed.
--
-- Action cards: the tasks tab, the in-chat plan card and the orchestration
-- state behind them are gone from the code. Their three tables and the
-- per-conversation state column are dropped, and chat messages that carried a
-- plan card keep their text but lose the card.
--
-- Knowledge library: it lists `feed_cards`, which only ever held cards
-- generated during phase one. The table stays (the library and the generator
-- still read and write it); its rows go, and so do favorites pointing at them
-- or at the hard-coded phase-one cards removed from backend/main.py.
--
-- Run once, in the Supabase SQL editor, against the project .env points at.

begin;

-- ── Action cards ─────────────────────────────────────────────────────────────
drop table if exists public.nuri_task_card_events;
drop table if exists public.nuri_task_cards;
drop table if exists public.tasks;

alter table if exists public.chat_sessions
  drop column if exists orchestration_state;

update public.chat_messages
   set transition = null
 where transition->>'kind' in ('task_card', 'tasks_generated');

-- ── Knowledge library ────────────────────────────────────────────────────────
delete from public.favorites
 where card_id in (select id from public.feed_cards)
    or card_id in (
      'card_food_picky', 'card_bilingual_school', 'card_baby_monitor',
      'card_sleep_routine', 'card_screen_time', 'card_thermometer',
      'alt_tantrum', 'alt_daycare', 'alt_carseat', 'alt_potty', 'alt_winter'
    );

delete from public.feed_cards;

commit;
