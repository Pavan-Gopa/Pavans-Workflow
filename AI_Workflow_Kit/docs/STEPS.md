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
- [x] Orchestrator confirms: ready to work with this process.
- [x] Human provides project context.
- [x] Enough context → minimal plan (S1+). Thin context → Architect research + plan.
- [x] Confirm gates: review on by default; Tester recommended.

**Out of scope:**
- Large product implementation before plan exists

## Verification

### Objective gates

- [x] PROJECT_CONTEXT contains real project information

### Judgment gates

- [x] next step or Architect path is clear

**Stop-gate:** Human agrees with the plan path

---

## S1 — Repair Dust provider login

**Goal:** Replace the brittle hard-coded Dust connection with a validated,
persisted workspace/region credential while retaining legacy raw-key support.
**Depends on:** S0
**Target files (sketch):**
- `/Users/pavan/.omp/agent/extensions/dust-provider.ts`

**Do:**
- [x] Repair Dust login across workspace IDs and API regions.

**Out of scope:**
- Changing Dust agents or workspace permissions
- Storing or printing the Human's API key

## Verification

### Objective gates

- [x] Mock login succeeds after a default-workspace `404` and corrected workspace input
- [x] `omp models find dust --json` discovers the fixture agent
- [x] `omp --model dust/mock-agent -p` returns the fixture conversation response

### Judgment gates

- [x] Authentication failures preserve `401`/`403` semantics and explain exhausted `404` probes
- [x] Credential migration is bounded to the Dust provider and legacy raw keys remain usable

**Ready for review when:** implementation is complete in scope and required
Objective gates are green.

**Stop-gate:** Reviewer APPROVED + Tester qa_green

---

_(add S2, S3, … as the plan solidifies)_
