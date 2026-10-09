# Main Orchestrator — procedure

How Main runs the workflow. The rules themselves (R1–R22) live in
`TEAM_CONTRACT.md`; this file only says how to apply them.

Launch: `bash AI_Workflow_Kit/script/omp_workflow.sh`.

## 1. Read and reconcile

**Full read** at startup/resume, `/workflow status`, Human interrupt, compaction
recovery, and canonical-file hash drift:

1. plan files named in `PROJECT_CONTEXT.md`;
2. `STATE.yaml`, `STEPS.md`, `DECISIONS.md`;
3. current feedback/report files for the active role;
4. repository status, real source, diff, tests, artifacts.

**Targeted reconciliation** for an ordinary transition: active step and IDs,
changed files, gate evidence, changed canonical hashes, and the exact
`agent://` fields needed to verify the result. Escalate to a full read when that
evidence is incomplete (see `CONTEXT_ECONOMY.md`).

At startup and `status`, reconcile `omp.active_agent` with `hub jobs`, `hub list`,
available `agent://` / `history://` artifacts, and the diff. Classify the last
run as active, recovered, interrupted without changes, interrupted with partial
work, or indeterminate. Preserve partial work; runtime disappearance is not a
product attempt (R15).

## 2. Dispatch a worker

Follow the transaction in R8, then:

```bash
python3 AI_Workflow_Kit/script/workflow_route.py coder --step <step> --json
bash AI_Workflow_Kit/script/workflow_models.sh validate-role <agent>
```

For a Coder assignment `<agent>` is the agent the router returned (`workflow-coder-fast` or
`workflow-coder`), so the model that will actually run is the one validated; for every other
role it is that role's agent. The router is the one place where recorded metrics may steer
routing (R21).

The assignment is compact and self-contained: goal and step, stable work-item
ID, `target_files` and exclusions, Coder Objective Gates, Reviewer-owned Judgment
Gates, source-of-truth paths, compact verified retry/interruption facts, and
`fix_round: true|false` (true when fixing Reviewer findings or Tester bugs).
Paste the role block from `WORKER_INPUT_DIGEST.md`; never tell a worker to
re-read TEAM_CONTRACT, KICK_*, or PROJECT_CONTEXT. Coder assignments also carry
`ponytail_mode` (`full` first attempt, `lite` after review/QA findings, `off`
when `repeated_failure_count >= 2`). Dispatch the agent returned by `workflow_route.py`
(`workflow-coder-fast` or `workflow-coder`). A `-backup` assignment (R16) additionally
carries `backup_failover: auto|human` and `failure_evidence` (§7).

**Coder Objective Gates** are the card's command gates without `(close-only)` —
exactly what `workflow_gates.py list --for coder` prints. When writing a card, keep
a step-scoped command gate the Coder runs (build plus the step's own tests, e.g.
`swift build && swift test --filter '<StepTests>'`) and mark the whole-project
suite and other slow project-wide commands `(close-only)`: the close check runs
every gate once on the final tree, so the Coder never repeats it. Never mark every
command gate `(close-only)`.

Right after a Coder/Designer handoff, start the fast graph refresh
(`bash AI_Workflow_Kit/script/graphify_rebuild.sh fast`) in the background together
with the close check rather than before it; dispatch the Reviewer once the refresh
has finished.

| Role | Agent | Use |
|---|---|---|
| Coder | `workflow-coder-fast` or `workflow-coder` | product implementation or verified fix |
| Reviewer | `workflow-reviewer` | read-only Judgment Gates and bounded complexity check |
| Tester | `workflow-tester` | runtime/QA evidence, approved test paths |
| Architect | `workflow-architect` | design uncertainty, plan/code conflict, Grilling, thrash |
| Security | `workflow-security` | evidence-grounded audit (R14) |
| Design Advisor | `workflow-design-advisor` | read-only UI/UX brief (R18) |
| Designer | `workflow-designer` | bounded presentation-layer redesign (R18) |

Every role except the Fast Coder has a `-backup` agent that only starts under R16; the Fast Coder
has none (a Fast Coder failure goes to `workflow-coder`).

## 3. The guard runs by itself

The `workflow-guard` extension works inside every workflow worker (R6): an
edit outside the role's scope, an edit to a workflow file, or a `git` command
that changes repository state is blocked before it runs. The worker gets a
tool error and carries on; nothing changed, nothing to undo. When the worker
finishes, its verdict judges only what the worker itself edited. Your own
commits and edits, the Human's, a parallel OMP session's, and OMP's settings
rewrites are listed as "changed by others meanwhile" and never blamed on the
worker. OMP's own agents (scout, explore, task) are not guarded.

What reaches your context:

| Message | Meaning | Do |
|---|---|---|
| none | clean | continue |
| `WORKFLOW GUARD — note …` | blocked attempts, report-mode findings | continue; if a blocked file is really needed, widen `target_files` with the Human's agreement and re-dispatch |
| `WORKFLOW GUARD — … target_files was empty` | `unscoped` | review the diff; quick close is refused |
| `WORKFLOW GUARD — boundary violation …` | the worker itself changed files outside its scope | R7 |

Files changed while the worker's shell commands ran are listed as
`shell_suspects` in `status` and in the close check; look at them before you
accept a read-only role's result. Manual commands:

```bash
python3 AI_Workflow_Kit/script/workflow_guard.py status --step <step> --all
python3 AI_Workflow_Kit/script/workflow_guard.py resolve --id <id> --note "Human: reverted src/x.ts"
python3 AI_Workflow_Kit/script/workflow_guard.py mode [enforce|report|off] --note "Human: ..."   # Human's call
python3 AI_Workflow_Kit/script/workflow_guard.py snapshot --role coder   # audit a run outside OMP
python3 AI_Workflow_Kit/script/workflow_guard.py verify --whole-repo     # ...judging every change as the worker's
```

Change the guard mode only on the Human's instruction and record it in
`DECISIONS.md`. `report` blocks nothing and lists what `enforce` would have
blocked; `off` disables the boundary guard (backup authorization stays).

## 4. Decide after a Coder or Designer result

```bash
python3 AI_Workflow_Kit/script/workflow_close.py check --json
```

| `decision` | Main does |
|---|---|
| `close_quick` | close the step (R13): check items, record evidence path, checkpoint |
| `review` | persist `waiting_review`, set `pipeline.quick_forbidden` from the output, dispatch Reviewer |
| `reopen_coder` | reopen the failed Objective items, persist verified retry memory, fresh Coder with `objective.failures` (failing lines and full log path). Never re-run the suite by hand to find the failing test: read the log |
| `reject_worker_result` | R7: show the Human the open violation(s), restore or keep the changes as they decide, `resolve` each verdict with their decision, re-run the check |
| `gate_timeout` | Objective gate timed out after Ns — not a Coder failure: re-run the close check with a larger `--timeout`; if it times out again at the raised limit, treat it as a hang and reopen the Coder |

`guard.info` lines (blocked attempts, shell suspects, 3.5.x legacy verdicts)
never change the decision; mention them to the Human when they matter.

If `offer_scoped_security` is true, set `security.next_run: offer_scoped` and ask
the Human once.

## 5. Other results

| Result | Main does |
|---|---|
| Coder `blocked` | record the exact blocker; get context or route Architect/Human |
| Reviewer `approved` | verify review evidence; dispatch the Tester when the close check said `tester.required` (R14); otherwise record the card's skip reason |
| Reviewer `changes_requested` | reopen affected IDs, persist issues, fresh Coder (`ponytail_mode: lite`) |
| Tester `qa_green` | verify commands and test diff; close when every requirement holds |
| Tester `bugs` | persist reproducible bugs; keep the Tester's failing tests as Objective Gates; fresh Coder (`lite`) |
| Architect `advice_ready` / `design_ready` | verify, accept or reject; persist accepted ADR/plan; Main keeps routing |
| Security `findings_open` / `security_clean` | persist the report; route accepted fixes through Coder → Reviewer → Tester |

## 6. Design escalation (R18)

- **Advice:** Human asks for direction → `workflow-design-advisor` (read-only) →
  Main checks the brief is specific → ordinary Coder implements → Reviewer →
  Tester → Human visual acceptance when required.
- **Direct redesign:** Human authorizes edits → Main confirms presentation-layer
  `target_files` and a preserve-list → `workflow-designer` → Main verifies diff
  and captures → Reviewer → Tester → Human records
  `visual acceptance: accepted | changes_requested`.

Every design assignment carries the Human's feedback verbatim, target surface,
preserve-list, exact files, visual evidence or reproduction command, observable
acceptance, and Objective Gates. If advice versus direct editing is unclear,
ask one short question instead of choosing the expensive path. Templates:
`KICK_DESIGNER.md`, details: `DESIGNER.md`.

## 7. Model failure (R16)

On a primary worker model/provider failure (provider error, quota/429/402, DNS/network, provider timeout, empty/aborted result caused by the provider — NOT `blocked`, gate failures, or review findings), provider failures are not product attempts (R15). Then:

- **Fast Coder:** it has no backup. Record metrics `model_failure` (`status: auto_failover`) and dispatch `workflow-coder` with a fresh context, without pausing the Human. If `workflow-coder` also fails for a model/provider reason, apply the backup rule below to it.
- **Every other role:** Main immediately records `omp.model_failure` with `status: backup_authorized`, `authorized_by: auto`, `role`, `primary_agent`, `failed_model`, `backup_agent`, `evidence`, `authorized_at`, records metrics `model_failure` with `status: auto_failover`, and dispatches the `-backup` agent with a fresh context. The backup must resolve to a model distinct from the failed primary.
- **Backup assignment:** build it like any assignment (§2) and add `backup_failover: auto` plus `failure_evidence` (the recorded primary failure: failed model, provider error excerpt, `authorized_at`). A backup the Human directed by hand (after `awaiting_human`) is dispatched with `backup_failover: human` and `failure_evidence` carrying the Human's exact words (`omp.model_failure.human_instruction`) next to the recorded failure. A backup agent returns `blocked` without either field.
- **Ask the Human only when** (a) the role's backup is missing or resolves to the same model as the primary, or (b) the backup run also fails for a model/provider reason → `status: awaiting_human`.

After the backup (or the escalated `workflow-coder`) run finishes (success or product result), Main clears `omp.model_failure`.

Main's own outage: switch live to `@workflow_orchestrator_backup` (Alt+Q) and run `/workflow status`.

## 8. Checkpoints and metrics

Only Main checkpoints (`GIT_CHECKPOINTS.md`), staging exactly the authorized
product/test paths plus the workflow files changed for the verified transition.
Rollback is destructive and needs the Human's explicit confirmation
(`WF_CONFIRM_ROLLBACK=<tag>`). Passive metrics are recorded after verified
transitions (`METRICS.md`); they never steer routing or gates (R21). The one
exception is the deterministic Fast Coder health window in `workflow_route.py`.

## 9. Human controls

`Alt+A` Agent Hub · `Alt+W` read-only dashboard · `Alt+M` model roles ·
`/workflow why` routing reason · `/workflow designer advise|redesign <surface>`.
After any intervention, re-read (R22).
