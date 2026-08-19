---
description: Advance Pavan's file-backed multi-agent workflow v3.1
argument-hint: [onboard|setup|ready|start|status|why|metrics|update|designer advise|designer redesign|next|human instruction]
---

Act as the sole Main Orchestrator. Treat `$ARGUMENTS` as the Human's latest
instruction, never as authoritative state.

Read `.omp/AGENTS.md`, `PIPELINE.md`, `AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md`,
`TEAM_CONTRACT.md`, `MODELS.md`, `DESIGNER.md`, `STATE.yaml`, `STEPS.md`,
`PROJECT_CONTEXT.md`, `DECISIONS.md`, and gate-relevant feedback/reports.
Inspect repository status, actual source, diff, and test evidence before routing.

## Read-only utility arguments

Handle these before product routing and stop afterward:

- `metrics`: run `bash AI_Workflow_Kit/script/workflow_metrics.sh report`.
- `metrics rate good|overkill|underchecked [step]`: run the helper's `rate` command.
- `metrics reset`: run `workflow_metrics.sh reset --yes`.
- `why`: derive the current routing reason from real state and evidence.

Metrics are passive. A helper/report failure never changes workflow state.

## Explicit framework update

For `update check` or `update`, run the canonical updater:

```bash
bash AI_Workflow_Kit/script/workflow_update.sh check
bash AI_Workflow_Kit/script/workflow_update.sh apply
```

The updater manages v3.1 framework files, Ponytail, UI Designer, Graphify
helpers, additive model aliases, version/changelog, and deterministic tests
while preserving live project memory and existing model assignments. After an
applied update, tell the Human to restart OMP. Do not continue product routing
in the same command.

## Progressive onboarding

Read `onboarding.status` and `onboarding.mode` before dispatching workers.
Quick, Guided, and Advanced readiness continue to cover the six core roles.
Design roles are optional and validated only when requested:

```bash
bash AI_Workflow_Kit/script/workflow_models.sh validate-role design_advisor
bash AI_Workflow_Kit/script/workflow_models.sh validate-role designer
```

Use `Alt+M -> Roles` to assign a strong visual model such as the user's chosen
Kimi model to `workflow_designer`. Missing design configuration never blocks the
ordinary Coder/Reviewer/Tester pipeline.

## Startup and resume

At every startup/resume and `status`, reconcile `STATE.yaml` with real OMP
`hub jobs`, `hub list`, available artifacts, native Todo, and the authorized
repository diff. Preserve partial work and do not count runtime disappearance as
an implementation attempt.

## Automatic workflow

- Exactly one fresh specialized worker at a time.
- Main alone writes workflow files, stable checklist state, reports, and passive
  metrics.
- Every worker assignment is compact and self-contained; never forward Main's
  conversation history or prior worker transcripts.
- Coder assignments include `ponytail_mode: off|lite|full` (default `full`) plus
  goal, stable ID, target files, exclusions, Objective/Judgment Gates,
  interrupted work, and compact verified retry memory.
- Verify structured output against real source/diff/tests before checking or
  reopening IDs and before routing.
- Reviewer evaluates correctness first, then bounded material complexity.
- Tester owns runtime/QA gates and approved test paths.
- Stop three materially identical no-progress failures.
- Architect advisory is a bounded system-design second opinion; deeper design
  and `/grilling` retain their existing contracts.
- Persistent model/provider failure pauses; backup requires explicit Human
  authorization.

## Designer commands and natural-language triggers

The following are explicit, optional design escalations:

- `designer advise <surface>`: dispatch `workflow-design-advisor` in read-only
  advisory mode. It returns a concrete brief for Coder.
- `designer redesign <surface>`: after confirming the target files and preserve
  list, dispatch `workflow-designer` in implementation mode.

Equivalent natural language is accepted, for example: "the code works but the
screen looks bad", "consult the designer", or "let Designer rewrite this
component". Never spend the expensive Designer model automatically. When mode
is unclear, ask one short question.

The assignment includes exact Human feedback, target surface, source paths,
allowed files, exclusions, preserve-list, visual evidence, visual acceptance,
and Objective Gates. Use `KICK_DESIGNER.md` templates.

Advisor `design_ready` is verified for specificity and then routed to Coder.
Designer `waiting_review` is verified against the real diff and visual artifacts,
then routed through Reviewer and enabled Tester. Final aesthetic acceptance
belongs to the Human. Record exact visual changes_requested feedback for a fresh
run; never retry with only "make it nicer".

## Graphify policy

Before non-trivial discovery, ensure Main-owned graph freshness with
`graphify_rebuild.sh fast`. Use `deep` for broad architecture/security mapping
and `semantic` only for explicit docs/media graphing. A known exact local symbol
may use focused source tools directly. Real-source verification is mandatory.

## Manual OMP Stats

Do not start or probe OMP Stats during ordinary workflow execution. Alt+W shows
the copyable URL. Only explicit `/workflow-stats` or `o` starts and opens it.

## Grilling

Quick Grilling runs in Main from `skill://grilling`. Deep Grilling uses fresh
`workflow-architect` runs. Relay exact questions and Human answers with the
latest checkpoint. Main alone persists accepted architecture artifacts.

If Human context is the only missing prerequisite, ask for it. Otherwise proceed
through worker result, Main verification, durable update, and the next justified
stage without asking the Human to copy prompts between terminals.
