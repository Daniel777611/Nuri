-- 四大核心系统 — the tables behind backend/nuri_core.
--
-- Safe to run against a live database and safe to run twice. Everything is
-- IF NOT EXISTS, and the pipeline treats every one of these tables as optional:
-- a deployment that has not run this file falls back to the existing
-- nuri_style_rules block and logs a warning, rather than losing turns.
--
-- Three things get stored here that the linear pipeline had nowhere to put:
--   nuri_directives     conditional response rules — the reason a reply can be
--                       changed without editing a prompt
--   nuri_turn_outcomes  what each turn decided, and what came back
--   nuri_turn_traces    per-subsystem cost, for comparing the two pipelines

-- ── 3 对话与主动模型: the directive store ────────────────────────────────────
create table if not exists nuri_directives (
    id           uuid primary key default gen_random_uuid(),
    -- Which subsystem owns this rule. Also the render order.
    layer        text not null default 'dialogue'
                 check (layer in ('safety','outcome','family','knowledge','dialogue')),
    kind         text not null default 'style',
    text         text not null,
    -- Empty object means "always", which is how a migrated style rule behaves.
    -- Keys the pipeline understands: age_months [lo,hi], risk_tier[],
    -- topics[], locale[], help_preference[], intent[], min_turns.
    applies_when jsonb not null default '{}'::jsonb,
    -- Higher renders first within a layer.
    priority     int not null default 0,
    -- Authored strength. The outcome model multiplies it; it does not write here.
    weight       real not null default 1.0 check (weight >= 0),
    active       boolean not null default true,
    source       text not null default 'authored',
    note         text,
    created_by   text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create index if not exists nuri_directives_active_idx
    on nuri_directives (active, priority desc);

comment on table nuri_directives is
    'Conditional response directives. Inserting a row changes NURI''s replies '
    'for the families and situations the condition names, with no code or '
    'prompt change. Deactivate rather than delete so the outcome history keeps '
    'pointing at something.';

-- ── 4 结果学习模型: the loop ─────────────────────────────────────────────────
create table if not exists nuri_turn_outcomes (
    id            uuid primary key default gen_random_uuid(),
    user_id       uuid,
    session_id    text,
    -- Joins a reply to the reaction that follows it. Matches nuri_turn_traces.id.
    turn_id       uuid not null,
    topic         text default '',
    risk_tier     text default 'none',
    -- Every directive in force when this reply was written. The attribution
    -- rule lives in code (outcome.summarize), so it can change without the
    -- data having to be recollected.
    directive_ids text[] not null default '{}',
    -- 'pending' until something comes back. See outcome.SIGNAL_WEIGHTS.
    signal        text not null default 'pending',
    created_at    timestamptz not null default now(),
    observed_at   timestamptz
);

create index if not exists nuri_turn_outcomes_user_idx
    on nuri_turn_outcomes (user_id, created_at desc);
create index if not exists nuri_turn_outcomes_pending_idx
    on nuri_turn_outcomes (user_id, signal, created_at desc);
create unique index if not exists nuri_turn_outcomes_turn_idx
    on nuri_turn_outcomes (turn_id);

-- ── 横切 Evaluation 与 Provenance ───────────────────────────────────────────
create table if not exists nuri_turn_traces (
    id               uuid primary key,
    session_id       text,
    user_id          uuid,
    pipeline         text not null default 'four_model',
    pipeline_version text,
    total_ms         int,
    -- Per-subsystem milliseconds, rendered characters, and counters. Kept as
    -- jsonb rather than columns because a new subsystem must not require a
    -- migration before it can be measured.
    timings          jsonb not null default '{}'::jsonb,
    contributions    jsonb not null default '{}'::jsonb,
    facts            jsonb not null default '{}'::jsonb,
    directive_ids    text[] not null default '{}',
    created_at       timestamptz not null default now()
);

create index if not exists nuri_turn_traces_pipeline_idx
    on nuri_turn_traces (pipeline, created_at desc);

comment on table nuri_turn_traces is
    'No prompt text — only which layer contributed how much, and what it cost. '
    'Compare two pipelines with provenance.compare over rows from each.';

-- ── chat_turn_logs: the flat half ───────────────────────────────────────────
-- Exactly provenance.TurnTrace.FLAT_COLUMNS. Supabase rejects an insert naming
-- a column that does not exist, and this row also carries every pre-existing
-- turn metric, so the two lists have to stay in step.
alter table public.chat_turn_logs add column if not exists pipeline text;
alter table public.chat_turn_logs add column if not exists pipeline_version text;
alter table public.chat_turn_logs add column if not exists risk_tier text;
alter table public.chat_turn_logs add column if not exists family_cache_hit boolean;
alter table public.chat_turn_logs add column if not exists directives_loaded int;
alter table public.chat_turn_logs add column if not exists directives_applied int;
alter table public.chat_turn_logs add column if not exists retrieved_stores text;
alter table public.chat_turn_logs add column if not exists outcome_samples int;
alter table public.chat_turn_logs add column if not exists ms_family_enrich int;
alter table public.chat_turn_logs add column if not exists ms_knowledge int;
alter table public.chat_turn_logs add column if not exists ms_dialogue int;
alter table public.chat_turn_logs add column if not exists ms_outcome int;
alter table public.chat_turn_logs add column if not exists ms_directives int;
