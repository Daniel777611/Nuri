-- nuri_style_rules: record when a row was last edited.
--
-- Round one of the D01–D20 evaluation was stopped mid-batch by the harness's
-- prompt-version guard, and answering "which rules changed, and when" turned
-- out to be impossible after the fact: every row still carried its seed
-- created_at (2026-08-30T01:32:36) and the updated_at column was never written.
-- The rule text is what the reply is made of, so an edit here is a prompt
-- change, and a prompt change during a regression batch invalidates it.
--
-- The trigger rather than an application-side timestamp: rules get edited from
-- the Supabase table editor and from #fix, and only one of those two goes
-- through our code.

alter table public.nuri_style_rules
  add column if not exists updated_at timestamptz not null default now();

-- Existing rows have never been stamped. Seeding them from created_at is the
-- honest answer — "not known to have changed since it was written" — rather
-- than now(), which would claim every rule was edited by this migration.
update public.nuri_style_rules
  set updated_at = created_at
  where updated_at is null or updated_at > now();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists nuri_style_rules_set_updated_at on public.nuri_style_rules;

create trigger nuri_style_rules_set_updated_at
  before update on public.nuri_style_rules
  for each row
  execute function public.set_updated_at();
