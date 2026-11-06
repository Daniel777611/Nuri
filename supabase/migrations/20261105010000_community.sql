-- Community: parent-to-parent questions, replies, relationships, P2P chat,
-- two-party AI consent and media (backend/community.py).
--
-- Contract source: the Figma handoff "Community 后端接口交接" (file
-- AdHDK7uLqyzvgbzm1FlM6F, node 216-13472) for the frozen web/iOS 1027 build.
-- Every route there is PROPOSED; the open product decisions this schema had to
-- take a side on are listed in backend/docs/community_api.md.
--
-- Accounts are text ids in public.users (no Supabase Auth). Every owned row
-- cascades from public.users, so account deletion removes it; storage objects
-- in the community-media bucket are NOT removed by the cascade (see the doc).
--
-- Lists page on a bigint identity `seq` instead of (created_at, id): one
-- strictly increasing column is a cursor that never skips or repeats a row
-- with a shared timestamp.
--
-- Write retries converge on unique (actor, client_request_id) keys: a resend
-- with the same key returns the first result, a resend with different content
-- is refused (IDEMPOTENCY_CONFLICT).

-- ── Profiles & preferences ───────────────────────────────────────────────────
create table if not exists public.community_profiles (
  user_id text primary key references public.users(id) on delete cascade,
  -- The only id other parents ever see. Never the account id.
  public_id uuid not null unique default gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 30),
  about text not null default '' check (char_length(about) <= 300),
  city_label text not null default '' check (char_length(city_label) <= 60),
  intent_codes text[] not null default '{}',
  avatar_media_id uuid,
  -- Coarse location, only when the parent opted in; rounded to ~1 km by the
  -- backend before it is written. Distances shown to others are rounded again.
  approx_lat double precision,
  approx_lng double precision,
  version integer not null default 1,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists community_profiles_seq_idx on public.community_profiles (seq desc);

create table if not exists public.community_preferences (
  user_id text primary key references public.users(id) on delete cascade,
  parent_message_notifications_enabled boolean not null default true,
  profile_hidden boolean not null default false,
  auto_translate_messages boolean not null default false,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

-- ── Questions ────────────────────────────────────────────────────────────────
create table if not exists public.community_questions (
  id uuid primary key default gen_random_uuid(),
  author_id text not null references public.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  original_language text not null default 'zh-CN',
  version_source text not null default 'original'
    check (version_source in ('original', 'polished')),
  polish_id uuid,
  anonymous boolean not null default false,
  show_child_age boolean not null default false,
  -- Snapshot at publish time; null when not shown or no child on file.
  child_age_months integer,
  status text not null default 'open' check (status in ('open', 'closed', 'deleted')),
  client_request_id text not null,
  request_fingerprint text not null,
  version integer not null default 1,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  deleted_at timestamptz,
  unique (author_id, client_request_id)
);
create index if not exists community_questions_author_idx
  on public.community_questions (author_id, seq desc);

create table if not exists public.community_question_deliveries (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.community_questions(id) on delete cascade,
  recipient_id text not null references public.users(id) on delete cascade,
  state text not null default 'waiting' check (state in ('waiting', 'replied', 'locked')),
  lock_reason text check (lock_reason in
    ('question_closed', 'question_deleted', 'expired', 'unavailable')),
  expires_at timestamptz not null,
  version integer not null default 1,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (question_id, recipient_id)
);
create index if not exists community_deliveries_recipient_idx
  on public.community_question_deliveries (recipient_id, state, seq desc);

create table if not exists public.community_replies (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.community_questions(id) on delete cascade,
  -- One reply per delivery: a resend can never create a second experience.
  delivery_id uuid not null unique
    references public.community_question_deliveries(id) on delete cascade,
  author_id text not null references public.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  language text not null default 'zh-CN',
  anonymous boolean not null default false,
  client_request_id text not null,
  request_fingerprint text not null,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  unique (author_id, client_request_id)
);
create index if not exists community_replies_question_idx
  on public.community_replies (question_id, seq desc);

-- reply_id null = the question's "reply to everyone" thread.
create table if not exists public.community_comments (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references public.community_questions(id) on delete cascade,
  reply_id uuid references public.community_replies(id) on delete cascade,
  author_id text not null references public.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  language text not null default 'zh-CN',
  client_message_id text not null,
  request_fingerprint text not null,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  unique (author_id, client_message_id)
);
create index if not exists community_comments_thread_idx
  on public.community_comments (question_id, reply_id, seq desc);

-- ── Relationships ────────────────────────────────────────────────────────────
create table if not exists public.community_invitations (
  id uuid primary key default gen_random_uuid(),
  sender_id text not null references public.users(id) on delete cascade,
  recipient_id text not null references public.users(id) on delete cascade,
  state text not null default 'pending'
    check (state in ('pending', 'accepted', 'declined', 'cancelled')),
  client_request_id text not null,
  request_fingerprint text not null,
  version integer not null default 1,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (sender_id <> recipient_id),
  unique (sender_id, client_request_id)
);
-- At most one open invitation per direction.
create unique index if not exists community_invitations_one_pending
  on public.community_invitations (sender_id, recipient_id) where state = 'pending';
create index if not exists community_invitations_recipient_idx
  on public.community_invitations (recipient_id, state, seq desc);

-- One row per pair, ordered so (a, b) and (b, a) cannot both exist.
create table if not exists public.community_relationships (
  id uuid primary key default gen_random_uuid(),
  user_low text not null references public.users(id) on delete cascade,
  user_high text not null references public.users(id) on delete cascade,
  state text not null default 'active' check (state in ('active', 'disconnected')),
  disconnected_by text,
  version integer not null default 1,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (user_low < user_high),
  unique (user_low, user_high)
);
create index if not exists community_relationships_high_idx
  on public.community_relationships (user_high, state);

create table if not exists public.community_blocks (
  blocker_id text not null references public.users(id) on delete cascade,
  blocked_id text not null references public.users(id) on delete cascade,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists community_blocks_blocked_idx on public.community_blocks (blocked_id);

-- ── Parent-to-parent conversations ───────────────────────────────────────────
-- Separate from chat_sessions/chat_messages: those are the one NURI AI chat
-- per account, and a P2P message must never reach the AI reply path.
create table if not exists public.community_conversations (
  id uuid primary key default gen_random_uuid(),
  user_low text not null references public.users(id) on delete cascade,
  user_high text not null references public.users(id) on delete cascade,
  -- Bumped on every AI revoke/block/disconnect; stale consent cannot revive it.
  ai_epoch integer not null default 0,
  last_message_seq bigint,
  last_message_at timestamptz,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  check (user_low < user_high),
  unique (user_low, user_high)
);

create table if not exists public.community_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.community_conversations(id) on delete cascade,
  sender_id text not null references public.users(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 2000),
  media_ids uuid[] not null default '{}',
  language text not null default 'zh-CN',
  client_message_id text not null,
  request_fingerprint text not null,
  seq bigint generated always as identity,
  created_at timestamptz not null default now(),
  unique (sender_id, client_message_id)
);
create index if not exists community_messages_conversation_idx
  on public.community_messages (conversation_id, seq desc);

create table if not exists public.community_read_cursors (
  conversation_id uuid not null references public.community_conversations(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  last_read_seq bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- ── Two-party AI consent ─────────────────────────────────────────────────────
create table if not exists public.community_ai_consent_requests (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.community_conversations(id) on delete cascade,
  initiator_id text not null references public.users(id) on delete cascade,
  purpose text not null default 'conversation_notes',
  provider text not null default 'openai',
  notice_version text not null,
  -- The conversation epoch this request belongs to; a revoke moves the
  -- conversation on, and every older request stops counting.
  epoch integer not null,
  state text not null default 'pending'
    check (state in ('pending', 'effective', 'declined', 'revoked', 'superseded')),
  effective_from_seq bigint,
  client_request_id text not null,
  request_fingerprint text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  revoked_at timestamptz,
  unique (initiator_id, client_request_id)
);
create index if not exists community_ai_requests_conversation_idx
  on public.community_ai_consent_requests (conversation_id, created_at desc);

create table if not exists public.community_ai_consent_decisions (
  request_id uuid not null references public.community_ai_consent_requests(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  decision text not null check (decision in ('allow', 'decline')),
  notice_version text not null,
  decided_at timestamptz not null default now(),
  primary key (request_id, user_id)
);

-- Polish / translation / transcription results, keyed for retries.
create table if not exists public.community_ai_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('polish', 'translation', 'transcription')),
  message_id uuid references public.community_messages(id) on delete cascade,
  target_language text,
  output_text text not null default '',
  state text not null default 'succeeded' check (state in ('succeeded', 'failed')),
  client_request_id text not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  unique (user_id, kind, client_request_id)
);

-- ── Media ────────────────────────────────────────────────────────────────────
create table if not exists public.community_media (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references public.users(id) on delete cascade,
  purpose text not null check (purpose in ('avatar', 'message')),
  state text not null default 'upload_authorized'
    check (state in ('upload_authorized', 'ready', 'rejected', 'committed', 'deleted')),
  declared_mime text not null,
  validated_mime text,
  byte_size integer not null,
  sha256 text not null,
  width integer,
  height integer,
  storage_path text not null unique,
  reject_reason text,
  -- What the asset was committed to: 'message:<id>' or 'avatar'.
  bound_to text,
  client_request_id text not null,
  request_fingerprint text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, client_request_id)
);
create index if not exists community_media_owner_idx on public.community_media (owner_id, state);

-- Private bucket; the backend hands out short-lived signed URLs only.
insert into storage.buckets (id, name, public)
values ('community-media', 'community-media', false)
on conflict (id) do nothing;

-- ── Notifications ────────────────────────────────────────────────────────────
-- Community events reuse notification_events (type 'chat', data.kind
-- 'community_*', data.target a typed in-app reference). Read state is new.
alter table public.notification_events
  add column if not exists read_at timestamptz;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- The backend uses the service role; enabling RLS with no policies keeps the
-- anon key from reading any of this directly.
alter table public.community_profiles enable row level security;
alter table public.community_preferences enable row level security;
alter table public.community_questions enable row level security;
alter table public.community_question_deliveries enable row level security;
alter table public.community_replies enable row level security;
alter table public.community_comments enable row level security;
alter table public.community_invitations enable row level security;
alter table public.community_relationships enable row level security;
alter table public.community_blocks enable row level security;
alter table public.community_conversations enable row level security;
alter table public.community_messages enable row level security;
alter table public.community_read_cursors enable row level security;
alter table public.community_ai_consent_requests enable row level security;
alter table public.community_ai_consent_decisions enable row level security;
alter table public.community_ai_requests enable row level security;
alter table public.community_media enable row level security;
