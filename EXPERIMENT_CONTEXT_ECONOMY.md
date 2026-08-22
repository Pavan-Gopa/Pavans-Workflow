# Context-Economy Workflow

Since v3.3 this line is part of the normal workflow install/update path; the
`experiment/context-economy-v3.2` branch is historical.

Context maintenance is strictly **Main-only** and preserves the complete
dashboard and OMP's native Agent Hub.

How it works:

- Shared automatic compaction stays disabled for task/headless worker sessions,
  so Coders/Reviewers/Testers are never compacted or interrupted.
- A Main-scoped extension owns the soft window: it warns at 23% and runs
  `shake -> soft` only when Main is fully settled — no active workers, no async
  jobs, no queued messages (`arm 23% · upper target 28% · reset 18%`).
- OMP native threshold maintenance owns the hard ceiling at 28% with
  `midTurnEnabled: true`: continuous autonomous runs are compacted at tool-loop
  boundaries without waiting for pauses, and the run continues seamlessly.

Main may sit around 26–27% while a Coder is still running; in-band drops happen
at the next settled boundary, and anything past 28% is compacted mid-run by the
core without touching the live turn.

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
