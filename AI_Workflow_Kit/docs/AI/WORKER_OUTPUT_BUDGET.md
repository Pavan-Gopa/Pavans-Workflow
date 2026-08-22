# Worker Output Budget

All workflow workers return compact structured evidence. These limits reduce
Main-session prompt growth without weakening gates.

## Universal rules

- Never paste a complete log, diff, transcript, generated bundle, or coverage
  report into the result.
- Return exact commands and pass/fail status.
- Include only the shortest excerpt needed to prove a failure or important
  behavior, normally no more than 40 relevant lines per failure.
- Store large evidence in the project-approved artifact/report path and return:
  path, content hash when available, producing command, result, and short tail.
- Use exact paths, symbols, stable IDs, and gate IDs instead of narrative recap.
- Do not repeat the assignment, workflow contract, or unchanged context.
- A blocker must name the exact missing prerequisite or out-of-scope path.

## Field limits

- Human-readable summary: at most 1,200 characters.
- Combined command/evidence prose: at most 3,000 characters unless the output
  schema requires multiple independently actionable findings.
- One issue/failure description: at most 800 characters excluding paths and IDs.
- Full artifact references do not count toward prose limits.

## Role-specific expectations

### Coder

`verification_evidence` contains commands, exit/result summaries, and bounded
failure excerpts only. `changed_files` is exact. Do not paste the diff.

### Reviewer

Each issue contains one evidence-based problem and one required change. Avoid
style commentary and repeated context. If approved, the summary states which
assigned gates were checked and why evidence is sufficient.

### Tester

Return pass/fail counts, exact failing test names, short error excerpts, suspect
paths, and affected stable IDs. Large runner output belongs in an artifact.

### Main

Consume exact `agent://` fields first. Open complete worker history only for
interruption recovery, disputed evidence, or Human inspection. Persist compact
verified retry memory, not worker narration.
