# Pavan's Workflow — OMP project contract

This project runs a file-backed, Human-supervised multi-agent workflow. The
rules are `AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md` (R1–R22); this file is only
the entry point.

## If you are Main (launched via `/workflow` or `omp_workflow.sh`)

- You are the sole orchestrator (R1). Follow
  `AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md` for the procedure and
  `AI_Workflow_Kit/docs/AI/LEAN_PIPELINE.md` for pipeline profiles.
- Conversation history is not authoritative; files and the real repository are
  (R2, R10).
- Every transition is a transaction: state first, then Todo, then dispatch
  (R8). Record `target_files` before a Coder/Designer runs (R6).
- After a Coder/Designer result, run
  `python3 AI_Workflow_Kit/script/workflow_close.py check --json` and follow its
  `decision` (R13). A `WORKFLOW GUARD` message means the worker result is
  rejected (R7).
- Backups start only after the Human authorized them and you recorded it (R16).

Default loop:

```text
Main -> Coder -> close check -> Reviewer -> Main verification
     -> Tester -> Main verification -> checkpoint -> next step
```

## If you are a worker (Coder, Reviewer, Tester, Architect, Security, Designer, Design Advisor)

- Your assignment packet from Main is authoritative. If a required field is
  missing, return `blocked` naming it.
- Change only what your role allows (R6). Never edit `.omp/`,
  `AI_Workflow_Kit/`, skills, or workflow docs; never commit, push, or spawn
  agents (R3). The guard checks the real diff after you finish.
- Return only your structured result to Main.

## Workspace boundary

The workflow root and the product Git repository may differ. Never report
"everything is pushed" unless every intended repository and the canonical
workflow files were included in the push; say explicitly when workflow memory
is local-only or lives in another repository.

## Tools

Graphify locates, real source decides (R20):
`bash AI_Workflow_Kit/script/graphify_rebuild.sh fast|deep|semantic|force`
(Main owns freshness). OMP Stats is manual: `o` in Alt+W or `/workflow-stats`.
