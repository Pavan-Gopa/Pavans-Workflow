# Install Pavan's Workflow

Pavan's Workflow is a project template for [Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi). OMP is the only required host. The installer adds [Graphify](https://github.com/Graphify-Labs/graphify) when it is not already available.

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
Relaunch after changing either Orchestrator entry so its runtime fallback chain
is rebuilt.

Terminal inspection remains available:

```bash
bash AI_Workflow_Kit/script/workflow_models.sh status
omp models find <name>
```

## 5. Start

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

Or launch OMP directly:

```bash
omp --model @workflow_orchestrator
/workflow onboard
```

Useful controls:

- `/workflow status` — reread file-backed state and continue.
- `/workflow <new instruction>` — redirect Main, then re-evaluate routing.
- `Alt+A` — open Agent Hub; inspect, steer, revive, or kill a worker.
- `Alt+W` (or `/workflow-dashboard`) — open the live step, role, model, and provider-quota panel.
- `/pause` — pause Main and subagents at safe boundaries.

## Update

Pull a new template version into a temporary clone and ask an OMP agent to compare/merge it. Do not blindly overwrite `.omp/config.yml` or live workflow state in a project already using the workflow.
