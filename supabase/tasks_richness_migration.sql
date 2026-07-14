-- Migration: tasks_richness_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
-- Adds the fields the redesigned task UI needs (type/description/steps/due date/
-- favorite/backfilled) so task deletion, clearing completed tasks, and type
-- filtering can be backed by real columns instead of client-side guesses.

alter table public.tasks add column if not exists task_type text not null default 'interaction';
alter table public.tasks add column if not exists description text not null default '';
alter table public.tasks add column if not exists steps jsonb not null default '[]'::jsonb;
alter table public.tasks add column if not exists due_date date;
alter table public.tasks add column if not exists is_favorited boolean not null default false;
alter table public.tasks add column if not exists backfilled boolean not null default false;
