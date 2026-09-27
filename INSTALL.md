# Install Pavan's Workflow

## Requirements

- OMP (`omp`):

  ```bash
  curl -fsSL https://omp.sh/install | sh          # macOS / Linux
  brew install can1357/tap/omp                    # or Homebrew
  bun install -g @oh-my-pi/pi-coding-agent        # or Bun
  irm https://omp.sh/install.ps1 | iex            # Windows PowerShell
  ```

  The extensions are type-checked against the OMP release pinned in
  `AI_Workflow_Kit/vendor/dependencies.lock`; the doctor warns on a different
  major version.
- `git`, Python 3.9+ (the macOS system `python3` is fine).
- Optional: Graphify (tested `graphifyy==0.9.46`). The installer installs it
  with `uv`, `pipx`, or `pip --user` when missing; without it the workflow uses
  source tools.

## Install into a project

From the project root (existing repository or a fresh `git init`):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/install.sh) .
```

Equivalent explicit-git form:

```bash
(
  set -Eeuo pipefail
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
  git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$tmp_dir/pw"
  bash "$tmp_dir/pw/install.sh" "$PWD"
)
```

What happens:

1. Framework files listed in `AI_Workflow_Kit/framework.manifest` are copied.
   Files you already have with different content (for example your own
   `.omp/AGENTS.md`) stop the install with a list — nothing is written.
2. Project state (`STATE.yaml`, `STEPS.md`, `PROJECT_CONTEXT.md`, reports) is
   rendered from `AI_Workflow_Kit/templates/`.
3. `.omp/config.yml` is created, or — if you already have one — the workflow
   roles, task policy, and Main-only context settings are merged into it.
4. `graphify-out/` is added to `.gitignore`; an initial code graph is built
   (skip with `WF_INSTALL_SKIP_GRAPHIFY=1`, timeout `WF_GRAPHIFY_INSTALL_TIMEOUT`).
5. The doctor runs.

Your `README.md`, `INSTALL.md`, `CHANGELOG.md`, and `VERSION` are never
touched; the framework version lives in `AI_Workflow_Kit/VERSION`.

Pin a release with `--ref v3.5.0` (default: the newest `vX.Y.Z` tag, else `main`).

## Update

Close OMP for the project, then:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/install.sh) --update
```

or, inside an installed project, `/workflow-update` in OMP, or
`bash AI_Workflow_Kit/script/workflow_update.sh check|apply [--ref <tag>] [--refresh-graphify]`.

The update:

- replaces framework files from the release manifest and removes files the
  release deleted — unless you modified them locally (they are kept and listed);
- never touches files you added under `.omp/` or elsewhere;
- keeps project state, model selections, custom `.graphifyignore` rules, and the
  Graphify index; runs the state migration and the doctor;
- backs up every framework file it touches to
  `<git-common-dir>/pavans-workflow/update-backups/<timestamp>/` and restores
  them automatically if the framework step fails (the state migration keeps its
  own `.bak-*` copies; a failing doctor is reported, not rolled back).

Restart OMP afterwards.

### From 3.4.x or older

Run the curl update once. It removes the old `AI_Workflow_Kit/experiments/`
payloads and bridge scripts, removes the legacy config marker, and restores a
`README.md`/`CHANGELOG.md`/`VERSION` that a pre-3.5 updater overwrote moments
before (from that updater's backup). Root `VERSION`/`CHANGELOG.md` files left by
older releases are pointed out; delete them if they are not your product's.

The old in-project updater (`bash AI_Workflow_Kit/script/workflow_update.sh apply`
from a 3.4 install) also works: while copying it replaces itself, lands on a
hand-over line in the new script, and finishes with the 3.5 manager. If an
older copy ever stops early, run the command above once more; OMP also warns
at startup when `AI_Workflow_Kit/installed.manifest` is missing.

## Configure models

Open **Alt+M → Roles**:

- **DEFAULT** — the persistent Main model and effort (complete both selector steps).
- `workflow_*` — worker primaries; `workflow_*_backup` — Human-authorized backups.
- Keep `workflow_reviewer` on a different model than `workflow_coder` **and**
  `workflow_coder_backup`, and spread backups across providers:

  ```bash
  python3 AI_Workflow_Kit/script/workflow_model_diversity.py
  ```

`workflow_orchestrator` is intentionally hidden: it aliases `@default`.

## Launch

```bash
bash AI_Workflow_Kit/script/omp_workflow.sh
```

## Verify

```bash
cat AI_Workflow_Kit/VERSION
bash AI_Workflow_Kit/script/workflow_doctor.sh
```

Expected version:

```text
3.5.0
```
