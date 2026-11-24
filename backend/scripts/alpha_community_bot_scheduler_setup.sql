-- Operational setup for Nuri-Testing (kyxnnrmyzmdutqylsxpw) only.
-- Run on that explicit Supabase project as postgres. This is not a migration
-- for a shared project. The scheduler remains off until its start script runs.

begin;

select pg_advisory_xact_lock(hashtext('nuri-alpha-community-bot-scheduler'));

create table if not exists public.alpha_community_bot_scheduler (
    id integer primary key check (id = 1),
    enabled boolean not null default false,
    token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),
    last_started_at timestamptz,
    last_finished_at timestamptz,
    last_activity jsonb not null default '{}'::jsonb,
    last_result jsonb not null default '{}'::jsonb
);

alter table public.alpha_community_bot_scheduler enable row level security;
revoke all on table public.alpha_community_bot_scheduler
    from public, anon, authenticated, service_role;
grant select, update on table public.alpha_community_bot_scheduler to service_role;

do $setup$
declare
    scheduler_token text;
begin
    select decrypted_secret into scheduler_token
    from vault.decrypted_secrets
    where name = 'nuri_alpha_community_bot_scheduler_token';

    if scheduler_token is null then
        scheduler_token := encode(extensions.gen_random_bytes(32), 'hex');
        perform vault.create_secret(
            scheduler_token,
            'nuri_alpha_community_bot_scheduler_token',
            'Bearer token for the Nuri-Testing Alpha Community bot scheduler'
        );
    end if;

    insert into public.alpha_community_bot_scheduler (id, token_sha256)
    values (1, encode(extensions.digest(scheduler_token, 'sha256'), 'hex'))
    on conflict (id) do update set token_sha256 = excluded.token_sha256
    where alpha_community_bot_scheduler.token_sha256 is distinct from excluded.token_sha256;
end
$setup$;

commit;
