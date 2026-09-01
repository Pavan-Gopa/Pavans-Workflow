#!/usr/bin/env bash
# Install the current Pavan's Workflow release into an existing project or
# prepare a template clone. VERSION is the single release source of truth.

set -euo pipefail

TARGET_INPUT="${1:-.}"

if [[ "$TARGET_INPUT" == "--update" || "$TARGET_INPUT" == "-u" ]]; then
  shift
  command -v git >/dev/null 2>&1 || { echo "ERROR: git is required." >&2; exit 1; }
  TARGET_ROOT="$(cd "${1:-.}" && pwd)"
  TEMP_CLONE="$(mktemp -d -t pavans-workflow-install.XXXXXX)"
  trap 'rm -rf "$TEMP_CLONE"' EXIT
  git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git "$TEMP_CLONE"
  cd "$TARGET_ROOT"
  exec bash "$TEMP_CLONE/AI_Workflow_Kit/script/workflow_update.sh" apply "$TARGET_ROOT"
fi

# Resolved after the --update branch so the script remains runnable through a
# /dev/fd pipe created by `bash <(curl ...) --update`.
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="$(cd "$TARGET_INPUT" && pwd)"
WF_VERSION="$(tr -d '[:space:]' < "$SOURCE_ROOT/VERSION" 2>/dev/null || echo unknown)"
PAYLOAD=(
  ".omp"
  "AI_Workflow_Kit"
  "grilling"
  "ponytail"
  "ponytail-review"
  "ponytail-audit"
  "ponytail-debt"
  "ui-designer"
  "PIPELINE.md"
  "ORCHESTRATOR_FIRST_PROMPT.md"
  "VERSION"
  "CHANGELOG.md"
)

command -v omp >/dev/null 2>&1 || {
  echo "ERROR: OMP is required." >&2
  echo "Install: curl -fsSL https://omp.sh/install | sh" >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: Python 3 is required." >&2
  exit 1
}

if [[ "$SOURCE_ROOT" != "$TARGET_ROOT" ]]; then
  conflicts=()
  for path in "${PAYLOAD[@]}"; do [[ -e "$TARGET_ROOT/$path" ]] && conflicts+=("$path"); done
  if (( ${#conflicts[@]} > 0 )); then
    echo "Workflow paths already exist in $TARGET_ROOT: ${conflicts[*]}" >&2
    echo "Use the safe updater instead:" >&2
    echo "  bash <(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/install.sh) --update" >&2
    exit 1
  fi
  for path in "${PAYLOAD[@]}"; do cp -R "$SOURCE_ROOT/$path" "$TARGET_ROOT/$path"; done
  [[ -e "$TARGET_ROOT/.graphifyignore" ]] || cp "$SOURCE_ROOT/.graphifyignore" "$TARGET_ROOT/.graphifyignore"
fi

chmod +x "$TARGET_ROOT"/AI_Workflow_Kit/script/*.sh 2>/dev/null || true

GITIGNORE="$TARGET_ROOT/.gitignore"
touch "$GITIGNORE"
grep -qxF 'graphify-out/' "$GITIGNORE" || printf '\ngraphify-out/\n' >> "$GITIGNORE"

EXPECTED_GRAPHIFY="$(awk '$1 == "graphify:" { in_graphify=1; next } in_graphify && $1 == "version:" { print $2; exit }' "$TARGET_ROOT/AI_Workflow_Kit/vendor/dependencies.lock" 2>/dev/null || true)"
EXPECTED_GRAPHIFY="${EXPECTED_GRAPHIFY:-0.9.46}"
if ! command -v graphify >/dev/null 2>&1; then
  echo "Installing tested Graphify version $EXPECTED_GRAPHIFY (package graphifyy)..."
  if command -v uv >/dev/null 2>&1; then
    uv tool install "graphifyy==$EXPECTED_GRAPHIFY"
  elif command -v pipx >/dev/null 2>&1; then
    pipx install "graphifyy==$EXPECTED_GRAPHIFY"
  else
    python3 -m pip install --user "graphifyy==$EXPECTED_GRAPHIFY"
  fi
else
  actual="$(graphify --version 2>/dev/null | awk '{print $NF}' || true)"
  if [[ "$actual" != "$EXPECTED_GRAPHIFY" ]]; then
    echo "WARN: Graphify $actual is installed; workflow v$WF_VERSION is pinned to $EXPECTED_GRAPHIFY." >&2
  fi
fi

run_with_timeout() {
  local seconds="$1"; shift
  python3 - "$seconds" "$@" <<'PYTIMEOUT'
import os
import signal
import subprocess
import sys

seconds = float(sys.argv[1])
command = sys.argv[2:]
process = subprocess.Popen(command, start_new_session=True)
try:
    raise SystemExit(process.wait(timeout=seconds))
except subprocess.TimeoutExpired:
    print(f"WARN: timed out after {seconds:g}s: {' '.join(command)}", file=sys.stderr)
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    raise SystemExit(124)
PYTIMEOUT
}

cd "$TARGET_ROOT"
printf '\n=== Installing Workflow v%s Main context policy ===\n' "$WF_VERSION"
bash AI_Workflow_Kit/experiments/context-economy/install.sh "$TARGET_ROOT"
python3 AI_Workflow_Kit/script/workflow_config_repair.py check .omp/config.yml

if [[ "${WF_INSTALL_SKIP_GRAPHIFY:-0}" != "1" ]]; then
  if ! run_with_timeout "${WF_GRAPHIFY_INSTALL_TIMEOUT:-120}" bash AI_Workflow_Kit/script/graphify_rebuild.sh fast; then
    echo "WARN: initial product graph was not built; source tools remain available." >&2
  fi
fi
bash AI_Workflow_Kit/script/workflow_doctor.sh

cat <<MESSAGE

Pavan's Workflow v$WF_VERSION is installed.

Next:
  1. Launch: bash AI_Workflow_Kit/script/omp_workflow.sh
  2. Set the persistent Main model and effort through Alt+M -> Roles -> DEFAULT.
  3. Configure worker primary/backup pairs through Alt+M -> Roles.
  4. Use Alt+W for the live dashboard and Alt+A for the full Agent Hub.
  5. Use the quick-switch control (Alt+Q in the workflow setup) for temporary Main backup use.
  6. OMP Stats remains manual: press o in Alt+W or run /workflow-stats.

The internal workflow_orchestrator role is a hidden managed alias to DEFAULT.
Restart OMP after any framework update so new extensions and model tags load.
MESSAGE
