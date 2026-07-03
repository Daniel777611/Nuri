-- Run this in the Supabase SQL Editor.
-- Fixes a security issue flagged by Supabase's linter (rls_disabled_in_public):
-- favorites, app_settings, feed_cards, and collections were created without RLS,
-- making them readable/writable by anyone holding the public anon key.
-- These tables are only ever accessed by the backend via the service_role key,
-- so we lock them down the same way email_logs.sql does.
-- Safe to re-run: all statements are idempotent.

alter table public.favorites enable row level security;
alter table public.app_settings enable row level security;
alter table public.feed_cards enable row level security;
alter table public.collections enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='favorites' and policyname='srole_favorites') then
    execute $p$ create policy srole_favorites on public.favorites for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='app_settings' and policyname='srole_app_settings') then
    execute $p$ create policy srole_app_settings on public.app_settings for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='feed_cards' and policyname='srole_feed_cards') then
    execute $p$ create policy srole_feed_cards on public.feed_cards for all to service_role using (true) with check (true) $p$;
  end if;
  if not exists (select 1 from pg_policies where tablename='collections' and policyname='srole_collections') then
    execute $p$ create policy srole_collections on public.collections for all to service_role using (true) with check (true) $p$;
  end if;
end $$;
