# Pavan's Workflow v3 — OMP Contract

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

Default flow:

```text
Coder -> Main verification -> Reviewer -> Main verification
      -> Tester -> Main verification -> next step
```

Reviewer is enabled unless explicitly skipped. Tester is recommended unless the
Human opts out. Security is offered once near release. Architect is used for
material design uncertainty, plan/code conflict, deep Grilling, or thrash.

## Stable checklist and runtime Todo

`STEPS.md` is Main-owned semantic completion memory. Every item has a stable ID:
`<step>.D<n>`, `<step>.O<n>`, or `<step>.J<n>`. Main alone checks or reopens it
after verification.

OMP's native Todo is a separate runtime subtask list. Prefix runtime tasks with
the parent work item (`[S3.D2] ...`). Completing a runtime Todo never checks a
`STEPS.md` item automatically.

## Ponytail

Ponytail is a project-local implementation policy, not a global Pi/OMP plugin.

- Only `workflow-coder` and `workflow-coder-backup` autoload `ponytail`.
- The accepted requirement, `target_files`, stable IDs, assigned gates,
  validation, security, accessibility, compatibility, data integrity, and the
  role's structured output always outrank simplification.
- `ponytail_mode` is assignment-local and does not persist between workers.
  `full` is default; `ultra` is never selected automatically.
- Reviewer remains correctness-first. It may block material avoidable
  complexity only when it names a concrete behavior-preserving replacement.
  Stylistic line-count preferences are not blocking findings.
- Architect prefers the smallest reversible design satisfying confirmed
  constraints but does not load Ponytail over Grilling.
- Tester and Security never reduce their gates for brevity.
- `ponytail-review`, `ponytail-audit`, and `ponytail-debt` are explicit one-shot
  tools, not automatic pipeline stages or canonical workflow memory.

## Graphify

Graphify is navigation evidence, never source of truth.

Use Graphify first for non-trivial discovery: unknown entry points, cross-file
behavior, callers/callees, dependency paths, blast radius, public APIs, schemas,
trust boundaries, Architect analysis, and Security analysis.

When Main already supplies an exact file and symbol and impact is demonstrably
local, focused LSP/grep/read may be smaller than a ritual graph query. In every
case, read the smallest relevant real source slice before editing or concluding.

Freshness is Main-owned:

```bash
bash AI_Workflow_Kit/script/graphify_rebuild.sh fast      # normal local loop
bash AI_Workflow_Kit/script/graphify_rebuild.sh deep      # clustered code map
bash AI_Workflow_Kit/script/graphify_rebuild.sh semantic  # explicit docs/media pass
bash AI_Workflow_Kit/script/graphify_rebuild.sh force     # full local recovery
```

Workers report staleness instead of rebuilding. Graphify failure never blocks
source-based work by itself.

## OMP Stats

OMP Stats is manual in v3.

- Nothing probes, starts, syncs, or displays a widget at session startup.
- There is no persistent Stats notice below the editor.
- Alt+W always shows the copyable local URL `http://127.0.0.1:3847` with status
  `manual` while idle.
- Press `o` in Alt+W or run `/workflow-stats` to explicitly start, sync, and open
  Stats. Only a server started by this OMP process is stopped at shutdown.
- Stats failure never affects routing, gates, or workflow metrics.

Passive workflow metrics under Git's private common directory remain separate
from OMP Stats and never control execution.

## Model failover

Automatic cross-model fallback is disabled. Persistent provider/model failure
is recorded and pauses routing without incrementing product attempts. Main may
start `workflow-<role>-backup` only after the Human explicitly authorizes that
recorded role and the fresh assignment carries
`human_backup_authorization: true` plus the exact instruction. Backup output
still requires ordinary repository and gate verification.

## Human control

The Human may interrupt or redirect Main at any time. Alt+A is Agent Hub for
worker inspection and intervention. Alt+W is the read-only workflow dashboard.
After any intervention Main rereads real repository and workflow state.
