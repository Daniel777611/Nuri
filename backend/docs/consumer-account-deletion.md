# Consumer account deletion (independent native-test branch)

This source is not a deployment. Do not connect tests to production or invoke a
real delete to verify it. NURI uses custom JWTs and public.users, not Supabase
Auth accounts; neither an administrator key nor auth.admin.deleteUser is used.

## Contract

DELETE /api/auth/account, with the current bearer token and JSON:

    {"confirmation":"DELETE","password":"current account password"}

No user ID or email is accepted. Confirmation is exact, extra fields are
rejected, and the password is a non-empty string of at most 72 UTF-8 bytes.

Success is HTTP 200, only after durable absence of the caller's user row is
confirmed:

    {"ok":true,"account_deleted":true,"subscription_cancelled":false}

Failures retain the existing error envelope. Business codes are in detail,
not the generic error.code:

| HTTP | detail.code | detail.deletion_state | Client meaning |
| --- | --- | --- | --- |
| 403 | ACCOUNT_REAUTH_FAILED | not_started | Wrong/changed password; retain the valid login. |
| 503 | ACCOUNT_DELETION_UNAVAILABLE | not_started | Dependency preflight failed; no delete statement began. |
| 503 | ACCOUNT_DELETION_INCOMPLETE | partial | Cleanup began; some records may be gone, but this call did not confirm identity removal. Do not claim rollback. |
| 503 | ACCOUNT_DELETION_UNCONFIRMED | unknown | Identity DELETE may have committed, or identity is gone but final privacy metadata erasure was not confirmed. Recheck /auth/me when online; 401 means the session is no longer usable, not proof every final metadata cleanup succeeded. |

Missing/invalid/deleted identities are 401; auth-storage outages are 503 (string
detail). Invalid input is 422 without echoed passwords. An absent route,
unsupported method, malformed success, network loss or timeout is never proof of
successful deletion. Only explicit success permits the client to report deletion.
Local sign-out must still compare the captured session, so a late result cannot
sign out a subsequently logged-in different account.

## Erasure and billing scope

The service preflights, then durably writes and reads back an all-false privacy
tombstone using the same privileged database client. Its write/readback failure
starts no destructive deletion. It then deletes caller-scoped FK-free favorites, collections,
LLM usage logs, optional turn outcomes/traces/reviewer eligibility, hashed
privacy/recommendation settings, and email verification/reset codes. Identity is
deleted after other data with a compare against the reverified password hash. Existing
users FK cascades remove owned family profiles, conversations/photos, tasks,
memories, feedback, push registration/events and local billing caches.
Only after durable identity absence is confirmed is the privacy tombstone
removed and its absence read back. Partial deletion leaves the explicit opt-out
in place, rather than reviving default-on preferences. A final tombstone cleanup
failure returns UNCONFIRMED, never 200; identity may already be gone and the
remaining hashed opt-out metadata then requires authorized operator cleanup.

Deleting this shared cloud identity affects the old public app and all other
clients of the same account. It does not cancel Stripe or App Store subscriptions
or delete provider billing records, previously transferred processor data, or
backups subject to retention. Operator-derived global style rules have no
reliable account ownership in the existing schema and are not globally erased.
The client must disclose these limits before confirmation.

This is not a multi-statement transaction: a partial failure is reported
honestly, not restored. Already-authorized requests/background work in other
workers can finish, overwrite settings, or recreate FK-free auxiliary records.
The tombstone does not cancel already-running calls or prevent another already
authorized writer from changing privacy; stronger serialization needs the
separately approved deletion-state/transaction design. No new request can
authenticate a deleted UID: both required and optional custom-JWT dependencies
freshly query users on every request, without memory-cache fallback. Same-email
registration creates a different UID and cannot revive the old JWT.
Strict atomic erasure/cancellation of already-started work requires separately
authorized schema/transaction/deletion-state work; it is not claimed here.

## Deployment gates (not performed)

The checked-in deployment routes /api/* through api/backend.py to
backend.main.app via vercel.json. No separate live backend was created.
The production origin has not received this branch or endpoint.

Before release, an authorized backend owner must:

1. Approve the deployment target, database isolation and deletion authority.
   A Vercel preview must not silently use production Supabase credentials/data.
2. Verify the actual database matches the existing migrations and FK cascades,
   including notification child cascades; required ancillary tables and service
   permissions must be present. The endpoint requires explicit
   SUPABASE_SERVICE_ROLE_KEY configuration and refuses runtime's anon-key
   fallback with 503 before deletion. Presence of that setting is not proof of
   the actual database role: the deployment owner must verify that the chosen
   server credential really has complete required permissions. Never print or
   copy its value into source. There is no schema migration in this patch.
3. Assess the global fresh-identity lookup's latency/availability impact on the
   old app and other protected clients, and the non-atomic/in-flight limits.
4. Validate an isolated seeded test account's API/UI contract and billing
   disclosure, then explicitly authorize any production promotion.

Until a compatible authorized backend is connected, the native UI must treat
404/405/503 as unavailable or uncertain, not as completed account deletion.

## Isolated verification

backend/tests/test_account_deletion.py uses a fake PostgREST database and
blocks sockets, DNS and Supabase client construction. Import suppresses .env
loading. It covers ownership, confirmation/password bounds, session retention,
deleted JWTs, optional-auth cache denial, dependency/partial failures, timeout
readback, same-email new identities and concurrent password-reset boundaries.
Do not run legacy live-API integration tests as a substitute.
