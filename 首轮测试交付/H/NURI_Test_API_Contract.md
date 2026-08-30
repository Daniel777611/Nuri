# NURI Test API Contract

For the DeepEval multi-turn run. Version 1.0 · 2026-08-30 · covers H-01 / BE-03.

Base URL: `https://nuri-git-nuri-test-1-ordashtech.vercel.app`

Everything below was exercised against that deployment. Verbatim request and
response bodies are in `sample_request_response.json`.

---

## 1. What differs from the proposed contract

The handoff document sketched `POST /api/chat` taking `{message,
conversation_id, user_id}`. NURI's real API is shaped differently, and the
differences are deliberate rather than incidental:

| Sketch | Actual | Why |
|---|---|---|
| `POST /api/chat` | `POST /api/chat/sessions/{id}/messages` | The conversation is a resource; the message is created inside it. |
| `message` | `text` | — |
| `conversation_id` in the body | in the path | — |
| `user_id` in the body | derived from the bearer token | A body-supplied user id would be an authorization bypass. It is ignored if sent. |
| `metadata.test_mode` | not a field | Isolation is a separate database, not a request flag. See §7. |
| — | `client_message_id` | Makes a retry idempotent. See §4. |
| — | `client_context.timezone` | The reply reasons about "today" and "last night". See §5. |

Adapting the runner to these names is a smaller job than changing the product's
API for a test, and it means the test drives the same route the app does.

---

## 2. Authentication

```
POST /api/auth/login
Content-Type: application/json

{"email": "automated_test_01@example.com", "password": "<password>"}
```

Returns `{"access_token": "...", "token_type": "bearer", "user": {...}}`.

Send it as `Authorization: Bearer <access_token>` on every other call. Tokens
last **7 days**; a regression run never needs to refresh mid-run, but logging in
again is free.

Twenty accounts, `automated_test_01` … `automated_test_20@example.com`, share
one password. Credentials arrive through the channel agreed separately — they
are not in this repository.

---

## 3. Conversations

**NURI gives an account exactly one conversation, permanently.** A database
constraint enforces it. This is a product decision, not a limitation of the test
setup: a parent scrolls back through everything they have ever said in one
place.

So the mapping for twenty blueprints is **one account per blueprint**, not
twenty conversations under one account. Separate accounts also give stronger
isolation than sessions would: they cannot share memory, profile facts or
product events even in principle.

```
POST /api/chat/sessions
Authorization: Bearer <token>

{}
```

Returns the account's conversation, creating it only if none exists. **The route
is idempotent** — call it at the start of every run; it will not create a
second conversation and will not cost a greeting.

Use the returned `id` as the conversation id. Map DeepEval's `thread_id` 1:1 to
one account, and let the server hold the state: send only the newest message
each turn, never the accumulated turns.

### Reset

```
POST /api/privacy/wipe
Authorization: Bearer <token>
```

Deletes the conversation and everything derived from it — messages, long-term
memories, follow-ups, children, tasks, favourites, turn logs. The login itself
survives, so the same account is immediately reusable for the next run. This is
the reset to call between repeat runs of the same blueprint.

**Do not use `DELETE /api/chat/sessions/{id}`.** It returns `409` by design: an
older client called it from an unmount handler and destroyed real conversations.

---

## 4. Sending a turn

```
POST /api/chat/sessions/{conversation_id}/messages
Authorization: Bearer <token>
Content-Type: application/json; charset=utf-8

{
  "text": "寶寶十個月，最近開始怕生，看到陌生人就大哭",
  "client_message_id": "mt_test_D07_run_01_turn_03",
  "client_context": {"timezone": "Asia/Taipei"}
}
```

| Field | Required | Notes |
|---|---|---|
| `text` | yes¹ | The parent's message. |
| `client_message_id` | recommended | 8–160 chars of `[A-Za-z0-9._:-]`. Unique per turn, **stable across retries of that turn**. |
| `client_context.timezone` | recommended | IANA name. Invalid names are rejected with 422 rather than guessed at. |
| `image_base64` | no | Not used by this test plan. |

¹ Either `text` or `image_base64` must be present.

**Encoding matters.** A body that is not UTF-8 is not rejected — the mangled
text reaches the model, which answers that it cannot read the message. Send
bytes, not a platform-encoded string.

### Idempotency

`client_message_id` determines the message's identity. If a request is sent
twice with the same id — a retry after a lost response, or the non-streaming
fallback after a stream failed to start — the server returns **the turn that was
already produced** instead of generating a second one. Reuse the id when
retrying the same turn; change it for a genuinely new turn.

Two requests racing on one conversation do not both generate: the second waits
briefly for the first, then returns its result.

### Response

```json
{
  "user_message": { "...": "the stored parent message" },
  "ai_messages": [ { "text": "...", "sources": [], "transition": null } ],
  "request_id": "06478a94bcaa44d5",
  "events": { "...": "see event_dictionary.md" },
  "version": { "model": "gpt-5.5", "prompt_version": "p_...",
               "backend_build": "dpl_...", "pipeline": "four_model" }
}
```

`ai_messages` is a list for historical reasons and currently always holds one
reply. Read `ai_messages[0].text` as the response text.

---

## 5. Time

The reply reasons about "今天", "昨晚", "上禮拜". The server does this from a
single clock reading frozen at the start of the turn, combined with the IANA
timezone in `client_context`. It never infers a timezone from language or
content, and it does not trust a client-supplied timestamp.

Omitting `client_context` is supported and yields UTC. For a Chinese-language
blueprint that is usually wrong by 8 hours, so send the timezone the persona
would plausibly live in and keep it constant for the whole conversation.

---

## 6. Streaming (optional)

```
POST /api/chat/sessions/{conversation_id}/messages/stream
```

Same body. Returns `text/event-stream`, verified working on this deployment:
`Content-Type: text/event-stream`, `X-Accel-Buffering: no`, chunked, with
incremental `data:` events.

```
data: {"type":"delta","text":"💜"}
data: {"type":"delta","text":" 我"}
...
data: {"type":"done","user_message":{...},"ai_messages":[...],
       "request_id":"...","events":{...},"version":{...}}
```

The `done` event carries the same envelope as the non-streaming response — take
the final text from it rather than concatenating deltas, so a dropped chunk
cannot silently truncate the transcript.

An error mid-stream arrives as `{"type":"error","code":...,"retryable":...}`.

**The non-streaming endpoint is the simpler choice for grading** and is what the
five-turn acceptance run used.

---

## 7. Test isolation

There is no `test_mode` flag. Isolation is structural: this deployment is bound
to a **separate Supabase project** that holds nothing but test data.

- Test conversations cannot reach a real family's memory, profile or analytics —
  they are not in the same database.
- The daily email push and the live card-research subsystem are switched off.
- The internal knowledge base and the operator style rules are present, so
  replies are shaped the way the product shapes them.

You can confirm which database answered without any credential: `prompt_version`
in every response is a hash of the prompt's stable half, including those style
rules. The test deployment returns a different value from production.

**One divergence to record.** The test project's style-rule set is not identical
to production's: it injects 19 rules where production injects 17. The
difference makes NURI more inclined to ask clarifying questions and to open with
an emotional acknowledgement than the live product currently is. `prompt_version`
distinguishes the two, so results stay attributable — but scores from this
environment should not be read as production's scores without noting it.

---

## 8. Errors

Every error carries a machine-readable envelope alongside the original `detail`:

```json
{
  "detail": "Missing or invalid token",
  "error": {"code": "AUTH_FAILED", "message": "Missing or invalid token",
            "retryable": false, "retry_after_ms": null},
  "request_id": "1b45172d0f8e4fb4"
}
```

| HTTP | code | retryable |
|---|---|---|
| 400 / 413 / 422 | `INVALID_REQUEST` | no |
| 401 / 403 | `AUTH_FAILED` | no |
| 404 | `NOT_FOUND` | no |
| 409 | `SESSION_CONFLICT` | **no** — see below |
| 429 | `RATE_LIMITED` | yes, after `retry_after_ms` |
| 500 / 502 / 503 | `SERVER_ERROR` | yes |
| 504 | `TIMEOUT` | yes |

A **409** means the same `client_message_id` already resolved with different
content. Re-sending cannot fix it; re-read the conversation instead.

On **422** the per-field list stays in `detail` — that is where the actionable
information is; `error.message` only summarises the first problem.

An unhandled crash surfaces as the platform's own 500 without this envelope.
Treat any 5xx as retryable whether or not `error` is present.

---

## 9. Versions

```
GET /api/version
```

```json
{"model":"gpt-5.5","prompt_version":"p_1d81d78dd2e2",
 "backend_build":"dpl_HbAeLbtSX19VCD3XteZ97dY97A7F",
 "pipeline":"four_model","pipeline_version":"four-model-v1"}
```

The same block rides on every chat response, so each transcript can be filed
against the build that produced it. No prompt text is disclosed.

`prompt_version` is a **content hash** of the persona, the output contract and
the operator style rules — not a number someone remembers to increment. If it
changes between two runs, the prompt changed, and the results are not
comparable. That is the field to assert on when deciding whether a batch may be
merged with an earlier one.

`backend_build` is the deployment id. If it ever reads `dev` on this host,
something is wrong with the deployment's environment and the run cannot be tied
to a commit.
