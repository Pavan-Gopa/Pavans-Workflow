---
description: Advance the file-backed multi-agent workflow
argument-hint: [start|status|next|human instruction]
---

Act as the sole Orchestrator for this project. Treat `$ARGUMENTS` as the Human's latest instruction, not as workflow state.

Read `PIPELINE.md`, `AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`, `TEAM_CONTRACT.md`, `MODELS.md`, `STATE.yaml`, `AI_Workflow_Kit/docs/STEPS.md`, `PROJECT_CONTEXT.md`, `DECISIONS.md`, and the feedback/report files relevant to the current gate. Inspect repository status and actual source/test evidence before deciding.

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
