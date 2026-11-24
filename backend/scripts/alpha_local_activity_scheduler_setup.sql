-- Operational setup for Nuri-Testing (kyxnnrmyzmdutqylsxpw) only, as postgres.
-- The existing Alpha scheduler and activity area schema must already exist.
-- This installs the credentials and queue isolation with scheduling paused.

begin;

select pg_advisory_xact_lock(hashtext('nuri-alpha-local-activity-scheduler'));

do $check$
begin
    if to_regclass('public.alpha_community_bot_scheduler') is null
       or to_regclass('public.local_activity_areas') is null then
        raise exception 'Expected the Alpha testing database and local activity schema';
    end if;
end
$check$;

create table if not exists public.alpha_local_activity_scheduler (
    id integer primary key check (id = 1),
    enabled boolean not null default false,
    token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$')
);

alter table public.alpha_local_activity_scheduler enable row level security;
revoke all on table public.alpha_local_activity_scheduler from public, anon, authenticated, service_role;
grant select on table public.alpha_local_activity_scheduler to service_role;

do $setup$
declare
    scheduler_token text;
begin
    select decrypted_secret into scheduler_token
    from vault.decrypted_secrets
    where name = 'nuri_alpha_local_activity_scheduler_token';

    if scheduler_token is null then
        scheduler_token := encode(extensions.gen_random_bytes(32), 'hex');
        perform vault.create_secret(
            scheduler_token, 'nuri_alpha_local_activity_scheduler_token',
            'Dedicated bearer token for the Nuri-Testing Alpha local activity scheduler'
        );
    end if;

    insert into public.alpha_local_activity_scheduler (id, token_sha256)
    values (1, encode(extensions.digest(scheduler_token, 'sha256'), 'hex'))
    on conflict (id) do update set token_sha256 = excluded.token_sha256
    where alpha_local_activity_scheduler.token_sha256 is distinct from excluded.token_sha256;
end
$setup$;

-- The standard dispatcher can run in other deployments using this same
-- testing database. Keep its contract and exclude only the Alpha activity kind.
create or replace function public.claim_due_notifications(batch_size integer)
returns setof public.notification_events
language plpgsql
as $function$
begin
    return query
    with due as (
        select id
        from public.notification_events
        where status = 'queued'
          and scheduled_at <= now()
          and (expires_at is null or expires_at > now())
          and (data ->> 'kind') is distinct from 'local_activity'
        order by scheduled_at
        limit greatest(batch_size, 0)
        for update skip locked
    )
    update public.notification_events e
       set status = 'processing',
           attempt_count = e.attempt_count + 1,
           updated_at = now()
      from due
     where e.id = due.id
    returning e.*;
end
$function$;

create or replace function public.claim_due_local_activity_notifications(batch_size integer)
returns setof public.notification_events
language sql
security invoker
set search_path = ''
as $function$
    with due as (
        select id
        from public.notification_events
        where status = 'queued'
          and scheduled_at <= now()
          and (expires_at is null or expires_at > now())
          and (data ->> 'kind') = 'local_activity'
        order by scheduled_at
        limit greatest(least(batch_size, 30), 0)
        for update skip locked
    )
    update public.notification_events e
       set status = 'processing',
           attempt_count = e.attempt_count + 1,
           updated_at = now()
      from due
     where e.id = due.id
    returning e.*;
$function$;

revoke all on function public.claim_due_local_activity_notifications(integer)
    from public, anon, authenticated, service_role;
grant execute on function public.claim_due_local_activity_notifications(integer) to service_role;

notify pgrst, 'reload schema';

commit;
