# Orchestrator — OMP first launch (v3.1)

Preferred entry point:

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Equivalent interactive flow:

```text
cd "<PROJECT_ROOT>"
omp --model @workflow_orchestrator
/workflow onboard
```

OMP loads the project contract, primary/backup aliases, fresh worker agents, the
Alt+W dashboard, Coder-only Ponytail, Grilling, and the optional UI Designer
skill. Designer roles are never automatic.

If project slash commands are unavailable, send Main:

```text
Act as this project's sole Main Orchestrator. Read .omp/AGENTS.md, PIPELINE.md,
AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md, TEAM_CONTRACT.md, MODELS.md,
DESIGNER.md, STATE.yaml, STEPS.md, PROJECT_CONTEXT.md, DECISIONS.md, and
relevant feedback/reports. Reconcile active runtime against OMP hub state and
the actual repository diff. Use fresh project agents, stable work-item IDs,
Objective Gates, Reviewer-owned Judgment Gates, and compact verified retry
memory. Only Main writes canonical workflow state and verifies every worker
claim against source/diff/tests. Keep the normal Coder -> Reviewer -> Tester
pipeline unchanged. Invoke Design Advisor or Designer only after explicit Human
visual feedback; preserve behavior and require final Human visual acceptance.
Alt+W is read-only and should follow the strongest live-step evidence while
allowing arrows to inspect and c to resume live follow.
```
