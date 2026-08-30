-- Run this in the Supabase SQL Editor to enable books management.
-- This must be run AFTER rag_vectors.sql since the discover RPC references rag_chunks.

-- ── Books registry ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.books (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  doc_id      text        UNIQUE NOT NULL,              -- matches rag_chunks.doc_id
  title       text        NOT NULL DEFAULT 'Untitled',
  category    text,
  description text,
  enabled     boolean     NOT NULL DEFAULT true,        -- admin toggles this
  chunk_count integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  indexed_at  timestamptz
);

ALTER TABLE public.books ENABLE ROW LEVEL SECURITY;

-- Public can read (admin UI reads directly via anon key)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'books' AND policyname = 'books_public_read'
  ) THEN
    CREATE POLICY "books_public_read" ON public.books FOR SELECT USING (true);
  END IF;
END $$;

-- Anyone (anon + service role) can write — books is non-sensitive metadata only.
-- The admin UI is password-gated at the application level.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'books' AND policyname = 'books_write'
  ) THEN
    CREATE POLICY "books_write" ON public.books FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── Helper: distinct doc_ids in rag_chunks with counts ────────────────────
-- Used by admin /discover endpoint to find unregistered chunks.
CREATE OR REPLACE FUNCTION public.distinct_chunk_doc_ids(
  p_namespace text DEFAULT 'pdf'
)
RETURNS TABLE (doc_id text, chunk_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT doc_id, COUNT(*) AS chunk_count
  FROM public.rag_chunks
  WHERE namespace = p_namespace
  GROUP BY doc_id;
$$;
