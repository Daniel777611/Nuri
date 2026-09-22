# HOMEPAGE-CN visual QA

**Result: passed** — reviewed 2026-09-21 against Figma node `253:2528` at the
402px phone-frame geometry. No P0, P1, or P2 visual defects remain in the
implemented home screen.

## Evidence

- Visual source: Figma file `1ctSYPTFJobb9l1wVmnNH4`, node `253:2528`
  (`HOMEPAGE-cN`, 402 x 874). Reference capture:
  `C:\Users\wangd\AppData\Local\Temp\codex-clipboard-2ed00568-01fe-45e0-a5e9-2ab3f408f9b6.png`.
- Implementation: isolated local Expo web preview at
  `http://127.0.0.1:8083/`, logged into a local preview-only account. The
  application phone canvas is capped at 402px; no production account or
  backend was used for visual QA.
- The Figma-owned mascot source is checked in as
  `frontend/assets/images/homepage/figma-mascot.png`.

## Comparison

| Region | Figma specification | Implementation result |
| --- | --- | --- |
| Page frame | 402px responsive phone canvas | Canvas remains 402px max-width and centers on desktop. |
| Header | 39 x 46 logo, dynamic greeting/avatar | Uses the existing dynamic name/avatar data with the Figma logo geometry. |
| Daily Selection | Section starts at x=17; card is 342 x 236; 36px radius; 24px content inset; 20px title; 55px arrow | Matches dimensions, gradient, title hierarchy, fixed-size material tag, CTA, and arrow footprint. |
| NURI's Home | Section starts at x=17; purple card is 370 x 312; 36px radius; 28px inset; 145 x 57 CTA | Matches card dimensions, vertical light-to-dark purple gradient, title clamp, and CTA position. |
| Mascot | Mirrored, positioned from the card midpoint, clipped within the purple card | Uses the exact Figma PNG, mirrors it, and clips it within the rounded card rather than allowing overflow. |
| Bottom navigation | Fixed 74px navigation above safe area | Remains fixed with the existing safe-area padding and SVG icon assets. |

## Intentional live-content differences

The Figma frame contains illustrative copy and a placeholder avatar. The
implementation deliberately renders the signed-in user's name/avatar and the
current daily material headline. Those values vary by account and day, while
their container geometry, text hierarchy, and truncation rules follow the
frame. Source provenance remains in the card's accessible name and detail
screen; the compact card uses the Figma material-type tag.

## Verification

- `node frontend/scripts/test-recommendation-entry-contract.mjs` — passed.
- `node frontend/scripts/test-nuri-home-preview-contract.mjs` — passed.
- `frontend/node_modules/.bin/tsc.cmd --noEmit` — passed.
- In-app browser visual comparison of the signed-in local preview — passed.

---

# Chat response feedback visual QA

**Final result: passed** — reviewed 2026-09-22 against the supplied Murray
answer-bubble reference at a 402 x 874 browser viewport. No P0, P1, or P2
visual or interaction defect remains in the response action row.

## Evidence

- Source reference:
  `C:\Users\wangd\AppData\Local\Temp\codex-clipboard-b0b562ee-09e6-4a2e-8830-7c3ea3cc0199.png`.
- Clean implementation capture:
  `frontend/test-results/chat-feedback-402.png`.
- Selected-state capture:
  `frontend/test-results/chat-feedback-selected-402.png`.
- Side-by-side review artifact:
  `frontend/test-results/chat-feedback-comparison.png`.

## Comparison and interaction checks

| Check | Result |
| --- | --- |
| Copy, heart, and thumbs-down order | Matches the supplied reference. |
| Compact purple outline icons under the answer text | Matches; touch targets are enlarged invisibly to 30 x 28px. |
| Like / Dislike selection | Mutually exclusive filled state with a subtle purple selection surface. |
| Streaming response | No actions are exposed until the answer has a durable message ID. |
| Copy | Browser clipboard contains the exact AI response text. |
| Feedback persistence behavior | Preview API receives the real session/message/rating contract; failed writes roll back the optimistic state. |
| Accessibility | Each control has a translated label; Like/Dislike expose `aria-pressed`. |
| Console/runtime errors | None during the automated interaction run. |

## Verification

- `frontend/node_modules/.bin/tsc.cmd --noEmit` — passed.
- `node frontend/scripts/test-chat-response-feedback-contract.mjs` — passed.
- `node frontend/scripts/verify-chat-response-feedback-ui.mjs` — passed: two
  AI answers rendered action rows at 402 x 874; Copy and Like-to-Dislike
  switching both succeeded.
