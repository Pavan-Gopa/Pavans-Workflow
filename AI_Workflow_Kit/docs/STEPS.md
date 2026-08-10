# Step cards

> Condensed cards for the current train. One step at a time.  
> Orchestrator opens a step in `STATE.yaml` only when the previous is green (or Human skips with a note).

---

## How to write a card

```markdown
## S1 — Short title

**Goal:** 1–3 sentences  
**Depends on:** S0 / none  
**Target files (sketch):**  
- path/a  
- path/b  

**Do:**
- [ ] first semantically verifiable work item
- [ ] next semantically verifiable work item

**Out of scope:**
- …

## Verification

### Objective gates

- [ ] `exact command` exits 0
- [ ] required artifact or behavior is deterministically present

### Judgment gates

- [ ] implementation follows the accepted architecture and intended semantics
- [ ] scope and public contracts remain bounded

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
- [ ] Orchestrator confirms: ready to work with this process.
- [ ] Human provides project context.
- [ ] Enough context → minimal plan (S1+). Thin context → Architect research + plan.
- [ ] Confirm gates: review on by default; Tester recommended.

**Out of scope:**
- Large product implementation before plan exists

## Verification

### Objective gates

- [ ] PROJECT_CONTEXT contains real project information

### Judgment gates

- [ ] next step or Architect path is clear

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
- [ ] project tests green, or QA explicitly skipped by Human with a recorded reason

### Judgment gates

- [ ]

**Ready for review when:** implementation is complete in scope and required
Objective gates are green.

**Stop-gate:** (Reviewer APPROVED | review explicitly skipped by Human) +
(Tester qa_green | QA explicitly skipped by Human)

---

_(add S2, S3, … as the plan solidifies)_
