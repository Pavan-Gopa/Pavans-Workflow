# Step cards

> Condensed cards for the current train. One step at a time.  
> Orchestrator opens a step in `STATE.yaml` only when the previous is green (or Human skips with a note).

---

## How to write a card

Every checklist item carries a stable ID: `<step>.<D|O|J><n>` — `D` for `Do`
work items, `O` for Objective gates, `J` for Judgment gates. IDs are unique
across the whole file and never change once assigned; `STATE.yaml` links the
active item by `current_work_item_id`, not by text. Run
`bash AI_Workflow_Kit/script/workflow_migrate.sh check` to verify.

```markdown
## S1 — Short title

**Goal:** 1–3 sentences  
**Depends on:** S0 / none  
**Target files (sketch):**  
- path/a  
- path/b  

**Do:**
- [ ] [S1.D1] first semantically verifiable work item
- [ ] [S1.D2] next semantically verifiable work item

**Out of scope:**
- …

## Verification

### Objective gates

- [ ] [S1.O1] `exact command` exits 0
- [ ] [S1.O2] required artifact or behavior is deterministically present

### Judgment gates

- [ ] [S1.J1] implementation follows the accepted architecture and intended semantics
- [ ] [S1.J2] scope and public contracts remain bounded

**Ready for review when:** implementation is complete in scope and required
Objective gates are green.

**Stop-gate:** (Reviewer APPROVED | review explicitly skipped by Human) +
(Tester qa_green | QA explicitly skipped by Human)
```

---

## S0 — Ready + context

**Goal:** Orchestrator has read the workflow, received project context, and either opened a minimal plan or started Architect.  
**Depends on:** none  
**Target files (sketch):**
- `AI_Workflow_Kit/docs/PROJECT_CONTEXT.md`
- `AI_Workflow_Kit/docs/AI/STATE.yaml`
- `AI_Workflow_Kit/docs/STEPS.md`

**Do:**
- [ ] [S0.D1] Orchestrator confirms: ready to work with this process.
- [ ] [S0.D2] Human provides project context.
- [ ] [S0.D3] Enough context → minimal plan (S1+). Thin context → Architect research + plan.
- [ ] [S0.D4] Confirm gates: review on by default; Tester recommended.

**Out of scope:**
- Large product implementation before plan exists

## Verification

### Objective gates

- [ ] [S0.O1] PROJECT_CONTEXT contains real project information

### Judgment gates

- [ ] [S0.J1] next step or Architect path is clear

**Stop-gate:** Human agrees with the plan path

---

## S1 — _(title)_

**Goal:** _(fill)_  
**Depends on:** S0  
**Target files (sketch):**
- 

**Do:**
- [ ] first semantically verifiable work item

**Out of scope:**
- 

## Verification

### Objective gates

- [ ]
- [ ] project tests green

### Judgment gates

- [ ]

**Ready for review when:** implementation is complete in scope and required
Objective gates are green.

**Stop-gate:** (Reviewer APPROVED | review explicitly skipped by Human) +
(Tester qa_green | QA explicitly skipped by Human)

---

_(add S2, S3, … as the plan solidifies)_
