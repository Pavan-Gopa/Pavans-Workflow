# Pavan's Workflow v3.1 — OMP Contract

This project runs one file-backed, Human-supervised multi-agent workflow inside
an OMP Main session.

## Authority and role boundaries

- Main is the sole Orchestrator when launched through `/workflow` or
  `AI_Workflow_Kit/script/omp_workflow.sh`.
- Only Main writes workflow state, plans, feedback, reports, checkpoints, and
  `.omp/**` during a workflow run.
- Specialized workers never route, spawn another worker, commit, tag, push, or
  hand work directly to another worker.
- Main does not implement product code after worker failures unless the Human
  gives explicit task-specific authorization.
- Run exactly one specialized worker at a time. Every retry is a fresh session.

## Source of truth

Conversation history is not authoritative. Before routing or changing a gate,
Main rereads:

1. authoritative plan files named by `PROJECT_CONTEXT.md`;
2. `AI_Workflow_Kit/docs/AI/STATE.yaml`;
3. `AI_Workflow_Kit/docs/STEPS.md` and `DECISIONS.md`;
4. current feedback/report files;
5. repository status, real source, diff, and test evidence.

Higher-priority sources in `TEAM_CONTRACT.md` win. A worker exiting does not
prove success.

## Main loop

1. Reconcile file-backed state with real OMP `hub jobs` / `hub list`, available
   artifacts, and the authorized repository diff. Preserve interrupted work;
   runtime disappearance alone is not a product failure.
2. Select one role justified by current state.
3. Dispatch a fresh project agent with a compact self-contained assignment:
   goal, step, stable work-item ID, target files, exclusions, Objective Gates,
   Reviewer-owned Judgment Gates, and source-of-truth paths.
4. Coder assignments include `ponytail_mode: off | lite | full`; default `full`.
5. Verify every result against real source/diff/tests before writing canonical
   feedback, checking or reopening stable IDs, recording metrics, or routing.
6. Stop after three materially identical failures of the same approach. New
   evidence, a new approach, or a different failure is progress.

Default flow remains unchanged:

```text
Coder -> Main verification -> Reviewer -> Main verification
      -> Tester -> Main verification -> next step
```

Reviewer is enabled unless explicitly skipped. Tester is recommended unless the
Human opts out. Security is offered once near release. Architect is used for
material system-design uncertainty, plan/code conflict, deep Grilling, or
implementation thrash.

## Optional Designer escalation

Designer is never inserted automatically into the default flow. Main uses it
only after explicit Human visual feedback or a direct request.

Two paths are available:

- `workflow-design-advisor`: read-only, lower-cost, implementation-ready brief;
  ordinary Coder may implement it afterward.
- `workflow-designer`: edit-capable, bounded presentation-layer redesign.

Main asks one concise clarification when advisory versus direct implementation
is ambiguous. Every design assignment carries the Human's exact feedback,
target surface, preserve-list, explicit files, visual acceptance criteria, and
available screenshot/capture or reproduction evidence.

Designer never changes backend behavior, API/schema, persistence, security,
business logic, routing, localization meaning, or unrelated screens. Direct
Designer output passes Main verification, Reviewer, enabled Tester, and final
Human visual acceptance. Reviewer/Tester green alone does not prove the Human
likes the result.

Neither design role autoloads Ponytail. Both autoload `ui-designer` and reuse
existing components/tokens before adding primitives or dependencies.

## Stable checklist and runtime Todo

`STEPS.md` is Main-owned semantic completion memory. Every item has a stable ID:
`<step>.D<n>`, `<step>.O<n>`, or `<step>.J<n>`. Main alone checks or reopens it
after verification.

OMP's native Todo is a separate runtime subtask list. Prefix runtime tasks with
the parent work item (`[S3.D2] ...`). Completing a runtime Todo never checks a
`STEPS.md` item automatically.

## Live dashboard cursor

Alt+W distinguishes the selected step (`*`) from the live workflow step (`>`).
When the Human has not navigated away, the plan follows the live step
automatically. Arrow navigation pauses follow mode; `c` returns to live follow.

The read-only dashboard resolves stale display state from, in order:

1. `current_work_item_id`;
2. active/in-progress OMP Todo;
3. active worker assignment;
4. canonical `STATE.yaml.current_step`;
5. a unique pending Todo fallback.

A runtime-derived live step produces a visible state-drift warning. Dashboard
recovery never writes canonical state; Main must reconcile it.

## Ponytail

Ponytail is a project-local implementation policy, not a global Pi/OMP plugin.
Only primary and backup Coder autoload it. Confirmed requirements, target files,
stable IDs, gates, validation, security, accessibility, compatibility, data
integrity, and structured output outrank simplification. Reviewer remains
correctness-first. Tester, Security, Architect, Advisor, and Designer never
reduce their contracts for brevity.

## Graphify

Graphify is navigation evidence, never source of truth. Use it for non-trivial
discovery, cross-file behavior, callers/callees, dependency paths, blast radius,
public APIs, schemas, trust boundaries, Architect work, and Security work. A
known exact local symbol may use focused LSP/grep/read. Real-source verification
is mandatory in both paths.

Main owns freshness:

```bash
bash AI_Workflow_Kit/script/graphify_rebuild.sh fast
bash AI_Workflow_Kit/script/graphify_rebuild.sh deep
bash AI_Workflow_Kit/script/graphify_rebuild.sh semantic
bash AI_Workflow_Kit/script/graphify_rebuild.sh force
```

Workers report staleness instead of rebuilding. Graphify failure never blocks
source-based work by itself.

## OMP Stats

OMP Stats remains manual. Nothing probes, starts, syncs, or displays a widget at
startup. Alt+W always shows `http://127.0.0.1:3847`. Press `o` or run
`/workflow-stats` to start/sync/open it explicitly. Stats never controls gates.

## Model failover

Automatic cross-model fallback is disabled. Persistent provider/model failure
is recorded and pauses routing without incrementing product attempts. Main may
start a matching backup only after the Human explicitly authorizes that role and
the assignment carries `human_backup_authorization: true` plus the exact
instruction. This applies to Coder, Reviewer, Tester, Architect, Security,
Design Advisor, and Designer.

## Human control

The Human may interrupt or redirect Main at any time. Alt+A is Agent Hub for
worker inspection and intervention. Alt+W is the read-only workflow dashboard.
After any intervention Main rereads real repository and workflow state.
