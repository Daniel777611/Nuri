# Rate limits, timeouts and retries

H-09 / BE-12. Numbers here are measured against the test deployment on
2026-08-30, not estimated.

---

## Measured latency

Five consecutive turns on one conversation, non-streaming, from a client
outside the platform:

| turn | ms |
|---|---|
| 1 | 8 465 |
| 2 | 10 540 |
| 3 | 8 595 |
| 4 | 10 499 |
| 5 | 12 134 |

Median 10.5s, slowest 12.1s. A turn does more than one model call — a small
routing model, an embedding for internal retrieval, then the reply — so the
floor is around 8s and there is no configuration that makes it much faster.

**Set the client timeout to 90 seconds.** Long enough that a slow turn is never
cut off, short enough that a genuinely stuck request is noticed. The platform's
own ceiling is 300s; nothing should ever get near it, and a turn that does is a
fault worth reporting rather than waiting out.

Record the observed duration per turn. `latency_ms` is not in the response body;
measure it client-side, or read the `version` block to confirm you are comparing
like with like across runs.

---

## Concurrency

**Two concurrent conversations. Do not raise it without asking.**

The backend runs as serverless functions where concurrent requests can share one
instance and a process-wide thread limit. Blocking calls from several turns can
therefore contend with each other rather than scaling out cleanly. Two is
comfortable; twenty parallel blueprints is not a supported shape.

Twenty blueprints at two at a time, five turns each, ~10.5s per turn, is roughly
**nine minutes of wall clock** for a full pass. Repeat runs multiply that. There
is no reason to push concurrency to save eight minutes.

There is **no request-per-minute limit configured** on this deployment, so
nothing will return 429 under this plan. The `RATE_LIMITED` code exists in the
error contract so a runner handles it correctly if one is ever added.

---

## Retries

The rule is in the error envelope: `error.retryable`. Do not infer it from the
status code alone — a 409 is a 4xx that specifically must not be resent.

| situation | do |
|---|---|
| `retryable: true` (5xx, 504) | Resend **with the same `client_message_id`**. |
| 429 | Wait `error.retry_after_ms`, then resend with the same id. |
| `retryable: false` (400/401/403/404/409/422) | Do not resend. Fix the request or re-read the conversation. |
| Timeout, no response | Resend with the same id. See below. |

### Why the same id matters

`client_message_id` is what makes a retry safe. The server derives the message's
identity from it, so a resend after a lost response returns **the turn that was
already produced** rather than generating a second one. A new id on a retry
creates a duplicate turn, and the transcript then contains a question the
persona never asked twice.

This is the one convention worth getting right in the runner: **one id per
logical turn, reused for every attempt at that turn.**

A timeout is the case that matters most. The request may well have succeeded on
the server while the response was lost; resending with the same id collects the
existing reply instead of paying for a second one.

---

## Maintenance and version stability

The deployment rebuilds when the branch is pushed. During a regression run,
nothing should be pushed to that branch — agree a window, or watch
`version.backend_build` and `version.prompt_version` on every response and split
the batch if either changes mid-run.

Those two fields are the authority on whether results may be merged. Neither is
maintained by hand: `backend_build` is the deployment id, `prompt_version` a
content hash of the prompt's stable half.

---

## Diagnosing a failure

Every response and every error carries `request_id`. Quote it when reporting a
problem — the backend can find that exact request, including which provider
calls it made and how long each took. Without it, "a turn was slow yesterday"
is not something anyone can look up.
