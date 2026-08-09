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
| `nuri_core/family_store.py` | 619 | `users`, `children`, `user_memories`, `follow_ups`, `normalized_inputs`, and the rendering of each |
| `nuri_core/knowledge_store.py` | 195 | the `internal` and `pdf` vector namespaces, embedding, chunking |
| `nuri_core/dialogue_reply.py` | 807 | persona, reply contract, both reply calls, streamed-JSON parser, task-card rules, `#fix` distillation, proactive composer |

`runtime.py` came first because nothing else could move until there was a way
to reach the Supabase handle without importing a module that builds a FastAPI
app at import time. That single import cycle is why `nuri_core` originally had
to receive all its data through injected callables.

main.py: **10,053 → 8,538 lines.**

Every moved name is re-exported from main.py under its old private alias, so
routes and tests that read them off `backend.main` are untouched. The aliases
are temporary — they go when the routes move out.

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

## Remaining, in dependency order

### 1. `backend/stores/` — the Supabase persistence section (1,181 lines)

Feed cards, favourites, collections, privacy settings, recommendation snapshots
and recommendation events. The last of those is the outcome model's data and
should land in `nuri_core/outcome_store.py`; the rest is a generic store layer.

**Blocked by a real knot, not by mechanics.** The persistence section calls
`_decorate_delivery_card` and `_prepared_snapshot_set_meets_source_contract`,
which live in the feed section — so stores and feed currently depend on each
other. The fix is an inversion, not a cut: `_attach_recommendation_snapshots`
is doing delivery-layer work inside the store layer and belongs on the feed
side. Do that first, as its own change, then this block moves cleanly.

### 2. `backend/feed/` — the feed section (4,132 lines, the largest by far)

Two natural modules:

* `feed/signals.py` — conversation-signal detection and learning-content
  ranking. All pure text analysis, no I/O, already the most testable code in
  the file.
* `feed/delivery.py` — the delivery contract: resource pairing, locale
  priority, authority gating, card decoration.

Measured coupling of the helper half (lines 2339–5091, 2,753 lines, 86 names):

* needs **8** names from elsewhere: `_db_get_privacy`,
  `_PRIVACY_STORAGE_UNAVAILABLE`, `_db_append_recommendation_events`,
  `_db_get_recommendation_events`, `_new_recommendation_event`,
  `_db_get_recommendation_snapshot_persistent`, `_normalize_preferred_locale`,
  `_urgent_task_suppressed` — the last already lives in `dialogue_reply`, and
  the rest arrive with step 1
* exports **24** names to the route handlers

So this is mechanical *after* step 1, and not before.

Note this block is not one of the four subsystems. It is a second delivery
surface that consumes them — 知识与决策 picks its sources and 结果学习 ranks
them — and forcing 4,000 lines of delivery-contract logic into the four boxes
would be a worse map, not a better one.

### 3. `backend/routes/` — the HTTP layer

`auth`, `children`, `feed`, `collections`, `favorites`, `analytics`, `chat`,
`tasks`, `privacy`, `admin`, `rag`, `daily_push`. Each becomes an `APIRouter`
that main.py mounts. This is what finally deletes the alias block, because
nothing outside main.py will still be calling `_profile_ctx`.

The in-memory fallback stores (`_tasks`, `_children`, …) move with the routes.
Watch the three `global _tasks` / `global _children` rebindings — rebinding a
name imported into another module updates the importer's binding only, so those
must become in-place mutation or attribute assignment.

### 4. `backend/schemas.py`, `backend/seed_data.py`, `backend/email_push.py`

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

**Tests that patch module internals.** `test_profile_ctx.py` monkeypatched
`backend.main.date`; the arithmetic now lives in `family_store`, so the patch
went to a module that no longer performs it and the test failed loudly. That is
the good case — a patch that silently stops applying is the bad one.

Offline suite: 686 tests. The `test_iter*` and `test_parenting_api` files need
a running server and fail identically on `main`.
