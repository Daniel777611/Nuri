-- Run only on Nuri-Testing (kyxnnrmyzmdutqylsxpw) as postgres.
-- Apply setup and deploy/verify the gated Alpha backend endpoint first.

begin;

select pg_advisory_xact_lock(hashtext('nuri-alpha-community-bot-scheduler'));

do $check$
begin
    if not exists (
        select 1 from public.alpha_community_bot_scheduler as scheduler
        join vault.decrypted_secrets as credential
            on credential.name = 'nuri_alpha_community_bot_scheduler_token'
            and scheduler.token_sha256 =
                encode(extensions.digest(credential.decrypted_secret, 'sha256'), 'hex')
        where scheduler.id = 1
    ) then
        raise exception 'Alpha Community scheduler setup is missing or its credential has changed';
    end if;
end
$check$;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
    'nuri-alpha-community-bot-tick',
    '*/30 * * * *',
    $tick$
    select net.http_post(
        url := 'https://nuri-git-testing-backend-alpha-ordashtech.vercel.app/api/internal/alpha-community-bots/tick',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || credential.decrypted_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 170000
    )
    from vault.decrypted_secrets as credential
    where credential.name = 'nuri_alpha_community_bot_scheduler_token'
      and exists (select 1 from public.alpha_community_bot_scheduler where id = 1 and enabled);
    $tick$
);

update public.alpha_community_bot_scheduler set enabled = true where id = 1;

commit;

-- To enqueue one immediate tick after starting, execute the SELECT inside
-- the $tick$ block on Nuri-Testing. It returns only a pg_net request ID.
-- To pause, run:
-- update public.alpha_community_bot_scheduler set enabled = false where id = 1;
