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
bash AI_Workflow_Kit/script/workflow_models.sh validate-role <role>
```

The assignment is compact and self-contained: goal and step, stable work-item
ID, `target_files` and exclusions, Objective Gates, Reviewer-owned Judgment
Gates, source-of-truth paths, and compact verified retry/interruption facts.
Paste the role block from `WORKER_INPUT_DIGEST.md`; never tell a worker to
re-read TEAM_CONTRACT, KICK_*, or PROJECT_CONTEXT. Coder assignments also carry
`ponytail_mode` (`full` first attempt, `lite` after review/QA findings, `off`
when `repeated_failure_count >= 2`).

| Role | Agent | Use |
|---|---|---|
| Coder | `workflow-coder` | product implementation or verified fix |
| Reviewer | `workflow-reviewer` | read-only Judgment Gates and bounded complexity check |
| Tester | `workflow-tester` | runtime/QA evidence, approved test paths |
| Architect | `workflow-architect` | design uncertainty, plan/code conflict, Grilling, thrash |
| Security | `workflow-security` | evidence-grounded audit (R14) |
| Design Advisor | `workflow-design-advisor` | read-only UI/UX brief (R18) |
| Designer | `workflow-designer` | bounded presentation-layer redesign (R18) |

Every role has a `-backup` agent that only starts under R16.

## 3. The guard runs by itself

The `workflow-guard` extension snapshots the repository before every worker
spawn and verifies it when the worker finishes (R6). A clean verdict is silent.
A `violation` or `unscoped` verdict arrives in Main's context as a
`WORKFLOW GUARD` message — act on it before routing (R7). Manual equivalents:

```bash
python3 AI_Workflow_Kit/script/workflow_guard.py status --step <step> --all
python3 AI_Workflow_Kit/script/workflow_guard.py resolve --id <id> --note "Human: reverted src/x.ts"
python3 AI_Workflow_Kit/script/workflow_guard.py snapshot --role coder   # before a manual run
python3 AI_Workflow_Kit/script/workflow_guard.py verify                  # after it
```

## 4. Decide after a Coder or Designer result

```bash
python3 AI_Workflow_Kit/script/workflow_close.py check --json
```

| `decision` | Main does |
|---|---|
| `close_quick` | close the step (R13): check items, record evidence path, checkpoint |
| `review` | persist `waiting_review`, set `pipeline.quick_forbidden` from the output, dispatch Reviewer |
| `reopen_coder` | reopen the failed Objective items, persist verified retry memory, fresh Coder |
| `reject_worker_result` | R7: show the Human the open violation(s), restore or keep the changes as they decide, `resolve` each verdict with their decision, re-run the check |

If `offer_scoped_security` is true, set `security.next_run: offer_scoped` and ask
the Human once.

## 5. Other results

| Result | Main does |
|---|---|
| Coder `blocked` | record the exact blocker; get context or route Architect/Human |
| Reviewer `approved` | verify review evidence; dispatch Tester unless QA was skipped |
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

Persistent provider/model failure pauses routing without counting an attempt.
Record under `omp.model_failure`: `status: awaiting_human`, `role`,
`primary_agent`, `failed_model`, `evidence`. After the Human authorizes the
backup, set `status: backup_authorized`, `backup_agent`, `human_instruction`
(exact words), `authorized_at` — the spawn hook refuses the backup otherwise.
Include `human_backup_authorization: true` and the instruction in the
assignment. Main's own outage: switch live to `@workflow_orchestrator_backup`
(Alt+Q) and run `/workflow status`.

## 8. Checkpoints and metrics

Only Main checkpoints (`GIT_CHECKPOINTS.md`), staging exactly the authorized
product/test paths plus the workflow files changed for the verified transition.
Rollback is destructive and needs the Human's explicit confirmation
(`WF_CONFIRM_ROLLBACK=<tag>`). Passive metrics are recorded after verified
transitions (`METRICS.md`); they never steer routing (R21).

## 9. Human controls

`Alt+A` Agent Hub · `Alt+W` read-only dashboard · `Alt+M` model roles ·
`/workflow why` routing reason · `/workflow designer advise|redesign <surface>`.
After any intervention, re-read (R22).
