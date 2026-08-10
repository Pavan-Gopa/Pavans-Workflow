# AI Team Contract

Keep this light. Human ↔ **Orchestrator** only for process control.

## Source of truth (priority)

1. Authoritative plan files listed in `PROJECT_CONTEXT.md` (if any)  
2. `STATE.yaml` — what to do **right now**  
3. `STEPS.md` — step cards  
4. `DECISIONS.md` — ADRs  
5. `PROJECT_CONTEXT.md` — repo map + commands  
6. `PIPELINE.md` — simple human overview  

Higher wins on conflict. Plan vs code conflict → **Architect** before large Coder work.

---

## Roles

| Role | Writes product code? | Job / write boundary |
|------|----------------------|----------------------|
| **Main Orchestrator** | No | Sole owner of state, plans, feedback, reports, routing, checkpoints, and passive metrics recording |
| **Coder** | Yes, assignment target files only | One implementation/fix; structured result to Main |
| **Reviewer** | No | Read-only verdict and findings |
| **Tester** | Tests / QA scripts only | Gate, gap-hunt, structured evidence |
| **Architect** | No | Read-only research, questions, Architecture Package |
| **Security** | No | Read-only optional final vulnerability audit |
| **Human** | — | Context, preferences, supervision and intervention |

### Models (summary)

| Role | Default |
|------|---------|
| Orchestrator | **Grok 4.5 · Max / High** · or **GPT 5.6 Sol · Medium** |
| Coder | Luna / DeepSeek Flash / Gemini Flash · Max–High |
| Reviewer | Luna / Gemini · **no DeepSeek** |
| Tester | Terra · Max / Extra High |
| Architect | Sol High–Extra High or Terra Max · **not Ultra** |
| Security | **GLM 5.2 · max** · Sol max · Opus 5 max (final offer only) |

Full table: `MODELS.md`.

---

## OMP pipeline

```text
Human ↔ Main
  → fresh Coder → Main verification
  → fresh Reviewer → Main verification
  → fresh Tester → Main verification
  → next step
```

Main dispatches project agents through OMP `task`. Children do not inherit
Main's conversation history. Every retry is a new task-agent session.

### Quality gates (Human preferences)

| Gate | Default | Notes |
|------|---------|-------|
| **Code review** | **On** | Minimum recommended bar. Skip only if Human says so. |
| **Tester** | **Recommended on** | Orchestrator should include Tester unless Human opts out. |
| **Security** | **Offer once** near release | Optional. Expensive top models. Not every step. |

### Verification gates

This section is the canonical gate contract. Step cards separate:

- **Objective gates** — deterministic evidence such as command exit codes,
  test/build/typecheck results, or artifact existence. Coder runs the assigned
  objective gates; Tester owns runtime/QA objective gates. Reviewer may repeat
  relevant commands.
- **Judgment gates** — engineering evaluation of semantics, accepted
  architecture, scope, public contracts, failure behavior, and trust
  boundaries. Reviewer is the primary evaluator; Coder never marks these green.

`waiting_review` means the scoped implementation and required Coder objective
gates are ready for independent judgment, not that the step is proven correct.
Only Main combines verified objective evidence, Reviewer judgment, and enabled
QA results to transition the step.

### Tester (when enabled)

1. Run the assigned runtime/QA Objective Gates.
2. Gap-hunt intended feature behavior and coverage against current source.
3. Add tests only in assignment-approved test/QA paths.
4. Return structured counts, commands, new tests, and failures to Main.
5. Main inspects every Tester-authored test diff for weakened assertions,
   implementation-coupled checks, and real product-behavior coverage.
6. A substantial test diff receives a short targeted Reviewer pass before the
   step closes.
7. Main verifies and writes `REPORT.md` / `BUG_REPORT.md`.

### Architect (when needed)

Research → options/questions → recommendation → Architecture Package. Main
persists accepted steps and ADRs.

### Bugs and security findings

| Who | Action |
|-----|--------|
| Tester / Security | Return structured evidence to Main |
| Main | Verify, write canonical report/state, issue Coder fix assignment |
| Coder | Patch product within target files |
| Reviewer | Re-review after fix |

Do not send bugs to another worker directly. Do not put live secrets in output.

---

## Hard rules

1. One step and one active specialized worker at a time.
2. Product diffs stay inside `STATE.yaml` / assignment target files.
3. Specialized agents return only to Main; no worker-to-worker handoff.
4. Only Main writes workflow documents or commits/tags/pushes.
5. No silent architecture redesign by Coder.
6. No fake data or fake green in production.
7. Graphify first when current; verify in real source.
8. Fresh worker context for every role run and retry.
9. Main verifies repository/test evidence before every transition.
10. Passive metrics are Main-only observation. Telemetry failure never changes
    workflow state, gates, retries, failover, recovery, checkpoints, or routing.
11. Stop three materially identical failures of the same approach and surface
    the blocker; changed approaches/evidence/failure states are progress.
12. Three failed Coder runs never authorize Main to write product code; stop,
    route to Architect when appropriate, or request Human direction.
13. Main alone checks or reopens `STEPS.md` `Do` boxes after source/evidence
    verification; workers never mutate canonical checklist state.

---

## Comments (quality bar)

| Where | What |
|-------|------|
| Module header | Role, ownership, must-not (short) |
| Non-obvious logic | **Why** |
| Public API | Intent + invariants |
| TODOs | Tied to a step id |

No secrets in comments. No novel on every getter.

---

## Worker handoff

Workers return the structured schema defined by their `.omp/agents/*.md` file.
They do not write `FEEDBACK.md`, route the next role, or ask the Human to copy a
prompt. Main validates the result and persists the canonical workflow record.

On a retry, Main adds only verified attempt memory: approach, observed result,
evidence, and why it was rejected. Worker transcripts and reasoning are never
handoff context. The durable record lives in `FEEDBACK.md`; the assignment
carries only the compact task-relevant subset.
