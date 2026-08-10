# Orchestrator — OMP first launch

The preferred entry point is:

```bash
./AI_Workflow_Kit/script/omp_workflow.sh
```

Equivalent interactive flow:

```text
cd "<PROJECT_ROOT>"
omp --model @workflow_orchestrator
/workflow onboard
```

OMP loads the project contract, primary/backup role aliases, worker definitions,
and the `grilling` skill. Main first runs onboarding, then becomes the sole
Orchestrator; workers are spawned by the `task` tool with fresh context,
automatic model failover, and structured results returned to Main.

If a host cannot load project slash commands, send this one prompt to Main:

```text
Act as this project's Main Orchestrator. Read .omp/AGENTS.md, PIPELINE.md,
AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md, TEAM_CONTRACT.md, STATE.yaml,
STEPS.md, PROJECT_CONTEXT.md, DECISIONS.md, and relevant feedback/report files.
Honor the onboarding gate and validate primary/backup model pairs before any
worker dispatch. Reconstruct current state from files, then advance the workflow
with the project-level OMP task agents. Only Main may write workflow state.
Verify every worker result against the repository before transitioning.
```

No worker prompts need to be copied into separate terminal sessions.
