# Install Pavan's Workflow v3.1

Version 3.1 restores the Alt+W live cursor and adds optional Design Advisor and
Designer roles without changing the default Coder → Reviewer → Tester flow.

## Update an existing v2/v3 project

First close OMP for that project. From its root:

```bash
( tmp_dir="$(mktemp -d)" && git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw" && bash "$tmp_dir/pw/AI_Workflow_Kit/script/workflow_update.sh" apply; rc=$?; rm -rf "${tmp_dir:-}"; exit "$rc" )
```

Workflow updates preserve the existing Graphify index and do not rebuild it by
default. To request a bounded refresh during the same update, append
`--refresh-graphify`.

The updater preserves `.omp/config.yml`, live state, steps, project context,
decisions, feedback, reports, product code, and tests. It adds only missing
optional design aliases to the existing model map and creates a backup under:

```text
<git-common-dir>/pavans-workflow/update-backups/<timestamp>/
```

Restart OMP after a successful update.

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

## New project from template

```bash
git clone https://github.com/Pavan-Gopa/Pavans-Workflow.git my-project
cd my-project
bash install.sh .
```

## Install into an existing repository without the workflow

```bash
tmp_dir="$(mktemp -d)"
git clone --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw"
bash "$tmp_dir/pw/install.sh" /absolute/path/to/your/project
rm -rf "$tmp_dir"
```

The installer refuses to overwrite an existing workflow; use the updater for
existing installations.

## Graphify

Tested version:

```bash
uv tool install "graphifyy==0.9.46"
```

A new installation attempts a local AST code-only graph with a 120-second
portable timeout. Skip that initial build with:

```bash
WF_INSTALL_SKIP_GRAPHIFY=1 bash install.sh .
```

Workflow updates preserve the current graph by default. Rebuild later:

```bash
bash AI_Workflow_Kit/script/graphify_rebuild.sh fast
```

## Launch and model roles

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Use **Alt+M → Roles** for the six core role pairs. Version 3.1 also adds:

```text
workflow_design_advisor
workflow_design_advisor_backup
workflow_designer
workflow_designer_backup
```

They are optional. Existing upgrades receive aliases to Reviewer/Architect
models so nothing breaks. Assign Kimi or another strong visual model to
`workflow_designer` when you want direct redesign work.

## Designer usage

Read-only advice:

```text
/workflow designer advise <surface>
```

Direct scoped implementation:

```text
/workflow designer redesign <surface>
```

Main passes exact Human feedback, target files, preserve-list, visual evidence,
and acceptance gates. Direct Designer edits still pass Reviewer, Tester, and
final Human visual acceptance.

## Alt+W behavior

The plan uses separate selected and live markers. It auto-follows live work until
you navigate with Up/Down. Press `c` to return to the live step. Runtime evidence
can recover display from stale state, but the dashboard never writes state.

## OMP Stats

Still manual. Alt+W shows `http://127.0.0.1:3847`; press `o` or run
`/workflow-stats`. No startup server or persistent widget is installed.

## Verify

```bash
cat VERSION
bash AI_Workflow_Kit/script/workflow_doctor.sh
```

Expected version:

```text
3.1.0
```
