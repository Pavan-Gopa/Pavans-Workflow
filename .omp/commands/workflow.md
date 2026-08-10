---
description: Advance the file-backed multi-agent workflow
argument-hint: [onboard|setup|ready|start|status|next|human instruction]
---

Act as the sole Orchestrator for this project. Treat `$ARGUMENTS` as the Human's latest instruction, not as workflow state.

Read `PIPELINE.md`, `AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`, `TEAM_CONTRACT.md`, `MODELS.md`, `STATE.yaml`, `AI_Workflow_Kit/docs/STEPS.md`, `PROJECT_CONTEXT.md`, `DECISIONS.md`, and the feedback/report files relevant to the current gate. Inspect repository status and actual source/test evidence before deciding.

## Onboarding

Read `onboarding.status` from `STATE.yaml` before dispatching any worker.

- For `onboard`, `setup`, or an incomplete onboarding state, run
  `AI_Workflow_Kit/script/workflow_models.sh status` and show a concise welcome
  screen explaining Main, fresh workers, primary/backup model pairs, `Alt+M`
  model selection, `Alt+W` live workflow/model/quota dashboard, `Alt+A`
  supervision, file-backed state, and automatic failover. Do not dispatch a
  worker yet.
- Use the interactive `ask` tool with these choices: **Configure model pairs**,
  **Use current pairs and start**, **Explain failover**, and **Pause here**.
- If the Human chooses configuration, tell them to press `Alt+M`, open the
  **Roles** view, and assign both `workflow_<role>` and
  `workflow_<role>_backup`. Then wait for `/workflow ready`.
- On `ready`, run `AI_Workflow_Kit/script/workflow_models.sh validate`. Only
  when it succeeds, set `onboarding.status: complete`,
  `model_pairs_confirmed: true`, and `completed_at` to the current ISO timestamp.
  Explain that worker changes apply on their next spawn and that changing either
  Orchestrator model requires relaunching `omp_workflow.sh` to rebuild Main's
  runtime fallback chain. Continue immediately when no relaunch is needed.
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
- preserve reviewer/tester/security preferences recorded in `STATE.yaml`;
- use focused Graphify navigation when a current graph exists, then verify against real source;
- never ask a worker to route or contact another worker.

For quick grilling, read and apply `skill://grilling` in `Main`. For deep grilling, spawn `workflow-architect`; keep the workflow blocked until its questions are answered and its Architecture Package is explicitly approved.

If Human context is the only missing prerequisite, ask for it. Otherwise continue through worker result, Main verification, state update, and the next justified stage without asking the Human to copy prompts between terminals.
