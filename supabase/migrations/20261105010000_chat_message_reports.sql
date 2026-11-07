-- Reports a parent files on an AI chat reply ("this answer is harmful /
-- offensive / misleading"). Google Play's AI-generated content policy requires
-- an in-app way to flag offensive output; these rows are the moderation queue
-- behind it. Like chat_message_feedback, only the service-role backend writes
-- and the admin dashboard reads.

create table if not exists public.chat_message_reports (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text not null references public.chat_sessions(id) on delete cascade,
  message_id text not null references public.chat_messages(id) on delete cascade,
  reason text not null
    check (reason in ('harmful', 'offensive', 'misleading', 'other')),
  note text check (note is null or char_length(note) <= 500),
  review_status text not null default 'pending'
    check (review_status in ('pending', 'actioned', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_message_reports_user_message_key unique (user_id, message_id)
);

create index if not exists chat_message_reports_review_idx
  on public.chat_message_reports (review_status, updated_at desc);
create index if not exists chat_message_reports_user_idx
  on public.chat_message_reports (user_id, updated_at desc);

alter table public.chat_message_reports enable row level security;

revoke all on table public.chat_message_reports from anon, authenticated;
grant select, insert, update, delete on table public.chat_message_reports to service_role;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_message_reports'
      and policyname = 'srole_chat_message_reports'
  ) then
    execute $p$
      create policy srole_chat_message_reports
        on public.chat_message_reports
        for all to service_role
        using (true) with check (true)
    $p$;
  end if;
end $$;

comment on table public.chat_message_reports is
  'Backend-only reports of harmful or offensive AI chat replies; the moderation queue for Play''s AI content policy.';
