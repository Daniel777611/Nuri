-- Migration: add_collections_migration.sql
-- Run in Supabase SQL editor to add collection folders for favorites.

-- User-defined collection folders (up to 12 per user)
CREATE TABLE IF NOT EXISTS collections (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ             DEFAULT NOW(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS collections_user_id_idx ON collections (user_id);

-- Add collection_id to favorites (nullable = uncategorized / added via old toggle)
ALTER TABLE favorites ADD COLUMN IF NOT EXISTS collection_id UUID REFERENCES collections(id) ON DELETE SET NULL;
