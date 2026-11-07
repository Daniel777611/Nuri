-- Community meeting decisions, 2026-11-06 (backend/docs/community_api.md).
--
-- D03: the community onboarding asks for a self-chosen tag; the role filter
-- in recommendations reads it instead of inferring anything from the account.
-- Null until the parent picks one.
alter table public.community_profiles
  add column if not exists gender_tag text
  check (gender_tag in ('mom', 'dad', 'other'));

comment on column public.community_profiles.gender_tag is
  'Self-chosen community tag (mom / dad / other); drives the 妈妈/爸爸 filter. Never inferred.';
