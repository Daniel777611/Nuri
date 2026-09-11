-- The daily card: one real post from another parent, per parent, per day.
--
-- Replaces the topic-driven 每日精选 carousel on Home. The card is decided on
-- the parent's first visit of their local day (backend/feed/daily_post.py) and
-- then stays the same until tomorrow, which is also what makes it cheap: one
-- row, one generation.
--
-- `status` is the claim that stops two requests from generating the same day
-- twice: 'pending' while one runs; 'ready' with a card; 'empty' when no post
-- qualified (retried a few hours later); 'failed' on a provider or storage
-- error (retried after minutes).
--
-- `query` keeps the two search strings sent to the search provider, so a bad
-- card can be traced to what was asked. They are already scrubbed of child
-- names and other identifiers before leaving NURI, and the row goes with the
-- account (cascade) and with a privacy wipe.

create table if not exists public.daily_post_cards (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  day date not null,
  status text not null check (status in ('pending', 'ready', 'empty', 'failed')),
  basis text,
  platform text,
  source_url text,
  card jsonb,
  query jsonb,
  error text,
  -- First time the parent opened the card, tapped through to the post, and
  -- took it to chat. Only the first of each is kept: the dashboard asks
  -- "did the card get used today", not "how many taps".
  opened_at timestamptz,
  source_clicked_at timestamptz,
  chat_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day)
);

create index if not exists daily_post_cards_user_day_idx
  on public.daily_post_cards (user_id, day desc);
create index if not exists daily_post_cards_day_idx
  on public.daily_post_cards (day desc);

alter table public.daily_post_cards enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'daily_post_cards'
      and policyname = 'daily_post_cards_service_role'
  ) then
    create policy daily_post_cards_service_role on public.daily_post_cards
      for all to service_role using (true) with check (true);
  end if;
end $$;
