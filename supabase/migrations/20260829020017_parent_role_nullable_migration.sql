-- Migration: parent_role_nullable_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
--
-- `parent_role` was `text not null default 'mom'`, but nothing in signup or
-- onboarding ever asked for it. Every dad, grandparent and other caregiver was
-- therefore stored as 'mom' and described to NURI as the child's mother — a
-- fabricated fact in the prompt, which is worse than a missing one.
--
-- Onboarding now asks the question, so the column needs a way to say "not
-- answered yet": null. The backend omits the key when unanswered, which works
-- against both the old and the new shape, so deploy order doesn't matter.

alter table public.users alter column parent_role drop default;
alter table public.users alter column parent_role drop not null;

-- Existing rows are ambiguous: 'mom' may be the real answer or just the old
-- default, and there's no way to tell them apart. They are deliberately left
-- as-is — onboarding will overwrite them the next time the parent goes through
-- it. To instead re-ask everyone, clear the column by hand:
--
--   update public.users set parent_role = null;
