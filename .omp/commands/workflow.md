---
description: Advance the file-backed multi-agent workflow
argument-hint: [onboard|setup|ready|start|status|metrics|metrics rate|metrics reset|update|update check|next|human instruction]
---

Act as the sole Orchestrator for this project. Treat `$ARGUMENTS` as the Human's latest instruction, not as workflow state.

Read `PIPELINE.md`, `AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`, `TEAM_CONTRACT.md`, `MODELS.md`, `STATE.yaml`, `AI_Workflow_Kit/docs/STEPS.md`, `PROJECT_CONTEXT.md`, `DECISIONS.md`, and the feedback/report files relevant to the current gate. Inspect repository status and actual source/test evidence before deciding.

## Passive workflow metrics

Handle arguments beginning with `metrics` before onboarding, update, or product
routing. Metrics never mutate workflow state or select the next actor.

- For `metrics`, run
  `bash AI_Workflow_Kit/script/workflow_metrics.sh report`, return the complete
  human-readable report, and stop.
- For `metrics rate good`, `metrics rate overkill`, or
  `metrics rate underchecked`, run the helper's `rate` command. If a step follows
  the rating, pass it with `--step`; otherwise the helper uses the latest
  completed step. Return the result and stop.
- For the explicit `metrics reset` instruction, run
  `bash AI_Workflow_Kit/script/workflow_metrics.sh reset --yes`, report the exact
  files removed, and stop. The reset touches telemetry only.
- Follow `AI_Workflow_Kit/docs/AI/METRICS.md` for event keys, candidate linkage,
  taxonomy, transition instrumentation, privacy, and failure behavior.

## Explicit workflow update

Handle `update` before onboarding or product routing. This is an explicit,
Human-invoked operation; never poll upstream periodically.

- For `update check` or `update`, create a temporary shallow clone of
  `https://github.com/Pavan-Gopa/Pavans-Workflow.git` and compare its `main`
  against the installed workflow framework.
- Compare only framework surfaces: `.omp/AGENTS.md`, `.omp/agents/`,
  `.omp/commands/`, `.omp/extensions/`, `grilling/`,
  `AI_Workflow_Kit/script/`, role/contract templates under
  `AI_Workflow_Kit/docs/AI/`, `PIPELINE.md`, and
  `ORCHESTRATOR_FIRST_PROMPT.md`.
- Never overwrite project-owned configuration or live memory:
  `.omp/config.yml`, `PROJECT_CONTEXT.md`, `STATE.yaml`, `STEPS.md`,
  `DECISIONS.md`, `FEEDBACK.md`, `REPORT.md`, `BUG_REPORT.md`,
  `SECURITY_REPORT.md`, or `COVERAGE.md`.
- `update check` reports the upstream commit and relevant differences, then
  stops without edits.
- `update` conservatively applies reviewed framework changes. Preserve local
  customizations; if a framework file has a non-trivial local conflict, leave it
  unchanged and report the exact conflict instead of replacing it blindly.
- After applying, run `workflow_doctor.sh`, shell syntax checks, agent/command
  discovery, and refresh Graphify. Report upstream commit, changed files,
  preserved files, conflicts, and validation.

After either update action, stop; do not continue into product routing in the
same command.

## Progressive onboarding

Read `onboarding.status` and `onboarding.mode` from `STATE.yaml` before dispatching any worker.

- Onboarding supports three modes:
  1. **Quick start (Default)**: Uses Main/default model for primary roles (`workflow_<role> -> @workflow_orchestrator`). Backups are optional until a model failure occurs. S0 starts immediately.
  2. **Guided**: Step-by-step interactive selection for primary roles (`Orchestrator`, `Coder`, `Reviewer`, `Tester`). Architect/Security are configured JIT when needed.
  3. **Advanced**: Full `Alt+M` Roles setup configuring all primary and backup pairs with provider diversity and thinking levels.
- For `onboard`, `setup`, or when `onboarding.status` is pending:
  - Run `bash AI_Workflow_Kit/script/workflow_models.sh status`.
  - Check readiness with `bash AI_Workflow_Kit/script/workflow_models.sh validate-level main`.
  - Present the interactive `ask` tool with options:
    - **Quick start (Recommended)** — use current/default model for all roles and begin S0 immediately.
    - **Guided setup** — configure primary roles step by step.
    - **Advanced setup** — configure all 6 primary + backup pairs via `Alt+M → Roles`.
    - **Explain manual failover & backup policy**.
    - **Pause here**.
  - When Quick start or Guided setup satisfies `validate-level main` (or higher), update `STATE.yaml`:
    `onboarding.status: complete`, `onboarding.mode: <quick|guided|advanced>`, and `completed_at: <ISO timestamp>`.
  - `/workflow ready` remains supported as a backward-compatible alias, but is no longer mandatory; any `/workflow`, `/workflow status`, or `/workflow start` command automatically verifies readiness and continues.
- **Just-In-Time role configuration**:
  - Before the first dispatch of any specialized worker (`coder`, `reviewer`, `tester`, `architect`, `security`), run `bash AI_Workflow_Kit/script/workflow_models.sh validate-role <role>`.
  - If the role is unconfigured, pause and prompt the Human with `ask` to configure only that role (`Alt+M → Roles` or use Main model), without requiring unneeded optional roles or backups.
- **Just-In-Time backup configuration**:
  - When a persistent model failure occurs, check if `workflow_<role>_backup` is configured using `bash AI_Workflow_Kit/script/workflow_models.sh validate-role <role> backup`.
  - If missing, prompt the Human to configure only that backup in `Alt+M` (or replace the primary model). Never choose or invoke a backup without explicit Human authorization.
- If onboarding is already complete, show a one-line readiness banner and continue. `setup` explicitly reopens the onboarding choice screen.

## Startup / resume reconciliation

For `status`, and at every new Main startup/resume before routing, apply the
reconciliation algorithm in `ORCHESTRATOR.md`. Use only real OMP surfaces:
`hub jobs`, `hub list`, and available `agent://` / `history://` artifacts.
Cross-check them with the authorized repository diff and result/test artifacts.
Classify stale active state conservatively, preserve partial work, and never
count runtime disappearance as implementation failure.

## Automatic workflow

Advance the established workflow automatically inside this OMP session:

- update workflow documents only from `Main`;
- dispatch exactly one fresh project worker at a time with `task`;
- use `workflow-coder`, `workflow-reviewer`, `workflow-tester`, `workflow-architect`, or `workflow-security` only when the current file-backed state calls for that role;
- give the worker a minimal, self-contained assignment including the assigned stable work-item ID (`<step>.D<n>`) and source-of-truth paths, never this conversation history;
- verify every structured worker result against the repository and update or reopen checklist items by stable ID before recording or transitioning;
- distinguish the Main-verified Step Checklist from native runtime Todo subtasks (completing a Todo never marks a `STEPS.md` box);
- write canonical feedback/reports/state yourself;
- stop after three materially identical failed attempts and surface a blocker;
- separate Objective Gates from Reviewer-owned Judgment Gates; Coder
  `waiting_review` means objective-ready for independent judgment, not step-complete;
- on a verified retry, persist attempt history in `FEEDBACK.md` and give the
  fresh Coder only compact approach/result/evidence/rejection memory;
- use `workflow-architect` with `Mode: advisory` only for an optional bounded
  second opinion; keep `Mode: design` and `Mode: /grilling` behavior distinct;
- on persistent worker model/provider failure, record
  `omp.model_failure.status: awaiting_human` and the exact evidence in
  `STATE.yaml`, set a visible blocker, and stop without incrementing product
  attempts or launching a backup;
- recognize an explicit Human instruction to retry that recorded role with its
  backup; then dispatch `workflow-<role>-backup` with
  `human_backup_authorization: true`, the exact instruction, and the original
  self-contained assignment. Clear the failure record only after verification;
  if backup fails, pause again;
- preserve reviewer/tester/security preferences recorded in `STATE.yaml`;
- record explicit Human gate skips and reasons instead of leaving impossible
  stop-gates;
- inspect Tester-authored test diffs and request a short targeted review when
  they are substantial;
- use focused Graphify navigation when a current graph exists, then verify against real source;
- never ask a worker to route or contact another worker.
- record passive local events at the exact verified Main transitions defined in
  `AI_Workflow_Kit/docs/AI/METRICS.md`; a metrics warning or missing store/helper
  never blocks, retries, advances, or otherwise changes the workflow;

For quick grilling, read and apply `skill://grilling` in `Main`. For deep
grilling, spawn `workflow-architect`; transparently relay its exact questions
and the Human's exact answers between fresh Architect runs, always carrying the
latest grilling checkpoint. Keep the workflow blocked until the Architecture
Package is explicitly confirmed.

If Human context is the only missing prerequisite, ask for it. Otherwise continue through worker result, Main verification, state update, and the next justified stage without asking the Human to copy prompts between terminals.
