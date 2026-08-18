---
name: ponytail-audit
description: >
  Run a one-shot repository-wide audit for removable complexity. Use when asked
  to find bloat, unnecessary dependencies, duplicated helpers, hand-rolled
  standard-library behavior, single-implementation abstractions, dead flags,
  wrappers, or speculative layers. Report findings only; do not modify code.
---

# Ponytail Audit

Use Graphify for non-trivial repository discovery when current, then verify each
finding in real source. Rank the largest safe reductions first.

Format:

`<tag>: <what to remove>. Replace with <concrete alternative>. [path]`

Tags: `delete`, `reuse`, `stdlib`, `native`, `yagni`, `shrink`.

Correctness, security, performance, and architecture approval remain outside
this skill. End with `net: about -N lines, -M dependencies possible.` If there
is nothing material to cut, return `Lean already. Ship.`
