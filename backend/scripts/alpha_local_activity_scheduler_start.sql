-- Activate only on Nuri-Testing (kyxnnrmyzmdutqylsxpw) after setup and live Alpha checks.
-- To pause both jobs, set enabled = false on the singleton scheduler row.

begin;

select pg_advisory_xact_lock(hashtext('nuri-alpha-local-activity-scheduler'));

do $check$
begin
    if not exists (
        select 1 from public.alpha_local_activity_scheduler as scheduler
        join vault.decrypted_secrets as credential
            on credential.name = 'nuri_alpha_local_activity_scheduler_token'
            and scheduler.token_sha256 =
                encode(extensions.digest(credential.decrypted_secret, 'sha256'), 'hex')
        where scheduler.id = 1
    ) or to_regprocedure('public.claim_due_local_activity_notifications(integer)') is null then
        raise exception 'Alpha activity scheduler setup is missing or its credential has changed';
    end if;
end
$check$;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
    'nuri-alpha-local-activity-generate',
    '5 15 * * *',
    $tick$
    select net.http_post(
        url := 'https://nuri-git-testing-backend-alpha-ordashtech.vercel.app/api/internal/alpha-local-activities/tick',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || credential.decrypted_secret
        ),
        body := '{"action":"generate"}'::jsonb,
        timeout_milliseconds := 170000
    )
    from vault.decrypted_secrets as credential
    where credential.name = 'nuri_alpha_local_activity_scheduler_token'
      and exists (select 1 from public.alpha_local_activity_scheduler where id = 1 and enabled);
    $tick$
);

select cron.schedule(
    'nuri-alpha-local-activity-dispatch',
    '*/5 * * * *',
    $tick$
    select net.http_post(
        url := 'https://nuri-git-testing-backend-alpha-ordashtech.vercel.app/api/internal/alpha-local-activities/tick',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || credential.decrypted_secret
        ),
        body := '{"action":"dispatch"}'::jsonb,
        timeout_milliseconds := 120000
    )
    from vault.decrypted_secrets as credential
    where credential.name = 'nuri_alpha_local_activity_scheduler_token'
      and exists (select 1 from public.alpha_local_activity_scheduler where id = 1 and enabled);
    $tick$
);

update public.alpha_local_activity_scheduler set enabled = true where id = 1;

commit;
