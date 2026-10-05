# NURI Native Lab

Independent native iOS test client on the `iOS-native-test` branch. Invitation-based external TestFlight remains the review route; access for the user's existing TestFlight account through the lab's internal group was separately authorized. The build is not internal-only. This is an Expo / React Native app, not a WKWebView around the hosted product. Consumer pages were ported from the audited `main` commit `6e243c9c3a5bb376a4102d4578b1a37a65baa4bd`. Existing `frontend` and `mobile-shell` are unchanged. A separately authorized consumer account-deletion backend patch is included only on this branch; it has not been deployed by building the iOS app. No changes are pushed to `main` or the public `iOS` branch.

## Isolation

- Phone display name: **Nuri**. App Store Connect's localized app name was saved as **Nuri 3.0** because Apple reported **Nuri** was already in use. The technical Expo name remains **NURI Native Lab**, with Xcode scheme/target **NURINativeLab**; the independent Bundle ID and tester groups are unchanged.
- Build **0.3.0 (1005)** is uploaded, processed, and available in the independent lab's internal and external groups. On 2026-10-05 Apple reported the authorized own internal tester had installed 1005; the phone's Update button was not inspected directly. The current source candidate is **0.3.0 (1006)**, synchronizing the new consumer changes from `main` commit `753ecffe6bd90f3f077b4e2b2da1b4999893d165`, and **not yet uploaded**. See `docs/main-sync-1006.md` for its outstanding acceptance gates.
- Independent Bundle ID: `com.ordashtech.nuri.nativelab`. The original web-shell app keeps `com.ordashtech.nuri`; both can be installed on the same phone. The lab uses only `nuri-native-lab://` links and separate login/installation/reminder storage. No old app data is migrated or deleted.
- It uses the existing production API at `https://nurifam.app/api` and the user's existing NURI account/data; this is **not** an isolated backend sandbox. Signing in is independent, but account-level server data/preferences are shared.
- Upload using **`ExportOptions-ExternalTestFlight.plist`**, with `testFlightInternalTestingOnly=false`, so the build can enter Beta App Review. This does not submit an App Store production release. `ExportOptions-InternalOnly.plist` is a retained alternate template, not the current release route.
- The separate Apple App ID and App Store Connect app record are registered: App Store Connect Apple ID **6818022351**, distinct from the original **6814282315**. External invitations use this separate app's `NURI Native Lab External` group after approval; the existing lab internal group is limited to the separately authorized tester. Never add a lab build to the original app's public `NURI Friends & Family` group. Original public builds, links, and tester caps must remain unchanged.
- The earlier local `0.3.0 (1001)` archive used the original identity and is **superseded: never upload or install it**. Use only archives verified as `com.ordashtech.nuri.nativelab`.
- Remote APNs delivery is not yet compatible with the unchanged backend: it validates registrations against a single `APNS_BUNDLE_ID` and sends that topic. The lab must send its real identity, never impersonate the old app. Supporting both apps requires approved multi-topic backend work; changing the global topic to the lab would break old-app push. Local reminders remain explicitly local test reminders.
- iOS lab billing is read-only. Existing membership remains usable, but checkout and subscription-management calls are disabled until the backend can return specifically to the lab; its current app return route opens the original shell.

## Implemented consumer flows

Native screens reuse the current client/API contracts for email login/verification and recovery, onboarding, home and recommendations, persistent AI chat and feedback, image input, resource details/favorites, tasks/check-ins, child profiles, privacy preferences and language settings. Native recording uses Expo Audio and the existing transcription endpoint. APNs uses the Swift bridge directly, with native event handling and authenticated installation registration. Task cards save actual images to Photos; resource sharing uses the iOS share sheet. Common navigation and notification settings live in a non-floating top header.

Notification settings separate real backend `daily_push` preferences from optional **local test reminders**. Arbitrary minute/second intervals only affect local test reminders; they do not configure the backend scheduler or substitute content for a real remote notification. iOS sub-minute local schedules have bounded coverage, shown in the UI.

Web admin screens are not part of the consumer native migration. Existing server feature gates are preserved: no new StoreKit subscriptions, server scheduler controls or public community service is invented by this client. The dedicated account-deletion screen uses only the approved consumer `/auth/account` contract, not the administrator endpoint. That new contract is not deployed by the iOS build; the current beta submission discloses this limitation and must not claim account deletion succeeded. Voice, camera, APNs delivery and authenticated production flows require device acceptance tests; passing compilation/unit tests alone is not proof of complete end-to-end feature parity.

Native chat attachments accept ordinary 24/48 MP photos within a 50 MP / 10000 px / 25 MiB source limit and resize to at most 1600 px before JPEG upload. The native decoder still loads the source image; peak memory on low-memory devices requires acceptance testing.

## Development

Use Node 20+ and pnpm 11.25.0. No server secrets or APNs private key belong in this project.

```sh
pnpm install
pnpm typecheck
pnpm test:native-ui
pnpm test:native-voice
pnpm test:native-push
pnpm test:native-bootstrap
pnpm test:native-auth
pnpm test:session-isolation
pnpm test:native-storage
pnpm test:ai-consent
pnpm test:account-deletion
pnpm test:daily-video
pnpm test:main-sync
pnpm test:native-google
pnpm exec expo prebuild --platform ios --no-install
cd ios
pod install
```

Open `ios/NURINativeLab.xcworkspace`. The local config plugin installs the APNs bridge and delegate; make authoritative bridge changes in `native/`, then rerun prebuild. Preview mode is opt-in for fixtures and must not be enabled in a TestFlight archive.

## External TestFlight release

Uploaded build 1004 adds monotonic session boundaries: account-specific views clear immediately when credentials change, and old JSON/error/stream results or callbacks cannot repopulate another account's screen, overwrite its login, or perform a second write under its JWT. Captured-owner push cleanup and account deletion retain their explicit ownership checks. The reproducible isolation suite executes real API modules, hooks and component callbacks with mocked transports; it is not a production end-to-end test.

Released 1005 adds the short phone display name `Nuri`, proportional home mascot layout, native knowledge/chat entry repairs, and distinct permission/session/service/connection error handling. Exact read-only preview/feed/search/detail and saved daily-card-by-ID requests stay usable without AI permission; personalized generation, today's daily-card generation and chat sends remain gated. Permission approval can return to a sanitized app-local origin only after the choice is saved. It still uses the same shared production backend and existing account data, not a new sandbox.

Candidate 1006 adds a native daily-video page and in-app YouTube player, the main-chat check-in entry, question-first daily articles and chat video cards, plus the official native Google sign-in SDK and guarded server-token exchange. Real Google iOS/Web OAuth configuration and authorized device acceptance remain outstanding; a missing configuration explicitly leaves email login available rather than pretending Google works. No shared backend, `main`, original public app, or existing tester group was changed by this source synchronization.

Archive scheme `NURINativeLab`, Release, generic iOS device, with the existing company Apple Distribution identity and the **lab-specific** `NURI Native Lab App Store Connect` provisioning profile. The old `NURI App Store Connect` profile cannot sign this distinct Bundle ID. Check the final archive's bundle ID, version/build, APNs production entitlement, permissions and embedded JavaScript. Export/upload with `ExportOptions-ExternalTestFlight.plist`. Build 1005 has been accepted, processed and configured in both existing lab groups. Candidate 1006 needs its own acceptance verification, signed archive and upload. Existing binaries do not receive these new source changes automatically. Never reuse an already accepted build number. Google-enabled external review also needs assessment of Apple's equivalent privacy-preserving login requirement; uploading a binary is not evidence of review compliance.

For a new candidate, after processing confirm external-testing eligibility, provide the real beta description/feedback/contact information, the public privacy URL `https://nurifam.com/privacy`, a valid review login and honest testing notes (including the lab's account-deletion backend, remote APNs and payment limitations). Submit Beta App Review for the independent external group. No fabricated accounts, credentials, contacts or attachments. Do not report external installability until Apple has approved the build and the tester invitation has actually been distributed. Approved internal access is separate from external review and does not prove the user installed or tested the app. Creating a public link or inviting others requires a separate explicit request.

### Outstanding external-review checks

The existing `/privacy/wipe` endpoint removes content but retains the login account; it is not account deletion. The new dedicated screen reauthenticates the current NURI password, requires exact `DELETE`, and captures the owning session. It accepts only `account_deleted:true`, protects a newer login from older completion, and exposes local credential-cleanup retry. The consumer backend patch has isolated mock tests, but actual production service-role permissions/FK cascades remain unverified and the endpoint is not deployed. Build 1004 was submitted before that rollout with the limitation disclosed; submission is not approval or proof of functional completeness, and Apple may require it to be resolved. See `backend/docs/consumer-account-deletion.md`. Never invoke the administrator endpoint or test by deleting a real account.

Third-party AI processing now has an explicit versioned per-user permission gate before native client requests, including automatic `/chat/sessions` greetings, family-context writes, text/image/audio chat and AI feeds. Refusal preserves non-AI controls; revocation stops future lab requests. Source and mocked actual callbacks are verified. It does not retroactively remove old conversations, change another client's settings or cancel already-started server work/crons. Final binary and authenticated device acceptance remain necessary; do not report this build as review-ready based only on unit tests.

The privacy URL returned HTTPS HTTP 200 and its 11-section NURI / Ordash Tech, Inc. policy was publicly readable without login in a browser on 2026-10-01. Real review login, authenticated device flows and final signed archive contents must still be verified. The first export failed with `Failed to Use Accounts`; Xcode was then found to have no signed-in Apple account. The user completed Xcode login and the Ordash Tech, Inc. team is now visible. No login bypass, key rotation or legal acceptance was performed.
