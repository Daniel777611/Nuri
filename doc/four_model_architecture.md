# NURI 四大核心系统

The turn pipeline in `backend/nuri_core`, and how to compare it against the
linear path it is meant to replace.

## The problem it exists to solve

The linear pipeline read six context blocks in one `asyncio.gather`,
concatenated them, and sent the result to the reply model. Two consequences:

* **The only way to change a reply was to edit a prompt.** Every rule applied
  to every family in every situation, because the prompt is one document.
  A rule that should only fire for a four-month-old had to be written as
  "if the child is under one year, ..." and hoped for.
* **Every turn paid for every block.** The internal vector store was queried on
  "谢谢". The style rules were re-fetched for every user on every turn. The web
  search could not start until the memory blocks it does not need had loaded.

## The four subsystems

| # | Module | Owns | Emits |
|---|--------|------|-------|
| 1 | `family.py` | profile, children, memories, follow-ups | 家庭状态 — stage, preferences, hard constraints |
| 2 | `knowledge.py` | internal RAG, web search, routing | 证据与决策 — evidence, risk tier, what it chose not to fetch |
| 3 | `dialogue.py` | directives, prompt assembly, proactive slot | the system prompt, and the task-card gate |
| 4 | `outcome.py` | turn outcomes | 结果 — per-directive weights, the negative-outcome gate |

Two cross-cutting layers sit beside them: `safety.py` (risk classification and
the gates that follow from it) and `provenance.py` (per-subsystem cost, which is
the instrument for the comparison below).

`orchestrator.py` runs them in three waves:

```
wave 0   family.core + safety.assess          synchronous, no I/O
wave 1   family.enrich · knowledge.decide · outcome.policy · load_directives
wave 2   dialogue.plan                        pure
```

Wave 0 is free because main.py has already loaded the profile row for the turn.
That is what lets the search start before memories have finished loading.

## Changing a reply without touching a prompt

Insert a row:

```sql
insert into nuri_directives (text, applies_when, priority) values (
  '这个月龄的睡眠问题先谈睡眠环境和作息，不要一上来就谈自主入睡训练。',
  '{"age_months": [3, 8], "topics": ["睡眠"]}'::jsonb,
  10
);
```

It renders only for families with a child aged 3–8 months, on turns the router
labelled with a sleep topic. Conditions the pipeline understands:
`age_months` (a `[lo, hi]` range), `risk_tier`, `topics` (substring match on the
router's topic), `locale`, `help_preference`, `intent`, `min_turns`. An unknown
key matches rather than fails, so a directive written against a fact a future
build will compute is inert today rather than breaking the turn.

Every rule already distilled from a `#fix` keeps working unchanged:
`nuri_style_rules` loads as unconditional directives, which is exactly how the
old always-on block behaved. Nothing has to be migrated.

## The learning loop

`nuri_turn_outcomes` records what each turn decided — topic, risk tier, and the
directives in force — with `signal = 'pending'`. A later reaction attaches
itself: a reviewer's `#fix` is a strong negative, an adopted task a mild
positive. `outcome.summarize` turns the counts into a multiplier per directive,
per family. Four samples minimum; a directive whose replies consistently draw a
`#fix` reaches weight zero and stops rendering without anyone deleting the row.

Safety directives are excluded. A gate a bad month of signals could switch off
is not a gate.

## Comparing the two pipelines

Both write to `chat_turn_logs`, tagged by the `pipeline` column, and keep the
existing `context_ms` / `route_ms` / `search_ms` names so anything already built
on them still works.

```bash
NURI_PIPELINE=linear    # the original single-gather path
NURI_PIPELINE=four_model # default
```

Latency, side by side:

```sql
select pipeline,
       count(*),
       percentile_cont(0.5) within group (order by first_token_ms) as p50_first_token,
       percentile_cont(0.9) within group (order by first_token_ms) as p90_first_token,
       percentile_cont(0.5) within group (order by context_ms)     as p50_context,
       avg(prompt_tokens)                                          as avg_prompt_tokens
from chat_turn_logs
where created_at > now() - interval '7 days'
group by pipeline;
```

Where the four-model path spends its time, and what it skipped:

```sql
select retrieved_stores,
       count(*),
       avg(ms_knowledge) as knowledge_ms,
       avg(ms_outcome)   as outcome_ms,
       avg(context_ms)   as context_ms
from chat_turn_logs
where pipeline = 'four_model' and created_at > now() - interval '7 days'
group by retrieved_stores
order by count(*) desc;
```

`nuri_turn_traces` holds the structured version — per-subsystem milliseconds and
rendered characters, no prompt text. `provenance.compare(a, b)` diffs two of
those records and reports which stage moved.

The three numbers worth watching first:

1. **`family_cache_hit` rate.** Low means the TTL or the fingerprint is wrong,
   and the family model is costing what it did before for no gain.
2. **`retrieved_stores` distribution.** Turns retrieving nothing are the saving;
   if it is near zero the skip heuristics are too conservative.
3. **`avg(prompt_tokens)` by pipeline.** Conditional directives should make the
   prompt *smaller* on an average turn than an always-on block does. If it grew,
   the directive set is being written as prose again.

## Failure behaviour

Every table this adds is optional. A deployment that has not run
`supabase/four_model_migration.sql` logs a warning per subsystem and falls back
to the linear pipeline's data — including `chat_turn_logs`, which retries
without the new columns rather than dropping the row. Any subsystem that raises
contributes nothing and records the exception type in the trace; the turn still
gets a reply.
