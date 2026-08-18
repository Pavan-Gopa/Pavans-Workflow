# Pipeline — Pavan's Workflow v3

A file-backed, multi-model OMP development loop with fresh specialized workers,
Main-owned state, conditional Graphify navigation, and Coder-only Ponytail.

## Start

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Main completes progressive onboarding, validates the next required role model,
and reconciles any interrupted runtime before dispatch.

## Step loop

```text
Human <-> Main
  -> fresh Coder + assignment-local Ponytail
  -> Main verifies source, diff, stable IDs, and Objective evidence
  -> fresh Reviewer checks Judgment Gates and material complexity
  -> Main verifies findings
  -> fresh Tester runs runtime/QA Objective Gates and gap-hunts coverage
  -> Main verifies tests/reports
  -> green: close step and continue
  -> red: persist compact verified retry memory and start a fresh Coder
```

Workers never write workflow state, route, spawn another worker, commit, or
push. Main never infers success from a worker exit.

## Ponytail

Only Coder and backup Coder autoload `ponytail`. Main assigns
`ponytail_mode: off|lite|full`, default `full`. The skill minimizes only among
implementations that already satisfy confirmed scope, target files, gates,
security, validation, accessibility, compatibility, data integrity, and the
structured handoff.

Reviewer remains correctness-first. Tester and Security do not load Ponytail.
Architect uses the smallest reversible confirmed design while retaining the
full Grilling contract.

## Graphify

```text
non-trivial discovery -> Graphify -> focused real source -> verify
known exact local symbol -> focused source tools -> verify
```

Main owns graph freshness. Default refresh:

```bash
bash AI_Workflow_Kit/script/graphify_rebuild.sh fast
```

`deep` adds clustering, `semantic` is an explicit docs/media pass, and `force`
performs full local recovery. A graph failure is advisory, not a product gate.

## Gates

- Objective Gates: deterministic commands/artifacts.
- Judgment Gates: Reviewer-owned semantic engineering assessment.
- Reviewer: on by default.
- Tester: recommended unless explicitly skipped.
- Security: offered once near release.

Main alone checks/reopens stable IDs `<step>.D<n>`, `.O<n>`, and `.J<n>` after
verification. OMP Todo is separate runtime memory.

## Failure and recovery

A retry receives only verified approach, observed result, evidence, and rejection
reason. Three materially identical no-progress failures stop. Runtime
interruption and provider/model failure do not increment product attempts.
Backups require explicit Human authorization.

## Dashboard and observability

- `Alt+W`: plan, current step, dual Todo, gates, blockers, metrics, session tokens,
  and the copyable Stats URL.
- `Alt+A`: worker transcripts and intervention.
- `Alt+M`: model roles.
- `/workflow metrics`: passive local telemetry outside the worktree.
- `/workflow-stats` or `o` in Alt+W: explicit OMP Stats start/sync/open.

OMP Stats never starts automatically and never places a persistent widget below
the editor.

## Update

```bash
tmp_dir="$(mktemp -d)" && git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw" && bash "$tmp_dir/pw/AI_Workflow_Kit/script/workflow_update.sh" apply; rm -rf "$tmp_dir"
```

The updater preserves live project memory and model mappings, backs up framework
files, migrates stable IDs, refreshes Graphify, and runs the doctor. Restart OMP
afterward.
