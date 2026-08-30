-- Run this in the Supabase SQL Editor before using /index and /ask.
-- The backend creates 1024-dimension embeddings with OpenAI text-embedding-3-large.

create extension if not exists vector;

create table if not exists public.rag_chunks (
  id text primary key,
  namespace text not null default 'pdf',
  doc_id text not null,
  chunk_id integer not null,
  content text not null,
  embedding vector(1024) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rag_chunks_doc_idx
  on public.rag_chunks (namespace, doc_id);

create index if not exists rag_chunks_embedding_idx
  on public.rag_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

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
