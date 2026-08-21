# Install Pavan's Workflow v3.2

Version 3.2 promotes the Main-only Context Economy experiment into the normal
workflow and adds Quick Worker Focus while preserving the v3.1 dashboard,
Designer path, long-worker runtime policy, and manual OMP Stats.

## Update an existing v2/v3 project

First close OMP for that project. From its root:

```bash
( tmp_dir="$(mktemp -d)" && git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw" && bash "$tmp_dir/pw/AI_Workflow_Kit/script/workflow_update.sh" apply; rc=$?; rm -rf "${tmp_dir:-}"; exit "$rc" )
```

The v3.2 updater automatically installs/repairs the stable Main context policy,
keeps task/headless workers out of Main compaction, binds
`workflow_orchestrator` to the authoritative `DEFAULT` Main model slot, and
installs Quick Worker Focus. Existing project model selections and live workflow
state are preserved.

Workflow updates preserve the existing Graphify index and do not rebuild it by
default. To request a bounded refresh during the same update, append
`--refresh-graphify`.

Framework backups are stored under:

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

## Main context economy

Context maintenance is Main-only. Worker/task sessions do not inherit automatic
compaction. Main warns near 23% context use, waits while a worker is active, and
performs the configured `shake -> soft` maintenance at the next safe Main idle
boundary around the 28% upper target.

The Main model has one authoritative slot: `DEFAULT`. The
`workflow_orchestrator` role aliases `@default`, so changing the Main model does
not leave the live session and workflow role mapping out of sync.

## Quick Worker Focus

With an empty composer and one running workflow worker:

```text
Main   -- Tab --> Worker
Worker -- Tab --> Main
Worker -- Esc --> Main
```

Tab remains normal OMP context-aware completion when text is present, an
autocomplete popup/overlay owns input, or no running worker exists. Agent Hub
(`Alt+A`) remains available for the full roster, history, abort, and intervention
controls.

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

Use **Alt+M → Roles** for the workflow role pairs. Design Advisor and Designer
remain optional. Existing upgrades receive aliases to Reviewer/Architect models
so nothing breaks; assign Kimi or another strong visual model to
`workflow_designer` when desired.

## Alt+W behavior

The plan uses separate selected and live markers. It auto-follows live work until
you navigate with Up/Down. Press `c` to return to the live step. The dashboard is
a fullscreen mouse-tracked vertical viewport, so long plans/checklists/native
Todo lists remain reachable by wheel, PageUp/PageDown, Shift+Up/Down, and `g/G`.

## OMP Stats

Still manual. Alt+W shows `http://127.0.0.1:3847`; press `o` or run
`/workflow-stats`. No startup server or persistent widget is installed. The
workflow delegates sync/security/server behavior to the native `omp stats` CLI.

## Verify

```bash
cat VERSION
bash AI_Workflow_Kit/script/workflow_doctor.sh
```

Expected version:

```text
3.2.0
```
