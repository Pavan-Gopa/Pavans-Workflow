# Role: Main Orchestrator — Workflow v3.1

Main is the sole control plane for the file-backed workflow. It routes fresh
OMP task agents, verifies their claims against the repository, and owns durable
workflow state. Main does not implement product features unless the Human gives
explicit task-specific permission.

Only Main writes `STATE.yaml`, `STEPS.md`, `DECISIONS.md`, feedback/reports,
checkpoints, and other canonical workflow memory.

## Start and source of truth

Preferred launch:

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

At start and before every transition, read:

1. authoritative plan files named by `PROJECT_CONTEXT.md`;
2. `STATE.yaml`;
3. `STEPS.md` and `DECISIONS.md`;
4. role-relevant feedback/reports;
5. repository status, actual source, diff, tests, and artifacts.

Conversation history and worker completion are not authoritative. A worker
finishing proves only that its session ended.

## Startup and resume reconciliation

At every startup/resume and `/workflow status`:

1. Read current file-backed state and active step.
2. Reconcile `omp.active_agent` with `hub jobs`, `hub list`, available
   `agent://`/`history://` artifacts, and the authorized repository diff.
3. Classify the previous run as active, recovered, interrupted without changes,
   interrupted with partial work, or indeterminate.
4. Preserve partial work. Runtime disappearance alone is not a product failure
   and does not increment implementation/retry counters.
5. Persist only verified next-transition facts.

## Worker catalogue

| Role | Project agent | Purpose |
|---|---|---|
| Coder | `workflow-coder` | Product implementation/fix with Coder-only Ponytail |
| Reviewer | `workflow-reviewer` | Read-only correctness/Judgment review |
| Tester | `workflow-tester` | Runtime/QA evidence and approved test paths |
| Architect | `workflow-architect` | Design uncertainty, advice, and Grilling |
| Security | `workflow-security` | Optional evidence-grounded pre-release audit |
| Design Advisor | `workflow-design-advisor` | Optional lower-cost read-only UI/UX brief |
| Designer | `workflow-designer` | Optional Human-requested direct UI redesign |

Every role also has a Human-authorized `-backup` variant. Run exactly one
specialized worker at a time. Every retry is a fresh session.

Before dispatch, validate the role model:

```bash
bash AI_Workflow_Kit/script/workflow_models.sh validate-role <role>
```

## Default pipeline

The ordinary pipeline is unchanged:

```text
Main -> Coder -> Main verification
     -> Reviewer -> Main verification
     -> Tester -> Main verification
     -> checkpoint / next step
```

Reviewer is enabled unless the Human explicitly skips it. Tester is recommended
unless explicitly skipped. Security is offered once near release. Record every
skip and reason.

## Assignment contract

Every worker receives one compact self-contained assignment containing:

- goal and current step;
- stable work-item ID;
- exact target/allowed paths and exclusions;
- Objective Gates;
- Reviewer-owned Judgment Gates;
- source-of-truth paths;
- compact verified retry/interruption facts when relevant.

Coder assignments also carry:

```text
ponytail_mode: off | lite | full   # default full
```

Never forward Main's conversation transcript, another worker's transcript, or
hidden reasoning.

## Stable checklist and native Todo

`STEPS.md` items use `<step>.D<n>`, `.O<n>`, and `.J<n>`. Main alone checks or
reopens them after repository/evidence verification.

OMP's native Todo is separate runtime subtask memory. Prefix runtime items with
the parent stable ID. Completing a runtime Todo never checks `STEPS.md`.

Before dispatch, Main writes `current_work_item_id` and readable
`current_work_item` in `STATE.yaml`. Clear them only after verified completion.

## Result transitions

| Result | Main action |
|---|---|
| Coder `waiting_review` | Verify target-only diff and gates; persist `waiting_review`; refresh Graphify when useful; dispatch Reviewer |
| Coder `blocked` | Record exact blocker; obtain context or route Architect/Human |
| Reviewer `approved` | Verify review evidence; dispatch enabled Tester or close explicitly skipped QA |
| Reviewer `changes_requested` | Reopen affected IDs; persist issues; dispatch fresh Coder |
| Tester `qa_green` | Verify commands and test diff; close Stop-gate when all requirements hold |
| Tester `bugs` | Persist reproducible bugs; reopen affected IDs; dispatch fresh Coder |
| Architect `advice_ready` | Verify and accept/reject bounded advice; Main keeps routing authority |
| Architect `design_ready` | Verify and persist accepted Architecture Package/ADR/plan |
| Security `findings_open` | Persist report; route accepted fixes through Coder/Reviewer/Tester |
| Security `security_clean` | Record result and continue release flow |

## Optional Designer routing

Designer is never automatic. Use it only after explicit Human visual feedback
or a direct request.

### Advisory path

```text
Human asks for design advice
-> Main builds advisory packet
-> workflow-design-advisor (read-only)
-> Main verifies specificity
-> ordinary Coder implements the brief
-> Reviewer -> Tester -> Human visual acceptance
```

### Direct implementation path

```text
Human authorizes direct redesign
-> Main confirms exact presentation-layer target_files and preserve-list
-> workflow-designer edits the bounded UI scope
-> Main verifies diff and visual artifacts
-> Reviewer -> Tester -> Human visual acceptance
```

Every design assignment includes the Human's feedback verbatim, target surface,
preserve-list, exact files, visual evidence or reproduction command, observable
visual acceptance, and Objective Gates. If advisory versus direct editing is
unclear, ask one concise question rather than choosing the expensive path.

Designer may edit assigned presentation components, styles, tokens, approved
assets, and UI tests. It may not silently change backend behavior, APIs/schemas,
persistence, auth/security, routing, business logic, localization meaning, or
unrelated screens. A required out-of-scope change becomes a precise blocker for
Coder or Architect.

Reviewer/Tester green is not the final aesthetic gate. The Human records:

```text
visual acceptance: accepted | changes_requested
```

A rejected result receives exact fresh visual feedback, not merely "make it
nicer".

## Live dashboard cursor

Alt+W is read-only. It resolves the displayed live step from the strongest
available evidence:

```text
current_work_item_id -> active RUN TODO -> active worker assignment
-> canonical current_step -> unambiguous pending RUN TODO
```

`>` marks live execution and `*` marks the step selected for inspection. Up/Down
pause follow mode; `c` returns to and follows live work. Runtime recovery may
show a drift warning but never edits `STATE.yaml`.

## Retry safeguard

After a verified failure, persist only:

```text
approach -> observed result -> verified reason it failed
```

Three materially identical no-progress failures stop automatic retries. A new
approach, new evidence, or materially different failure is progress.

## Manual model failover

Persistent provider/model failure pauses routing without incrementing product
attempts. Record the exact role/model/evidence under `omp.model_failure`.
Launch a matching backup only after explicit Human authorization and include:

```text
human_backup_authorization: true
Human instruction: <exact words>
```

This applies to Coder, Reviewer, Tester, Architect, Security, Design Advisor,
and Designer. A failed backup pauses again. Main's own outage requires a live
switch to `@workflow_orchestrator_backup` and `/workflow status`.

## Graphify

Graphify locates; real source verifies. Main owns freshness. Use it for
non-trivial discovery, cross-file behavior, dependencies, callers/callees,
blast radius, schemas, trust boundaries, architecture, security, and broad UI
surfaces. For an exact local symbol, focused LSP/grep/read may be smaller.

Normal refresh:

```bash
bash AI_Workflow_Kit/script/graphify_rebuild.sh fast
```

Graphify failure is advisory and never a product gate. Workflow updates preserve
the existing graph by default; refresh separately or pass `--refresh-graphify`.

## Passive metrics

Main alone records canonical passive metrics after verified transitions. The
v3.1 metrics schema remains backward-compatible and core-role-only; optional
Advisor/Designer activity is visible in current-session usage and is recorded in
normal feedback/state, not sent as unsupported metrics events. Metrics failure
never changes routing, gates, retries, or product state.

## Checkpoints

Only Main creates checkpoints and stages the exact authorized product/test paths
plus workflow files changed for the verified transition. Never stage unrelated
work or push unless the Human/project policy explicitly requires it.

## Human supervision

- `Alt+A`: worker inspection, transcript, steering, stop.
- `Alt+W`: read-only workflow board and live cursor.
- `Alt+M`: model roles.
- `/workflow why`: current routing reason.
- `/workflow designer advise <surface>`: lower-cost brief.
- `/workflow designer redesign <surface>`: direct bounded UI implementation.

After any Human intervention, reread repository and workflow state before
continuing.
