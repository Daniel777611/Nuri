# NURI Native Lab

Independent native iOS test client on the `iOS-native-test` branch. The user requested invitation-based external TestFlight distribution on 2026-10-01, superseding the previous internal-only plan. This is an Expo / React Native app, not a WKWebView around the hosted product. Consumer pages were ported from the audited `main` commit `6e243c9c3a5bb376a4102d4578b1a37a65baa4bd`. The existing `frontend`, `backend`, and `mobile-shell` directories are unchanged.

## Isolation

- Display name: **NURI Native Lab**, version **0.3.0 (1002)**.
- Independent Bundle ID: `com.ordashtech.nuri.nativelab`. The original web-shell app keeps `com.ordashtech.nuri`; both can be installed on the same phone. The lab uses only `nuri-native-lab://` links and separate login/installation/reminder storage. No old app data is migrated or deleted.
- It uses the existing production API at `https://nurifam.app/api` and the user's existing NURI account/data; this is **not** an isolated backend sandbox. Signing in is independent, but account-level server data/preferences are shared.
- Upload using **`ExportOptions-ExternalTestFlight.plist`**, with `testFlightInternalTestingOnly=false`, so the build can enter Beta App Review. This does not submit an App Store production release. `ExportOptions-InternalOnly.plist` is a retained alternate template, not the current release route.
- The separate Apple App ID and App Store Connect app record are registered: Apple App ID **6818022351**, distinct from the original **6814282315**. Distribute only through this separate app's dedicated external `NURI Native Lab External` group after approval. Never add a lab build to the original app's public `NURI Friends & Family` group. Original public builds, links, and tester caps must remain unchanged. The already-created lab internal group is a prerequisite container only; do not assign the current build to it or distribute internally.
- The earlier local `0.3.0 (1001)` archive used the original identity and is **superseded: never upload or install it**. Use only archives verified as `com.ordashtech.nuri.nativelab`.
- Remote APNs delivery is not yet compatible with the unchanged backend: it validates registrations against a single `APNS_BUNDLE_ID` and sends that topic. The lab must send its real identity, never impersonate the old app. Supporting both apps requires approved multi-topic backend work; changing the global topic to the lab would break old-app push. Local reminders remain explicitly local test reminders.
- iOS lab billing is read-only. Existing membership remains usable, but checkout and subscription-management calls are disabled until the backend can return specifically to the lab; its current app return route opens the original shell.

## Implemented consumer flows

Native screens reuse the current client/API contracts for email login/verification and recovery, onboarding, home and recommendations, persistent AI chat and feedback, image input, resource details/favorites, tasks/check-ins, child profiles, privacy preferences and language settings. Native recording uses Expo Audio and the existing transcription endpoint. APNs uses the Swift bridge directly, with native event handling and authenticated installation registration. Task cards save actual images to Photos; resource sharing uses the iOS share sheet. Common navigation and notification settings live in a non-floating top header.

Notification settings separate real backend `daily_push` preferences from optional **local test reminders**. Arbitrary minute/second intervals only affect local test reminders; they do not configure the backend scheduler or substitute content for a real remote notification. iOS sub-minute local schedules have bounded coverage, shown in the UI.

Web admin screens are not part of the consumer native migration. Existing server feature gates are preserved: no new StoreKit subscriptions, server scheduler controls, public community service or account-deletion API is invented by this client. Voice, camera, APNs delivery and authenticated production flows require device acceptance tests; passing compilation/unit tests alone is not proof of complete end-to-end feature parity.

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
pnpm test:native-storage
pnpm exec expo prebuild --platform ios --no-install
cd ios
pod install
```

Open `ios/NURINativeLab.xcworkspace`. The local config plugin installs the APNs bridge and delegate; make authoritative bridge changes in `native/`, then rerun prebuild. Preview mode is opt-in for fixtures and must not be enabled in a TestFlight archive.

## External TestFlight release

Archive scheme `NURINativeLab`, Release, generic iOS device, with the existing company Apple Distribution identity and the **lab-specific** `NURI Native Lab App Store Connect` provisioning profile. The old `NURI App Store Connect` profile cannot sign this distinct Bundle ID. Check the final archive's bundle ID, version/build, APNs production entitlement, permissions and embedded JavaScript. Export/upload with `ExportOptions-ExternalTestFlight.plist`. Build 1002 was signed successfully but its first upload failed before success, so it has not been published as Internal Only; do not re-upload an already accepted build number if this status changes.

After processing, confirm the build is eligible for external testing, provide the real beta description/feedback/contact information, the public privacy URL `https://nurifam.com/privacy`, a valid review login and honest testing notes (including the lab's remote APNs and payment limitations). Submit Beta App Review for the independent external group. No fabricated accounts, credentials, contacts or attachments. Do not report installability until Apple has approved the build and the tester invitation has actually been distributed. Use an invitation to the user's own TestFlight account; creating a public link or inviting others requires a separate explicit request.
