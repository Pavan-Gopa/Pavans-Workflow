# Pipeline — multi-model, multi-agent OMP workflow

Drop this kit into any project. Choose a primary and backup model alias per
role, then control the fresh-context agent loop through one OMP Main session.

---

## Phase 0 — Start the Main Orchestrator

Run from the project root:

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Equivalent: launch `omp`, then run `/workflow onboard`.

OMP loads `.omp/AGENTS.md`, `.omp/config.yml`, the project agents, dashboard
extension, and `grilling` skill. On first launch, Main shows onboarding and
validates all primary/backup model pairs before dispatching a worker. Press
`Alt+M` to configure roles, then run `/workflow ready`. Press `Alt+W` at any
time to inspect live step progress, the active model, and provider quota;
`Alt+A` opens the detailed Agent Hub. After onboarding, Main reads the
file-backed workflow and asks for missing project context. Do not start a
separate worker terminal or copy a kick prompt.

---

## Phase 1 — Context from you

Tell the Orchestrator, in plain language:

- Project title  
- What it is  
- What you want done now  
- Stack / how to build & test (if you know)  
- Constraints (optional)

The Orchestrator saves a short version into `AI_Workflow_Kit/docs/PROJECT_CONTEXT.md` when useful.

---

## Phase 2 — Plan, advice, or Architect

| Situation | What the Orchestrator does |
|-----------|----------------------------|
| **Enough context** to act safely | Writes a **minimal plan** (few steps in `STEPS.md` / `STATE.yaml`) and starts the first coding step. |
| **One bounded design uncertainty** | Optionally asks the existing Architect for a fresh read-only `Mode: advisory` second opinion. No Grilling, ADR, or Architecture Package. |
| **Not enough** for a real plan | Uses `Mode: design` or deep `/grilling` through a separate **Architect** session. |

### Architect modes

Main dispatches `workflow-architect` as a fresh OMP task agent. Advisory mode
returns concise advice and stops. For deep discovery, `/grilling` autoloads the
skill: headless iterations return exact material questions and a checkpoint;
Main transparently relays exact Human answers into the next fresh Architect.
Only after explicit confirmation does the Architect return an Architecture
Package. It never implements or persists plans; Main verifies and writes
accepted plan/ADR changes.

---

## Phase 3 — Coding loop (each step)

```text
Human ↔ Main Orchestrator only
  → fresh workflow-coder runs assigned Objective Gates
  → Main verifies source/diff/evidence
  → fresh workflow-reviewer evaluates Judgment Gates
  → Main verifies findings
  → fresh workflow-tester runs runtime/QA Objective Gates
  → Main verifies tests/reports
  → green → Main updates state and opens the next step
  → red → Main records verified attempt memory and starts a fresh Coder fix run
```

| Gate | Default | Human choice |
|------|---------|--------------|
| **Code review** | **On** every step | Explicit skip is recorded in state |
| **Tester** | **Recommended on** | Explicit opt-out is recorded in state |
| **Security** | **Offer once** near release | Optional, expensive |

Workers never invent the pipeline, write workflow-state files, invoke another
worker, or commit. Main is the only workflow-state owner.

Fresh retries receive compact verified facts from `FEEDBACK.md`: attempted
approach, observed result, evidence, and rejection reason. They never receive a
prior worker transcript. At startup or `/workflow status`, Main reconciles
file-backed active-agent state with real `hub` status, artifacts, and the
authorized diff. Interrupted partial work is preserved; runtime disappearance
alone is not an implementation failure.

---

## Roles in one line

| Role | Job |
|------|-----|
| **Orchestrator** | Reconciles state, verifies results, and routes compact self-contained assignments |
| **Coder** | Implements current scope and runs assigned Objective Gates |
| **Reviewer** | Owns independent Judgment Gates; approves or requests changes |
| **Tester** | Runs runtime/QA Objective Gates and fills real coverage gaps |
| **Architect** | Optional bounded advice, normal design, or deep Grilling |
| **Security** | Optional final vuln audit when project is ready |

---

## Models (short)

Canonical recommendations: `AI_Workflow_Kit/docs/AI/MODELS.md`.
Runtime aliases are in `.omp/config.yml`:

| Role | Primary | Backup |
|------|---------|--------|
| Orchestrator | `@workflow_orchestrator` | `@workflow_orchestrator_backup` |
| Coder | `@workflow_coder` | `@workflow_coder_backup` |
| Reviewer | `@workflow_reviewer` | `@workflow_reviewer_backup` |
| Tester | `@workflow_tester` | `@workflow_tester_backup` |
| Architect | `@workflow_architect` | `@workflow_architect_backup` |
| Security | `@workflow_security` | `@workflow_security_backup` |

Change either assignment through `Alt+M`; no agent prompt changes.

Persistent worker model/provider failure pauses the workflow. Main records the
failure and starts `workflow-<role>-backup` only after explicit Human
authorization. Automatic cross-model fallback is disabled.

---

## Folder map

```text
.omp/
  AGENTS.md                       ← shared control-plane contract
  config.yml                      ← role aliases + task lifecycle
  agents/                         ← independent worker definitions
  commands/workflow.md            ← /workflow entry point
grilling/                         ← discovery skill
AI_Workflow_Kit/
  docs/                           ← file-backed state, plans, reports
  script/omp_workflow.sh          ← OMP launcher
  script/workflow_models.sh        ← primary/backup model-pair validation
  script/graphify_rebuild.sh      ← Graphify refresh
```

---

## Golden rules

1. Human controls the process through **Main**; Agent Hub is available for live intervention.
2. One fresh specialized worker at a time.
3. Only Main writes workflow state, plans, feedback, and reports.
4. Workers receive task-specific context, never Main's conversation history.
5. `GRAPHIFY -> FIND; SOURCE -> VERIFY`.
6. Main verifies actual repository and test evidence before every transition.
7. Stop only materially identical failures of the same approach after three
   attempts; preserve compact verified retry memory.
8. Reconcile stale runtime state before routing.
