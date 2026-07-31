-- Migration: source_domains_migration.sql
-- Run in the Supabase SQL editor. Safe to re-run: every statement is idempotent.
--
-- The trust tiering behind NURI's external citations. Two things read it:
--
--   * `authority` rows become the include-list for medical/safety questions, so
--     those searches never leave a set of vetted sources;
--   * `blocked` rows become the exclude-list for open-web questions, and are
--     filtered again after the provider answers (defence in depth — a provider
--     that quietly ignores the exclude parameter must not be able to put a
--     content farm in front of a parent).
--
-- Kept in a table rather than in code for the same reason as nuri_style_rules:
-- the people who notice a bad source shouldn't need a deploy to remove it.
--
-- Tier meanings:
--   authority — vetted institutions. Eligible for medical/safety answers.
--   good      — reputable, editorially reviewed, but not an institution.
--   neutral   — no opinion on file; ranked last. Rows are optional at this tier.
--   blocked   — never cited, never searched.
--
-- IMPORTANT: external web sources are the WEAKEST tier of context NURI has.
-- They must never override the `internal` RAG namespace, which is must-follow.

create table if not exists public.source_domains (
  -- Registrable domain, lowercase, no scheme and no leading "www."
  -- Matching is suffix-based, so "cdc.gov" also covers "www.cdc.gov".
  domain     text primary key,
  tier       text not null check (tier in ('authority', 'good', 'neutral', 'blocked')),
  -- 'en' | 'zh' | 'any'. Drives which language pass a domain is offered to.
  lang       text not null default 'any',
  -- Shown on the citation chip. "AAP" reads as a trust signal;
  -- "healthychildren.org" does not.
  site_name  text not null default '',
  note       text not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Matches the read in websearch.load_domain_rules(): active rows, by tier.
create index if not exists source_domains_active_tier_idx
  on public.source_domains (active, tier);

alter table public.source_domains enable row level security;

-- Service role only: written by admins through the backend, read by the backend
-- when planning a search. Never touched directly by a signed-in app user.
do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'source_domains' and policyname = 'srole_source_domains'
  ) then
    execute $p$
      create policy srole_source_domains on public.source_domains
        for all to service_role using (true) with check (true)
    $p$;
  end if;
end $$;

-- ── Seed ─────────────────────────────────────────────────────────────────────
-- on conflict do nothing: re-running never overwrites a tier someone has since
-- adjusted by hand.

-- English authorities. Deliberately the long list: for North American Chinese
-- parents the differentiating value is reaching AAP/CDC guidance they can't
-- read in the original, so this tier needs enough breadth to actually answer.
insert into public.source_domains (domain, tier, lang, site_name, note) values
  ('healthychildren.org',   'authority', 'en', 'AAP',                 'American Academy of Pediatrics, parent-facing'),
  ('aap.org',               'authority', 'en', 'AAP',                 'American Academy of Pediatrics, clinical'),
  ('cdc.gov',               'authority', 'en', 'CDC',                 'US Centers for Disease Control'),
  ('medlineplus.gov',       'authority', 'en', 'MedlinePlus',         'US National Library of Medicine'),
  ('nichd.nih.gov',         'authority', 'en', 'NICHD',               'US National Institute of Child Health'),
  ('nhs.uk',                'authority', 'en', 'NHS',                 'UK National Health Service'),
  ('who.int',               'authority', 'en', 'WHO',                 'World Health Organization'),
  ('aafp.org',              'authority', 'en', 'AAFP',                'American Academy of Family Physicians'),
  ('acog.org',              'authority', 'en', 'ACOG',                'Obstetrics; pregnancy and postpartum'),
  ('mayoclinic.org',        'authority', 'en', 'Mayo Clinic',         ''),
  ('chop.edu',              'authority', 'en', 'CHOP',                'Children''s Hospital of Philadelphia'),
  ('stanfordchildrens.org', 'authority', 'en', 'Stanford Children''s', ''),
  ('seattlechildrens.org',  'authority', 'en', 'Seattle Children''s', ''),
  ('cincinnatichildrens.org','authority','en', 'Cincinnati Children''s', ''),
  ('hopkinsmedicine.org',   'authority', 'en', 'Johns Hopkins',       ''),
  ('caringforkids.cps.ca',  'authority', 'en', 'CPS',                 'Canadian Paediatric Society; relevant for Toronto/Vancouver users'),
  ('raisingchildren.net.au','authority', 'en', 'Raising Children',    'Australian government-funded parenting service'),
  ('zerotothree.org',       'authority', 'en', 'ZERO TO THREE',       'Early development, 0-3'),
  ('llli.org',              'authority', 'en', 'La Leche League',     'Breastfeeding')
on conflict (domain) do nothing;

-- Chinese authorities.
insert into public.source_domains (domain, tier, lang, site_name, note) values
  ('dxy.com',      'authority', 'zh', '丁香医生',     ''),
  ('dxy.cn',       'authority', 'zh', '丁香园',       'Clinician-facing arm of the same publisher'),
  ('cma.org.cn',   'authority', 'zh', '中华医学会',   ''),
  ('nhc.gov.cn',   'authority', 'zh', '国家卫健委',   ''),
  ('chinacdc.cn',  'authority', 'zh', '中国疾控中心', '')
on conflict (domain) do nothing;

-- Reputable but not institutional. Fine for general parenting questions;
-- the search planner keeps them out of medical/safety answers.
insert into public.source_domains (domain, tier, lang, site_name, note) values
  ('babycenter.com',    'good', 'en', 'BabyCenter',   'Editorially reviewed, commercial'),
  ('whattoexpect.com',  'good', 'en', 'What to Expect', 'Editorially reviewed, commercial'),
  ('parents.com',       'good', 'en', 'Parents',      'Editorially reviewed, commercial'),
  ('haodf.com',         'good', 'zh', '好大夫在线',   'Physician Q&A; quality varies by author')
on conflict (domain) do nothing;

-- Blocked: content farms and low-signal UGC. These are the ones that make
-- Chinese-language parenting search results unusable on average.
insert into public.source_domains (domain, tier, lang, site_name, note) values
  ('baijiahao.baidu.com', 'blocked', 'zh', '', 'Content farm'),
  ('mbd.baidu.com',       'blocked', 'zh', '', 'Baidu content-farm mirror'),
  ('zhidao.baidu.com',    'blocked', 'zh', '', 'Unmoderated UGC'),
  ('jingyan.baidu.com',   'blocked', 'zh', '', 'Unmoderated UGC'),
  ('toutiao.com',         'blocked', 'zh', '', 'Content farm'),
  ('360doc.com',          'blocked', 'zh', '', 'Scraped-article aggregator')
on conflict (domain) do nothing;

-- ── Corrections from live search testing ─────────────────────────────────────
-- Plain UPDATEs, not inserts, so they also apply to a database where the seed
-- above already ran (`on conflict do nothing` would skip a changed row).
--
-- Several of the "English" authorities publish in Chinese too, and tagging them
-- `en` kept them out of the Chinese authority pass for no reason. Verified
-- against live results: mayoclinic.org/zh-hans returns real Chinese articles.
update public.source_domains set lang = 'any'
 where domain in ('mayoclinic.org', 'who.int', 'nhs.uk', 'medlineplus.gov');

-- Found while testing Chinese queries: UNICEF China publishes the 0-2 feeding
-- and development guidance that these searches are looking for.
insert into public.source_domains (domain, tier, lang, site_name, note) values
  ('unicef.cn',  'authority', 'zh',  'UNICEF 中国', 'Feeding and early development guidance'),
  ('unicef.org', 'authority', 'any', 'UNICEF',      '')
on conflict (domain) do nothing;

-- ── Pending a call from the team ─────────────────────────────────────────────
-- Left unseeded on purpose. Each has a genuinely wide quality spread, and
-- picking a tier is a product judgement rather than an engineering one:
--
--   zhihu.com          -- expert answers and confident nonsense, same page
--   xiaohongshu.com    -- high engagement among the target users; low sourcing
--   mp.weixin.qq.com   -- ranges from hospital accounts to pure marketing
--   sohu.com, 163.com  -- real news desks hosting self-published channels
--
-- Until a row exists they behave as `neutral`: searchable on open-web
-- questions, ranked below everything above, never used for medical answers.
