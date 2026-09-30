# NURI Native Lab

Private native iOS test client on the `iOS-native-test` branch. This is an Expo / React Native app, not a WKWebView around the hosted product. Consumer pages were ported from the audited `main` commit `6e243c9c3a5bb376a4102d4578b1a37a65baa4bd`. The existing `frontend`, `backend`, and `mobile-shell` directories are unchanged.

## Isolation

- Display name: **NURI Native Lab**, version **0.3.0 (1001)**.
- Bundle ID remains `com.ordashtech.nuri` because the existing APNs backend accepts that identity. It uses the existing production API at `https://nurifam.app/api` and the user's existing NURI account/data; this is **not** an isolated backend sandbox.
- Upload using `ExportOptions-InternalOnly.plist`. Its `testFlightInternalTestingOnly` flag is mandatory. Never submit this build to external testing or add it to the public `NURI Friends & Family` group.
- Only add it to a dedicated internal `NURI Native Lab` group. Public builds, public links, and tester caps must remain unchanged.
- Installing it replaces the previous NURI app on that particular tester's phone. It does not coexist as a second app. Switching back is possible by installing the public build again from TestFlight.

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
pnpm exec expo prebuild --platform ios --no-install
cd ios
pod install
```

Open `ios/NURINativeLab.xcworkspace`. The local config plugin installs the APNs bridge and delegate; make authoritative bridge changes in `native/`, then rerun prebuild. Preview mode is opt-in for fixtures and must not be enabled in a TestFlight archive.

## Internal TestFlight release

Archive scheme `NURINativeLab`, Release, generic iOS device, with the existing company Apple Distribution identity and App Store provisioning profile. Check the final archive's bundle ID, version/build, APNs production entitlement, permissions and embedded JavaScript. Export/upload only with `ExportOptions-InternalOnly.plist`. After Apple finishes processing, verify the internal-only label and attach the build only to the dedicated internal group before reporting it available to testers.
