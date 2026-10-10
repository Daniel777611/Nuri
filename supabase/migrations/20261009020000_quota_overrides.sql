-- Per-account chat allowance overrides (backend/quota.py, admin page 对话额度).
--
-- For sponsored and other hand-picked accounts. An override never lowers what
-- the account's tier gives: the account gets whichever is more generous.
-- daily_turns null = unlimited. expires_at null = no end date.
--
-- The tier allowances themselves are one JSON row in app_settings
-- (key 'quota_config'), written from the admin page; no table needed.

create table if not exists public.user_quota_overrides (
  user_id text primary key references public.users(id) on delete cascade,
  daily_turns integer check (daily_turns is null or daily_turns > 0),
  note text not null default '',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_quota_overrides enable row level security;
revoke all on table public.user_quota_overrides from anon, authenticated;
grant select, insert, update, delete on table public.user_quota_overrides to service_role;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'user_quota_overrides'
      and policyname = 'srole_user_quota_overrides'
  ) then
    execute $p$
      create policy srole_user_quota_overrides on public.user_quota_overrides
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;
