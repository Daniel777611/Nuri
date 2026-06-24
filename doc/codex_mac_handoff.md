# Codex Mac/iOS Handoff

Last updated: 2026-05-21

This document is the handoff context for opening this project on a MacBook with Codex and preparing for future iOS app development.

## Current Project Location

Windows workspace:

```text
C:\works\Ordash_Lab_LLC\Project\family_growth
```

Current files:

```text
doc/family_growth_radar_prd_v0_1.md
doc/family_growth_radar_prd_v0_1.docx
doc/codex_mac_handoff.md
```

Figma/FigJam planning board:

```text
https://www.figma.com/board/Z25IsrkTXwPmj2PLs6mS2u
```

## Product Vision

The long-term product is not a generic parenting app and not a general AI parenting Q&A tool.

The final vision is:

```text
Every family has a professional, highly personalized child growth advisor that understands this specific child and gives parents precise, practical, reviewable guidance for this child, this family, and this stage.
```

The product should be:

- Professional: grounded in child development, educational psychology, attachment, emotional regulation, executive function, and family systems.
- Personalized: focused on this specific child, not an abstract age group.
- Practical: converts professional understanding into concrete family actions.
- Continuous: observes, suggests, follows up, reviews, and adjusts.
- Boundary-aware: not a medical diagnosis tool, not a psychological diagnosis tool, not a child scoring system, and not a surveillance product.

## Core Product Logic

Long-term loop:

```text
Professional observation framework
-> Guided parent observation
-> Family daily context and eventually smart-home signals
-> Dynamic child profile
-> Personalized guidance plan
-> Parent execution
-> Review and adjustment
-> Deeper understanding of this child
```

The moat is not parenting content itself. The moat is:

```text
professional observation ability + long-term individual child profile + family-context feedback loop
```

## Current Lean Strategy

We are not starting with an app.

We are using a staged MVP strategy:

```text
Stage 1: Concierge MVP
Stage 2: Automated group-service MVP
Later: guided observation, child profile, personalized plans, app/MCP/iOS productization
```

### Stage 1: Concierge MVP

Target:

```text
1-3 US-based Chinese families with children aged 0-3.
```

Purpose:

```text
Validate whether parents find current-stage action guidance helpful, whether they want to keep receiving it, and whether they may be willing to pay for a more stable or more personalized service.
```

Execution:

- Manually select 1-3 families.
- Manually collect minimal child information.
- Manually create a current-stage action guide.
- Send it through the family's preferred channel.
- Follow up after 7 days.

Minimal input:

```text
Child age or birthday
Sex, optional
City/state, optional
Special situation, free text
Current uncertainty or question, optional
Preferred receiving channel
```

Action guide structure:

```text
Current stage: what the child may be developing
What parents can do this week
Signals to observe this week
One small action for today
Common parent misreadings
When to consult a professional
```

Stage 1 validation questions:

```text
1. Was this actually helpful?
2. Do parents want to keep receiving it?
3. Would they consider paying for a stable or more personalized version?
```

Stage 1 pass signals:

```text
At least 1-2 families clearly say it is helpful.
At least 1 family tries one suggested action.
At least 1 family wants to continue.
At least 1 family expresses willingness to pay or to learn pricing.
No obvious anxiety-inducing negative feedback.
```

### Stage 2: Automated Group-Service MVP

Target:

```text
Around 100 US-based Chinese families with children aged 0-3.
```

Purpose:

```text
Validate whether age-segmented action guidance can be delivered at scale through a group/channel/automation flow.
```

This stage should not pretend to be deeply personalized. It should be positioned as age-stage action guidance. Families who want deeper help can later enter a more personalized flow.

## First Feedback Loop

The first Build-Measure-Learn loop is:

```text
Build:
  Create one current-stage action guide manually for 1-3 families.

Measure:
  Ask whether it was helpful, whether they acted on it, whether they want to keep receiving it, and whether they would consider paying.

Learn:
  Decide whether to continue, adjust the guide, or stop and rewrite the content framework.
```

Do not lock the first loop to WeChat. Possible channels include WeChat, email, SMS, WhatsApp, PDF, Google Doc, Notion, or a simple web page. The first loop validates content value, not channel selection.

## Important Figma Sections

The FigJam board contains strategy maps including:

- Final vision: personalized family education advisor.
- Stage 1 experiment map.
- Operations strategy map for US Chinese 0-3 families.
- Minimal first feedback loop.
- Two-stage MVP strategy: deep first, then broad.
- Stage 1 experiment framework: helpfulness, continuation, willingness to pay.

## Recommended MacBook Setup

The project should be synced through a private Git repository.

On Windows, this folder is currently not a git repo. Recommended setup:

```powershell
cd C:\works\Ordash_Lab_LLC\Project\family_growth
git init
git add doc
git commit -m "Add project PRD and Codex handoff context"
git branch -M main
git remote add origin <PRIVATE_GITHUB_REPO_URL>
git push -u origin main
```

On MacBook:

```bash
git clone <PRIVATE_GITHUB_REPO_URL>
cd family_growth
```

Then open this folder in Codex on the Mac and ask:

```text
Please read doc/codex_mac_handoff.md and doc/family_growth_radar_prd_v0_1.md first. Then summarize the current product vision, MVP strategy, and the next execution step before making changes.
```

## iOS Development Preparation

On the MacBook:

1. Install Xcode from the Mac App Store.
2. Open Xcode once and install additional components.
3. Accept the license:

```bash
sudo xcodebuild -license
```

4. Confirm the toolchain:

```bash
xcodebuild -version
swift --version
```

5. Sign in with Apple ID in Xcode if device testing or TestFlight will be needed.
6. Decide later whether the iOS app will be native SwiftUI or React Native/Expo. Do not start iOS implementation until Stage 1 evidence is clear unless the goal is only technical exploration.

## Working Rule Going Forward

Do not rely on chat history as the only source of project understanding.

Any major decision should be written into the repo, especially:

- Product vision changes.
- Stage definitions.
- Experiment results.
- Action guide templates.
- Safety and privacy boundaries.
- iOS architecture decisions.

