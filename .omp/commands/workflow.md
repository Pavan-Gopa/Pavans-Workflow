---
description: Advance the file-backed multi-agent workflow
argument-hint: [onboard|setup|ready|start|status|next|human instruction]
---

Act as the sole Orchestrator for this project. Treat `$ARGUMENTS` as the Human's latest instruction, not as workflow state.

Read `PIPELINE.md`, `AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`, `TEAM_CONTRACT.md`, `MODELS.md`, `STATE.yaml`, `AI_Workflow_Kit/docs/STEPS.md`, `PROJECT_CONTEXT.md`, `DECISIONS.md`, and the feedback/report files relevant to the current gate. Inspect repository status and actual source/test evidence before deciding.

## Onboarding

Read `onboarding.status` from `STATE.yaml` before dispatching any worker.

- For `onboard`, `setup`, or an incomplete onboarding state, run
  `bash AI_Workflow_Kit/script/workflow_models.sh status` and show a concise
  welcome screen explaining Main, fresh workers, primary/backup model pairs,
  `Alt+M` model selection, `Alt+W` live workflow/model/quota dashboard, `Alt+A`
  supervision, file-backed state, and Human-authorized backup retry. Do not
  dispatch a worker yet.
- Use the interactive `ask` tool with these choices: **Configure model pairs**,
  **Use current pairs and start**, **Explain manual failover**, and **Pause here**.
- If the Human chooses configuration, tell them to press `Alt+M`, open the
  **Roles** view, and assign both `workflow_<role>` and
  `workflow_<role>_backup`. Then wait for `/workflow ready`.
- On `ready`, run `bash AI_Workflow_Kit/script/workflow_models.sh validate`. Only
  when it succeeds, set `onboarding.status: complete`,
  `model_pairs_confirmed: true`, and `completed_at` to the current ISO timestamp.
  Explain that model changes apply to subsequent worker spawns. If Main itself
  is unavailable, the Human must switch the live session to
  `@workflow_orchestrator_backup` through the model selector before continuing.
- If onboarding is already complete, show a one-line readiness banner and
  continue. `setup` explicitly reopens the full onboarding screen.

## Automatic workflow

Advance the established workflow automatically inside this OMP session:

- update workflow documents only from `Main`;
- dispatch exactly one fresh project worker at a time with `task`;
- use `workflow-coder`, `workflow-reviewer`, `workflow-tester`, `workflow-architect`, or `workflow-security` only when the current file-backed state calls for that role;
- give the worker a minimal, self-contained assignment and source-of-truth paths, never this conversation history;
- verify every structured worker result against the repository before recording it or transitioning;
- write canonical feedback/reports/state yourself;
- stop after three materially identical failed attempts and surface a blocker;
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

For quick grilling, read and apply `skill://grilling` in `Main`. For deep
grilling, spawn `workflow-architect`; transparently relay its exact questions
and the Human's exact answers between fresh Architect runs, always carrying the
latest grilling checkpoint. Keep the workflow blocked until the Architecture
Package is explicitly confirmed.

If Human context is the only missing prerequisite, ask for it. Otherwise continue through worker result, Main verification, state update, and the next justified stage without asking the Human to copy prompts between terminals.
