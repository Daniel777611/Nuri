# Nuri YouTube TestFlight iteration 1007

Candidate on 2026-10-06: **0.3.0 (1007)**. The YouTube navigation and metadata fixes pass the final offline regression checks. Device archive verification, Apple upload and TestFlight availability are still pending; the source changes and passing tests do not establish that a phone can update yet.

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

1. Verify the exact signed production archive contains build `1007`, the unchanged Lab bundle/team/profile, APNs production, the production API and preview mode disabled.
2. Upload through the existing authorized Apple/Xcode workflow; confirm Apple receives and processes `1007`.
3. Add it to the existing native internal and external groups. Submit Beta App Review if Apple requires it, retain the existing public link and tester limit, and confirm the eligible group shows `Testing`.
4. Test the phone's Update path, embedded playback, related and source links, original title and separate NURI summary.

This is a targeted implementation correction, not a legal clearance of all third-party content or a guarantee that every remotely selected video is embeddable. Broader Meta excerpt licensing, source-content rights and backend summary provenance remain outside this release's scope.
