# Passive Workflow Metrics

> Metrics observe the workflow. Metrics never control the workflow — except the deterministic Fast Coder
> health window that `workflow_route.py` computes from recorded Fast Coder attempts (R21).

This is the canonical telemetry contract for Main and the shared aggregation
helper. Apart from that window it does not change routing, Retry Memory, Objective/Judgment Gates,
Grilling, checkpoints, model failover, or `maxConcurrency: 1`.

## Storage and runtime

The helper uses Python's standard library only. Python is already a prerequisite
of the required Graphify installation; no telemetry dependency is added.

Default event path:

```text
<git-common-dir>/pavans-workflow/metrics/events.jsonl
```

`git rev-parse --git-common-dir` resolves the directory, so linked worktrees and
nonstandard Git layouts share the correct repository-local store. The companion
start metadata is `events.jsonl.meta.json`. Both paths live inside Git's private
administrative directory and cannot be staged or committed. No `.gitignore`
entry is required.

`PAVAN_WORKFLOW_METRICS_PATH` may override the event file for tests or special
installations. The helper rejects an override inside the worktree unless it is
also inside Git's common directory. An external absolute path is allowed.

Metrics start cleanly when the first event is recorded. There is no historical
backfill from `STATE.yaml`, `FEEDBACK.md`, Git history, transcripts, or reports.
Reset requires the recognized companion metadata marker, deletes only those two
telemetry files, and restarts collection.

## Event schema

The store is append-only JSON Lines: one object per line. Main supplies a stable
`event_key`; the helper supplies UTC `ts` and `schema_version`.

```json
{"schema_version":1,"ts":"2026-08-10T18:00:00.000Z","event":"worker_started","event_key":"worker_started:coder-S3-01","step":"S3","run_id":"coder-S3-01","candidate_id":"coder-S3-01","role":"coder","attempt":1,"model_role":"workflow_coder","provider":"openai-codex","model":"gpt-5.6-luna"}
```

Fields are present only when applicable:

- identity: `step`, `run_id`, `candidate_id`, `role` (`coder`, `coder_fast`, `reviewer`, `tester`, `architect`, `security`), `attempt`;
- outcome: `result`, `review_kind`, `gate`, `classification`, `status`;
- failure: `failure_category`, `detected_by`, `repeat_count`, `threshold`;
- model sample: `model_role`, `provider`, `model`;
- bounded evidence pointer: `evidence_ref`;
- optional Human assessment: `human_rating`;
- pipeline: `pipeline_profile` (`quick`, `standard`, `critical`);
- optional token count: `tokens` (OMP-reported usage for that worker/step, never a USD estimate).

Supported event types:

| Event | Meaning |
|-------|---------|
| `step_started` | Main opened a product step in canonical state |
| `step_completed` | Main verified the full Stop-gate and closed the step |
| `worker_started` | OMP accepted an actual specialized-worker dispatch |
| `worker_result` | Main verified a worker result against source/evidence |
| `failure` | Main verified a product/workflow failure and its taxonomy |
| `runtime_interruption` | Main completed startup/resume interruption classification |
| `model_failure` | Main persisted a real model/provider blocker (`status: awaiting_human` or `auto_failover`) |
| `gate_skipped` | Human explicitly skipped Reviewer, QA, or Security, or the close check skipped QA for a card's R14 reason (`tester.skip_reason`) |
| `retry_safeguard_triggered` | The existing no-progress threshold was reached |
| `human_turn` | A Human message reached Main while a step was current (recorded by the `workflow-main-attribution` extension, not by Main) |
| `orchestrator_model` | The model Main ran for a step, first seen or changed (same extension) |
| `human_rating` | Optional `good`, `overkill`, or `underchecked` rating |

Architect `worker_started` records `mode: advisory`, `design`, or `grilling`.
When `--model` is not provided on `worker_started`, `model_role` defaults to `workflow_<role>` (or `workflow_<role>_backup`) and `model` auto-fills from `.omp/config.yml` `modelRoles` (resolving `@alias` chains up to depth 5 and stripping `:thinking`).
Reviewer `worker_result` records `review_kind: product` or `test_diff`. Every
product Reviewer/Tester result carries the candidate's Coder/Fast Coder `run_id` as
`candidate_id`; that stable link is what makes QA-escape calculation honest.
The report includes a `fast_coder` breakdown by model (attempts, resolved, first-pass success, pending).
### Stable keys

Use these deterministic forms:

```text
step_started:<step>
step_completed:<step>
worker_started:<run_id>
worker_result:<run_id>
failure:<step>:<candidate_id-or-run_id>:<detected_by>:<failure_category>
runtime_interruption:<run_id>:<classification>
model_failure:<run_id>
gate_skipped:<step>:<gate>
retry_safeguard:<step>:<failure-signature-id>
```

Same key plus the same semantic payload is a no-op even when the retry generated
a later timestamp. Same key plus a conflicting payload emits a warning and
preserves the first record. Main does not invent a replacement key to hide a
conflict.

## Privacy and minimization

The writer uses an allowlist; arbitrary JSON is not accepted. It never records:

- Human prompts or Main/worker conversation transcripts (`human_turn` is only a step id and a model id);
- chain-of-thought or worker reasoning;
- source code, Git diffs, command stdout/stderr, or full provider errors;
- API keys, access tokens, credentials, secrets, or personal content;
- report bodies or retry-memory prose.

Detailed evidence remains in canonical workflow files. Metrics stores only a
bounded `evidence_ref`, such as `AI_Workflow_Kit/docs/AI/FEEDBACK.md`.

## Main instrumentation

Only Main records telemetry. Workers are not told where the store is and their
role/output contracts remain unchanged. At each transition, Main first performs
the existing repository/source/evidence verification, then runs the matching
observer command. A warning or missing helper never changes the state update or
next actor.

| Existing Main transition | Event recorded after the transition is real |
|--------------------------|----------------------------------------------|
| Open a step in `STATE.yaml` | `step_started` |
| `task` accepts a worker and returns its run/agent id | `worker_started` |
| Verify a structured worker result | `worker_result` |
| Verify Reviewer/Tester/Main/Architect product failure | `failure` |
| Classify a disappeared/killed worker on resume | `runtime_interruption` |
| Persist `omp.model_failure.status: awaiting_human` | `model_failure` |
| Persist explicit Human gate opt-out, or a QA skip the close check reported (`tester.required: false`) | `gate_skipped` |
| Existing retry safeguard reaches its threshold | `retry_safeguard_triggered` |
| Verify Reviewer + enabled QA Stop-gate and close step | `step_completed` |

Do not emit `worker_started` for a task that OMP never accepted. Do not emit
`worker_result` for runtime disappearance or launch failure. A recovered result
is recorded only after normal Main verification. `interrupted_no_changes`,
`interrupted_partial`, and `indeterminate` are runtime events, not automatic
implementation failures.

Examples:

```bash
bash AI_Workflow_Kit/script/workflow_metrics.sh record step_started \
  --event-key step_started:S3 --step S3 --pipeline-profile standard

bash AI_Workflow_Kit/script/workflow_metrics.sh record worker_started \
  --event-key worker_started:coder-S3-01 --step S3 \
  --run-id coder-S3-01 --candidate-id coder-S3-01 --role coder --attempt 1 \
  --model-role workflow_coder --provider openai-codex --model gpt-5.6-luna

bash AI_Workflow_Kit/script/workflow_metrics.sh record worker_result \
  --event-key worker_result:reviewer-S3-01 --step S3 \
  --run-id reviewer-S3-01 --candidate-id coder-S3-01 --role reviewer \
  --result changes_requested --review-kind product \
  --evidence-ref AI_Workflow_Kit/docs/AI/FEEDBACK.md

bash AI_Workflow_Kit/script/workflow_metrics.sh record failure \
  --event-key failure:S3:coder-S3-01:reviewer:scope_violation --step S3 \
  --candidate-id coder-S3-01 --failure-category scope_violation \
  --detected-by reviewer --evidence-ref AI_Workflow_Kit/docs/AI/FEEDBACK.md
```

When OMP exposes the actual resolved provider/model, record it. Otherwise omit
those fields; never guess. Model rows with fewer than five runs are labeled
`small sample` and are descriptive only.

## Metric definitions

All counts use unique valid events after `event_key` deduplication.

- **Completed steps**: unique `step_completed.step` values.
- **Completed product steps**: completed steps with at least one verified Coder
  `worker_result`.
- **First-pass step success**: completed product steps with exactly one unique
  Coder result, no product Reviewer `changes_requested`, and no Tester `bugs`,
  divided by completed product steps. Explicitly skipped gates do not by
  themselves make the step non-first-pass.
- **Average Coder attempts**: unique verified Coder result runs on completed
  product steps divided by completed product steps. Runtime interruptions and
  model launch failures without a verified Coder result are excluded.
- **Reviewer rejection rate**: product-review `changes_requested` divided by
  product-review `approved + changes_requested`. `review_kind: test_diff` is
  excluded.
- **QA escape rate**: Reviewer-approved candidate IDs that later receive Tester
  `bugs`, divided by Reviewer-approved candidate IDs actually sent to Tester.
  QA-skipped candidates are excluded.
- **Architect escalation rate**: completed product steps with Architect mode
  `design` or `grilling`, divided by completed product steps.
- **Advisor usage**: completed product steps with Architect mode `advisory`,
  divided by completed product steps.
- **Repeated-failure incidents**: unique `retry_safeguard_triggered` events.
- **Runtime interruption rate**: `runtime_interruption` events divided by actual
  `worker_started` runs.
- **Model failure rate**: `model_failure` runs divided by the union of actual
  worker-start run IDs and model-failure run IDs.
- **Step duration**: median elapsed UTC time from `step_started` to
  `step_completed` for paired steps.
- **Worker duration**: median elapsed UTC time from `worker_started` to the first
  matching `worker_result`, `runtime_interruption`, or `model_failure`; also
  grouped by role.
- **Failure categories**: count of the bounded `failure_category` enum:
  `missed_requirement`, `incorrect_implementation`, `scope_violation`,
  `architecture_mismatch`, `objective_gate_failure`, `regression`,
  `ambiguous_requirement`, `other`.
- **Detected by**: failure counts for `main`, `reviewer`, `tester`, `architect`.

Human rating is a separate count using the latest recorded rating per step and
never affects success/failure formulas. There is no quality score, cost estimator,
or AI classifier; model ranking is only the per-role leaderboard below.

**By pipeline profile.** Events may carry `pipeline_profile`. Aggregation groups
completed steps, Coder attempts/retries, Reviewer `changes_requested`, Tester
`bugs`, median step duration, and summed `tokens` (or `n/a` when no token
fields were recorded) under `quick`, `standard`, `critical`, and `unlabeled`.
Main should pass `--pipeline-profile` on `step_started` / worker events and
`--tokens` when OMP exposes a usage number. Do not convert tokens to currency.

## Commands

From Main:

```text
/workflow metrics
/workflow metrics rate good
/workflow metrics rate overkill S3
/workflow metrics rate underchecked
/workflow metrics reset
```

Direct deterministic interfaces:

```bash
bash AI_Workflow_Kit/script/workflow_metrics.sh report
bash AI_Workflow_Kit/script/workflow_metrics.sh report --json
bash AI_Workflow_Kit/script/workflow_metrics.sh report --scope all
bash AI_Workflow_Kit/script/workflow_metrics.sh validate
bash AI_Workflow_Kit/script/workflow_metrics.sh reset --yes
bash AI_Workflow_Kit/script/workflow_metrics.sh self-check
bash AI_Workflow_Kit/script/workflow_metrics.sh selftest
```

`/workflow metrics` is read-only and returns the aggregated report (this project) without
changing `STATE.yaml` or routing product work. Reset deletes only the event file
and its companion metrics-start metadata; it does not touch workflow documents.
Alt+W reads the same JSON aggregation with a 15-second cache and renders the
canonical per-step and team summaries. The dashboard also has a separate,
in-memory `THIS OMP SESSION` token counter. It is not a canonical workflow
metric and is never written to this event store.

Main usage comes from persisted/live OMP assistant messages; worker usage comes
from OMP task progress. Both use OMP's displayed-consumption formula:
`input + output + cacheWrite`; cumulative worker progress is converted to
deltas so refreshes do not double-count. `cacheRead` is intentionally excluded
because repeated cached context would make a misleading work-done total.
Counters reset when the live Main session changes, group by the exact resolved
provider/model, include Main and every worker role, and are presented without
scores, rankings, cost estimates, or external telemetry.

## Model leaderboard

`report` carries a `leaderboard` section: one table per role, one row per model,
reusing the definitions above (no second formula). A model is `provider/id` with
the effort suffix (`:high`, ...) stripped, so one model is one row at every
effort. Workers whose model was not recorded appear as `unknown`.

| Role | Primary metric (ranked) | Also shown |
|------|-------------------------|------------|
| Orchestrator (Main) | Human messages per completed step, lower is better | Coder retries/step, `missed_requirement` failures/step, median step duration, Human ratings |
| Coder, Fast Coder | First-review approval: product Reviews of that model's candidates that were `approved` ÷ reviewed candidates (per role: each role counts only its own candidates) | runs, median duration, tokens/run, model-failure rate; Fast Coder also first-pass success |
| Reviewer | QA escape rate of its approvals, lower is better | runs, median duration, tokens/run, model-failure rate |
| Tester | not ranked (no ground truth) | bugs-found rate, runs, median duration, tokens/run, model-failure rate |
| Architect, Security | not ranked | runs, median duration, tokens/run, model-failure rate |

- A model needs **5 primary-metric samples** to be ranked; below that it is shown
  with `n` and `low sample`, unranked. Unranked roles list models by run count.
- Runs are attributed to the model recorded on their `worker_started` (the
  `model_failure` event's model when the start has none).
- **Main attribution.** Main cannot report its own model through bash, so the
  `workflow-main-attribution` extension records it. On each Human message
  (interactive input; OMP UI commands such as `/model`, `/clear` and `!` shell
  lines are ignored, `/workflow ...` counts) it records `human_turn`
  (`step`, `model`), and on each agent start `orchestrator_model` (`step`,
  `model`; once per step and model) on every agent start and every model turn,
  so a step opened or a model switched inside one prompt's loop is still seen.
  Event keys are bounded and collision-free: `orchestrator_model:<step>:<24-hex digest of
  step+model>` and `human_turn:<step>:<ms>:<seq>` (a step longer than 100
  characters is shortened to a prefix plus a digest of the whole id). The
  extension counts an event as recorded only when the recorder prints its
  `metrics recorded|duplicate_noop` acknowledgement (the recorder itself always exits 0), and
  retries on the next observation otherwise. `step` is `STATE.yaml`'s
  `current_step`; with no current step nothing is recorded. Only the top-level
  Main session records; workers never do. Neither event carries prompt text,
  and a failing recorder is silent and never delays or alters Human input.
- A completed step belongs to a Main model only when exactly one Main model
  was recorded for it. Steps that saw several Main models are counted as
  `mixed` and excluded; steps with no attribution as `unattributed`. Both
  counts are printed.
- Not a quality score or composite: every number is a count over recorded events
  with its sample size, and Human ratings stay a separate count.

### Cross-project scope

Every successful `record` upserts the project into a user-level registry,
`$XDG_STATE_HOME/pavans-workflow/projects.json` (default
`~/.local/state/pavans-workflow/projects.json`): `name`, `root`, and the absolute
path of the project's event store. That path is the only thing stored globally;
events stay in each repository's private Git directory.

```bash
bash AI_Workflow_Kit/script/workflow_metrics.sh report                 # this project (default)
bash AI_Workflow_Kit/script/workflow_metrics.sh report --scope all     # every registered project, read-only
bash AI_Workflow_Kit/script/workflow_metrics.sh report --scope all --json
```

The registry upsert holds an inter-process lock across read, merge and atomic
replace, so concurrent first records never drop a registration. `--scope all`
reads each registered store without modifying it, namespaces step, run,
candidate and event ids per project with a digest of the store path (not the
display name, which is only made unique for the report) so the same `S1` in two
repositories never collides, and merges them into one report. A store whose
events have wrong-typed fields counts them as malformed lines: they are skipped with
a warning, and the store is skipped (with a printed note) only when no valid events remain.
Missing or unreadable stores and an unreadable registry are skipped with a printed note. Projects
register on their first successful record after updating; there is no backfill.
The Alt+W dashboard shows a one-line-per-role leaderboard summary in the health
column and the full tables under `l`; it uses this same `--scope all` report.

## Reliability

- Record-time storage, permission, parser, or runtime failures print a concise
  warning and exit without blocking workflow routing.
- Reports skip malformed JSONL lines, warn with line numbers, and aggregate the
  remaining valid events.
- Unknown event types and additional future fields are ignored safely. A higher
  schema version is counted for visibility but does not crash aggregation.
- `validate --strict` may fail for maintenance/diagnostics; normal reporting and
  product workflow remain available.
- `selftest` uses temporary stores only and covers first pass, Reviewer catch,
  QA escape, both gate skips, runtime/model isolation, advisory/deep Architect,
  targeted test-diff review, duplicate keys, and malformed trailing JSONL.
