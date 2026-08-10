# Grilling Formats

Load this file only when you need to render or persist one of the formats below.
Adapt labels to the user's language for user-facing material. Persistent project
artifacts follow the project's established documentation language.

## Deep-Mode Architect Handoff

Keep this compact. Do not paste large repository excerpts or the Orchestrator's
full conversation history.

```text
Mode: /grilling
Task: [user's task, faithfully restated]
User language: [language / locale if known]
Desired outcome: [only if already known]
Known hard constraints: [only constraints already established]
Governing context: [file/reference names if present]
Graphify status: FRESH | STALE | UNAVAILABLE | NOT_APPLICABLE

Use project context to answer factual questions yourself.
Search directions:
- [task-specific Graphify/repository question 1]
- [task-specific Graphify/repository question 2]
- [task-specific Graphify/repository question 3]

If the harness provides direct Human access, grill the Human until the
Confirmation Gate passes. In a headless task-agent harness, return the exact
material question frontier plus an Interrupted-Session Checkpoint. Continue in
a fresh Architect run after the Orchestrator relays the Human's exact answers.
Return the Architecture Package only after confirmation.
```

## Compact Question

Use for quick mode or low-complexity choices.

```text
### Q[N]. [Decision]
1. [Option A] — recommended ✅ — [brief basis]
2. [Option B] — [brief trade-off]
3. [Option C] — [brief trade-off]
Other: write your own answer.
```

If there is no justified recommendation:

```text
No recommendation yet — [brief reason].
```

## Consequential Question

Use only when the choice materially affects architecture, scope, reliability,
security, data, migration, compatibility, or cost.

```text
### Q[N]. [Decision]
Why it matters: [one or two sentences]

1. [Option A] — recommended ✅
   Basis: [project evidence / goal / trade-off]
   Trade-offs: [concise]
2. [Option B]
   Trade-offs: [concise]
3. [Option C]
   Trade-offs: [concise]
Other: write your own answer.

Main risk if chosen poorly: [concise]
```

## Decision Tree

Internal working form:

```text
Goal
├── D1 [ANSWERED] — ...
│   └── D1.1 [PENDING] — ...
├── D2 [EXPLORED] — ...
├── D3 [ASSUMPTION] — ...
└── D4 [IMMATERIAL] — ...
```

Show it only when useful or requested.

## Unknowns Tracker

```md
| # | Unknown | Status | Basis / source | Blocks plan? |
|---|---------|--------|----------------|--------------|
| U1 | ... | EXPLORED | Graphify: ... / file:... | No |
| U2 | ... | ANSWERED | User decision Q3 | No |
| U3 | ... | ASSUMPTION | Accepted by user | No |
| U4 | ... | PENDING | — | Yes |
| U5 | ... | IMMATERIAL | Deferred: reason | No |
```

## Confirmation Gate

```text
Agreed understanding
- Goal: ...
- In scope: ...
- Out of scope: ...
- Success criteria: ...

Key decisions
1. ...
2. ...

Accepted assumptions
- ...

Deferred / non-blocking
- ...

Unknowns: ANSWERED [N] · EXPLORED [N] · ASSUMPTION [N] · PENDING 0 · IMMATERIAL [N]

Confirm this understanding and I will produce the final plan/package, or tell me
what to change.
```

## Quick-Mode Execution Plan

```md
# Execution Plan: [Title]

## Goal
[1-3 sentences]

## Scope
### In scope
- ...

### Out of scope
- ...

## Success criteria
- ...

## Decisions
| # | Decision | Choice | Basis |
|---|----------|--------|-------|
| 1 | ... | ... | ... |

## Accepted assumptions
- ...

## Implementation steps
### 1. [Step]
- What: ...
- Depends on: ...
- Verify / done when: ...
- Risks: ...

## Deferred / non-blocking
- ...
```

## Deep-Mode Architecture Package

```md
# Architecture Package: [Title]

## Goal and agreed scope
- Goal: ...
- In scope: ...
- Out of scope: ...
- Success criteria: ...

## Project evidence
- Graphify context: [relevant nodes/paths/communities only]
- Verified source/doc references: ...
- Governing constraints: ...

## Decisions
| # | Decision | Choice | Rationale | Rejected alternatives |
|---|----------|--------|-----------|-----------------------|
| 1 | ... | ... | ... | ... |

## Proposed ADR updates
- ADR-N: [title] — [why it passes the ADR threshold]

## Proposed glossary updates
- [Canonical term]: [meaning]

## Solution structure
- Components: ...
- Interactions / data flow: ...
- Data model / contracts: ...
- Failure and recovery behavior: ...

## Implementation phases
### Phase 1. [Title]
- Work: ...
- Depends on: ...
- Done when: ...

## Risks and mitigations
- ...

## Accepted assumptions
- ...

## Deferred / non-blocking
- ...

## Handoff to Orchestrator
- Persist approved ADR/glossary changes.
- Decompose phases into downstream tasks.
- Preserve the decisions and rejected alternatives above.
```

## ADR Proposal

Use only when the ADR threshold in `SKILL.md` is satisfied.

```md
# ADR-[N]: [Title]

## Status
Proposed | Accepted | Superseded

## Context
[Why this decision exists]

## Decision
[What was chosen]

## Alternatives considered
- [Alternative]: [why rejected]

## Consequences
- Positive: ...
- Negative / trade-off: ...

## Evidence
- [Graphify/source/user decision reference]
```

## Glossary Proposal

```md
### [Canonical term]
Definition: [project-specific meaning]
Use when: [boundary / examples]
Avoid: [confusing synonym or overloaded term, only if useful]
```

## Interrupted-Session Checkpoint

```md
# Grilling Checkpoint

## Mode
/grilling | quick grilling

## Task
...

## Decisions made
- ...

## Rejected alternatives
- ...

## Accepted assumptions
- ...

## Evidence gathered
- ...

## Unknowns Tracker
[table]

## Current decision frontier
1. ...
2. ...

## Next action
[resume grilling / switch to deep mode / resolve project conflict]
```
