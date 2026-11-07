-- Reports on community content (questions, replies, comments, parent-to-parent
-- messages) and on parents themselves. Google Play's user-generated content
-- policy requires an in-app way to flag objectionable content and users;
-- these rows are the moderation queue behind it (/admin/community-reports).
--
-- reported_user_id is resolved by the backend, never sent by the client, and
-- is never shown to the reporter (anonymous authors stay anonymous). snapshot
-- keeps the text as it was reported, so review still works after an edit or
-- removal. Only the service-role backend reads and writes this table.

create table if not exists public.community_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id text not null references public.users(id) on delete cascade,
  target_kind text not null
    check (target_kind in ('question', 'reply', 'comment', 'message', 'parent')),
  target_id text not null,
  reported_user_id text references public.users(id) on delete set null,
  reason text not null
    check (reason in ('harassment', 'sexual', 'hate', 'child_safety', 'self_harm', 'spam', 'other')),
  note text check (note is null or char_length(note) <= 500),
  snapshot text,
  status text not null default 'pending'
    check (status in ('pending', 'actioned', 'dismissed')),
  reviewer_note text check (reviewer_note is null or char_length(reviewer_note) <= 500),
  content_removed boolean not null default false,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint community_reports_once unique (reporter_id, target_kind, target_id)
);

create index if not exists community_reports_queue_idx
  on public.community_reports (status, created_at desc);
create index if not exists community_reports_reported_idx
  on public.community_reports (reported_user_id, created_at desc);

alter table public.community_reports enable row level security;
revoke all on table public.community_reports from anon, authenticated;
grant select, insert, update, delete on table public.community_reports to service_role;

comment on table public.community_reports is
  'Backend-only reports of community content and parents; the moderation queue for Play''s UGC policy.';
