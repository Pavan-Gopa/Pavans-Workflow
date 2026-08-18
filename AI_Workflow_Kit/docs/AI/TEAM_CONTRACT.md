# AI Team Contract — Workflow v3

Human process control goes through Main. Workers return structured evidence only.

## Source-of-truth priority

1. Authoritative plan files listed in `PROJECT_CONTEXT.md`
2. `STATE.yaml`
3. `STEPS.md`
4. `DECISIONS.md`
5. `PROJECT_CONTEXT.md`
6. `PIPELINE.md`

Higher wins. A material plan/code conflict routes to Architect before large
implementation.

## Roles and write boundaries

| Role | Product writes | Boundary |
|---|---:|---|
| Main | No | State, plans, reports, checkpoints, routing, passive metrics |
| Coder | Yes | Assignment `target_files` only; Ponytail policy autoloaded |
| Reviewer | No | Read-only correctness/Judgment verdict plus bounded complexity check |
| Tester | Tests only | Approved test/QA paths and runtime evidence |
| Architect | No | Advice, design, questions, Architecture Package |
| Security | No | Optional evidence-grounded vulnerability audit |
| Human | — | Context, preferences, authorization, intervention |

Workers never commit, push, route, spawn another worker, or write canonical
workflow memory.

## Gate contract

- **Objective Gates** are deterministic commands/artifacts. Coder runs assigned
  implementation gates; Tester owns runtime/QA gates.
- **Judgment Gates** cover semantics, accepted architecture, scope, contracts,
  failure behavior, maintainability, and trust boundaries. Reviewer owns them.
- `waiting_review` is not completion. Main closes a step only after verified
  objective evidence, Reviewer judgment, and enabled QA.
- Reviewer is on by default; Tester is recommended; Security is offered near
  release. Every Human skip and reason is persisted.

## Ponytail contract

Ponytail reduces the implementation only after the problem and real code flow
are understood.

Precedence:

1. role and structured-output contracts;
2. confirmed requirement, target files, stable IDs, and gates;
3. security, validation, accessibility, compatibility, and data integrity;
4. real source evidence;
5. simplification.

Only primary and backup Coder autoload Ponytail. Main sets assignment-local
`ponytail_mode: off|lite|full`, default `full`. It never persists across fresh
workers and never authorizes changing confirmed scope.

Reviewer may block a complexity issue only when it is material and has a
specific behavior-preserving replacement: existing repository reuse, stdlib,
native platform behavior, an already-installed dependency, deletion of
speculative configuration/layers, or removal of duplicated logic. Shorter style
alone is not a finding.

Tester and Security never reduce required coverage or controls for brevity.
Architect seeks the smallest reversible confirmed design without loading the
full implementation skill over Grilling.

## Graphify contract

Use Graphify for non-trivial discovery and blast-radius work. For an exact known
local symbol, focused LSP/grep/read may be cheaper. The real source is always
verified before edits or consequential claims. Main owns freshness; workers
report stale/unavailable graphs. Graphify is advisory and never a release gate.

## Hard rules

1. One step and one specialized worker at a time.
2. Product edits stay inside assignment target files.
3. Worker output returns only to Main.
4. Main alone changes workflow files and canonical checkboxes.
5. No silent architecture redesign, fake data, or fake green.
6. Fresh worker context for every role and retry.
7. Main verifies repository/test evidence before every transition.
8. Stop three materially identical failures; new evidence or approach is progress.
9. Runtime disappearance and model failure are not product attempts.
10. Automatic backup model selection is forbidden.
11. Passive metrics and OMP Stats never control routing or gates.
12. OMP Stats is manual and must not install a startup widget or notification.

## Stable IDs and handoff

`STEPS.md` items use `<step>.D<n>`, `.O<n>`, and `.J<n>`. Main alone checks or
reopens them after verification. Runtime Todo remains separate and uses the
parent ID prefix for dashboard linkage.

Retry assignments carry only verified approach, observed result, evidence, and
rejection reason. They never carry transcripts or hidden reasoning.
