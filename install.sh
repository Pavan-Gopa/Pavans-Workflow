#!/usr/bin/env bash
# Install Pavan's Workflow v3.3 into an existing project or prepare a template clone.

set -euo pipefail

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

# Resolved after the --update branch so the script stays runnable through
# `curl ... | bash -s -- --update`, where BASH_SOURCE is a /dev/fd pipe.
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_ROOT="$(cd "$TARGET_INPUT" && pwd)"
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

if [[ "$SOURCE_ROOT" != "$TARGET_ROOT" ]]; then
  conflicts=()
  for path in "${PAYLOAD[@]}"; do [[ -e "$TARGET_ROOT/$path" ]] && conflicts+=("$path"); done
  if (( ${#conflicts[@]} > 0 )); then
    echo "Workflow paths already exist in $TARGET_ROOT: ${conflicts[*]}" >&2
    echo "Use the safe updater instead:" >&2
    echo "  ( tmp_dir=\"\$(mktemp -d)\" && git clone -q --depth 1 https://github.com/Pavan-Gopa/Pavans-Workflow.git \"\$tmp_dir/pw\" && bash \"\$tmp_dir/pw/AI_Workflow_Kit/script/workflow_update.sh\" apply; rc=\$?; rm -rf \"\$tmp_dir\"; exit \"\$rc\" )" >&2
    exit 1
  fi
  for path in "${PAYLOAD[@]}"; do cp -R "$SOURCE_ROOT/$path" "$TARGET_ROOT/$path"; done
  [[ -e "$TARGET_ROOT/.graphifyignore" ]] || cp "$SOURCE_ROOT/.graphifyignore" "$TARGET_ROOT/.graphifyignore"
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
    echo "WARN: Graphify $actual is installed; workflow v3.2 was validated with $EXPECTED_GRAPHIFY." >&2
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
printf '\n=== Installing Workflow v3.3 Main context policy ===\n'
bash AI_Workflow_Kit/experiments/context-economy/install.sh "$TARGET_ROOT"

if [[ "${WF_INSTALL_SKIP_GRAPHIFY:-0}" != "1" ]]; then
  if ! run_with_timeout "${WF_GRAPHIFY_INSTALL_TIMEOUT:-120}" bash AI_Workflow_Kit/script/graphify_rebuild.sh fast; then
    echo "WARN: initial product graph was not built; source tools remain available." >&2
  fi
fi
bash AI_Workflow_Kit/script/workflow_doctor.sh

cat <<'MESSAGE'

Pavan's Workflow v3.3 is installed.

Next:
  1. Launch: bash AI_Workflow_Kit/script/omp_workflow.sh
  2. Complete onboarding and model-role setup through Alt+M -> Roles.
  3. Use Alt+W for the live workflow dashboard; its live cursor follows current work.
  4. With an empty composer, Tab jumps from Main directly into the running worker; Tab or Esc returns to Main.
  5. OMP Stats remains manual: press o in Alt+W or run /workflow-stats.
  6. Optional: assign workflow_designer to Kimi or another strong visual model in Alt+M.

Main-only context economy keeps worker sessions uncompacted while preserving the
Orchestrator across long runs. Coder agents load Ponytail automatically. Design
Advisor and Designer load the project-local ui-designer skill only when the Human
explicitly requests them.
MESSAGE
