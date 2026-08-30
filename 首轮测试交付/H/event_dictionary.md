# Event dictionary

H-07 / BE-11. Every chat response carries an `events` object. It exists so a
grader can assert on what the product *did*, separately from what it *said* —
"建議諮詢專業人士" appearing in a sentence is not the same fact as the turn
having escalated.

```json
"events": {
  "task_created": false,
  "task_ids": [],
  "task_proposed": true,
  "task_proposal_count": 1,
  "card_ids": [],
  "escalation_level": "suggest_professional",
  "escalation_reason_code": "safety.emergency",
  "risk_tier": "medical"
}
```

---

## Tasks

**`task_created` is always `false` on a chat turn. This is correct, not a bug.**

A NURI turn *proposes* tasks. A row in the `tasks` table appears only when the
parent accepts one, through a separate request the test plan never makes. An
assertion built on `task_created` will therefore never fire — and reporting the
drafts as created would have made every such assertion wrong in the same
direction, which is worse than reporting nothing.

| field | meaning |
|---|---|
| `task_created` | Whether a Task row was persisted this turn. Always `false` here. |
| `task_ids` | Ids of persisted Tasks. Always `[]` here. |
| `task_proposed` | **Whether the reply offered task cards.** This is the assertable one. |
| `task_proposal_count` | How many drafts, typically 1–3. |

The drafts themselves are in `ai_messages[0].transition.tasks` when
`task_proposed` is true: each has `title`, `scope` (`today` / `week`),
`task_type`, `description` and `steps`.

Tasks are suppressed — `task_proposed: false` regardless of content — when the
safety layer has classified the turn as urgent or a crisis, or when the parent
has declined tasks. A blueprint that ends in an emergency should expect no task
cards; that is the designed behaviour.

---

## Cards

| field | meaning |
|---|---|
| `card_ids` | The recommendation card this conversation was opened from, if any. |

Empty for the whole of this test plan: cards are a home-feed entry point, and
the blueprints start conversations directly. Cited sources are a different
thing and live in `ai_messages[0].sources`.

---

## Escalation

Two fields describe the same judgement at two resolutions. The safety layer runs
on the parent's raw text **before** any retrieval, so an emergency is classified
before the turn spends time on a search.

`escalation_level` — the three values the test contract asks for:

| value | meaning |
|---|---|
| `none` | Ordinary parenting conversation. |
| `suggest_professional` | The reply should point at in-person professional help. |
| `urgent` | Emergency or crisis; the reply names emergency services or a crisis line. |

`risk_tier` — the internal classification, five values, reported because
collapsing to three loses a distinction graders often need:

| `risk_tier` | maps to | what it means |
|---|---|---|
| `none` | `none` | — |
| `elevated` | `none` | Heightened concern, no professional referral required. |
| `medical` | `suggest_professional` | A medical question, or a symptom that needs a clinician. |
| `crisis` | `urgent` | Parent safety. The reply names a crisis line, not an ambulance. |
| `emergency` | `urgent` | Child in immediate danger. |

`crisis` is checked before `emergency`: the two overlap in wording, and of the
two readings the parent in danger is the one whose directive names the right
service.

`escalation_reason_code` — the id of the safety rule that fired, e.g.
`safety.emergency`, `safety.crisis`. `null` when nothing fired, which is normal
for `medical` (that tier comes from routing, not from a gate).

### Observed

From the five-turn acceptance run: turns 1–3 (night waking, returning to work)
were `none`. Turn 4 disclosed a rash after egg yolk and the turn moved to
`medical` / `suggest_professional`; turn 5 stayed there and the reply reordered
its advice to put the possible allergy before the sleep problem.

---

## What is *not* in `events`

- Whether sources were cited — see `ai_messages[0].sources`.
- Which knowledge stores were consulted, and the router's decision. Kept
  internal; ask if a blueprint needs it.
- Anything about the parent's account. `events` is per-turn only.
