# Git checkpoints

## Rules

1. **Idempotent** — existing tag is not overwritten.
2. **Explicit scope** — dirty checkpoints require `WF_STAGE_PATHS`.
3. **Scope guard** — if any tracked, staged, deleted, or untracked path lies
   outside that scope, the checkpoint fails before staging or committing.
4. **Local by default** — commits and tags are pushed only when
   `WF_PUSH_CHECKPOINTS=1`.
5. **Orchestrator only** commits / tags / pushes.
6. **Commit convention:**
   - PRE: `chore(<prefix>): checkpoint before <step>`
   - POST: `feat(<prefix>): <step> — <summary>`
7. **Tags:**
   - PRE: `<prefix>/pre-<step>` (e.g. `proj/pre-S1`)
   - POST: `<prefix>/<step>-done` (e.g. `proj/S1-done`)
`<prefix>` comes from `PROJECT_CONTEXT.md` / `STATE.yaml` (`project_prefix`). Default: `proj`.

## Usage

```bash
cd "<PROJECT_ROOT>"

# Authorize only current step paths and Main-owned workflow files changed for
# this transition. Newline-separate paths with spaces.
export WF_STAGE_PATHS=$'src/feature\ntests/feature\nAI_Workflow_Kit/docs/AI/STATE.yaml\nAI_Workflow_Kit/docs/STEPS.md'
bash AI_Workflow_Kit/script/checkpoint.sh pre S1
bash AI_Workflow_Kit/script/checkpoint.sh post S1 "short description"
bash AI_Workflow_Kit/script/checkpoint.sh list

# Explicit off-site backup, only when Human/project policy permits it.
WF_PUSH_CHECKPOINTS=1 bash AI_Workflow_Kit/script/checkpoint.sh post S2 "done"
```

Other overrides:

```bash
export WF_PROJECT_PREFIX=myapp
```

With a clean worktree and no `WF_STAGE_PATHS`, the script may tag the current
HEAD. It never infers `"."` from repository layout. Use `WF_STAGE_PATHS="."`
only when the whole repository is intentionally in scope.

## When

| Event | Action |
|-------|--------|
| Before Coder starts step | `pre <step>` |
| After every Coder handoff/fix | Graphify rebuild before Reviewer (no checkpoint yet) |
| After review **approved/skipped** + QA **green/skipped** | `post <step>` then graphify then open next |
| Doc-only bootstrap | post after Orchestrator closes bootstrap step |

## Rollback (careful — destructive)

```bash
bash AI_Workflow_Kit/script/checkpoint.sh list
# hard reset only if Human confirms
git reset --hard <prefix>/pre-S1
```
