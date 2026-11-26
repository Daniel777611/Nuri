-- Run as postgres only on Nuri-Testing after deploying the Alpha tick action.
-- Uses the existing Alpha scheduler latch and Vault token without changing either.
begin;

select pg_advisory_xact_lock(hashtext('nuri-alpha-local-activity-scheduler'));

do $check$
begin
    if to_regclass('public.alpha_community_bot_scheduler') is null
        or to_regprocedure('public.claim_due_local_activity_notifications(integer)') is null
        or not exists (
            select 1 from public.alpha_local_activity_scheduler as scheduler
            join vault.decrypted_secrets as credential
                on credential.name = 'nuri_alpha_local_activity_scheduler_token'
                and scheduler.token_sha256 =
                    encode(extensions.digest(credential.decrypted_secret, 'sha256'), 'hex')
            where scheduler.id = 1
        ) then
        raise exception 'Expected the Nuri-Testing Alpha scheduler and verified Vault credential';
    end if;
end
$check$;

create or replace function public.claim_due_alpha_community_notifications(batch_size integer)
returns setof public.notification_events
language sql
security invoker
set search_path = ''
as $function$
    with locked as (
        select event.id, event.status, event.attempt_count
        from public.notification_events as event
        where (
            event.status = 'queued'
            or (event.status = 'processing' and event.updated_at <= now() - interval '10 minutes')
          )
          and event.scheduled_at <= now()
          -- Keep historical events available in-app without pushing the backlog.
          and event.created_at > now() - interval '24 hours'
          and (event.expires_at is null or event.expires_at > now())
          and event.type = 'chat'
          and event.data ->> 'kind' in (
              'community_question', 'community_reply', 'community_invitation',
              'community_conversation', 'community_ai_consent'
          )
          and exists (
              select 1 from public.push_devices as device
              where device.user_id = event.user_id
                and device.is_active
                and device.platform = 'ios'
                and device.bundle_id = 'com.ordashtech.nuri.beta'
                and device.apns_environment = 'production'
                and device.permission_status in ('authorized', 'provisional')
          )
        order by event.scheduled_at, event.id
        limit greatest(least(coalesce(batch_size, 0), 10), 0)
        for update of event skip locked
    ), due as (
        select locked.id, case
            when locked.status = 'queued' then 'processing'
            -- A prior worker may have stopped after persisting acceptance.
            -- Record the confirmed delivery without sending to that device again.
            when exists (
                select 1 from public.notification_deliveries as delivery
                join public.push_devices as device on device.id = delivery.device_id
                where delivery.event_id = locked.id
                  and delivery.status = 'accepted'
                  and device.platform = 'ios'
                  and device.bundle_id = 'com.ordashtech.nuri.beta'
                  and device.apns_environment = 'production'
            ) then 'partial'
            when locked.attempt_count >= 5 then 'failed'
            else 'processing'
        end as next_status
        from locked
    ), updated as (
        update public.notification_events as event
           set status = due.next_status,
               attempt_count = event.attempt_count + case when due.next_status = 'processing' then 1 else 0 end,
               last_error = case due.next_status
                   when 'partial' then null
                   when 'failed' then 'processing_retry_exhausted'
                   else event.last_error
               end,
               updated_at = now()
          from due
         where event.id = due.id
        returning event.*
    )
    select * from updated where status = 'processing';
$function$;

revoke all on function public.claim_due_alpha_community_notifications(integer)
    from public, anon, authenticated, service_role;
grant execute on function public.claim_due_alpha_community_notifications(integer) to service_role;

select cron.schedule(
    'nuri-alpha-community-push-dispatch',
    '*/5 * * * *',
    $tick$
    select net.http_post(
        url := 'https://nuri-git-testing-backend-alpha-ordashtech.vercel.app/api/internal/alpha-local-activities/tick',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || credential.decrypted_secret
        ),
        body := '{"action":"dispatch_community"}'::jsonb,
        timeout_milliseconds := 170000
    )
    from vault.decrypted_secrets as credential
    where credential.name = 'nuri_alpha_local_activity_scheduler_token'
      and exists (select 1 from public.alpha_local_activity_scheduler where id = 1 and enabled);
    $tick$
);

notify pgrst, 'reload schema';

commit;
