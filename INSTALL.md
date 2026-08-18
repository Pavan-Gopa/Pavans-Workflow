# Install Pavan's Workflow v3

Pavan's Workflow is a project template for
[Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi). Version 3 adds a
project-local Ponytail policy, conditional Graphify navigation, dependency
locking, and manual OMP Stats.

## Update an existing workflow

From the installed project's root:

```bash
tmp_dir="$(mktemp -d)" && git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw" && bash "$tmp_dir/pw/AI_Workflow_Kit/script/workflow_update.sh" apply; rm -rf "$tmp_dir"
```

Or inside OMP:

```text
/work-update
```

After updating, close and relaunch OMP so project extensions, agents, and skills
are reloaded.

## 1. Install OMP

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

Verify:

```bash
omp --version
```

Start OMP once and authenticate the model providers you intend to use.

## 2A. New project from the template

```bash
git clone https://github.com/Pavan-Gopa/Pavans-Workflow.git my-project
cd my-project
bash install.sh .
```

Replace the template project context and step cards with your product details.
Keep `.omp/`, `AI_Workflow_Kit/`, `grilling/`, and the `ponytail*` directories.

## 2B. Install into an existing repository

```bash
tmp_dir="$(mktemp -d)"
git clone --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw"
bash "$tmp_dir/pw/install.sh" /absolute/path/to/your/project
rm -rf "$tmp_dir"
```

The installer refuses to overwrite existing workflow paths. For an existing
installation, use the updater at the top of this document.

## 3. Graphify

The installer uses the official PyPI package `graphifyy` and installs the tested
version when Graphify is absent:

```bash
uv tool install "graphifyy==0.9.46"
```

Alternatives:

```bash
pipx install "graphifyy==0.9.46"
python3 -m pip install --user "graphifyy==0.9.46"
```

Check:

```bash
graphify --version
```

A different installed version is not silently downgraded; the doctor reports a
warning because a global Graphify tool may be shared with other projects.

The default graph refresh is local AST code-only and incremental:

```bash
bash AI_Workflow_Kit/script/graphify_rebuild.sh fast
```

Use `semantic` only when you deliberately want docs/media extraction through a
configured backend. `.graphifyignore` keeps workflow control-plane files out of
normal product graphs; customize it for your repository if needed.

## 4. First launch and model roles

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

The explicit `bash` form works even when copied files lost executable bits. The
launcher sets the active working directory to the project root; OMP does not
search parent directories for project `.omp/` configuration.

Use **Alt+M -> Roles** to configure:

```text
workflow_orchestrator
workflow_coder
workflow_reviewer
workflow_tester
workflow_architect
workflow_security
```

Each also has a `_backup` role. Backups are optional until needed, but they are
never invoked automatically. Persistent model failure pauses and requires an
explicit instruction such as `continue Tester with backup`.

Progressive onboarding supports quick, guided, and advanced setup. Use:

```text
/workflow onboard
/workflow setup
/workflow status
```

## 5. Ponytail behavior

The installer adds four project skills:

- `ponytail` — automatically loaded only by Coder and backup Coder;
- `ponytail-review` — explicit one-shot complexity review;
- `ponytail-audit` — explicit repository-wide simplification audit;
- `ponytail-debt` — explicit ledger of `ponytail:` markers.

Ponytail never overrides target files, confirmed scope, stable IDs, gates,
validation, security, accessibility, compatibility, data integrity, or the
worker's structured handoff.

## 6. OMP Stats is manual

Version 3 does **not** start OMP Stats at session startup and does not install a
persistent below-editor widget or warning.

Open Alt+W to see the copyable URL:

```text
http://127.0.0.1:3847
```

Press `o` in Alt+W or run:

```text
/workflow-stats
```

That explicit action starts, syncs, and opens Stats. Ordinary workflow turns and
worker completions do not auto-sync it. Passive `/workflow metrics` remain
available independently.

## 7. Verify installation

```bash
bash AI_Workflow_Kit/script/workflow_doctor.sh
```

The doctor checks:

- version and required paths;
- shell syntax and deterministic selftests;
- Ponytail discovery and Coder-only autoload scoping;
- absence of Stats startup/widget/lifecycle hooks;
- Graphify version, graph JSON, and a bounded smoke query when a graph exists;
- model aliases, migration, and passive metrics runtime.

## 8. Useful controls

- `Alt+W` — live workflow dashboard and manual Stats URL.
- `Alt+A` — Agent Hub.
- `Alt+M` — model roles.
- `/workflow status` — reconcile runtime and continue.
- `/workflow why` — explain routing.
- `/work-update` — apply upstream framework update.
- `/work-update check` — dry-run update.
- `/workflow metrics` — passive local report.
- `/workflow-stats` — explicit Stats start/open.

## Update guarantees

`workflow_update.sh` preserves:

- `.omp/config.yml`;
- `STATE.yaml`;
- `STEPS.md`;
- `PROJECT_CONTEXT.md`;
- `DECISIONS.md`;
- feedback, QA, bug, security, and coverage reports.

Before replacing framework files it stores a backup under:

```text
<git-common-dir>/pavans-workflow/update-backups/<timestamp>/
```

The project `.graphifyignore` is installed only when absent and is not overwritten
on later updates.
