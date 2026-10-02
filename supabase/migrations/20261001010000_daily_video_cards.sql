-- The daily video: one YouTube video per parent, per local day.
--
-- The second card in Home's 每日精选 and the knowledge card of the daily push
-- (backend/feed/daily_video.py). Same row shape and claim as
-- daily_post_cards, so the same store code runs both. `card` also holds the
-- video's summary once the parent has opened it (written on first open, then
-- kept). `platform` is always 'youtube'; `source_url` is the watch link, used
-- to keep the same video from coming back within 60 days.

create table if not exists public.daily_video_cards (
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

create index if not exists daily_video_cards_user_day_idx
  on public.daily_video_cards (user_id, day desc);
create index if not exists daily_video_cards_day_idx
  on public.daily_video_cards (day desc);

alter table public.daily_video_cards enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'daily_video_cards'
      and policyname = 'daily_video_cards_service_role'
  ) then
    create policy daily_video_cards_service_role on public.daily_video_cards
      for all to service_role using (true) with check (true);
  end if;
end $$;
