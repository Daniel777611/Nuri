-- Migration: onboarding_fields_migration.sql
-- Run in Supabase SQL editor. Safe to re-run: all statements are idempotent.
-- Adds the fields the redesigned onboarding flow collects (parenting-style
-- preferences + a completion flag) so the app stops re-showing onboarding on
-- every visit — previously these were sent by the frontend but silently
-- dropped because the backend didn't know about them.

alter table public.users add column if not exists concern_other text not null default '';
alter table public.users add column if not exists hobbies text not null default '';
alter table public.users add column if not exists help_preference text not null default '';
alter table public.users add column if not exists info_source text not null default '';
alter table public.users add column if not exists content_frequency text not null default '';
alter table public.users add column if not exists onboarding_completed boolean not null default false;
