# Design QA — Remove chat quick-reply buttons

- Source visual truth: `test_reports/quick-replies-reference-20260730.png`
- Implementation capture: `test_reports/quick-replies-removed-20260730.png`
- Route: `http://localhost:8081/chat/chat-1`
- State: local Preview mode, AI history message containing three non-empty `quick_replies`
- Viewport: 901 × 886 CSS px
- Source pixels: 901 × 886
- Implementation pixels: 900 × 886
- Density normalization: deviceScaleFactor 1; the in-app browser removed one horizontal chrome pixel, so the comparison used the centered phone canvas and message/footer regions rather than the outermost desktop pixel.

## Full-view comparison evidence

The source shows three pill-shaped quick-question controls directly below the AI message. The implementation keeps the same centered mobile chat canvas, header, message bubble, background treatment, and fixed composer, but no longer renders those controls. The local fixture uses shorter message copy than the supplied screenshot, so message-height and scroll-position differences were excluded from fidelity judgments.

## Focused region comparison evidence

- Historical data still contains `入睡有点困难`, `睡得不错`, and `想聊聊别的问题` in `quick_replies`; all three visible-text locator counts are `0`.
- The `说点什么...` composer remains present, visible, and enabled.
- Pressing Enter sends a new Preview message.
- The resulting task-suggestion response still renders two `添加计划` controls.
- No new duplicate-key console error appeared after the Preview ID generator was made collision-safe.

## Required fidelity surfaces

- Fonts and typography: unchanged; the existing NURI font family, weights, sizes, line heights, and wrapping remain intact.
- Spacing and layout rhythm: unchanged outside the intentionally removed quick-reply row; the message bubble now ends naturally after its text.
- Colors and visual tokens: unchanged; no token, gradient, border, shadow, or semantic color was modified.
- Image quality and asset fidelity: unchanged; no image, icon, logo, or decorative asset was added, removed, or replaced.
- Copy and content: AI message text, input placeholder, task-card copy, and controls are unchanged; only quick-question labels are no longer exposed.

## Findings

No actionable P0, P1, or P2 visual mismatch remains for the requested change.

## Comparison history

1. Initial local check still showed the three pills because the existing Metro server was running a fixed, stale bundle.
2. The Preview server was restarted against the edited source; the same history fixture then rendered with no quick-reply controls.
3. Enter-to-send and task-card rendering were exercised. A pre-existing Preview-only duplicate ID warning was found and fixed with a monotonic suffix.
4. The interaction was repeated; quick-reply counts remained zero, task controls remained visible, and no new duplicate-key error was emitted.

## Follow-up polish

None required for this scoped removal.

final result: passed
