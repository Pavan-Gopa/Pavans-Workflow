# Git checkpoints

## Rules

1. **Idempotent** — existing tag is not overwritten.
2. **Scope-guard** — stage **only this project’s paths**.  
   Never `git add -A` at a monorepo parent without a path filter.
3. **Orchestrator only** commits / tags / pushes.
4. **Commit convention:**
   - PRE: `chore(<prefix>): checkpoint before <step>`
   - POST: `feat(<prefix>): <step> — <summary>`
5. **Tags:**
   - PRE: `<prefix>/pre-<step>` (e.g. `proj/pre-S1`)
   - POST: `<prefix>/<step>-done` (e.g. `proj/S1-done`)
6. **Push** if remote allows; if push is disabled — keep local and tell Human.

`<prefix>` comes from `PROJECT_CONTEXT.md` / `STATE.yaml` (`project_prefix`). Default: `proj`.

## Usage

```bash
cd "<PROJECT_ROOT>"
./AI_Workflow_Kit/script/checkpoint.sh pre S1
./AI_Workflow_Kit/script/checkpoint.sh post S1 "short description"
./AI_Workflow_Kit/script/checkpoint.sh list
```

Optional env overrides:

```bash
export WF_PROJECT_PREFIX=myapp   # tag/commit prefix
export WF_STAGE_PATHS="."       # or relative path of product inside monorepo
```

## When

| Event | Action |
|-------|--------|
| Before Coder starts step | `pre <step>` |
| After every Coder handoff/fix | Graphify rebuild before Reviewer (no checkpoint yet) |
| After review **approved** + QA **green** | `post <step>` then graphify then open next |
| Doc-only bootstrap | post after Orchestrator closes bootstrap step |

## Rollback (careful — destructive)

```bash
./AI_Workflow_Kit/script/checkpoint.sh list
# hard reset only if Human confirms
git reset --hard <prefix>/pre-S1
```
