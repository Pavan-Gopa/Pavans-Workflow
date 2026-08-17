# Install Pavan's Workflow

Pavan's Workflow is a project template for [Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi). OMP is the only required host. The installer adds [Graphify](https://github.com/Graphify-Labs/graphify) when it is not already available.

> ⚡ **Workflow v2 is live!** Update any existing project in one command:  
> * **In terminal:** `curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/AI_Workflow_Kit/script/workflow_update.sh | bash`  
> * **Inside OMP chat:** `/work-update` (or `/workflow-update`)

## 1. Install OMP

Official macOS/Linux installer:

```bash
curl -fsSL https://omp.sh/install | sh
```

Other official options:

```bash
# Homebrew
brew install can1357/tap/omp

# Bun 1.3.14+
bun install -g @oh-my-pi/pi-coding-agent
```

Windows PowerShell:

```powershell
irm https://omp.sh/install.ps1 | iex
```

Confirm:

```bash
omp --version
```

Start `omp` once and configure/authenticate the model providers you plan to use. OMP supports many providers; this workflow does not store API keys or credentials.

## 2A. Use as a new repository

```bash
git clone https://github.com/Pavan-Gopa/Pavans-Workflow.git my-project
cd my-project
bash install.sh .
```

Replace the template `PROJECT_CONTEXT.md`, step cards, and product files with your project details. Keep `.omp/`, `AI_Workflow_Kit/`, `grilling/`, and `PIPELINE.md`.

## 2B. Install into an existing repository

```bash
tmp_dir="$(mktemp -d)"
git clone --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pavans-workflow"
bash "$tmp_dir/pavans-workflow/install.sh" /absolute/path/to/your/project
```

The installer refuses to overwrite existing workflow paths. If the target already has `.omp/`, `AI_Workflow_Kit/`, or similarly named workflow files, use the OMP-agent installation prompt below so the agent can merge deliberately.

## 2C. Ask an OMP agent to install it

Open OMP in the target repository and paste:

```text
Install Pavan's Workflow from
https://github.com/Pavan-Gopa/Pavans-Workflow into this repository.

Read README.md and INSTALL.md from that repository first. Preserve this
repository's existing files and Git history. Clone the workflow to a temporary
directory, inspect conflicts, and use its install.sh only when it will not
overwrite existing project configuration. If workflow paths already exist,
merge conservatively instead of replacing them. Ensure Graphify is installed
from the official `graphifyy` package, build the initial graph, and verify that
OMP discovers the project agents, `/workflow` command, and `grilling` skill.
Then show me the available models from `omp models` and ask me to choose the
model mapping for each workflow role before starting product work.
```

This is the safest zero-copy workflow: the agent downloads, checks, installs, and verifies the template in the current repository.

## 3. Install Graphify manually if needed

The installer tries `uv`, then `pipx`, then user-level `pip`. Official recommended installation:

```bash
# Install uv if needed
curl -LsSf https://astral.sh/uv/install.sh | sh

# Official Graphify package has a double y; CLI command is `graphify`
uv tool install graphifyy
```

Confirm:

```bash
graphify --version
```

Graphify's code index is local and deterministic. Semantic extraction of docs/media requires a supported backend; without one, this workflow explicitly falls back to local AST code-only indexing.

## 4. Complete first-run onboarding

Launch:

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Use the explicit `bash` form shown above. It remains valid if a GitHub API
download or AI-assisted file copy dropped the script's executable bit.

The launcher explicitly pins OMP to the installed project root. Project role
aliases and extensions are loaded from that exact directory; OMP does not walk
up parent directories looking for `.omp/`.

Main opens onboarding before the first worker starts. Choose **Configure model
pairs**, press **Alt+M**, and open the model selector's **Roles** view.

Assign both entries for every role:

```text
workflow_<role>          primary model
workflow_<role>_backup   backup model
```

Typing filters the available OMP catalog. Use different providers for the two
entries when possible. `modelRoleStorage: project` makes the UI persist all
assignments in the target project's `.omp/config.yml`.

Return to Main and run `/workflow ready`. Main validates every primary and
backup before dispatching work. Worker changes apply on their next spawn.
Automatic cross-model fallback is disabled: after a persistent worker
model/provider failure, Main records a blocker and waits for an explicit
instruction such as `continue Tester with backup`. A running Main must be
switched live to `@workflow_orchestrator_backup` or relaunched if its own model
is unavailable.

Terminal inspection remains available:

```bash
bash AI_Workflow_Kit/script/workflow_models.sh status
omp models find <name>
```

## 5. Start

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

To launch OMP directly, first change to the installed project root:

```bash
cd /absolute/path/to/your/project
omp --cwd "$PWD" --model @workflow_orchestrator
/workflow onboard
```

If **Alt+M** contains only OMP's built-in roles and **Alt+W** does nothing,
close that process and use `omp_workflow.sh`. The session was started from the
wrong directory and therefore loaded neither `.omp/config.yml` nor
`.omp/extensions/`.

Useful controls:

- `/work-update` (or `/workflow-update`) — fast, automated update from upstream GitHub main.
- `/work-update check` (or `/workflow-update check`) — preview differences against upstream main without editing.
- `/workflow why` — explain the current routing decision, status, and next actor.
- `/workflow status` — reconcile runtime/repository state, then continue.
- `/workflow <new instruction>` — redirect Main, then re-evaluate routing.
- `Alt+A` — open Agent Hub; inspect, steer, revive, or kill a worker.
- `Alt+W` (or `/workflow-dashboard`) — open the responsive live `PLAN | CURRENT | STATISTICS` task board (press `t` to toggle between `STEP CHECKLIST` and `RUN TODO` views; press `o` to open OMP Stats in the browser).
- `bash AI_Workflow_Kit/script/workflow_migrate.sh check|apply` — validate or apply schema v2 with stable checklist IDs.
- `/workflow metrics` — show the passive local workflow report.
- `/workflow metrics rate good|overkill|underchecked [step]` — add an optional Human rating.
- `/workflow metrics reset` — delete only local telemetry and start fresh.
- `/pause` — pause Main and subagents at safe boundaries.
- `continue <role> with backup` — authorize one fresh backup worker after a recorded model/provider failure.
- `/workflow-stats` — check/retry the OMP Stats server, sync session files, and open `http://127.0.0.1:3847` in the browser.

Metrics use the Python standard-library runtime already required by Graphify.
Events default to
`<git-common-dir>/pavans-workflow/metrics/events.jsonl`; the helper resolves the
Git common directory rather than assuming `.git`, so worktrees remain correct.
The store is outside the worktree and cannot enter commits. No historical data
is reconstructed. See `AI_Workflow_Kit/docs/AI/METRICS.md`.

OMP Stats starts automatically with every interactive session at
`http://127.0.0.1:3847` (loopback only). The URL appears in the widget below
the editor and in the Alt+W dashboard footer. A Stats server that was already
running before the workflow started is reused and never stopped on shutdown;
Stats failures never block the workflow.


## Update

Update your workflow framework to the latest upstream release at any time:

### Inside OMP chat
```text
/work-update           # or /workflow-update
/work-update check     # dry-run inspection
```

```bash
# Universal one-liner from any existing workflow project:
curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/AI_Workflow_Kit/script/workflow_update.sh | bash

# Or if workflow_update.sh is already installed:
bash AI_Workflow_Kit/script/workflow_update.sh        # apply update safely
bash AI_Workflow_Kit/script/workflow_update.sh check  # dry-run inspection
```

The update pulls the latest framework files, preserves `.omp/config.yml` (model mappings), preserves live `STATE.yaml`, step cards, decisions, feedback, and reports, runs schema v2 migration, and executes doctor verification.
