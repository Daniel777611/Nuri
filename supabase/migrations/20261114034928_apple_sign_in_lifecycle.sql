-- Additive to apple_sign_in. Existing Apple bindings retain their encrypted
-- grants. A lifecycle event changes the provider association, not Nuri data.
alter table public.users
  add column apple_session_generation bigint not null default 0,
  add column apple_authorized_at bigint not null default 0,
  add column apple_revoked_at bigint not null default 0,
  add column apple_relay_event_at bigint not null default 0,
  add column apple_relay_disabled boolean not null default false;

create table public.apple_signin_event_receipts (
  receipt_hash text primary key check (receipt_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default statement_timestamp()
);
create index apple_signin_event_receipt_age_idx
  on public.apple_signin_event_receipts (received_at);
alter table public.apple_signin_event_receipts enable row level security;
revoke all on table public.apple_signin_event_receipts from public, anon, authenticated;
grant select, insert, delete on table public.apple_signin_event_receipts to service_role;

create function public.record_apple_signin_event(
  p_receipt_hash text, p_audience text, p_subject text, p_event text,
  p_event_time bigint, p_relay_email text
) returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.apple_signin_event_receipts
    where received_at < statement_timestamp() - interval '8 days';
  insert into public.apple_signin_event_receipts (receipt_hash) values (p_receipt_hash)
    on conflict do nothing;
  if not found then
    return;
  end if;

  if p_event in ('consent-revoked', 'account-deleted') then
    update public.users
      set apple_revoked_at = p_event_time,
          apple_session_generation = apple_session_generation + 1,
          apple_refresh_ciphertext = '',
          apple_relay_disabled = case when lower(email) like '%@privaterelay.appleid.com'
            then true else apple_relay_disabled end,
          apple_relay_event_at = case when lower(email) like '%@privaterelay.appleid.com'
            then greatest(apple_relay_event_at, p_event_time) else apple_relay_event_at end
      where apple_subject = p_subject and apple_client_id = p_audience
        and apple_revoked_at < p_event_time and apple_authorized_at <= p_event_time;
  elsif p_event in ('email-enabled', 'email-disabled') then
    update public.users
      set apple_relay_disabled = (p_event = 'email-disabled'), apple_relay_event_at = p_event_time
      where apple_subject = p_subject and apple_client_id = p_audience
        and lower(email) = p_relay_email and apple_relay_event_at < p_event_time
        and (p_event = 'email-disabled' or apple_revoked_at = 0);
  else
    raise exception 'Unsupported Apple notification type';
  end if;
end;
$$;

revoke all on function public.record_apple_signin_event(text, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.record_apple_signin_event(text, text, text, text, bigint, text)
  to service_role;
