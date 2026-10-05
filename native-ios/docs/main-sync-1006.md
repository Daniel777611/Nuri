# Main synchronization candidate 1006

Status on 2026-10-05: source implementation and offline regressions complete; **not uploaded to TestFlight**. Native compilation and real service acceptance are separate gates, not implied by the tests below.

## Scope and identity

- Read-only source reference: `origin/main` commit `753ecffe6bd90f3f077b4e2b2da1b4999893d165`.
- Only `native-ios` on `iOS-native-test` is modified. No `main`, `frontend`, shared production backend, deployment, Google permissions or public shell release is changed.
- Candidate: `0.3.0 (1006)`, `com.ordashtech.nuri.nativelab`, Apple app `6818022351`, phone label `Nuri`.
- Existing production account/API remains `https://nurifam.app/api`; this is not a sandbox. Existing 1005 remains available while this candidate is checked.

## Implemented source changes

- Home daily video and main-chat check-in, retaining proportional artwork, account-scoped state and explicit failures.
- Dedicated saved/today video page, YouTube embedded playback, available summary and conversation transition. Player URLs require an exact 11-character video ID, send no NURI JWT or shared cookies, and unload on background/blur. Its Referer identifies the actual app bundle.
- Latest main question-first daily articles and chat video cards.
- Matching daily-video/check-in/Google API contracts and English/Traditional Chinese copy. Saved video reads remain usable without new AI permission; operations that may generate content remain gated.
- Official native Google SDK with installed-binary configuration checks, cancellation handling, server-side identity exchange and existing SecureStore/session-generation ownership controls. It does not embed web OAuth or trust a provider email as the NURI identity.

## Verification to date

All 27 offline regression commands passed after integrating the candidate: existing account/session/storage/permission/navigation/push/voice/billing/deletion/chat/image tests plus new Google, video and main-API suites. The new Google suite has 46 cases; the final video suite has 47 including 19 existing regressions and six subsequent reliability checks; the main-API suite has 16. TypeScript, affected React ESLint and `git diff --check` passed. Pods installed successfully. These mocked tests are not authenticated production or video playback evidence.

Anonymous, read-only production probes show video/check-in routes require authentication, and `HEAD /api/auth/google` returns 405 with `Allow: POST`. Route existence does not prove Google audience configuration, database permissions, generated content or APNs works.

## Remaining gates

1. Completed: the user verified the company browser account; the existing `Nuri web` client was located in project `nifty-canyon-510623-c2`. After the user's explicit action-time confirmation, a separate iOS client for `com.ordashtech.nuri.nativelab` was created. The original Web client and its settings were not changed.
2. Both public client IDs and the correct callback scheme are now in the generated iOS configuration. Actual installed-binary configuration, backend audience acceptance and a real authorized login still need verification. The project is External/Testing, but this SDK's basic `email profile` request qualifies for Google's test-list exception; no additional users or publishing permissions were needed or changed. No production backend audience was changed. See `native-google-signin.md`.
3. Verify native compilation, actual YouTube playback and an authorized real Google login against the existing shared backend. Production AI generation/account writes are not covered by the offline tests.
4. Assess Apple's 4.8 equivalent privacy-preserving login requirement before claiming a Google-enabled external beta is compliant. It is not a technical upload check. The audited main does not expose an Apple-token login API; a decorative Apple button is not a solution.
5. Only after acceptance: create/verify the candidate's signed archive, upload it to the independent lab, verify Apple processing and testing availability, and verify this user's install/update availability. An upload attempt alone is not completion.

No credentials, provider tokens, user content or private keys belong in this document.
