# Folding main.py into the four subsystems

`main.py` was 10,053 lines and contained every fragment of the architecture in
`doc/four_model_architecture.md` — the family's memory alongside the vector
store alongside the persona alongside the HTTP routes. This is the map of where
each fragment goes, what has moved, and what the remaining moves cost.

The ordering is not arbitrary. Each cut was measured first: a block is only
safe to move when the names it needs from what stays behind can themselves be
moved or already live below it. The measurement script is at the bottom.

## Done

| Module | Lines | What it took from main.py |
|---|---|---|
| `runtime.py` | 172 | env, OpenAI clients, Supabase handle, the clock |
| `memstore.py` | 59 | the Supabase-unavailable fallback containers |
| `locales.py` | 34 | preferred-locale normalisation |
| `stores.py` | 564 | generated cards, feed mode, privacy, snapshots, favourites, collections |
| `nuri_core/family_store.py` | 619 | `users`, `children`, `user_memories`, `follow_ups`, `normalized_inputs`, and the rendering of each |
| `nuri_core/knowledge_store.py` | 195 | the `internal` and `pdf` vector namespaces, embedding, chunking |
| `nuri_core/dialogue_reply.py` | 807 | persona, reply contract, both reply calls, streamed-JSON parser, task-card rules, `#fix` distillation, proactive composer |
| `nuri_core/outcome_store.py` | 629 | recommendation engagement events — the second outcome stream |
| `feed/signals.py` | 1,724 | what the conversation is about |
| `feed/delivery.py` | 1,284 | what to show for it, and whether it is ready |

`runtime.py` came first because nothing else could move until there was a way
to reach the Supabase handle without importing a module that builds a FastAPI
app at import time. That single import cycle is why `nuri_core` originally had
to receive all its data through injected callables.

main.py: **10,053 → 4,543 lines**, and what remains is the app shell plus the
HTTP route handlers.

## One binding per name

There is no alias layer. An earlier pass kept `_old_name = module.new_name` in
main.py so route handlers could keep their spelling, and it caused the same bug
three times: **a name bound at import is not the name a monkeypatch replaces.**
A test patching `main._db_get_privacy` stopped reaching the store module that
now reads it, and mostly did not fail — the patches install `{}` or a stub the
path happens not to hit, so the divergence stays invisible until it matters.

The rule that replaced it:

* main.py calls `stores.get_privacy(...)`, not a local alias.
* Anything a test swaps is reached through its module — `runtime.get_supabase()`,
  `runtime.content_research_oai`, `memstore.privacy`,
  `content_research.research_learning_resources`. Never `from x import y` for
  those; the import binds the object.
* `main._get_supabase` is a wrapper function, not an aliased import, for exactly
  this reason.
* A name with a reader outside its module is public. Twelve feed internals had
  test consumers and lost their underscore; keeping it while importing anyway is
  a lie in the code.

## The rule the split follows

Within each subsystem, the line is **"does it touch the database or a model"**:

```
family.py        knows about turns, caches state,  never touches a table
family_store.py  talks to tables,                  never knows about a turn

knowledge.py     decides whether a turn needs evidence  (pure, no client)
knowledge_store  fetches it                             (embeddings, vectors)

dialogue.py      decides what to say                    (pure, no client)
dialogue_reply   calls the model                        (persona, contracts)
```

This is what lets `extract_and_upsert_memories` live in `family.py` with its
cache invalidation in the same function as the write — the only arrangement
where a stale memory block cannot be left behind by forgetting a line.

## The inversion that unblocked the rest

Worth recording, because the same shape will recur. The persistence section and
the feed section called each other: `_attach_recommendation_snapshots` and
`_apply_prepared_snapshot_to_feed_card` sat among the `_db_*` helpers and
reached back into the feed section for `_decorate_delivery_card` and
`_prepared_snapshot_set_meets_source_contract`. Neither layer could be lifted
out without dragging the other.

The direction was already obvious on reading them: they read and write
snapshots, but what they *do* with one is decorate a home card. That is
delivery work that happens to persist, not persistence that happens to
decorate. Moving those two functions to the feed side — pure code motion, no
signature or call site changed — left the store section needing nothing from
feed, and both became separable.

Look for this before reaching for a cut: when two blocks are mutually
dependent, usually one function is on the wrong side, not both blocks
genuinely entangled.

The feed is not a fifth subsystem. It is a delivery surface that consumes the
four — 知识与决策 picks its sources, 结果学习 ranks them — with a contract of
its own about what a parent may be shown. Forcing 3,000 lines of delivery rules
into the four boxes would be a worse map.

## Remaining

### 1. `backend/routes/` — the HTTP layer

What most of the remaining 4,543 lines are. `auth`, `children`, `feed`,
`collections`, `favorites`, `analytics`, `chat`, `tasks`, `privacy`, `admin`,
`rag`, `daily_push` — each an `APIRouter` that main.py mounts, leaving main.py
as app construction, middleware and mounting.

Mostly mechanical now: the routes call `stores.get_privacy`,
`feed_delivery.category_feed_card` and so on by module already, so a route
function can move without its body changing. The chat routes are the exception
— `_prepare_turn`, `_reply_context`, `_task_suggestion` and `_persist_ai_turn`
are turn orchestration rather than HTTP, and belong in `nuri_core` beside the
pipeline they drive.

The `global` rebindings that would have bitten here are already converted to
in-place mutation.

### 2. `backend/schemas.py`, `backend/seed_data.py`, `backend/email_push.py`

Pydantic models, the static feed cards and chat scripts, and the SMTP sender.
Zero coupling, movable at any time, deliberately left until last because they
buy modularity and nothing else.

## Verifying a move

The suite catches most breakage, but two classes of bug slip through, and both
bit during this work:

**Undefined names in the moved code.** A block that used `dt_time` because
main.py imported `time as dt_time` fails only on the branch that calls it — in
this case `follow_up_due_at` with a parent-stated date, which nothing offline
exercises. Scan for it:

```bash
python - <<'EOF'
import ast, builtins, pathlib
for p in pathlib.Path('backend').rglob('*.py'):
    tree = ast.parse(p.read_text(encoding='utf-8-sig'))
    defined = set(dir(builtins))
    for n in ast.walk(tree):
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): defined.add(n.name)
        elif isinstance(n, (ast.Import, ast.ImportFrom)): defined.update((a.asname or a.name).split('.')[0] for a in n.names)
        elif isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store): defined.add(n.id)
        elif isinstance(n, ast.arg): defined.add(n.arg)
        elif isinstance(n, ast.ExceptHandler) and n.name: defined.add(n.name)
        elif isinstance(n, ast.Global): defined.update(n.names)
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    if used - defined - {'__file__'}: print(p, sorted(used - defined - {'__file__'}))
EOF
```

**Overlapping cut ranges.** Deleting several line ranges from one file in a
single pass silently eats the edges when two ranges touch. Delete
highest-first, and assert on the first line of each range before cutting.

**Regexes written for import lists matching real code.** A pattern stripping
`^\s*name,$` out of a `from x import (...)` block also removed
`content_research_oai,` where it was a positional argument on its own line.
Compare the moved block against the original structurally, not just by eye:

```python
# definition sets and AST node counts, before vs after
orig_defs == new_defs and abs(ast_nodes_new - ast_nodes_orig) < expected_delta
```

**Tests that patch module internals.** `test_profile_ctx.py` monkeypatched
`backend.main.date`; the arithmetic now lives in `family_store`, so the patch
went to a module that no longer performs it and the test failed loudly. That is
the good case — a patch that silently stops applying is the bad one.

Offline suite: 686 tests. The `test_iter*` and `test_parenting_api` files need
a running server and fail identically on `main`.
