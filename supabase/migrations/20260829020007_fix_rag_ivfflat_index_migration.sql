-- Run this in the Supabase SQL Editor.
-- Safe to re-run: all statements are idempotent.
--
-- Fixes two RAG issues discovered while wiring up the "internal" (must-follow)
-- knowledge partition alongside the existing "pdf" (external, reference-only)
-- one:
--
-- 1. The live match_rag_chunks() function only had 4 params (filter_doc_id,
--    filter_namespace, match_count, query_embedding) — it was missing
--    filter_doc_ids, even though supabase/rag_vectors.sql in this repo has
--    defined the 5-param version (used for the /admin/books enable/disable
--    filter) for a while. That file was apparently never (re-)run against
--    this project, so the books-enabled filter and any 5-param caller
--    (including the new internal-namespace retrieval) failed with a
--    "Could not find the function" PostgREST error. This re-applies the
--    5-param version from rag_vectors.sql.
--
-- 2. rag_chunks_embedding_idx is an ivfflat index built with lists=100, but
--    the table currently only has ~100-300 rows. With that few rows spread
--    across 100 buckets, most buckets are empty or near-empty, and ivfflat's
--    default probes=1 means a query can easily probe an empty bucket and
--    return ZERO matches even when a highly relevant chunk exists elsewhere
--    in the table (confirmed empirically: some internal-namespace queries
--    returned no rows at all). Dropping the index falls back to an exact
--    sequential scan ordered by cosine distance, which is exact (no recall
--    loss) and still fast at this row count. Re-add a properly-tuned
--    ivfflat/hnsw index once the corpus grows into the tens of thousands of
--    rows and a seq scan starts showing up in query latency.

drop index if exists public.rag_chunks_embedding_idx;

-- `create or replace function` only replaces a function with the exact same
-- argument signature — it does NOT remove a differently-arity overload. The
-- previously-deployed 4-param version (no filter_doc_ids) is still sitting
-- alongside the 5-param one below, so PostgREST now sees two candidates and
-- refuses to pick one ("Could not choose the best candidate function").
-- Drop the old overload explicitly first.
drop function if exists public.match_rag_chunks(vector(1024), int, text, text);

create or replace function public.match_rag_chunks(
  query_embedding vector(1024),
  match_count int default 5,
  filter_doc_id text default null,
  filter_namespace text default 'pdf',
  filter_doc_ids text[] default null   -- array of enabled doc_ids; null = no filter
)
returns table (
  id text,
  doc_id text,
  chunk_id integer,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
as $$
  select
    rc.id,
    rc.doc_id,
    rc.chunk_id,
    rc.content,
    rc.metadata,
    1 - (rc.embedding <=> query_embedding) as similarity
  from public.rag_chunks rc
  where rc.namespace = filter_namespace
    and (filter_doc_id is null or rc.doc_id = filter_doc_id)
    and (filter_doc_ids is null or rc.doc_id = any(filter_doc_ids))
  order by rc.embedding <=> query_embedding
  limit match_count;
$$;
