# Context-Economy Experimental Workflow v2

Branch: `experiment/context-economy-v3.2`

Version 2 corrects the first experimental overlay's architectural mistake: it
no longer replaces base workflow files. The complete existing Pavan's Workflow,
including the rich Alt+W dashboard and native Alt+A Agent Hub, remains in place.
Context economy is installed as a separate extension.

## Repair or install

Close OMP for the project, then run from the project root:

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

For a project already running experiment v1, installation first restores every
base workflow file that v1 replaced. It prefers the exact pre-experiment
baseline stored under Git's private common directory and falls back to pristine
v3.1.4 branch files only when a baseline copy cannot be found. Product source,
product tests, canonical state, plans, decisions, reports, and artifacts are
not touched.

Restart OMP after installation.

## Verify

```bash
bash AI_Workflow_Kit/script/workflow_experiment.sh status
bash AI_Workflow_Kit/script/workflow_experiment.sh doctor
```

Then confirm:

```text
Alt+W  -> complete original workflow dashboard
Alt+A  -> native Agent Hub and active processes
Alt+Q  -> primary/backup Orchestrator toggle
```

## Update and rollback

```bash
bash AI_Workflow_Kit/script/workflow_experiment.sh update
bash AI_Workflow_Kit/script/workflow_experiment.sh rollback
```

Rollback changes only experiment-owned additive files, the three
experiment-owned config sections (`cycleOrder`, `contextPromotion`,
`compaction`), and the single `app.model.cycleForward` action. Other workflow
and product changes made during the trial are preserved.
