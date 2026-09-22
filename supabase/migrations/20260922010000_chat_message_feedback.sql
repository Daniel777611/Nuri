-- Chat reply feedback collected by the backend for review and future training.
-- App clients never access this table directly; the service-role backend owns
-- writes and the admin dashboard reads.

create table if not exists public.chat_message_feedback (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  session_id text not null references public.chat_sessions(id) on delete cascade,
  message_id text not null references public.chat_messages(id) on delete cascade,
  source_user_message_id text references public.chat_messages(id) on delete set null,
  rating text not null check (rating in ('like', 'dislike')),
  training_eligible boolean not null default false,
  review_status text not null default 'pending'
    check (review_status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_message_feedback_user_message_key unique (user_id, message_id)
);

create index if not exists chat_message_feedback_created_idx
  on public.chat_message_feedback (created_at desc);
create index if not exists chat_message_feedback_review_idx
  on public.chat_message_feedback (review_status, training_eligible, created_at desc);
create index if not exists chat_message_feedback_user_idx
  on public.chat_message_feedback (user_id, created_at desc);
create index if not exists chat_message_feedback_session_idx
  on public.chat_message_feedback (session_id, updated_at desc);

alter table public.chat_message_feedback enable row level security;

-- Explicitly keep the Data API closed to app roles. service_role is the only
-- role used by the backend and admin dashboard for this sensitive dataset.
revoke all on table public.chat_message_feedback from anon, authenticated;
grant select, insert, update, delete on table public.chat_message_feedback to service_role;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_message_feedback'
      and policyname = 'srole_chat_message_feedback'
  ) then
    execute $p$
      create policy srole_chat_message_feedback
        on public.chat_message_feedback
        for all to service_role
        using (true) with check (true)
    $p$;
  end if;
end $$;

comment on table public.chat_message_feedback is
  'Backend-only like/dislike labels for AI chat replies; candidates for training review.';
comment on column public.chat_message_feedback.training_eligible is
  'Whether this feedback row may be considered by the training review pipeline.';
comment on column public.chat_message_feedback.review_status is
  'Editorial review state: pending, approved, or rejected.';
