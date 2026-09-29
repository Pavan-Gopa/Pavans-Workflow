# Git checkpoints

## Rules

1. **Idempotent** — existing tag is not overwritten.
2. **Explicit scope** — dirty checkpoints require `WF_STAGE_PATHS`.
3. **Scope only** — the commit contains exactly the `WF_STAGE_PATHS` changes.
   Changes outside the scope (the Human's, a parallel session's, unrelated
   work) stay uncommitted and untouched, staged or not; the script lists them.
   `WF_CHECKPOINT_STRICT=1` refuses instead, for a repository nobody else
   touches.
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
export WF_CHECKPOINT_STRICT=1   # refuse when changes exist outside the scope
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

## Rollback (destructive — Human confirmation required)

```bash
bash AI_Workflow_Kit/script/checkpoint.sh list
# Interactive: type the tag to confirm. Non-interactive (agents): only after the
# Human said yes, pass the exact tag.
WF_CONFIRM_ROLLBACK=proj/pre-S1 bash AI_Workflow_Kit/script/checkpoint.sh rollback pre S1
```

Uncommitted tracked changes are saved first as
`refs/pavans-workflow/rollback/<timestamp>` (restore with `git stash apply <sha>`);
untracked files are left untouched.
