# Pavan's Workflow

A reusable **multi-model, multi-agent development workflow** for
[Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi), with
[Graphify](https://github.com/Graphify-Labs/graphify) as the shared code
intelligence layer.

This is deliberately more than a multi-agent prompt pack. Each role has an
independent OMP model alias, so you can combine different providers and models
in one controlled workflow:

- one model for orchestration;
- another for architecture and deep discovery;
- a fast implementation model for coding;
- a different model family for independent code review;
- a careful test model for QA;
- a maximum-quality security model for the optional final audit.

You choose the models. The workflow owns role boundaries, fresh context,
routing, file-backed state, Graphify navigation, and human supervision.

## What it automates

```mermaid
flowchart LR
    H[Human supervisor] <--> O[Main Orchestrator]
    O --> C[Fresh Coder]
    C --> O
    O --> R[Fresh Reviewer]
    R --> O
    O --> T[Fresh Tester]
    T --> O
    O -. when needed .-> A[Fresh Architect]
    A --> O
    O -. optional near release .-> S[Fresh Security Reviewer]
    S --> O
```

All routing goes through Main. A worker never hands work to another worker and
never decides the next role.

Default step loop:

```text
Main → Coder → Main verification
     → Reviewer → Main verification
     → Tester → Main verification
     → next step
```

If a gate fails, Main records verified evidence and starts a **new** Coder
session. After three materially identical failures, automatic retries stop and
the workflow surfaces a blocker or routes once to Architect.

## Core properties

### Multi-model by design

Every role resolves through `.omp/config.yml`:

| Role | OMP agent | Model alias |
|------|-----------|-------------|
| Orchestrator | Main session | `@workflow_orchestrator` |
| Architect | `workflow-architect` | `@workflow_architect` |
| Coder | `workflow-coder` | `@workflow_coder` |
| Code Reviewer | `workflow-reviewer` | `@workflow_reviewer` |
| Tester | `workflow-tester` | `@workflow_tester` |
| Security Reviewer | `workflow-security` | `@workflow_security` |

Change one alias to change one model. No role prompt needs to be rewritten.

### Fresh context

Each specialized worker is an independent OMP task-agent session. It receives
only:

1. its stable role contract;
2. the current assignment;
3. source-of-truth file paths;
4. allowed paths and acceptance criteria;
5. access to the live repository and Graphify.

It does not inherit Main's conversation history or another worker's transcript.

### Files are memory

Conversation history is not authoritative. Durable workflow state lives in:

- `AI_Workflow_Kit/docs/AI/STATE.yaml`;
- `AI_Workflow_Kit/docs/STEPS.md`;
- `AI_Workflow_Kit/docs/DECISIONS.md`;
- `AI_Workflow_Kit/docs/AI/FEEDBACK.md`;
- QA, bug, and security report files;
- the actual repository, diff, and test output.

Only Main writes workflow state. Worker completion alone never advances a gate;
Main verifies the real source and evidence first.

### Graphify-first navigation

All roles follow:

```text
GRAPHIFY → FIND
SOURCE CODE → VERIFY
```

Graphify localizes relevant symbols, dependencies, callers/callees, tests, data
flow, and blast radius. Agents then read the smallest relevant real source slice
before editing or concluding.

The included rebuild script attempts semantic extraction and falls back to
local AST code-only indexing when no supported semantic backend is configured.

### Human supervision

OMP Agent Hub keeps the process observable:

- press `Alt+A` to see active agents, role, resolved model, usage, and activity;
- open a worker transcript;
- steer or stop a worker;
- give Main a new instruction at any time;
- restart a role with fresh context.

The workflow automates mechanical routing; it does not remove human control.

### Grilling

The included `grilling` skill turns ambiguous work into explicit decisions and
an execution-ready plan:

- quick mode runs in Main;
- deep mode runs in the read-only Architect agent;
- only Main persists an approved Architecture Package, ADR, glossary change, or
  step plan.

## Requirements

- OMP — required host.
- Git — for cloning/checkpoints.
- Graphify — installed automatically when possible by `install.sh`.
- Python 3.10+ plus `uv` or `pipx` if Graphify is not installed.
- Credentials for whichever model providers you choose in OMP.

No model provider or API key is hard-coded into this repository.

## Install OMP

Official macOS/Linux installer:

```bash
curl -fsSL https://omp.sh/install | sh
```

Homebrew:

```bash
brew install can1357/tap/omp
```

Bun:

```bash
bun install -g @oh-my-pi/pi-coding-agent
```

Windows PowerShell:

```powershell
irm https://omp.sh/install.ps1 | iex
```

Source and current installation options:
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi).

## Fastest installation: ask OMP

Open OMP inside the target project and paste:

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

The agent downloads, installs, checks conflicts, verifies discovery, and leaves
model selection to you.

## Manual installation

New project from the template:

```bash
git clone https://github.com/Pavan-Gopa/Pavans-Workflow.git my-project
cd my-project
./install.sh .
```

Existing project:

```bash
tmp_dir="$(mktemp -d)"
git clone --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pavans-workflow"
"$tmp_dir/pavans-workflow/install.sh" /absolute/path/to/your/project
```

The installer refuses to overwrite existing workflow paths.

Full platform instructions: [INSTALL.md](INSTALL.md).

## Choose your models in OMP

Start OMP from the project root, then press **Alt+M** (or run `/models`) to
open the native model selector. Switch to its **Roles** view, select any
`workflow_*` role, and choose an available provider/model and reasoning level:

- `workflow_orchestrator`
- `workflow_architect`
- `workflow_coder`
- `workflow_reviewer`
- `workflow_tester`
- `workflow_security`

Typing in the selector filters the models currently available through your OMP
providers. Because this template sets `modelRoleStorage: project`, assignments
made in the UI are persisted to this repository's `.omp/config.yml`, not only
to your global OMP profile.

A worker that is already running keeps the model it resolved at launch. The
next worker for that role uses the new assignment automatically. Restart Main
after changing `workflow_orchestrator`.

The terminal catalog remains useful for checking exact selectors:

```bash
omp models
omp models find <name>
```

Editing `.omp/config.yml` directly is only a fallback. The included mappings
are examples, not requirements. Prefer a different model family for Reviewer
than Coder when available.

## Start the workflow

```bash
./AI_Workflow_Kit/script/omp_workflow.sh
```

Or launch OMP normally:

```bash
omp --model @workflow_orchestrator
/workflow start
```

Useful controls:

| Action | Control |
|--------|---------|
| Re-read state and continue | `/workflow status` |
| Redirect Main | `/workflow <new instruction>` |
| Inspect/steer/kill workers | `Alt+A` |
| Pause Main and workers safely | `/pause` |
| Change role model assignments | `Alt+M` or `/models` |
| Query models from the terminal | `omp models` |

## Repository map

```text
.omp/
  AGENTS.md                   shared workflow contract
  config.yml                  role aliases and task lifecycle
  agents/                     five specialized worker definitions
  commands/workflow.md        orchestration entry point
grilling/                     discovery and decision skill
AI_Workflow_Kit/
  docs/                       state, plans, role contracts, reports
  script/omp_workflow.sh      launcher
  script/graphify_rebuild.sh  Graphify refresh
  script/workflow_doctor.sh   installation/configuration check
  script/checkpoint.sh        scoped Git checkpoints
PIPELINE.md                   concise process overview
INSTALL.md                    full installation guide
install.sh                    safe template installer
```

## Extend it

Fork the repository and add roles, change output schemas, replace model aliases,
or adapt the state machine. Keep the central invariants if you want the same
operational behavior:

- one controlling Main;
- fresh workers;
- no worker-to-worker routing;
- Main-only state writes;
- file-backed source of truth;
- Graphify for navigation, source for verification;
- explicit human supervision.

## License

MIT. See [LICENSE](LICENSE).
