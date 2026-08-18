---
name: ponytail
description: >
  Select the smallest compliant implementation after understanding the real
  code path. Use for workflow Coder implementation and bug-fix tasks to prefer
  reuse, standard-library and native platform behavior, fewer files, fewer
  dependencies, and the shortest maintainable diff without weakening scope,
  validation, tests, security, accessibility, compatibility, or data safety.
---

# Ponytail for Pavan's Workflow

Apply this policy only after reading the assignment and verifying the real code flow.

## Precedence

1. Role contract and structured output schema.
2. Confirmed requirement, `target_files`, stable IDs, and assigned gates.
3. Security, validation, accessibility, compatibility, and data integrity.
4. Real repository evidence.
5. This simplification policy.

The assignment may set `ponytail_mode: off | lite | full`. Default to `full`.
The mode is assignment-local and never persists into another fresh worker.

## Ladder

Stop at the first rung that fully satisfies the assignment:

1. Is new code actually required by the confirmed scope?
2. Does the repository already contain the helper, type, pattern, or behavior?
3. Does the standard library solve it?
4. Does the native platform solve it?
5. Does an already-installed dependency solve it?
6. Can the same behavior use fewer files, branches, configuration, or lines?
7. Write the minimum maintainable implementation.

`lite` implements the requested approach but records one concrete smaller alternative.
`full` enforces the ladder. `off` follows the normal Coder contract without this policy.

## Rules

- Understand before minimizing. A small change in the wrong place is another bug.
- Prefer deletion and reuse over addition.
- Add no speculative abstraction, configuration, factory, interface, or dependency.
- Fix a bug at the shared root cause when that location is inside `target_files`.
  Otherwise return `blocked` and identify the additional required path.
- Preserve assigned Objective Gates. Ponytail never reduces the verification plan.
- Never simplify away trust-boundary validation, security controls, error handling
  that prevents loss, accessibility basics, hardware calibration, or an explicit
  requirement.
- A deliberate shortcut with a measurable ceiling may use a comment of the form
  `ponytail: <ceiling>; upgrade when <trigger>`.
- Keep the role's required structured output unchanged. Ponytail governs the
  implementation, not the handoff schema.
