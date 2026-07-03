-- Run this in the Supabase SQL Editor if the users table is missing the unique constraint on email.
-- Safe to run: only adds the constraint if it doesn't already exist.

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.users'::regclass
      and contype = 'u'
      and conname like '%email%'
  ) then
    alter table public.users add constraint users_email_key unique (email);
  end if;
end $$;
