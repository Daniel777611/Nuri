-- Shared search results for the daily cards.
--
-- The daily post and the daily video used to search Tavily once per parent
-- per day, which is more than the free plan's 1000 requests a month and why a
-- 10-a-day cap left about half the accounts without a card or a push
-- (2026-11). Search words are made from the coarse profile (age band + one
-- concern), so many parents ask the same thing, and the answer barely changes
-- from one day to the next. One row here is one search: what came back for
-- these words, kept for CONTENT_POOL_TTL_DAYS (default 7) and shared by every
-- parent whose plan produces the same words (backend/feed/search_pool.py).
--
-- Only the search is shared. Each parent's card is still picked from these
-- results by the model, against their own child's age, standing memories and
-- the posts they have already seen.

create table if not exists public.content_search_pool (
  kind text not null check (kind in ('post', 'video')),
  lang text not null check (lang in ('zh', 'en')),
  -- The search words, whitespace-normalised and lower-cased.
  query text not null,
  -- What the provider returned: a list of
  -- {title, url, snippet, lang, published_at, images: [{url, description}]}.
  results jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  -- Cards built from this search since it was fetched; for the dashboard only.
  uses integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (kind, lang, query)
);

create index if not exists content_search_pool_fetched_idx
  on public.content_search_pool (fetched_at desc);

alter table public.content_search_pool enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'content_search_pool'
      and policyname = 'content_search_pool_service_role'
  ) then
    create policy content_search_pool_service_role on public.content_search_pool
      for all to service_role using (true) with check (true);
  end if;
end $$;
