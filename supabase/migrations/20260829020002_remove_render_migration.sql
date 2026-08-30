-- Migration: remove_render_migration.sql
-- Run this in the Supabase SQL editor before deploying the updated backend.
-- Creates feed_cards, app_settings, and favorites tables so all
-- previously in-memory state is persisted and Render can be removed.

-- AI-generated knowledge cards (replaces _gen_cards in-memory list)
CREATE TABLE IF NOT EXISTS feed_cards (
  id          TEXT        PRIMARY KEY,
  type        TEXT        NOT NULL,
  type_label  TEXT        NOT NULL DEFAULT '科普',
  cta         TEXT                 DEFAULT '问问AI →',
  title       TEXT        NOT NULL,
  summary     TEXT                 DEFAULT '',
  body        TEXT                 DEFAULT '',
  tags        JSONB                DEFAULT '[]'::jsonb,
  hook_line   TEXT                 DEFAULT '',
  image_url   TEXT                 DEFAULT '',
  keywords    JSONB                DEFAULT '[]'::jsonb,
  source      TEXT                 DEFAULT 'ai',
  created_at  TIMESTAMPTZ          DEFAULT NOW()
);

-- Admin key-value settings (replaces _feed_gen_mode global)
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT        PRIMARY KEY,
  value       TEXT        NOT NULL,
  updated_at  TIMESTAMPTZ          DEFAULT NOW()
);

-- Seed default mode
INSERT INTO app_settings (key, value)
VALUES ('feed_gen_mode', 'ai')
ON CONFLICT (key) DO NOTHING;

-- User favorites (replaces _favorites in-memory dict)
CREATE TABLE IF NOT EXISTS favorites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL,
  card_id     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ             DEFAULT NOW(),
  UNIQUE (user_id, card_id)
);
CREATE INDEX IF NOT EXISTS favorites_user_id_idx ON favorites (user_id);
