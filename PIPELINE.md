# Pipeline — multi-model, multi-agent OMP workflow

Drop this kit into any project. Choose a model alias per role, then control the
entire fresh-context agent loop through one OMP Main session.

---

## Phase 0 — Start the Main Orchestrator

Run from the project root:

```bash
./AI_Workflow_Kit/script/omp_workflow.sh
```

Equivalent: launch `omp`, then run `/workflow start`.

OMP loads `.omp/AGENTS.md`, `.omp/config.yml`, the project agents, and the
`grilling` skill. Main reads the file-backed workflow and asks for project
context when `STATE.yaml` is still at bootstrap. Do not start a separate worker
terminal or copy a kick prompt.

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

## Phase 2 — Plan or Architect

| Situation | What the Orchestrator does |
|-----------|----------------------------|
| **Enough context** to act safely | Writes a **minimal plan** (few steps in `STEPS.md` / `STATE.yaml`) and starts the first coding step. |
| **Not enough** for a real plan | Offers to plan **with you**, usually via a separate **Architect** session. |

### Architect (when planning is hard)

Main dispatches `workflow-architect` as a fresh OMP task agent. For deep
discovery it autoloads the `grilling` skill, may return focused questions, and
ultimately returns an Architecture Package. It does not implement or persist
plans. Main verifies and writes accepted plan/ADR changes.

---

## Phase 3 — Coding loop (each step)

```text
Human ↔ Main Orchestrator only
  → fresh workflow-coder → Main verifies source/diff/evidence
  → fresh workflow-reviewer → Main verifies findings
  → fresh workflow-tester → Main verifies tests/reports
  → green → Main updates state and opens the next step
  → red → Main records findings and starts a fresh Coder fix run
```

| Gate | Default | Human choice |
|------|---------|--------------|
| **Code review** | **On** every step | Skip only explicitly |
| **Tester** | **Recommended on** | Opt out explicitly |
| **Security** | **Offer once** near release | Optional, expensive |

Workers never invent the pipeline, write workflow-state files, invoke another
worker, or commit. Main is the only workflow-state owner.

---

## Roles in one line

| Role | Job |
|------|-----|
| **Orchestrator** | Reads state, decides next move, writes full kick prompts + model tips |
| **Coder** | Implements the current step only |
| **Reviewer** | Approves or requests changes |
| **Tester** | Runs gate, finds coverage gaps, adds tests (no product fixes) |
| **Architect** | Research + plan / ADR when design is unclear |
| **Security** | Optional final vuln audit when project is ready |

---

## Models (short)

Canonical recommendations: `AI_Workflow_Kit/docs/AI/MODELS.md`.
Runtime aliases are in `.omp/config.yml`:

| Role | Alias |
|------|-------|
| Orchestrator | `@workflow_orchestrator` |
| Coder | `@workflow_coder` |
| Reviewer | `@workflow_reviewer` |
| Tester | `@workflow_tester` |
| Architect | `@workflow_architect` |
| Security | `@workflow_security` |

Change an alias mapping to switch one role's model without editing its agent.
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
7. Stop materially identical retry loops after three failed attempts.
8. English docs. Speak to the Human in their language.
