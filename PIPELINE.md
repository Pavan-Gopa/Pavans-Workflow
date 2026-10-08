# Pipeline — Pavan's Workflow

A file-backed, multi-model OMP development loop: fresh specialized workers,
Main-owned state, code-checked boundaries, and optional Human-requested design
escalation. Rules: `AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md`. Procedure:
`AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`.

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

## Step loop

```text
Human <-> Main
  -> state transaction (step, work item, profile, target_files)        R8
  -> workflow_route.py coder (fast_first -> Fast Coder; fallback -> Coder)
  -> fresh Coder/Fast Coder (+ Ponytail) guard blocks out-of-scope edits R6
  -> workflow_close.py check           gates + guard + blast radius     R13
       close_quick ........... quick card, everything green -> close
       review ................ fresh Reviewer -> Main verifies
                               -> fresh Tester  -> Main verifies -> close
       reopen_coder .......... gate failed -> verified retry memory -> fresh Coder
       gate_timeout .......... gate timed out after Ns -> re-run check with larger timeout
       reject_worker_result .. worker's own violation -> Human decides -> fresh Coder

Profiles and gate syntax: `AI_Workflow_Kit/docs/AI/LEAN_PIPELINE.md`.

## Design escalation (never automatic)

```text
Advice:   Human feedback -> Design Advisor (read-only) -> Coder -> Reviewer -> Tester
Redesign: Human authorizes -> Designer (UI target_files) -> Reviewer -> Tester
          -> Human visual acceptance
```

## Failure and recovery

Three materially identical no-progress failures stop (R15). Runtime
interruption and provider/model failure are not product attempts. On a primary
worker model/provider failure, Main dispatches the role's `-backup` agent with
`backup_failover` and the failure evidence in the assignment; a Fast Coder failure
goes to `workflow-coder` (no Fast Coder backup), and a backup that aliases the failed
primary does not count. The Human is asked only when no distinct backup is configured
or the backup fails (R16).

## Observability

- `Alt+W` plan, live cursor, gates, workers, metrics, tokens (read-only).
- `Alt+A` Agent Hub: transcripts, intervention, abort.
- `Alt+M` model roles; the doctor warns when the Reviewer shares the Coder's model.
- `/workflow-stats` or `o` in Alt+W: manual OMP Stats.

## Update

```bash
bash AI_Workflow_Kit/script/workflow_update.sh check   # plan only
bash AI_Workflow_Kit/script/workflow_update.sh apply   # newest vX.Y.Z release
```

Framework files come from `AI_Workflow_Kit/framework.manifest`; project state,
model selections, custom `.omp` files, and the Graphify index are preserved.
Touched framework files are backed up and the framework step rolls back on
failure. Restart OMP afterwards.
