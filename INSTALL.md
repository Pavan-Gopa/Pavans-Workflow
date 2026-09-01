# Install Pavan's Workflow v3.4.2

v3.4.2 fixes the Main model/effort selector race. `DEFAULT` is the only editable
Main-model slot; `workflow_orchestrator` remains a hidden managed alias used by
launch and quick-switch behavior.

## Update an existing v2/v3 project

Close OMP for that project. From its root:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/install.sh) --update
```

Equivalent explicit-git form:

```bash
(
  set -Eeuo pipefail
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw"
  bash "$tmp_dir/pw/AI_Workflow_Kit/script/workflow_update.sh" apply "$PWD"
)
```

The updater preserves project model choices, workflow state, reports, product
code, custom `.graphifyignore` rules, and the existing Graphify index. It repairs
older Main-role layouts as follows:

1. An existing `DEFAULT` remains authoritative.
2. A direct `workflow_orchestrator` selection is copied to `DEFAULT` only when
   no explicit `DEFAULT` exists.
3. `workflow_orchestrator` is restored to `"@default"` and hidden from the role
   picker.

Framework backups are stored under:

```text
<git-common-dir>/pavans-workflow/update-backups/<timestamp>/
```

Append `--refresh-graphify` to request a bounded Graphify refresh. Restart OMP
after a successful update.

## Install OMP

macOS/Linux:

```bash
curl -fsSL https://omp.sh/install | sh
```

Other options:

```bash
brew install can1357/tap/omp
bun install -g @oh-my-pi/pi-coding-agent
```

Windows PowerShell:

```powershell
irm https://omp.sh/install.ps1 | iex
```

## New project from the template

```bash
git clone https://github.com/Pavan-Gopa/Pavans-Workflow.git my-project
cd my-project
bash install.sh .
```

## Install into an existing repository without the workflow

```bash
(
  set -Eeuo pipefail
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  git clone --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw"
  bash "$tmp_dir/pw/install.sh" /absolute/path/to/your/project
)
```

The installer refuses to overwrite existing workflow paths. Use the updater for
an existing installation.

## Configure the Main model correctly

Open **Alt+M → Roles** and edit **DEFAULT**. Complete both stages of OMP's
selector: choose the model, then choose the effort/thinking level.

Do not look for a separate editable `workflow_orchestrator` row in v3.4.2. It is
intentionally hidden because it aliases `@default`.

- To change the persistent primary: assign the new model + effort to `DEFAULT`.
- To use the configured backup temporarily: use the quick-switch control
  (`Alt+Q` in the workflow setup).
- To change the backup mapping: edit `workflow_orchestrator_backup` in Roles.

## Graphify

Tested package version:

```bash
uv tool install "graphifyy==0.9.46"
```

A new installation attempts a local AST code-only graph with a portable
120-second timeout. Skip the initial build with:

```bash
WF_INSTALL_SKIP_GRAPHIFY=1 bash install.sh .
```

Workflow updates preserve the current graph by default. Rebuild later with:

```bash
bash AI_Workflow_Kit/script/graphify_rebuild.sh fast
```

## Launch

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Use **Alt+M → Roles** for worker primary/backup pairs. Design Advisor and
Designer remain optional.

## Main context economy

Context maintenance is Main-only. Worker/task sessions do not inherit automatic
Main compaction. OMP owns the native 28% hard threshold with mid-turn
checkpoints; the workflow's soft window can compact earlier when Main is fully
settled.

## Quick Worker Focus

```text
Main   -- Tab --> Worker
Worker -- Tab --> Main
Worker -- Esc --> Main
```

Tab keeps OMP's normal completion behavior when text is present, a popup or
overlay owns input, or no worker is running. `Alt+A` remains the full Agent Hub.

## OMP Stats

Stats remains manual. Press `o` in Alt+W or run `/workflow-stats`. No startup
server or persistent widget is installed.

## Verify

```bash
cat VERSION
python3 AI_Workflow_Kit/script/workflow_config_repair.py check .omp/config.yml
bash AI_Workflow_Kit/script/workflow_doctor.sh
```

Expected version:

```text
3.4.2
```
