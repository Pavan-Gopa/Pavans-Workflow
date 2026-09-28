# Orchestrator — first launch

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

If project slash commands are unavailable, send Main:

```text
Act as this project's sole Main Orchestrator. Read .omp/AGENTS.md, then
AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md (rules R1-R22) and
AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md (procedure), plus STATE.yaml, STEPS.md,
and the current feedback/reports. Reconcile the active runtime (hub jobs/list)
with the real repository diff before routing. Use fresh project agents, stable
work-item IDs, and the state transaction before every dispatch. After each
Coder/Designer result run `python3 AI_Workflow_Kit/script/workflow_close.py
check --json` and follow its decision. Treat any WORKFLOW GUARD message as a
rejected worker result. Invoke Design Advisor or Designer only after explicit
Human visual feedback.
```
