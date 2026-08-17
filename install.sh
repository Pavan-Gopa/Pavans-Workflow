#!/usr/bin/env bash
# Install Pavan's Workflow into an existing project, or prepare a template clone.

set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "--update" || "${1:-}" == "-u" ]]; then
  shift
  TARGET_INPUT="${1:-.}"
  cd "$TARGET_INPUT"
  exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/AI_Workflow_Kit/script/workflow_update.sh)"
fi
TARGET_INPUT="${1:-.}"
TARGET_ROOT="$(cd "$TARGET_INPUT" && pwd)"

PAYLOAD=(
  ".omp"
  "AI_Workflow_Kit"
  "grilling"
  "PIPELINE.md"
  "ORCHESTRATOR_FIRST_PROMPT.md"
)

if ! command -v omp >/dev/null 2>&1; then
  echo "ERROR: OMP is required." >&2
  echo "Install: curl -fsSL https://omp.sh/install | sh" >&2
  exit 1
fi

if [[ "$SOURCE_ROOT" != "$TARGET_ROOT" ]]; then
  conflicts=()
  for path in "${PAYLOAD[@]}"; do
    if [[ -e "$TARGET_ROOT/$path" ]]; then
      conflicts+=("$path")
    fi
  done

  if (( ${#conflicts[@]} > 0 )); then
    echo "Workflow already exists in $TARGET_ROOT." >&2
    echo "To update to the latest release safely, run:" >&2
    echo "  curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/AI_Workflow_Kit/script/workflow_update.sh | bash" >&2
    exit 1
  fi

  for path in "${PAYLOAD[@]}"; do
    cp -R "$SOURCE_ROOT/$path" "$TARGET_ROOT/$path"
  done
fi

# GitHub API downloads and AI-assisted file copies may lose executable bits.
# Restore them, while keeping every documented command runnable through `bash`.
if ! chmod +x "$TARGET_ROOT"/AI_Workflow_Kit/script/*.sh; then
  echo "WARN: could not restore script executable bits; use the documented bash commands." >&2
fi

GITIGNORE="$TARGET_ROOT/.gitignore"
if [[ ! -f "$GITIGNORE" ]] || ! grep -qxF 'graphify-out/' "$GITIGNORE"; then
  printf '\ngraphify-out/\n' >> "$GITIGNORE"
fi

if ! command -v graphify >/dev/null 2>&1; then
  echo "Installing Graphify (PyPI package: graphifyy)..."
  if command -v uv >/dev/null 2>&1; then
    uv tool install graphifyy
  elif command -v pipx >/dev/null 2>&1; then
    pipx install graphifyy
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m pip install --user graphifyy || {
      echo "ERROR: Graphify installation failed." >&2
      echo "Install uv, then run: uv tool install graphifyy" >&2
      exit 1
    }
  else
    echo "ERROR: Graphify needs Python 3.10+ and uv or pipx." >&2
    exit 1
  fi
fi

cd "$TARGET_ROOT"
if ! bash ./AI_Workflow_Kit/script/graphify_rebuild.sh; then
  echo "WARN: initial Graphify index was not built; the workflow can rebuild it after product source exists." >&2
fi

bash ./AI_Workflow_Kit/script/workflow_doctor.sh

cat <<'MESSAGE'

Pavan's Workflow is installed.

Next:
  1. Launch: bash AI_Workflow_Kit/script/omp_workflow.sh
  2. Follow the first-run onboarding screen.
  3. Press Alt+M to assign a primary and backup model to every workflow role.
  4. Press Alt+A to supervise active workers.
  5. Press Alt+W to inspect the live plan, current work, statistics, and current-session model tokens.

OMP loads the project agents, /workflow command, live dashboard, passive metrics helper, and grilling skill automatically.
MESSAGE
