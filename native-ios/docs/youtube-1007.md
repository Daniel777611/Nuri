# Nuri YouTube TestFlight iteration 1007

Released to TestFlight on 2026-10-06: **0.3.0 (1007)**. The YouTube navigation and metadata fixes pass the final offline regression checks. The production archive has succeeded and passed identity/signature verification. User-authorized non-destructive signing recovery is complete: the new identity passed a lock/unlock/sign round trip and the production IPA exported successfully and passed independent verification. Xcode confirms **Uploaded to Apple** at 15:11 CDT; App Store Connect has processed build 1007 and shows **Testing**, with the existing internal and external groups attached. This is an update of the same app, not a new app or a new installation entry. Later diagnostics confirm that the old login Keychain was already unlocked; repeated Mac-password entry was not a justified remediation.

## Scope and identity

- Only `native-ios` on `iOS-native-test` changes. The shared production backend, `main`, Meta recommendations, original public web-shell app, Google OAuth clients and production accounts are unchanged.
- Apple app `6818022351`, bundle `com.ordashtech.nuri.nativelab`, team `6PL6HQYU7P`, phone display name `Nuri` and marketing version `0.3.0` remain unchanged. Source config, generated Info.plist and both Xcode target configurations use build `1007`.
- The API remains `https://nurifam.app/api`. A Simulator preview is explicitly marked **NOT FOR UPLOAD**; the device archive must use preview mode disabled.

## YouTube changes

The summary page retains the official YouTube privacy-enhanced embedded player. Its normal links, related-video links, help links and clicked advertisement destinations can now open through iOS HTTPS universal links: the installed YouTube app can handle its links, otherwise the system browser handles them. New-window callbacks no longer discard every destination. Related embed links are converted to ordinary YouTube watch links before dispatch.

External navigation rejects non-HTTPS schemes, URL credentials, unexpected ports, control characters, IP-address destinations and common local-network host suffixes. The isolated WebView still receives only its actual app-identifier Referer, not NURI authorization headers or shared cookies. Automatic unrelated top-frame redirects are denied; validated HTTPS player subframes remain available. Link failures offer a visible retry without falsely marking video playback as failed. Duplicate pending callbacks, backgrounding, leaving the screen, unmounting and changing video IDs cannot restore stale link errors or dispatch saved callbacks.

Home video cards show the original source title and a complete, untinted thumbnail, with channel and recommendation copy outside the image. The summary page also shows the original title; the backend's AI display title is a separate guide heading. The existing disclosure remains accurate: NURI's points come from the video's title and search description, not from watching its footage.

Chat video transitions likewise use a complete thumbnail without a play-button overlay, identify YouTube and label the returned title as **NURI content guide**. The existing backend transition payload can contain its AI display title; opening the detail page retrieves the full card and shows the source title. This iteration does not invent an original title that is absent from that limited payload.

## Final offline verification

All **25 `test:*` package commands** pass after the final chat and player changes. Node's counted suites report **307 test cases**, including **54 daily-video and related Home tests**, **46 native Google tests** and **16 main API contract tests**. Another nine commands use direct assertion scripts and do not expose a case count. No real backend or account calls run in these fixtures.

`tsc --noEmit` and ESLint for `YouTubePlayer.tsx`, `DailyVideoCard.tsx`, `app/daily-video.tsx` and `app/chat/[id].tsx` pass with zero errors and zero warnings. The initial bootstrap failure was a stale `1006` expectation; its source/config consistency checks now pass for `1007`.

The navigation tests exercise normal and new-window YouTube links, clicked advertisement links, secure URL rejection, related embeds, browser dispatch failure and retry, background/unmount/video-change races, thumbnail presentation and original-title versus AI-guide presentation. Offline fixtures do not prove live WKWebView playback, the installed YouTube app handoff or Apple distribution eligibility.

## Release gates

Upload gate initially observed at 13:11 CDT: both recommended and explicit/manual existing-certificate/profile Xcode upload paths fail while re-signing `React.framework` with `errSecInternalComponent`. A command-line re-sign probe on the failed temporary export also fails with the same existing company identity. Initial `security show-keychain-info` authentication failures were insufficient evidence to conclude that the Keychain was locked.

Subsequent non-secret diagnostics on 2026-10-06 establish that the canonical login Keychain is unlocked, readable and writable (`SecKeychainGetStatus=0`, flags `0x7`). The existing Distribution identity and private-key reference are present, but an item-specific legacy access query fails with `errSecAuthFailed`. A fresh Xcode restart and standard distribution retry still fail, and signing an isolated copy of `/usr/bin/true` with the exact same existing identity also fails with `errSecInternalComponent`. Thus the failure is not specific to React or the app export configuration. The exact underlying private-key operation fault remains unresolved; do not infer an incorrect Mac password or claim confirmed key corruption. The separate `login_renamed_1` password prompt was canceled; that is not the current default signing Keychain.

After the user explicitly authorized recovery, a new Apple Distribution certificate (`AB87E0C98D349BD895BDAFB466129DB17D5E9C12`, Apple ID `SVZQN6ASC2`, expiry 2027-10-06) and matching App Store Connect profile (`eef75416-6e46-4388-ab31-9e5159d5ff0d`, `NURI Native Lab Release 2026-10-06`) were created. A dedicated protected local release Keychain holds the new identity, with trusted signing access scoped to codesign. Credentials stay outside the repository; none are recorded in this document. Old certificates, private keys, APNs keys, profiles, passwords and ACLs were not altered or revoked. Default Keychain remains canonical login. The release Keychain is temporarily added to search visibility only during signing/export, with the original list restored afterward.

The new certificate initially signed an isolated copy of `/usr/bin/true` successfully, but the first dedicated Keychain later locked and then rejected signing even after logical unlock. A fresh isolated checked Keychain, using raw password bytes, passed create/lock/unlock, import/lock/unlock and ordinary codesign validation with the same approved identity. No second Apple certificate was issued. The fresh checked Keychain exported the original archive successfully. This is distinct from the original login Keychain fault; no old Keychain reset or password guessing occurred. Original archive manifest remains unchanged (`3ef1ada7df8cb1aa0fd8e1f6f9489024a4d22f5c84715c73e59bdfd0b59ff2a7`, 170 regular files).

Verified production IPA SHA-256: `6bfac0e09943ad84ebaf7639300d5ac0e3f0d1fbfe4ce2a4854f984a4e928f8f`. Its ZIP and strict/deep code signature validation pass, with new certificate `AB87E0C98D349BD895BDAFB466129DB17D5E9C12`, matching new profile UUID, unchanged bundle/version/build/display name, production APS and `get-task-allow=false`. Archived JavaScript SHA-256 remains unchanged after re-export.

The Xcode upload completed with non-blocking missing-dSYM warnings for the prebuilt React, ReactNativeDependencies and Hermes frameworks. These warnings affect symbolic crash diagnostics for those frameworks; they did not prevent Apple from accepting or processing the binary. No placeholder dSYMs were generated. The original search list was restored to canonical login only, the default Keychain stayed unchanged, and the new checked release Keychain was locked after IPA signing.

App Store Connect build ID: `a4418936-b355-4edc-9ade-12b34c8ce2a5`. Existing group IDs remain `29022ca6-a008-492d-bc7c-762e53f5a909` (internal) and `f2c5c7b9-fbaf-4b71-bc5f-783812d976b0` (external). The build's What to Test describes official playback, original titles/full thumbnails, safe external source/related/help/ad navigation and distinct NURI guides/summaries. Submit for Review was clicked with Automatically notify testers checked; the returned build list shows Testing with both groups, rather than Waiting for Review. Phone-side Update rendering and actual playback have not been directly observed on a physical device.

The existing external group still has six testers and its existing public link `https://testflight.apple.com/join/gTTmYR29` with limit 30. Existing installed testers are recorded on build 1006 before updating; their group access was preserved. They do not need a second app or a new invitation to update to 1007.

Production archive verification completed: `ARCHIVE SUCCEEDED`, strict/deep code signature validation passed, bundle `com.ordashtech.nuri.nativelab`, version `0.3.0`, build `1007`, phone label `Nuri`, team `6PL6HQYU7P`, production APNs, `get-task-allow=false`. The generated production JavaScript explicitly has `isPreviewMode=false`, retains `https://nurifam.app/api`, and includes the new link-retry/chat-guide/uncropped-thumbnail paths. Archived Hermes bundle SHA-256: `68538b11d4f76f606876e6f555e1d7cfe23485791ccafbc91dd858160f37d748`.

Implementation commit `3a9005f` was pushed successfully to `origin/iOS-native-test`; no other branch was pushed.

Live Simulator verification is not claimed: the reused unsigned native Simulator baseline could not persist its private Keychain fixture session. A temporary local-only signing experiment was rejected by AMFI and was reverted. This did not alter the signed production archive, app data or backend; actual installed-device playback and YouTube-app handoff remain tester verification steps.

1. Complete: exact signed production archive contains build `1007`, the unchanged Lab bundle/team, APNs production, the production API and preview mode disabled.
2. Complete: existing authorized Apple/Xcode workflow uploaded `1007`; Apple received and processed it.
3. Complete: original native internal and external groups are attached and build 1007 shows Testing. No new app, testing group, public link, or installation entry was created.
4. Tester verification: open the existing Nuri 3.0 entry in TestFlight and update to `0.3.0 (1007)`; test embedded playback, related/source links, original title and separate NURI summary.

This is a targeted implementation correction, not a legal clearance of all third-party content or a guarantee that every remotely selected video is embeddable. Broader Meta excerpt licensing, source-content rights and backend summary provenance remain outside this release's scope.
