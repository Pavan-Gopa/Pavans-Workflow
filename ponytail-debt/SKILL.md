---
name: ponytail-debt
description: >
  Collect deliberate `ponytail:` shortcut comments into a read-only debt
  ledger. Use when asked what Ponytail deferred, which simplifications have
  ceilings, or which shortcuts need revisiting. Report locations, ceilings,
  triggers, and malformed markers without changing workflow state.
---

# Ponytail Debt

Search tracked source while excluding `.git`, dependency directories, build
output, `graphify-out`, and workflow skill directories.

Recognize comments shaped like:

`ponytail: <ceiling>; upgrade when <trigger>`

Group results by file and render:

`<path>:<line> — <ceiling>. trigger: <trigger>.`

Mark entries without a concrete trigger as `no-trigger`. End with
`N markers, M with no trigger.` If none exist, return
`No ponytail debt markers.`
