-- Migration: privacy_settings_migration.sql
-- Run this in the Supabase SQL editor BEFORE deploying the matching backend.
-- Safe to re-run: every statement is idempotent.
--
-- Privacy settings (including the UI language) were only ever held in the
-- backend's module-level `_privacy` dict. On Vercel's serverless runtime that
-- dict belongs to one warm instance, so the next request could land somewhere
-- that never saw the write and the setting silently reverted to the default.
--
-- Until this runs, PUT /api/privacy answers 503 ("设置暂时无法保存") instead of
-- pretending to save — which is the point: the previous silent no-op is exactly
-- what testers reported as "按了沒有改變".

alter table public.users
  add column if not exists allow_history_training boolean not null default true;
alter table public.users
  add column if not exists daily_push boolean not null default true;
alter table public.users
  add column if not exists anonymous_community_share boolean not null default false;

-- 'zh-CN' | 'zh-TW' | 'en'. Kept as free text rather than an enum/check so a
-- future locale can't 422 the whole settings write; the backend normalises
-- unknown values in _normalize_language().
alter table public.users
  add column if not exists language text not null default 'zh-CN';

-- Anyone stored under the old two-letter code predates the zh-CN/zh-TW split.
update public.users set language = 'zh-CN' where language in ('zh', 'zh-Hans');
update public.users set language = 'zh-TW' where language = 'zh-Hant';
