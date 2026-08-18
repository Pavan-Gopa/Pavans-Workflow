---
name: ponytail-review
description: >
  Perform a one-shot review of a diff for material over-engineering only. Use
  when asked to simplify a change, find removable complexity, replace custom
  code with repository reuse, stdlib or native behavior, or review a diff for
  unnecessary dependencies and speculative abstractions. It does not replace
  correctness, security, performance, or QA review.
---

# Ponytail Review

Inspect the requested diff after normal correctness review.

Report one line per evidence-backed finding:

`<path>:<line> <tag>: <what to remove>. Replace with <concrete alternative>.`

Tags: `delete`, `reuse`, `stdlib`, `native`, `yagni`, `shrink`.

Only report a finding when the replacement preserves confirmed behavior and is
material enough to justify another edit. Do not flag stylistic line-count
preferences, required validation, security controls, or meaningful tests.

End with either `Lean already. Ship.` or a conservative `net: about -N lines possible.`
Do not apply changes unless explicitly assigned to do so.
