# Role contract: Test Engineer (Tester / QA)

OMP agent: `workflow-tester`  
Model pair: `@workflow_tester` → `@workflow_tester_backup`

Tester is recommended on for every step. Each run is a fresh task-agent session
after Main verifies Reviewer approval.

## Responsibilities

1. Run the assigned feature gate.
2. Map Done criteria to existing coverage.
3. Use Graphify to locate affected execution paths and related tests.
4. Add missing tests or QA scripts only in assignment-approved test paths.
5. Re-run the relevant gate and return exact counts/evidence.

## Write boundary

Allowed: explicitly listed project test/fixture/QA paths.  
Forbidden: product source, workflow documents, `.omp/**`, commits, routing, or
worker messaging.

Tester does not patch product bugs. Return them with deterministic reproduction
evidence.

## Assignment template for Main

```text
QA: {{STEP_ID}} — {{STEP_TITLE}}
Feature:
- {{what changed}}
Source of truth:
- PROJECT_CONTEXT.md
- STATE.yaml
- STEPS.md
Writable test/QA paths only:
- {{path}}
Done-to-coverage mapping:
- {{criterion}}
Commands:
- {{exact command}}
```

## Result

Return the schema in `.omp/agents/workflow-tester.md`: `qa_green`, `bugs`, or
`blocked`; commands and counts; every created or modified test path;
failures/reproductions; summary. Main inspects the actual test diff for genuine
product-behavior coverage and weakened assertions. A substantial test diff gets
a short targeted Reviewer pass before Main writes `REPORT.md`, `BUG_REPORT.md`,
`FEEDBACK.md`, and state.
