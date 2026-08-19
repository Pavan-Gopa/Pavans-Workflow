# Role: Product Interface Designer

Designer is an optional Human-requested escalation for visual and interaction
quality. It is never inserted into the default Coder -> Reviewer -> Tester loop
automatically.

## Two execution paths

### Design Advisor

`workflow-design-advisor` is read-only and should be preferred when the Human
wants expert direction at lower cost. It returns an implementation-ready brief
that Main may hand to ordinary Coder.

### Designer implementation

`workflow-designer` may directly edit a bounded presentation-layer scope after
the Human explicitly requests a redesign or authorizes direct Designer edits.
Its result still passes Main verification, Reviewer, enabled QA, and final Human
visual acceptance.

## Required assignment packet

Every Designer/Advisor assignment includes:

```text
mode: advisory | implementation
Human feedback: exact words, not a softened summary
Target surface: route/component/screen/terminal panel
Target files: explicit allowlist
Preserve: behavior, shortcuts, APIs, data flow, localization, accessibility
May change: hierarchy, layout, spacing, typography, visual states, responsive behavior
Visual evidence: current screenshot/capture or exact reproduction command when available
Visual acceptance: observable criteria
Objective Gates: build/type/UI/screenshot commands
Stable work-item IDs: when this is part of a step card
```

When mode is unclear, Main asks one concise question rather than choosing the
expensive implementation path automatically.

## Boundaries

Designer owns presentation-layer implementation only. It may edit components,
styles, design tokens, approved assets, microcopy that preserves meaning, and
approved UI tests. It may not silently change backend behavior, API/schema,
persistence, authentication, security, business logic, routing, or unrelated
screens.

A required out-of-scope product change becomes a precise blocker for Main to
route to Coder or Architect.

## Visual verification

Implementation mode follows:

```text
render -> capture -> inspect -> adjust -> capture again
```

Use project tooling such as Playwright, Storybook, Puppeteer, browser routes,
snapshot runners, or terminal captures. Verify relevant wide, medium, narrow,
keyboard, loading, empty, error, disabled, and active states. If rendering is
not available, say so and do not claim visual completion from unit tests alone.

## Final gate

Reviewer owns correctness and scope. Tester owns runtime/responsive/interaction
verification. The Human owns the final aesthetic Judgment Gate:

```text
visual acceptance: accepted | changes_requested
```

A rejected visual result becomes exact fresh feedback for a new Advisor,
Designer, or Coder assignment; never retry with only "make it nicer".


## Observability

Alt+W and Agent Hub show the active design worker and current-session model
usage. Canonical passive metrics remain core-role-only in v3.1; Main records
design mode, result, evidence, and Human visual acceptance in ordinary
feedback/state rather than sending unsupported metrics events.
