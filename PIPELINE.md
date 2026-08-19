# Pipeline — Pavan's Workflow v3.1

A file-backed, multi-model OMP development loop with fresh specialized workers,
Main-owned state, conditional Graphify, Coder-only Ponytail, a live plan cursor,
and optional Human-requested design escalation.

## Start

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

## Default step loop — unchanged

```text
Human <-> Main
  -> fresh Coder + assignment-local Ponytail
  -> Main verifies source, diff, stable IDs, and Objective evidence
  -> fresh Reviewer checks Judgment Gates and material complexity
  -> Main verifies findings
  -> fresh Tester runs runtime/QA gates and gap-hunts coverage
  -> Main verifies tests/reports
  -> green: close step and continue
  -> red: persist compact verified retry memory and start a fresh Coder
```

Designer is never inserted automatically.

## Optional visual-quality loop

### Advisory

```text
Human visual feedback
  -> Main captures exact complaint and target surface
  -> Design Advisor (read-only)
  -> Main verifies the brief
  -> ordinary Coder implements
  -> Reviewer -> Tester -> Human visual acceptance when required
```

### Direct implementation

```text
Human explicitly authorizes Designer edits
  -> Main confirms target files, preserve-list, visual evidence, gates
  -> Designer edits only presentation/UI scope
  -> Main verifies real diff and captures
  -> Reviewer -> Tester -> Human visual acceptance
```

Designer may not silently change backend behavior, API/schema, persistence,
security, business logic, routing, localization meaning, or unrelated screens.

## Live plan cursor

Alt+W distinguishes selected (`*`) and live (`>`) steps. Auto-follow uses strong
runtime evidence when canonical state is stale:

```text
current_work_item_id -> active Todo -> active worker -> STATE current_step
```

Arrow navigation pauses follow. `c` resumes live follow. Runtime recovery is
read-only and surfaces state drift for Main reconciliation.

## Ponytail

Only Coder and backup Coder autoload `ponytail`. Designer/Advisor autoload
`ui-designer`; they preserve meaningful visual, responsive, interaction, and
accessibility behavior rather than minimizing it away.

## Graphify

```text
non-trivial discovery -> Graphify -> focused real source -> verify
known exact local symbol -> focused source tools -> verify
```

Main owns freshness. Graphify failure is advisory. Update/install bounds its
refresh time when `--refresh-graphify` is explicitly requested.

## Gates

- Objective Gates: deterministic commands/artifacts.
- Reviewer Judgment Gates: correctness, contracts, scope, architecture.
- Human visual gate: final aesthetic acceptance after a direct redesign.
- Reviewer is on by default; Tester is recommended; Security is optional near release.

## Failure and recovery

Three materially identical no-progress failures stop. Runtime interruption and
provider/model failure do not count as product attempts. Every backup—including
Advisor and Designer—requires explicit Human authorization.

## Dashboard and observability

- `Alt+W`: plan, selected/live cursor, dual Todo, gates, workers, metrics, tokens,
  and manual Stats URL.
- `Alt+A`: transcripts and intervention.
- `Alt+M`: core and optional design model roles.
- `/workflow-stats`: explicit Stats start/sync/open only.

## Update

```bash
( tmp_dir="$(mktemp -d)" && git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw" && bash "$tmp_dir/pw/AI_Workflow_Kit/script/workflow_update.sh" apply; rc=$?; rm -rf "${tmp_dir:-}"; exit "$rc" )
```

Graphify refresh is deferred by default; use `--refresh-graphify` for an
explicit bounded refresh. The updater preserves live project
memory and model selections, adds only missing design aliases, stores a framework
backup, runs migration/doctor, and requires an OMP restart.
