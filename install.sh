#!/usr/bin/env bash
# Install Pavan's Workflow v3 into an existing project or prepare a template clone.

set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_INPUT="${1:-.}"

if [[ "$TARGET_INPUT" == "--update" || "$TARGET_INPUT" == "-u" ]]; then
  shift
  TARGET_ROOT="$(cd "${1:-.}" && pwd)"
  TEMP_CLONE="$(mktemp -d -t pavans-workflow-install.XXXXXX)"
  trap 'rm -rf "$TEMP_CLONE"' EXIT
  git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$TEMP_CLONE"
  cd "$TARGET_ROOT"
  exec bash "$TEMP_CLONE/AI_Workflow_Kit/script/workflow_update.sh" apply
fi

TARGET_ROOT="$(cd "$TARGET_INPUT" && pwd)"
PAYLOAD=(
  ".omp"
  "AI_Workflow_Kit"
  "grilling"
  "ponytail"
  "ponytail-review"
  "ponytail-audit"
  "ponytail-debt"
  "PIPELINE.md"
  "ORCHESTRATOR_FIRST_PROMPT.md"
  "VERSION"
  "CHANGELOG.md"
)

if ! command -v omp >/dev/null 2>&1; then
  echo "ERROR: OMP is required." >&2
  echo "Install: curl -fsSL https://omp.sh/install | sh" >&2
  exit 1
fi

if [[ "$SOURCE_ROOT" != "$TARGET_ROOT" ]]; then
  conflicts=()
  for path in "${PAYLOAD[@]}"; do
    [[ -e "$TARGET_ROOT/$path" ]] && conflicts+=("$path")
  done
  if (( ${#conflicts[@]} > 0 )); then
    echo "Workflow paths already exist in $TARGET_ROOT: ${conflicts[*]}" >&2
    echo "Use the safe updater instead:" >&2
    echo "  git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git /tmp/pw && bash /tmp/pw/AI_Workflow_Kit/script/workflow_update.sh && rm -rf /tmp/pw" >&2
    exit 1
  fi
  for path in "${PAYLOAD[@]}"; do cp -R "$SOURCE_ROOT/$path" "$TARGET_ROOT/$path"; done
  if [[ ! -e "$TARGET_ROOT/.graphifyignore" ]]; then
    cp "$SOURCE_ROOT/.graphifyignore" "$TARGET_ROOT/.graphifyignore"
  fi
fi

chmod +x "$TARGET_ROOT"/AI_Workflow_Kit/script/*.sh 2>/dev/null || true

GITIGNORE="$TARGET_ROOT/.gitignore"
touch "$GITIGNORE"
grep -qxF 'graphify-out/' "$GITIGNORE" || printf '\ngraphify-out/\n' >> "$GITIGNORE"

EXPECTED_GRAPHIFY=0.9.46
if ! command -v graphify >/dev/null 2>&1; then
  echo "Installing tested Graphify version $EXPECTED_GRAPHIFY (package graphifyy)..."
  if command -v uv >/dev/null 2>&1; then
    uv tool install "graphifyy==$EXPECTED_GRAPHIFY"
  elif command -v pipx >/dev/null 2>&1; then
    pipx install "graphifyy==$EXPECTED_GRAPHIFY"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m pip install --user "graphifyy==$EXPECTED_GRAPHIFY"
  else
    echo "ERROR: Graphify needs Python 3.10+ and uv or pipx." >&2
    exit 1
  fi
else
  actual="$(graphify --version 2>/dev/null | awk '{print $NF}' || true)"
  if [[ "$actual" != "$EXPECTED_GRAPHIFY" ]]; then
    echo "WARN: Graphify $actual is installed; workflow v3 was validated with $EXPECTED_GRAPHIFY." >&2
    echo "      To align: uv tool install --force 'graphifyy==$EXPECTED_GRAPHIFY'" >&2
  fi
fi

cd "$TARGET_ROOT"
if ! bash AI_Workflow_Kit/script/graphify_rebuild.sh fast; then
  echo "WARN: initial product graph was not built; source tools remain available." >&2
fi
bash AI_Workflow_Kit/script/workflow_doctor.sh

cat <<'MESSAGE'

Pavan's Workflow v3 is installed.

Next:
  1. Launch: bash AI_Workflow_Kit/script/omp_workflow.sh
  2. Complete onboarding and model-role setup.
  3. Use Alt+W for the live workflow dashboard.
  4. OMP Stats is manual: its URL is shown in Alt+W; press o or run /workflow-stats to start it explicitly.

Coder agents load the project-local Ponytail policy automatically. Other roles
keep their independent correctness, QA, architecture, and security contracts.
MESSAGE
