# Main synchronization candidate 1006

Status on 2026-10-05: **0.3.0 (1006) uploaded, processed and available in both existing Lab test groups**. Apple displays `Testing` in the internal and external groups after the external `Submit for Review` action. Real Google-to-NURI login, online video playback and the actual phone Update button remain separate, unverified acceptance checks.

## Scope and identity

- Read-only source reference: `origin/main` commit `753ecffe6bd90f3f077b4e2b2da1b4999893d165`.
- Only `native-ios` on `iOS-native-test` is modified. No `main`, `frontend`, shared production backend, deployment, existing Web OAuth client permissions or public shell release is changed.
- Candidate: `0.3.0 (1006)`, `com.ordashtech.nuri.nativelab`, Apple app `6818022351`, phone label `Nuri`.
- Existing production account/API remains `https://nurifam.app/api`; this is not a sandbox. Existing 1005 remains available; no previous build or original public shell was expired.

## Implemented source changes

- Home daily video and main-chat check-in, retaining proportional artwork, account-scoped state and explicit failures.
- Dedicated saved/today video page, YouTube embedded playback, available summary and conversation transition. Player URLs require an exact 11-character video ID, send no NURI JWT or shared cookies, and unload on background/blur. Its Referer identifies the actual app bundle.
- Latest main question-first daily articles and chat video cards.
- Matching daily-video/check-in/Google API contracts and English/Traditional Chinese copy. Saved video reads remain usable without new AI permission; operations that may generate content remain gated.
- Official native Google SDK with installed-binary configuration checks, cancellation handling, server-side identity exchange and existing SecureStore/session-generation ownership controls. It does not embed web OAuth or trust a provider email as the NURI identity.

## Verification to date

All 27 offline regression commands passed after integrating the candidate: existing account/session/storage/permission/navigation/push/voice/billing/deletion/chat/image tests plus new Google, video and main-API suites. The new Google suite has 46 cases; the final video suite has 47 including 19 existing regressions and six subsequent reliability checks; the main-API suite has 16. TypeScript, affected React ESLint and `git diff --check` passed. Pods installed successfully. These mocked tests are not authenticated production or video playback evidence.

Anonymous, read-only production probes show video/check-in routes require authentication, and `HEAD /api/auth/google` returns 405 with `Allow: POST`. Route existence does not prove Google audience configuration, database permissions, generated content or APNs works.

The installed Simulator Release 1006 exposes the enabled native Google button and opens the genuine `accounts.google.com` sign-in page, branded "Continue to Nuri". Login completion was handed to the user; no Google credential was entered by the agent, and no returned NURI JWT is verified.

Device archive `build/archives/NURI-Native-Lab-0.3.0-1006.xcarchive` completed with `ARCHIVE SUCCEEDED`. Independent read-only verification of that exact archive passed strict Apple Distribution signing, the Lab bundle/profile/team, APNs production, disabled debugging and no shared Keychain entitlement. Its linked native Google bridge/SDK, actual public client IDs and callback match. Its own Hermes bytecode confirms `https://nurifam.app/api` and `preview=false`; SHA256 `75dfbe586a150b0b161e6df420d1bb21393925ac91f9dd923dc787bd1d19848f`. This does not prove authenticated Google exchange or video playback.

## Release outcome and follow-up verification

1. Completed: the user verified the company browser account; the existing `Nuri web` client was located in project `nifty-canyon-510623-c2`. After the user's explicit action-time confirmation, a separate iOS client for `com.ordashtech.nuri.nativelab` was created. The original Web client and its settings were not changed.
2. Both public client IDs, the correct callback scheme and linked bridge/SDK are verified in the actual Simulator and device binaries. Backend audience acceptance and a real authorized login still need verification. The project is External/Testing, but this SDK's basic `email profile` request qualifies for Google's test-list exception; no additional users or publishing permissions were needed or changed. No production backend audience was changed. See `native-google-signin.md`.
3. Verify actual YouTube playback and an authorized real Google login against the existing shared backend. Production AI generation/account writes are not covered by the offline tests.
4. Apple's 4.8 equivalent privacy-preserving login requirement remains a broader App Store review risk; the observed external `Testing` status does not prove universal or future review compliance. The audited main does not expose an Apple-token login API; a decorative Apple button is not a solution. No such shared backend change was made.
5. The user completed existing-account Xcode reauthentication. Organizer reports `Uploaded to Apple`, build number `1006`, and App Store Connect received it on Oct 5, 2026 at 5:04 PM America/Chicago. Apple processing completed. Existing internal group `NURI Native Lab` and external group `NURI Native Lab External` both show `0.3.0 (1006)` as `Testing`; accurate What to Test text was saved and automatic notification was left enabled. The existing authorized own internal tester is still present and was last reported installed on 1005, so the account has 1006 eligibility; the actual phone Update button and 1006 installation were not inspected. The external group currently has zero testers and no public link; no new public exposure or invitations were created.
6. Xcode reported non-blocking symbol-upload warnings for React.framework, ReactNativeDependencies.framework and hermes.framework. The app's own dSYM matches its binary; corresponding framework dSYMs were absent from the cached vendor distributions. These warnings affect framework crash symbolication, not the observed upload/processing/testing outcome. Do not substitute unrelated UUID symbols or rebuild/re-upload 1006 merely to hide them.

No credentials, provider tokens, user content or private keys belong in this document.
