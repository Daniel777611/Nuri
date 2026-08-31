-- Migration: nuri_style_rules_selection.sql
-- Run in the Supabase SQL editor. Requires nuri_style_rules_migration.sql and
-- nuri_style_rules_seed.sql to have run first.
--
-- Makes the style rules selectable instead of unconditional.
--
-- The seed shipped nineteen rows and every one of them reached every prompt,
-- under a heading that read 必须遵守. The model did what it was told: it
-- satisfied them one at a time, so a reply that only needed "how old is she?"
-- arrived with a numbered question list, a bulleted observation checklist, a
-- number range and an emoji. backend/evals/rule_ablation.py measured the split
-- on an off-domain question — five rows account for essentially all of it:
--
--     all     266 chars   5.0 lists   6.0 questions   1.0 emoji
--     minus   112         0.0         1.0             0.0
--
-- Several of them also contradict NURI_PERSONA outright. The persona says
-- 「自然地一次问一件事…不要把好几种情况的分支一次性列完让对方自己对号入座」;
-- style-inquiry-01 said 「先用编号列出 3-5 个具体问题，一次问完」 and
-- style-dig-01 said 「给选项让对方对号入座」. Injected as must-follow, the
-- table won. That is the whole of the "NURI 太像在做诊断" complaint.
--
-- Three columns fix it, and the four-model pipeline already knew how to read
-- all three — nothing was ever written into them:
--
--   mode          'must' renders under 必须遵守. 'advisory' renders under a
--                 heading that says to pick the one or two that fit and leave
--                 the rest, and is the only mode the per-turn cap trims.
--   priority      Decides what survives that cap, so it is no longer cosmetic.
--   applies_when  Matched against the turn's facts (risk_tier / topics /
--                 age_months / locale / min_turns / has_sources). An empty
--                 object still means "always", so an untouched row keeps
--                 behaving the way it did.
--
-- The caps live in backend/nuri_core/dialogue.py (ALWAYS_ADVISORY_LIMIT,
-- CONDITIONAL_ADVISORY_LIMIT), currently 3 and 3.
--
-- A consequence worth knowing before tuning priorities: the unconditional
-- advisory rules are sorted once and the top three go in, so the same three go
-- in on every turn. Today that is style-warmth-04, style-validate-01 and
-- style-warmth-03. style-reframe-01, style-warmth-05 and style-warmth-01 sit
-- below the line and are effectively parked. The way to make a parked rule
-- fire is to give it an `applies_when` so it competes in the conditional
-- bucket instead — raising its priority past a warmth rule only swaps which
-- one is parked.
--
-- Re-running: idempotent, and authoritative for the nineteen seeded rows. It
-- resets their mode/priority/applies_when, and rewrites the text of the five
-- listed at the bottom. Rows written by `#fix` or by the admin page are never
-- touched — they take the column defaults (advisory, priority 50), which is
-- the point: one reviewer's note about one reply should not become a standing
-- must-follow for every parent.

alter table public.nuri_style_rules
  add column if not exists mode text not null default 'advisory',
  add column if not exists priority int not null default 50,
  add column if not exists weight real not null default 1.0,
  add column if not exists applies_when jsonb not null default '{}'::jsonb;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'nuri_style_rules_mode_chk'
  ) then
    alter table public.nuri_style_rules
      add constraint nuri_style_rules_mode_chk check (mode in ('must', 'advisory'));
  end if;
end $$;

-- The read in dialogue._load_style_rules is still active-only; ordering is done
-- in Python because priority alone does not decide the outcome any more.
create index if not exists nuri_style_rules_active_priority_idx
  on public.nuri_style_rules (active, priority desc);


-- ── mode / priority / applies_when for the seeded rows ───────────────────────
--
-- risk_tier note: safety.assess escalates to 'elevated' for any family with a
-- recorded constraint (an allergy is enough), so the two "ask before you
-- conclude" rules are gated on ('none','elevated') rather than on 'none'.
-- Gating them on 'none' would silently switch them off for every family that
-- has an allergy on file, which is the opposite of what they are for.

update public.nuri_style_rules as r
   set mode         = v.mode,
       priority     = v.priority,
       applies_when = v.applies_when
  from (values
    -- must: the two that hold for every turn, in every language, plus the one
    -- that only exists to keep a medical hand-off from becoming a brush-off.
    ('style-lang-01',      'must',     90, '{}'::jsonb),
    ('style-warmth-02',    'must',     85, '{}'::jsonb),
    ('style-refer-01',     'must',     80, '{"risk_tier":["medical","crisis","emergency"]}'::jsonb),

    -- advisory, conditional: these compete for CONDITIONAL_ADVISORY_LIMIT and
    -- only when this turn's facts select them.
    ('style-inquiry-01',   'advisory', 70, '{"risk_tier":["none","elevated"]}'::jsonb),
    ('style-dig-01',       'advisory', 65, '{"risk_tier":["none","elevated"]}'::jsonb),
    -- 别以某个量为目标 only makes sense on a turn that is about a quantity.
    ('style-pressure-01',  'advisory', 46, '{"topics":["喂","奶","副食","辅食","吃","量"]}'::jsonb),
    -- Naming AAP/CDC is advice when the reply carries citations and noise when
    -- it does not, so this one keys on whether sources were actually fetched.
    ('style-cite-01',      'advisory', 45, '{"has_sources":true}'::jsonb),
    ('style-slowdown-01',  'advisory', 42, '{"topics":["副食","辅食","戒","训练","作息","进度"]}'::jsonb),
    ('style-numbers-01',   'advisory', 40, '{"topics":["喂","奶","副食","辅食","睡","作息","量"]}'::jsonb),
    ('style-signals-01',   'advisory', 35, '{"topics":["发展","里程碑","准备","警讯","就医","副食","辅食","语言","动作"]}'::jsonb),
    -- Asking after the parent themselves lands once there is a conversation to
    -- land in; on turn one it reads as a script.
    ('style-parent-01',    'advisory', 32, '{"min_turns":4}'::jsonb),
    ('style-checklist-01', 'advisory', 25, '{"topics":["托婴","托育","检查","健儿","长辈","参观","面谈","签约"]}'::jsonb),
    -- Inviting a parent to pass their trick on presumes they have told you one.
    ('style-share-01',     'advisory', 15, '{"min_turns":8}'::jsonb),

    -- advisory, unconditional: the top ALWAYS_ADVISORY_LIMIT of these go in
    -- every turn. All three that currently clear the line are warmth rules,
    -- which is deliberate — the register complaint is that NURI reads as a
    -- diagnostician, and warmth is the half that kept losing.
    ('style-warmth-04',    'advisory', 62, '{}'::jsonb),
    ('style-validate-01',  'advisory', 60, '{}'::jsonb),
    ('style-warmth-03',    'advisory', 58, '{}'::jsonb),
    ('style-reframe-01',   'advisory', 55, '{}'::jsonb),
    ('style-warmth-05',    'advisory', 50, '{}'::jsonb),
    -- Last on purpose. 💜/🤍 as a standing instruction is where "warm" turns
    -- into "decorated"; below the line it is available to an operator who
    -- wants it back, without being spent on every reply.
    ('style-warmth-01',    'advisory', 10, '{}'::jsonb)
  ) as v(id, mode, priority, applies_when)
 where r.id = v.id;


-- ── the five rewrites ────────────────────────────────────────────────────────
--
-- Demoting a rule to advisory stops it dominating; it does not fix a rule that
-- says the wrong thing. These five did.

-- Was: 默认用台湾习惯的繁体中文用词…但如果家长明显在用简体中文…就跟随家长.
-- The default came first and the exception second, which is backwards: NURI
-- follows the parent, and the Taiwanese vocabulary is what it falls back to
-- when the parent has not indicated anything.
update public.nuri_style_rules set rule =
  '先跟随家长：用他这条消息在用的语言和文字回复，沿用他已经用过的词'
  '（他说「辅食」就说「辅食」，说「副食品」就说「副食品」），也尊重他所在地区的说法，不要纠正他。'
  '只有在家长没有表现出明显倾向时，才用台湾习惯的繁体中文用词：副食品、托婴、汤匙、试敏、月龄。'
where id = 'style-lang-01';

-- Was the same sentence without the last clause. The clause is there because
-- the observed symptom is asymmetric: the same account is noticeably warmer in
-- 繁体中文 than in 简体中文 or English, and the rule set this was distilled
-- from is entirely Taiwanese, so "be warm" was reading as "be warm in Chinese".
update public.nuri_style_rules set rule =
  '每一则回复先接住家长这句话里的情绪或处境，再进入内容，顺序不能颠倒。'
  '肯定要具体到只有他适用：「宝宝已经 8 公斤，一路以母奶为主，这真的很不容易」远胜过「你做得很好」。'
  '这一条与用哪种语言无关——英文和简体中文的回复不应该比繁体中文冷淡。'
where id = 'style-warmth-02';

-- Was: 先用编号列出 3-5 个具体问题，一次问完. Directly against the persona's
-- 一次问一件事, and against 紧急时不要先追问细节. The intent it encodes —
-- gather in one round trip rather than five — survives as the exception.
update public.nuri_style_rules set rule =
  '资讯不足时先问、不要急着下结论，这一条永远成立。至于一次问几个：默认只问最关键的那一件，'
  '等家长答了再问下一件；只有当几个问题彼此相关、缺一不可，或家长明显想一次讲完时，才一次列 2-3 个，且不要超过 3 个。'
  '问题要能真的分辨情况（例如「他看到汤匙就闭嘴，还是愿意含一下但会吐出来？」），不要问空泛的「情况怎么样」。'
where id = 'style-inquiry-01';

-- Was: 给选项让对方对号入座. The options were the instruction; now they are the
-- fallback for when an open question gets nothing back.
update public.nuri_style_rules set rule =
  '家长说「累」「压力大」「撑不住」时，不要立刻给方法，先问是什么在压着他。'
  '如果他一时说不上来，再给两三个具体的可能让他对号入座（「是因为一直喂奶让你很难休息？'
  '还是担心宝宝怎么喝都喝不饱？」）——开放的那一句先问，选项是备用，不是开场。'
where id = 'style-dig-01';

-- Was: 开头放一个 💜…偶尔用 🤍 收尾. Read as a formatting requirement, which is
-- how warmth becomes decoration.
update public.nuri_style_rules set rule =
  '💜 / 🤍 可酌用，不是规定：只在真的要安慰家长、或开启一个新话题时，偶尔在段落开头放一个 💜。'
  '多数回复不需要 emoji；每一段都放会变成装饰，而不是温度。'
where id = 'style-warmth-01';

-- Not one of the five, but the same failure mode in miniature: "带上具体数字"
-- with nothing telling the model what to do when it does not have one.
update public.nuri_style_rules set rule =
  '给做法时带上具体数字范围：一次一两小口、约 5 分钟、每次增加 15-30 mL、连续 7-10 天。'
  '没有数字的建议家长执行不了。但没有可靠依据时，宁可给范围或直说不确定，'
  '也不要为了显得具体而编一个数字。'
where id = 'style-numbers-01';
