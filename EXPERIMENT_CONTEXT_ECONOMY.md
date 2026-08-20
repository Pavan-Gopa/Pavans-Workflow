# Context-Economy Experimental Workflow

Branch: `experiment/context-economy-v3.2`

This overlay is designed for installation on top of an existing Pavan's
Workflow project. It preserves product files, tests, canonical live workflow
state, model assignments, and unrelated OMP settings.

## Included

- Floating Main compaction: arm at 23%, compact at the first safe boundary, use
  native OMP threshold at 28%, reset the latch at 18%.
- `shake -> soft` portable compaction with remote/speculative/idle paths disabled.
- Compact `workflow_context` read-only tool and compaction anchor.
- Alt+W context usage and compaction lifecycle display.
- Alt+Q built-in role toggle between Main primary and backup.
- Targeted ordinary-transition reads and bounded worker results.
- One-time baseline backup, repeatable experiment updates, diagnostics, and
  section-aware rollback.

## Install over an existing project

Close OMP for that project. From the project root:

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

## Operate

```bash
bash AI_Workflow_Kit/script/workflow_experiment.sh status
bash AI_Workflow_Kit/script/workflow_experiment.sh doctor
bash AI_Workflow_Kit/script/workflow_experiment.sh update
```

Inside OMP:

```text
/workflow-experiment status
/workflow-experiment doctor
/workflow-experiment update
/workflow-context
/workflow-context-economy
```

`/work-update` and `/workflow-update` automatically follow the experimental
channel while `.omp/workflow-context-policy.json` exists.

## Backup location

The first install captures the exact pre-experiment workflow overlay under the
repository's private Git common directory:

```text
<git-common-dir>/pavans-workflow/experiments/context-economy/baseline/
```

The baseline is not overwritten by later experiment updates. It records whether
each managed file originally existed, the original project config, and the
original model-cycle keybinding action.

## Roll back

Close OMP, then run:

```bash
bash AI_Workflow_Kit/script/workflow_experiment.sh rollback
```

Rollback:

- restores every experiment-managed workflow file to its original state;
- removes experiment files that did not exist before installation;
- restores the original `cycleOrder`, `contextPromotion`, and `compaction`
  sections while preserving model-role changes and unrelated config edits made
  during the experiment;
- restores only `app.model.cycleForward` in `keybindings.yml`, preserving other
  hotkey edits;
- stores the final experimental overlay in a timestamped forensic backup;
- never touches product source, product tests, `STATE.yaml`, `STEPS.md`,
  `DECISIONS.md`, feedback, reports, or project artifacts.

Restart OMP after rollback.

## Suggested evaluation

Track at least:

- context percentage before and after each compaction;
- number of Main requests and input/cache-read tokens per step;
- whether a worker was active when compaction began;
- factual recall across compaction and Alt+Q switches;
- gate accuracy versus the non-experimental workflow;
- provider quota consumption over comparable tasks;
- any state-hash drift or unnecessary full reconciliations.

A successful trial should show lower prompt growth without worker interruption,
lost gates, lost Human instructions, or weaker source verification.
