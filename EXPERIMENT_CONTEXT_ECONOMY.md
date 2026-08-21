# Context-Economy Experimental Workflow v3

Branch: `experiment/context-economy-v3.2`

Version 3 makes context maintenance strictly **Main-only**. It also preserves
the complete Pavan's Workflow 3.1.4 dashboard and OMP's native Agent Hub.

## Why v3 exists

Version 2 correctly restored the full dashboard, but its project compaction
settings and extension were still inherited by task sessions. A Coder could
therefore display or run soft compaction even though only Main was supposed to
be compressed.

Version 3 fixes both paths:

- OMP automatic compaction is disabled in the shared project config, preventing
  native threshold/mid-turn compaction in workers.
- A separately scoped extension manually compacts only the top-level
  interactive Main session.
- Nested/headless worker sessions disable the timer, status, tool, anchor, and
  compaction invocation.
- Main warns at 23%, reports `waiting-worker` while a worker is active, and runs
  `shake -> soft` at the first safe Main idle boundary before/around the 28%
  upper target.

It is normal for Main to remain around 26–27% while Coder is still running. The
context drop should occur after the worker and Main turn settle.

## Repair or update an existing installation

Wait for any active Coder/Reviewer/Tester to finish, close OMP for the project,
and run from the project root:

```bash
bash AI_Workflow_Kit/script/workflow_experiment.sh update
```

For a fresh installation or when the old manager is unavailable:

```bash
(
  tmp_dir="$(mktemp -d)" &&
  git clone -q --depth 1 --branch experiment/context-economy-v3.2 \
    https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw" &&
  bash "$tmp_dir/pw/AI_Workflow_Kit/experiments/context-economy/install.sh" "$PWD";
  rc=$?;
  rm -rf "${tmp_dir:-}";
  exit "$rc"
)
```

Restart OMP after installation.

## Verify

```bash
bash AI_Workflow_Kit/script/workflow_experiment.sh status
bash AI_Workflow_Kit/script/workflow_experiment.sh doctor
```

Inside Main:

```text
/workflow-context-economy
```

Expected:

```text
Scope: main · policy=top-level Main only
Worker auto-compaction: disabled
```

Then confirm:

```text
Alt+W  -> complete original workflow dashboard
Alt+A  -> native Agent Hub and active processes
Alt+Q  -> primary/backup Orchestrator toggle
```

A worker must show no `MAIN ctx` status and no context-economy warning.

## Rollback

```bash
bash AI_Workflow_Kit/script/workflow_experiment.sh rollback
```

Rollback changes only experiment-owned additive files, the three
experiment-owned config sections (`cycleOrder`, `contextPromotion`,
`compaction`), and the single `app.model.cycleForward` action. Other workflow
and product changes made during the trial are preserved.
