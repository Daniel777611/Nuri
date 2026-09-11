-- Email verification and password reset.
--
-- Until now an account was an address that passed a regex. `a@x.com` could
-- register, and nothing ever proved the person holding the password also held
-- the mailbox — which also meant there was no way to hand an account back to
-- someone who forgot their password.
--
-- Run this BEFORE deploying the code that reads it: the register route writes
-- `email_verified_at`, and an insert naming a missing column fails.

-- ── 1. users.email_verified_at ───────────────────────────────────────────────
-- Null means "registered, code not yet entered". Such an account cannot sign
-- in: login answers 403 EMAIL_NOT_VERIFIED and sends a fresh code instead.
alter table public.users
  add column if not exists email_verified_at timestamptz;

-- Every account that exists when this runs predates verification and is
-- grandfathered: nobody who is already testing gets locked out. Only accounts
-- registered through the new flow can be unverified.
update public.users
   set email_verified_at = created_at
 where email_verified_at is null;

-- ── 2. email_codes ───────────────────────────────────────────────────────────
-- One row per code sent. Only an HMAC of the code is stored, so this table
-- being read does not hand anyone a working code. Rows are short-lived; the
-- backend prunes an address's rows older than a day each time it issues one.
--
-- Keyed by address rather than user id: a reset request names an address,
-- and the rate limits are per mailbox, which is the thing being protected
-- from a flood of mail.
create table if not exists public.email_codes (
  id text primary key,
  email text not null,
  purpose text not null check (purpose in ('verify', 'reset')),
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_codes_lookup_idx
  on public.email_codes (email, purpose, created_at desc);

-- House RLS shape: the backend reaches Supabase with the service role key and
-- signs its own JWTs, so there is no `auth.uid()` to match against.
alter table public.email_codes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'email_codes'
      and policyname = 'email_codes_service_role'
  ) then
    create policy email_codes_service_role on public.email_codes
      for all to service_role using (true) with check (true);
  end if;
end $$;
