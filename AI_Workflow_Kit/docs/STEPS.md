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
1. …
2. …

**Out of scope:**
- …

**Done when:**
- [ ] …
- [ ] tests/QA green, or explicitly skipped by Human with a recorded reason

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
1. Orchestrator confirms: ready to work with this process.
2. Human provides project context.
3. Enough context → minimal plan (S1+). Thin context → Architect research + plan.
4. Confirm gates: review on by default; Tester recommended.

**Out of scope:**
- Large product implementation before plan exists

**Done when:**
- [ ] PROJECT_CONTEXT has real project info
- [ ] Next step or Architect kick is clear

**Stop-gate:** Human agrees with the plan path

---

## S1 — _(title)_

**Goal:** _(fill)_  
**Depends on:** S0  
**Target files (sketch):**
- 

**Do:**
1. 

**Out of scope:**
- 

**Done when:**
- [ ] 
- [ ] project tests green, or QA explicitly skipped by Human with a recorded reason

**Stop-gate:** (Reviewer APPROVED | review explicitly skipped by Human) +
(Tester qa_green | QA explicitly skipped by Human)

---

_(add S2, S3, … as the plan solidifies)_
