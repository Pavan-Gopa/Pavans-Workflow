---
description: Advance Pavan's file-backed multi-agent workflow v3
argument-hint: [onboard|setup|ready|start|status|why|metrics|update|next|human instruction]
---

Act as the sole Main Orchestrator. Treat `$ARGUMENTS` as the Human's latest
instruction, never as authoritative state.

Read `.omp/AGENTS.md`, `PIPELINE.md`, `AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`,
`TEAM_CONTRACT.md`, `MODELS.md`, `STATE.yaml`, `STEPS.md`, `PROJECT_CONTEXT.md`,
`DECISIONS.md`, and gate-relevant feedback/reports. Inspect repository status,
actual source, diff, and test evidence before routing.

## Read-only utility arguments

Handle these before product routing and stop afterward:

- `metrics`: run `bash AI_Workflow_Kit/script/workflow_metrics.sh report`.
- `metrics rate good|overkill|underchecked [step]`: run the helper's `rate`
  command with the optional step.
- `metrics reset`: run
  `bash AI_Workflow_Kit/script/workflow_metrics.sh reset --yes`.
- `why`: derive the current routing reason from real state and evidence.

Metrics are passive. A helper/report failure never changes workflow state.

## Explicit framework update

For `update check` or `update`, run the canonical updater rather than manually
reimplementing its path list:

```bash
bash AI_Workflow_Kit/script/workflow_update.sh check
bash AI_Workflow_Kit/script/workflow_update.sh apply
```

The updater manages v3 framework files, Ponytail skills, Graphify helpers,
version/changelog, and deterministic tests while preserving `.omp/config.yml`
and live project state, plans, decisions, feedback, and reports. After an
applied update, tell the Human to restart OMP. Do not continue product routing in
the same command.

## Progressive onboarding

Read `onboarding.status` and `onboarding.mode` before dispatching workers.

- Quick start may share Main's configured model with primary roles.
- Guided setup configures primary execution/quality roles as needed.
- Advanced setup configures all primary/backup pairs with provider diversity.
- Before a specialized dispatch, run
  `bash AI_Workflow_Kit/script/workflow_models.sh validate-role <role>`.
- Missing backup configuration is requested only after a real recorded model
  failure and never authorizes automatic backup use.

Use `Alt+M -> Roles` for model assignments. Mark onboarding complete only after
the selected readiness level is genuinely satisfied.

## Startup and resume

At every startup/resume and `status`, reconcile `STATE.yaml` with real OMP
`hub jobs`, `hub list`, available artifacts, and the authorized repository diff.
Classify stale active state conservatively, preserve partial work, and do not
count runtime disappearance as an implementation attempt.

## Automatic workflow

- Exactly one fresh specialized worker at a time.
- Main alone writes workflow files, stable checklist state, reports, and passive
  metrics.
- Every worker assignment is compact and self-contained; never forward Main's
  conversation history or prior worker transcripts.
- Coder assignments include:

```text
ponytail_mode: off | lite | full   # default full
```

  plus goal, assigned `<step>.D<n>`, `target_files`, exclusions, Objective Gates,
  Reviewer-owned Judgment Gates, interrupted work, and compact verified retry
  memory when applicable.
- Verify structured output against real source/diff/tests before checking or
  reopening stable IDs and before routing.
- `waiting_review` means objective-ready for independent judgment, not complete.
- Reviewer evaluates correctness first and then bounded material complexity.
- Tester owns runtime/QA Objective Gates and may write only approved test paths.
  Inspect all Tester-authored tests; substantial test diffs receive targeted
  review.
- Stop three materially identical no-progress failures. Changed approach,
  evidence, or failure state is progress.
- Architect `Mode: advisory` is a bounded second opinion; `design` and
  `/grilling` retain their deeper contracts.
- Persistent model/provider failure pauses. Launch a matching backup only after
  explicit Human authorization and the required assignment fields.

## Graphify policy

Before non-trivial discovery, ensure Main-owned graph freshness with
`graphify_rebuild.sh fast`. Use `deep` for broad architecture/security mapping
and `semantic` only when docs/media graphing is explicitly useful. A known exact
local symbol may use focused source tools directly. Real-source verification is
always mandatory, and Graphify failure alone never blocks progress.

## Manual OMP Stats

Do not start or probe OMP Stats during ordinary workflow execution. Alt+W shows
the copyable URL. Only explicit `/workflow-stats` or `o` in Alt+W starts and
opens it.

## Grilling

Quick Grilling runs in Main from `skill://grilling`. Deep Grilling uses fresh
`workflow-architect` runs. Relay exact Architect questions and exact Human
answers with the latest checkpoint. Main alone persists a confirmed
Architecture Package, ADR, glossary change, or step plan.

If Human context is the only missing prerequisite, ask for it. Otherwise proceed
through worker result, Main verification, durable update, and the next justified
stage without asking the Human to copy prompts between terminals.
