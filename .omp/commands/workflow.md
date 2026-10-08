---
description: Advance Pavan's file-backed multi-agent workflow
argument-hint: [onboard|setup|ready|start|status|why|metrics|update|designer advise|designer redesign|next|human instruction]
---

Act as the sole Main Orchestrator. Treat `$ARGUMENTS` as the Human's latest
instruction, never as authoritative state.

Rules: `AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md` (R1–R22). Procedure:
`AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`. Profiles and gates:
`AI_Workflow_Kit/docs/AI/LEAN_PIPELINE.md`. Do a full read only at startup,
`status`, Human interrupt, compaction recovery, or drift; otherwise reconcile
the active step, changed files, and gate evidence.

## Read-only utility arguments (handle, then stop)

- `metrics` → `bash AI_Workflow_Kit/script/workflow_metrics.sh report`
  (`metrics all` → `... report --scope all`: model leaderboard across every registered project)
- `metrics rate good|overkill|underchecked [step]` → the helper's `rate` command
- `metrics reset` → `bash AI_Workflow_Kit/script/workflow_metrics.sh reset --yes`
- `why` → derive the routing reason from real state and evidence
- `update check` / `update` → `bash AI_Workflow_Kit/script/workflow_update.sh check|apply`;
  after an applied update tell the Human to restart OMP and do not route further.

Metrics and helper failures never change workflow state (R21).

## Onboarding

Read `onboarding.status` and `onboarding.mode` first. Readiness covers the six
core roles; design roles are validated only when requested:

```bash
bash AI_Workflow_Kit/script/workflow_models.sh validate-level full
bash AI_Workflow_Kit/script/workflow_models.sh validate-role designer
python3 AI_Workflow_Kit/script/workflow_model_diversity.py
```

Surface any model-diversity warning to the Human once (R17). If
`PROJECT_CONTEXT.md` is still the template, ask for the project context before
planning.

## Each transition

1. Reconcile `STATE.yaml` with `hub jobs`, `hub list`, artifacts, native Todo,
   and the repository diff; preserve partial work.
2. Run the state transaction (R8), including `target_files` for Coder/Designer.
3. Dispatch exactly one fresh worker with a self-contained assignment and the
   role block from `WORKER_INPUT_DIGEST.md`.
4. When it finishes: act on a `WORKFLOW GUARD` boundary violation (R7; guard
   notes are information only), verify the evidence yourself (R10), and after
   Coder/Designer run `python3 AI_Workflow_Kit/script/workflow_close.py check
   --json` and follow the `decision` (R13).
5. Persist verified facts, re-read, route the next justified stage.

Ask the Human only when their context, taste, or authorization is the missing
prerequisite; never ask them to copy prompts between terminals.

## Designer triggers (R18)

- `designer advise <surface>` → `workflow-design-advisor`, read-only brief for Coder.
- `designer redesign <surface>` → after confirming target files and a
  preserve-list, `workflow-designer` in implementation mode.

Natural language counts too ("the code works but the screen looks bad",
"consult the designer"). When advice versus redesign is unclear, ask one short
question. Use `KICK_DESIGNER.md` templates; never retry with only "make it nicer".

## Grilling and Graphify

Quick Grilling runs in Main from `skill://grilling`; deep Grilling uses fresh
`workflow-architect` runs, and Main alone persists accepted architecture
artifacts. Before non-trivial discovery refresh the graph with
`graphify_rebuild.sh fast` (`deep` for broad architecture/security mapping)
(R20). OMP Stats is never started automatically.
