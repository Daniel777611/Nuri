-- Migration: message_sources_migration.sql
-- Run in the Supabase SQL editor BEFORE deploying the matching backend.
-- Safe to re-run: idempotent.
--
-- The external sources an AI reply cited, stored alongside the reply so the
-- links survive a reload rather than living only in the response that produced
-- them.
--
-- Shape: [{"n": 1, "title": "...", "url": "...", "site_name": "AAP",
--          "lang": "en", "tier": "authority"}]
--
-- These entries are built server-side from the search results the backend
-- fetched, indexed by the citation numbers the model emitted. The model never
-- writes a URL, so nothing here can be a hallucinated link.
--
-- Deploying ahead of this migration is survivable but lossy: _persist_ai_turn
-- retries the insert without the column and logs a warning, so replies are
-- still saved, just without their links.

alter table public.chat_messages
  add column if not exists sources jsonb not null default '[]'::jsonb;
