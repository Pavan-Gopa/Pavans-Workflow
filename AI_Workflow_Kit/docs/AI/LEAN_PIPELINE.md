# Pipeline profiles, close decision, retry economy

Unlabeled step cards run the default loop: Coder → close check → Reviewer →
Tester. Rules: `TEAM_CONTRACT.md` R11–R15.

## Profiles

Written on the `STEPS.md` card and copied into `STATE.yaml` before dispatch:

```markdown
**Risk:** normal            # low | normal | high
**Pipeline profile:** quick # quick | standard | critical
```

| Profile | Reviewer | Tester | Security |
|---|---|---|---|
| `standard` (default) | on unless the Human skips it | recommended | offered near release |
| `quick` | skipped only on a `close_quick` decision | skipped with it | no |
| `critical` | on | on unless the Human skips it | scoped pass offered on a blast-radius hit |

Writing `quick` on the card is the Human's authorization; Main never invents it.

## Close decision (code, not memory)

After a verified Coder/Designer result:

```bash
python3 AI_Workflow_Kit/script/workflow_close.py check --json
```

It runs the card's Objective Gates (`workflow_gates.py`), reads every guard
verdict recorded for the step (`workflow_guard.py`), and classifies the diff against the pre-step
checkpoint tag (`workflow_security_scope.py`). `close_quick` needs all of:

- the card says `quick` and `**Risk:**` is not `high`;
- at least one command gate, all green, and every manual Objective gate
  already checked (`[x]`) by Main;
- a `clean` Coder/Designer guard verdict for the step and no open violation or
  `unscoped` run (an empty `target_files` gives `unscoped`);
- no blast-radius hit: security, secrets, contracts (API/schema/migration/
  proto/GraphQL), infra (CI, Docker, IaC), dependency manifests, or the
  workflow control plane.

Otherwise the decision is `review` and the output lists `quick_blockers`.
`reopen_coder` means a gate failed; `reject_worker_result` means a guard
violation for the step is still open (R7) — a later clean run never hides it.
A violation is only ever a change the worker itself made; `guard.info` lists
blocked attempts, shell suspects, and 3.5.x legacy verdicts (whole-repository
diffs, not attributable), none of which changes the decision.

## Writing gates that run

```markdown
### Objective gates

- [ ] [S3.O1] `$ npm test -- --run src/cart` exits 0     explicit: always runs
- [ ] [S3.O2] `pytest -q tests/cart` exits 0             recognised runner
- [ ] [S3.O3] `./script/smoke.sh` exits 0                explicit relative path
- [ ] [S3.O4] `CHANGELOG.md` mentions the cart fix       manual evidence (not run)
```

Every command on a line must pass. Backticked file or symbol names are never
executed. `python3 AI_Workflow_Kit/script/workflow_gates.py list` shows how a
card is parsed.

## Retry economy

| Situation | `ponytail_mode` |
|---|---|
| First Coder attempt on the item | `full` |
| Reviewer `changes_requested` or Tester `bugs` | `lite` |
| `repeated_failure_count >= 2` | `off` |

On Tester `bugs`, require a failing test in approved test paths before the next
Coder run; that test becomes an Objective Gate for the retry.

## Assignment-first

Every assignment is self-contained (goal, stable IDs, `target_files`,
exclusions, gates, compact retry facts, the role block from
`WORKER_INPUT_DIGEST.md`). An incomplete assignment makes the worker return
`blocked`; it does not trigger a full-contract reread.
