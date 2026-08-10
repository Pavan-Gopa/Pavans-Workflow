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
./install.sh .
```

Replace the template `PROJECT_CONTEXT.md`, step cards, and product files with your project details. Keep `.omp/`, `AI_Workflow_Kit/`, `grilling/`, and `PIPELINE.md`.

## 2B. Install into an existing repository

```bash
tmp_dir="$(mktemp -d)"
git clone --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pavans-workflow"
"$tmp_dir/pavans-workflow/install.sh" /absolute/path/to/your/project
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

## 4. Choose a model for each role

Launch OMP from the target project's root and press **Alt+M**, or run:

```text
/models
```

In the model selector's **Roles** view, choose each `workflow_*` role and assign
an available provider/model plus reasoning level. Type in the selector to
filter the available catalog.

This template sets `modelRoleStorage: project`, so the UI persists these role
assignments under `modelRoles` in the target project's `.omp/config.yml`.
Manual YAML editing is not required.

For a terminal listing or exact-name search:

```bash
omp models
omp models find <name>
```

Every role may use a different provider/model. Existing running workers keep
the model resolved at launch; the next worker uses the changed assignment.
Restart Main after changing `workflow_orchestrator`.

## 5. Start

```bash
./AI_Workflow_Kit/script/omp_workflow.sh
```

Or:

```bash
omp --model @workflow_orchestrator
/workflow start
```

Useful controls:

- `/workflow status` — reread file-backed state and continue.
- `/workflow <new instruction>` — redirect Main, then re-evaluate routing.
- `Alt+A` — open Agent Hub; inspect, steer, revive, or kill a worker.
- `/pause` — pause Main and subagents at safe boundaries.

## Update

Pull a new template version into a temporary clone and ask an OMP agent to compare/merge it. Do not blindly overwrite `.omp/config.yml` or live workflow state in a project already using the workflow.
