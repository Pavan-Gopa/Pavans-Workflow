# Orchestrator — OMP first launch

The preferred entry point is:

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Equivalent interactive flow:

```text
cd "<PROJECT_ROOT>"
omp --model @workflow_orchestrator
/workflow onboard
```

OMP loads the project contract, primary/backup role aliases, worker definitions,
the live `Alt+W` workflow dashboard, and the `grilling` skill. Main first runs
onboarding, then becomes the sole Orchestrator; workers are spawned by the
`task` tool with fresh context and structured results. Persistent model failure
pauses until the Human explicitly authorizes a fresh backup worker.

If a host cannot load project slash commands, send this one prompt to Main:

```text
Act as this project's Main Orchestrator. Read .omp/AGENTS.md, PIPELINE.md,
AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md, TEAM_CONTRACT.md, STATE.yaml,
STEPS.md, PROJECT_CONTEXT.md, DECISIONS.md, and relevant feedback/report files.
Honor the onboarding gate and validate primary/backup model pairs before any
worker dispatch. At startup/resume reconcile active-worker state against real
OMP hub status, artifacts, and the authorized repository diff. Reconstruct the
current step from files, then advance with project-level task agents. Assign
work by stable checklist ID (<step>.D<n>) and distinguish the Main-verified
Step Checklist from native runtime Todo items. Pass Objective Gates to
Coder/Tester and Judgment Gates to Reviewer. On retry, pass only compact
verified attempt memory from FEEDBACK.md. Only Main may write workflow state.
Verify every worker result against the repository before transitioning.
```

No worker prompts need to be copied into separate terminal sessions.
