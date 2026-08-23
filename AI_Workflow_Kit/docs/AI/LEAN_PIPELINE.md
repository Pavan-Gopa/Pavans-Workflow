# Lean Pipeline — experiment contract

Active when `.omp/workflow-lean-pipeline.json` exists. Default unlabeled
behavior is unchanged: Coder → Main verification → Reviewer → Tester.

This file is the experiment addendum. `TEAM_CONTRACT.md` still wins on role
boundaries. Lean never lets economy outrank a high-risk card.

## Pipeline profiles

Read from the current `STEPS.md` card, then copy into `STATE.yaml`:

```yaml
pipeline:
  profile: standard   # quick | standard | critical
  authorized_by: null
  authorized_at: null
  note: null
```

| Profile | Reviewer | Tester | Security |
|---|---|---|---|
| `standard` (default) | on unless Human skipped | recommended | offer near release |
| `quick` | skip after green Objective Gates | skip | no |
| `critical` | on | on unless Human skipped | offer scoped pass if blast-radius hits |

`quick` is ignored when the card `**Risk:**` is `high`. Write `quick` only on
docs, comments, config copy, or other low-blast work. Writing the field on the
card is the Human authorization; Main does not invent `quick`.

Before closing a `quick` step or dispatching Reviewer on `standard`/`critical`,
run:

```bash
python3 AI_Workflow_Kit/script/workflow_gates.py run --json
```

A missing or failed command gate is not `waiting_review`. Reopen the Coder
item. Gates without a backticked command stay manual Judgment/artifact checks.

## Retry economy

| Situation | `ponytail_mode` |
|---|---|
| First Coder attempt on the item | `full` |
| Reviewer `changes_requested` or Tester `bugs` | `lite` |
| `repeated_failure_count >= 2` | `off` |

On Tester `bugs`, require a failing test in approved test paths before
dispatching Coder. That test becomes an Objective Gate for the retry.

## Assignment-first

Every worker assignment is self-contained: goal, stable IDs, target files,
exclusions, gates, compact retry facts, and the matching digest from
`WORKER_INPUT_DIGEST.md`. Do not tell workers to re-read TEAM_CONTRACT,
KICK_*, or PROJECT_CONTEXT. Incomplete assignments should `blocked`, not
trigger a full-contract reread.

Main targeted reconciliation (see `CONTEXT_ECONOMY.md`) is the default for an
ordinary transition. Full reread remains required at startup/resume,
`/workflow status`, Human interrupt, compaction recovery, and hash drift.

## Scoped Security

After a verified Coder diff, run:

```bash
python3 AI_Workflow_Kit/script/workflow_security_scope.py
```

A hit sets `security.next_run: offer_scoped` and asks the Human. Decline
records `declined`. This is not a full pre-release campaign.

## Rollback

The overlay is removable:

```bash
bash AI_Workflow_Kit/experiments/lean-pipeline/install.sh rollback
```
