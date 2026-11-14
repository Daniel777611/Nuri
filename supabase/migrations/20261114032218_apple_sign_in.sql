-- The existing public.users table has service-role-only RLS. Keep the private
-- Apple identity on the same row so signup/link and subject uniqueness are atomic.
alter table public.users
  add column apple_subject text,
  add column apple_client_id text,
  add column apple_refresh_ciphertext text,
  add constraint users_apple_credentials_complete check (
    (apple_subject is null and apple_client_id is null and apple_refresh_ciphertext is null)
    or (apple_subject is not null and apple_client_id is not null and apple_refresh_ciphertext is not null)
  );

create unique index users_apple_subject_unique
  on public.users (apple_subject) where apple_subject is not null;

create table public.apple_signin_challenges (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  audience text not null,
  purpose text not null check (purpose in ('signin', 'link', 'delete')),
  user_id text references public.users (id) on delete cascade,
  expires_at timestamptz not null,
  constraint apple_signin_challenge_owner check ((purpose = 'signin') = (user_id is null))
);

create index apple_signin_challenges_expires_at_idx
  on public.apple_signin_challenges (expires_at);
create index apple_signin_challenges_user_id_idx
  on public.apple_signin_challenges (user_id) where user_id is not null;
alter table public.apple_signin_challenges enable row level security;
revoke all on table public.apple_signin_challenges from public, anon, authenticated;
grant select, insert, delete on table public.apple_signin_challenges to service_role;

create table public.apple_signin_challenge_limits (
  bucket text not null,
  expires_at timestamptz not null,
  issued integer not null check (issued between 1 and 30),
  primary key (bucket, expires_at)
);
create index apple_signin_challenge_limits_expires_at_idx
  on public.apple_signin_challenge_limits (expires_at);
alter table public.apple_signin_challenge_limits enable row level security;
revoke all on table public.apple_signin_challenge_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.apple_signin_challenge_limits to service_role;

create function public.issue_apple_signin_challenge(
  p_nonce_hash text, p_audience text, p_purpose text, p_user_id text, p_bucket text
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  current_time_utc timestamptz := statement_timestamp();
  window_end timestamptz := to_timestamp((floor(extract(epoch from statement_timestamp()) / 300) + 1) * 300);
  accepted integer;
begin
  delete from public.apple_signin_challenge_limits where expires_at <= current_time_utc;
  delete from public.apple_signin_challenges where expires_at <= current_time_utc;

  insert into public.apple_signin_challenge_limits as limits (bucket, expires_at, issued)
    values (p_bucket, window_end, 1)
    on conflict (bucket, expires_at) do update set issued = limits.issued + 1
      where limits.issued < 30
    returning issued into accepted;
  if accepted is null then
    return false;
  end if;

  insert into public.apple_signin_challenges (nonce_hash, audience, purpose, user_id, expires_at)
    values (p_nonce_hash, p_audience, p_purpose, p_user_id, current_time_utc + interval '5 minutes');
  return true;
end;
$$;

revoke all on function public.issue_apple_signin_challenge(text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.issue_apple_signin_challenge(text, text, text, text, text) to service_role;
