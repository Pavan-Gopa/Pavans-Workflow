# OMP Workflow Contract

This project runs its established workflow inside one OMP session.

## Role boundary

- The OMP `Main` session is the Orchestrator when launched through `/workflow` or `AI_Workflow_Kit/script/omp_workflow.sh`.
- A task subagent follows its `.omp/agents/` role and assignment. It never manages routing or workflow state.
- Only `Main` may change `AI_Workflow_Kit/docs/**`, `PIPELINE.md`, `README.md`, `ORCHESTRATOR_FIRST_PROMPT.md`, or `.omp/**` during workflow execution.
- Workers never commit, tag, push, invoke another worker, or send work directly to another worker. Their only normal handoff is their structured task result to `Main`.
- Main does not implement product code after worker failures. Only an explicit,
  task-specific Human instruction may authorize a Main code edit.
- Run one specialized worker at a time. Every retry is a new task agent session.

## Onboarding and manual model failover

- Before the first worker, Main completes the `STATE.yaml` onboarding gate.
- `Alt+M` configures paired `workflow_<role>` and
  `workflow_<role>_backup` aliases through OMP's native Roles selector.
- Primary worker definitions select only the primary alias. Backup execution
  variants select only the backup alias and enforce Human authorization.
- Persistent worker model/provider failure is recorded and pauses routing.
- Main's own backup requires a live Human model switch or a relaunch on
  `@workflow_orchestrator_backup`.
- A backup result still requires normal repository and test verification.


## Source of truth

Conversation history is not authoritative. Before every routing or stage transition, `Main` rereads:

1. authoritative plan files named in `AI_Workflow_Kit/docs/PROJECT_CONTEXT.md`;
2. `AI_Workflow_Kit/docs/AI/STATE.yaml`;
3. `AI_Workflow_Kit/docs/STEPS.md` and `AI_Workflow_Kit/docs/DECISIONS.md`;
4. the latest feedback/report files relevant to the current gate;
5. repository status, real source, diff, and test evidence.

On conflict, follow `AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md`. Do not infer success from a worker exiting.

## Passive metrics boundary

- Main alone records local workflow events after the existing transition has
  been verified. Workers never write or receive telemetry context.
- `AI_Workflow_Kit/docs/AI/METRICS.md` is the schema, formula, storage, privacy,
  and instrumentation source of truth.
- Metrics are append-only observation. Missing/corrupt storage, helper failure,
  report failure, or dashboard failure never changes state, gates, retries,
  recovery, failover, checkpoints, or routing.
- `/workflow metrics` is read-only. Metrics reset deletes telemetry only.

## Orchestration loop

1. Reconstruct the current step from files. At startup/resume reconcile any
   `omp.active_agent` with `hub jobs`, `hub list`, available agent/history
   artifacts, and the actual authorized repository diff. Preserve partial work;
   runtime interruption alone increments no implementation/retry counter.
2. Incorporate the Human's latest instruction, then reread affected
   source-of-truth files.
3. Select exactly one next role from the existing workflow.
4. Spawn it with `task`, its project agent name, a fresh unique run name, and a
   compact self-contained assignment: goal, step, allowed paths, exclusions,
   Objective Gates, Reviewer-owned Judgment Gates, and source-of-truth paths.
   On retry include only verified approach/result/evidence/rejection memory from
   `FEEDBACK.md`; never pass worker transcripts or Main's conversation history.
5. When its structured result arrives, inspect the actual diff/source/test
   output. If Tester changed tests, inspect the test diff for weakened
   assertions and real product behavior; use a short targeted Reviewer pass for
   a substantial diff.
6. Only after verification, write the canonical entry to `FEEDBACK.md`,
   `REPORT.md`, `BUG_REPORT.md`, or `SECURITY_REPORT.md`, update `STATE.yaml`,
   and route the next role.

Default step flow remains `workflow-coder -> Main verification -> workflow-reviewer -> Main verification -> workflow-tester -> Main verification`. Reviewer is required unless the Human explicitly skips it. Tester is enabled unless the Human opts out. Record every skip and reason so the step gate remains satisfiable. Security is offered once near release and runs only after Human approval. Architect is used for unclear design, plan/code conflict, deep grilling, or implementation thrash.

After a verified Coder handoff, persist `implementation.status: waiting_review`;
reserve `complete` for a fully satisfied step Stop-gate.

For bounded design uncertainty, Main may dispatch the existing
`workflow-architect` with `Mode: advisory`. Advice is read-only and optional:
no Grilling, Human interview, ADR, Architecture Package, persistence, or
routing. `Mode: design` and `Mode: /grilling` retain their existing paths.

If the same approach produces the same material failure three times without
progress, stop automatic retries. A new approach, new evidence, or materially
different failure is progress, not another identical failure. Main records the
verified attempt memory in `FEEDBACK.md`, surfaces blockers in `STATE.yaml`, and
asks the Human for direction or routes once to `workflow-architect` when the
workflow permits it.

Persistent model/provider failure is a pause, not a routing decision. Record it
under `omp.model_failure` and `retry_guard.blocker` in `STATE.yaml`; do not
increment product-work attempts or launch the configured backup automatically.
Only after the Human explicitly requests backup retry for that recorded role may
Main dispatch `workflow-<role>-backup`, with
`human_backup_authorization: true` and the exact Human instruction in the fresh
assignment. Clear the model-failure record only after a verified result. A
failed backup pauses again. Non-model failures and Human aborts are not eligible.

## Graphify

Use `GRAPHIFY -> FIND; SOURCE -> VERIFY`:

1. If `graphify-out/graph.json` exists, start with focused `graphify query`, `path`, `explain`, or `affected` calls.
2. Read the smallest relevant real source/doc slice before editing or making a consequential claim.
3. If the graph is missing or stale, `Main` runs `bash AI_Workflow_Kit/script/graphify_rebuild.sh`. Workers report staleness rather than rebuilding it.
4. Never wander through the repository without a task-specific reason.

## Grilling

The existing `grilling/` skill is discovered through `.omp/config.yml`.

- Quick mode stays in `Main`.
- Deep mode uses fresh `workflow-architect` runs with the `grilling` skill
  autoloaded. Main is a transparent relay: it forwards exact questions and
  exact Human answers with the latest grilling checkpoint, never answering on
  the Human's behalf.
- `Main` alone persists confirmed plans, ADRs, glossary changes, and downstream
  steps.

## Human control

The Human may interrupt or redirect `Main` at any time. `Alt+W` opens the
read-only workflow/agent/model/quota dashboard. `Alt+A` opens Agent Hub to
inspect, steer, revive, or kill the current worker. After any intervention,
`Main` rereads repository and workflow files before continuing.

`/workflow update check` compares the installed framework with upstream without
editing. `/workflow update` performs a conservative explicit update while
preserving `.omp/config.yml` and all project/live workflow memory. There is no
background polling, daemon, or scheduler.
