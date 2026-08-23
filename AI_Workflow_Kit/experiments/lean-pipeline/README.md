# Lean Pipeline experiment

Opt-in overlay on Pavan's Workflow v3.3.1. Default project behavior stays
`standard` (Coder → Reviewer → Tester). The experiment adds smarter routing
and cuts repeated prompt load without removing gates on real product work.

## What it changes

- **Pipeline profiles on step cards.** `quick` skips Reviewer/Tester after
  Main re-runs Objective Gates. `critical` keeps the full loop and can offer a
  scoped Security pass. Unlabeled cards stay `standard`.
- **Deterministic Objective Gates.** `workflow_gates.py` runs backticked
  commands from the current step. Main no longer treats a worker's evidence
  string as proof that a command passed.
- **Cheaper retries.** Review/QA retries dispatch Coder with `ponytail_mode:
  lite` (or `off` after two identical failures). Tester writes a failing test
  before returning `bugs`.
- **Assignment-first workers.** Fresh workers trust the compact assignment
  packet instead of re-reading TEAM_CONTRACT / KICK_* / PROJECT_CONTEXT.
- **Scoped Security offer** when the verified diff hits auth/credential/trust
  paths. Still optional. Still not a full pre-release campaign.

## Apply to an existing project

Close OMP for that project first. From **this** checkout:

```bash
bash AI_Workflow_Kit/experiments/lean-pipeline/install.sh apply /absolute/path/to/your/project
```

From GitHub after this branch is pushed:

```bash
(
  set -Eeuo pipefail
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  git clone -q --depth 1 --branch experiment/lean-pipeline \
    https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw"
  bash "$tmp_dir/pw/AI_Workflow_Kit/experiments/lean-pipeline/install.sh" apply "$PWD"
)
```

The installer:

1. refuses to run if OMP looks live (best-effort);
2. copies the current framework files to
   `<git-common-dir>/pavans-workflow/experiment-backups/lean-pipeline/<stamp>/`;
3. overlays this experiment;
4. additively inserts a `pipeline:` block into `STATE.yaml` only when missing;
5. never overwrites live `STEPS.md`, `PROJECT_CONTEXT.md`, reports, product
   code, or model-role selections.

Restart OMP after a successful apply.

## Rollback

```bash
bash AI_Workflow_Kit/experiments/lean-pipeline/install.sh rollback /absolute/path/to/your/project
```

If you applied from a clone, run the same command from the **installed**
project (the installer is copied there) or from this checkout with the project
path. Rollback restores the timestamped backup recorded in
`.omp/workflow-lean-pipeline.json` and deletes files the experiment added.

Live plan/state/product files stay as they were during the experiment, except
the additive `pipeline:` block is removed when the installer inserted it.

## Check / doctor

```bash
bash AI_Workflow_Kit/experiments/lean-pipeline/install.sh check /path/to/project
bash AI_Workflow_Kit/experiments/lean-pipeline/install.sh doctor /path/to/project
```

## Keep it

If the experiment feels better, merge `experiment/lean-pipeline` into `main`
and ship it as a normal release. Until then, do not run the stable
`workflow_update.sh apply` from `main` on a project that still has this
overlay — it would mix trees. Rollback first, then update, or merge and
update from the merged main.

## Opt into `quick` on a step

Add this to a card in `STEPS.md`:

```markdown
**Risk:** low
**Pipeline profile:** quick
```

Then open that step as usual. Main copies the profile into `STATE.yaml`.
High-risk cards ignore `quick` and stay on the full loop.
