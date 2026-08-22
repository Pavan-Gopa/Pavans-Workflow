#!/usr/bin/env bash
# Safe explicit update of Pavan's Workflow framework.
#
# Usage:
#   workflow_update.sh check [project]
#   workflow_update.sh apply [project] [--refresh-graphify]
#
# Preserved: live project state/plan/report files and existing model selections.

set -euo pipefail

ACTION="apply"
TARGET_DIR="$PWD"
REFRESH_GRAPHIFY="${WF_UPDATE_REFRESH_GRAPHIFY:-0}"
for arg in "$@"; do
  case "$arg" in
    check|apply) ACTION="$arg" ;;
    --refresh-graphify) REFRESH_GRAPHIFY=1 ;;
    --skip-graphify) REFRESH_GRAPHIFY=0 ;;
    *) [[ -d "$arg" ]] && TARGET_DIR="$(cd "$arg" && pwd)" ;;
  esac
done

PROJECT_ROOT="$TARGET_DIR"
UPSTREAM_URL="${WF_UPSTREAM_URL:-https://github.com/Pavan-Gopa/Pavans-Workflow.git}"
UPSTREAM_BRANCH="${WF_UPSTREAM_BRANCH:-main}"
GRAPHIFY_TIMEOUT="${WF_GRAPHIFY_UPDATE_TIMEOUT:-120}"
TEMP_CLONE="$(mktemp -d -t pavans-workflow-update.XXXXXX)"
trap 'rm -rf "$TEMP_CLONE"' EXIT

command -v git >/dev/null 2>&1 || { echo "ERROR: git is required." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required." >&2; exit 1; }
git clone --depth 1 --branch "$UPSTREAM_BRANCH" --quiet "$UPSTREAM_URL" "$TEMP_CLONE"
UPSTREAM_COMMIT="$(git -C "$TEMP_CLONE" rev-parse --short HEAD)"
UPSTREAM_VERSION="$(tr -d '[:space:]' < "$TEMP_CLONE/VERSION" 2>/dev/null || echo unknown)"
LOCAL_VERSION="$(tr -d '[:space:]' < "$PROJECT_ROOT/VERSION" 2>/dev/null || echo 0.0.0)"

version_relation="$(python3 - "$LOCAL_VERSION" "$UPSTREAM_VERSION" <<'PYVERSION'
import re
import sys

def version(value: str) -> tuple[int, ...]:
    parts = []
    for token in value.strip().lstrip("vV").split("."):
        match = re.match(r"(\d+)", token)
        parts.append(int(match.group(1)) if match else 0)
    return tuple((parts + [0, 0, 0])[:3])

local = version(sys.argv[1])
upstream = version(sys.argv[2])
print("older" if upstream < local else "newer" if upstream > local else "same")
PYVERSION
)"
if [[ "$ACTION" == "apply" && "$version_relation" == "older" && "${WF_ALLOW_WORKFLOW_DOWNGRADE:-0}" != "1" ]]; then
  echo "ERROR: refusing workflow downgrade from v$LOCAL_VERSION to upstream v$UPSTREAM_VERSION." >&2
  echo "Use a newer upstream release, or set WF_ALLOW_WORKFLOW_DOWNGRADE=1 only for an intentional rollback." >&2
  exit 1
fi

FRAMEWORK_PATHS=(
  ".omp/AGENTS.md"
  ".omp/agents"
  ".omp/commands"
  ".omp/extensions"
  ".omp/lib"
  ".omp/tests"
  "grilling"
  "ponytail"
  "ponytail-review"
  "ponytail-audit"
  "ponytail-debt"
  "ui-designer"
  "AI_Workflow_Kit/script"
  "AI_Workflow_Kit/vendor"
  "AI_Workflow_Kit/experiments/context-economy"
  "AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md"
  "AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md"
  "AI_Workflow_Kit/docs/AI/MODELS.md"
  "AI_Workflow_Kit/docs/AI/METRICS.md"
  "AI_Workflow_Kit/docs/AI/ARCHITECT.md"
  "AI_Workflow_Kit/docs/AI/KICK_CODER.md"
  "AI_Workflow_Kit/docs/AI/KICK_REVIEWER.md"
  "AI_Workflow_Kit/docs/AI/DESIGNER.md"
  "AI_Workflow_Kit/docs/AI/KICK_DESIGNER.md"
  "PIPELINE.md"
  "ORCHESTRATOR_FIRST_PROMPT.md"
  "INSTALL.md"
  "README.md"
  "VERSION"
  "CHANGELOG.md"
)

printf 'Upstream: %s · version %s · commit %s\n\n' "$UPSTREAM_BRANCH" "$UPSTREAM_VERSION" "$UPSTREAM_COMMIT"
cd "$PROJECT_ROOT"

if [[ "$ACTION" == "check" ]]; then
  echo "=== Workflow Update Check (read-only) ==="
  changed=0
  for item in "${FRAMEWORK_PATHS[@]}"; do
    src="$TEMP_CLONE/$item"; dst="$PROJECT_ROOT/$item"
    [[ -e "$src" ]] || continue
    if [[ ! -e "$dst" ]]; then
      printf '[NEW]      %s\n' "$item"; changed=1
    elif [[ -d "$src" ]]; then
      if ! diff -qr -x .DS_Store "$dst" "$src" >/dev/null 2>&1; then
        printf '[MODIFIED] %s\n' "$item"; changed=1
      fi
    elif ! cmp -s "$dst" "$src"; then
      printf '[MODIFIED] %s\n' "$item"; changed=1
    fi
  done
  [[ -e .graphifyignore ]] || { printf '[NEW]      .graphifyignore\n'; changed=1; }
  if [[ ! -f .omp/config.yml ]]; then
    printf '[REPAIR]   .omp/config.yml missing; updater will recover the newest workflow config backup\n'
    changed=1
  elif ! python3 "$TEMP_CLONE/AI_Workflow_Kit/script/workflow_config_repair.py" check .omp/config.yml >/dev/null 2>&1; then
    printf '[REPAIR]   .omp/config.yml needs workflow role/YAML/task-policy repair\n'
    changed=1
  fi
  if ! grep -Eq '^[[:space:]]*workflow_orchestrator:[[:space:]]*"@default"([[:space:]]|$)' .omp/config.yml 2>/dev/null; then
    printf '[MIGRATE]  Main model slot -> DEFAULT / workflow_orchestrator alias\n'; changed=1
  fi
  if [[ ! -f .omp/workflow-context-policy.json || ! -f .omp/lib/workflow-context-economy.ts ]]; then
    printf '[MIGRATE]  Main-only context economy v3\n'; changed=1
  fi
  if [[ -f .graphifyignore ]] && ! grep -qxF '/ui-designer/' .graphifyignore; then
    printf '[ADD]       .graphifyignore -> /ui-designer/\n'; changed=1
  fi
  (( changed == 0 )) && echo "Already up to date."
  exit 0
fi

COMMON_GIT_DIR="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)"
case "$COMMON_GIT_DIR" in /*) ;; *) COMMON_GIT_DIR="$PROJECT_ROOT/$COMMON_GIT_DIR" ;; esac
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="$COMMON_GIT_DIR/pavans-workflow/update-backups/$STAMP"
mkdir -p "$BACKUP_ROOT"

backup_path() {
  local path="$1"
  [[ -e "$PROJECT_ROOT/$path" ]] || return 0
  mkdir -p "$BACKUP_ROOT/$(dirname "$path")"
  cp -R "$PROJECT_ROOT/$path" "$BACKUP_ROOT/$path"
}

copy_file() {
  local path="$1"
  backup_path "$path"
  mkdir -p "$PROJECT_ROOT/$(dirname "$path")"
  cp "$TEMP_CLONE/$path" "$PROJECT_ROOT/$path"
  printf 'OK   synced %s\n' "$path"
}

copy_overlay_dir() {
  local path="$1"
  backup_path "$path"
  mkdir -p "$PROJECT_ROOT/$path"
  cp -R "$TEMP_CLONE/$path/." "$PROJECT_ROOT/$path/"
  printf 'OK   synced %s/\n' "$path"
}

copy_exact_dir() {
  local path="$1"
  backup_path "$path"
  rm -rf "$PROJECT_ROOT/$path"
  mkdir -p "$(dirname "$PROJECT_ROOT/$path")"
  cp -R "$TEMP_CLONE/$path" "$PROJECT_ROOT/$path"
  printf 'OK   replaced managed %s/\n' "$path"
}

repair_model_config() {
  backup_path ".omp/config.yml"
  python3 "$TEMP_CLONE/AI_Workflow_Kit/script/workflow_config_repair.py" \
    repair "$PROJECT_ROOT" "$TEMP_CLONE/.omp/config.yml" "$COMMON_GIT_DIR"
}

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

echo "=== Applying Workflow v$UPSTREAM_VERSION ==="
for item in "${FRAMEWORK_PATHS[@]}"; do
  [[ -e "$TEMP_CLONE/$item" ]] || continue
  if [[ -d "$TEMP_CLONE/$item" ]]; then
    case "$item" in
      ponytail|ponytail-review|ponytail-audit|ponytail-debt|ui-designer|AI_Workflow_Kit/vendor|AI_Workflow_Kit/experiments/context-economy)
        copy_exact_dir "$item" ;;
      *) copy_overlay_dir "$item" ;;
    esac
  else
    copy_file "$item"
  fi
done

printf '\n=== Preserving / repairing project model roles ===\n'
repair_model_config

printf '\n=== Installing Workflow v3.3 Main context policy ===\n'
bash "$TEMP_CLONE/AI_Workflow_Kit/experiments/context-economy/install.sh" "$PROJECT_ROOT"

if [[ ! -e "$PROJECT_ROOT/.graphifyignore" ]]; then
  cp "$TEMP_CLONE/.graphifyignore" "$PROJECT_ROOT/.graphifyignore"
  echo "OK   installed .graphifyignore"
elif ! grep -qxF '/ui-designer/' "$PROJECT_ROOT/.graphifyignore"; then
  backup_path ".graphifyignore"
  printf '\n/ui-designer/\n' >> "$PROJECT_ROOT/.graphifyignore"
  echo "OK   extended .graphifyignore for ui-designer/"
else
  echo "KEEP existing .graphifyignore"
fi

chmod +x "$PROJECT_ROOT"/AI_Workflow_Kit/script/*.sh 2>/dev/null || true

printf '\n=== Migrating durable state ===\n'
bash AI_Workflow_Kit/script/workflow_migrate.sh apply || true

if [[ "$REFRESH_GRAPHIFY" != "1" ]]; then
  printf '\n=== Graphify refresh deferred (default) ===\n'
  printf 'The existing graph was preserved. Refresh later with:\n'
  printf '  bash AI_Workflow_Kit/script/graphify_rebuild.sh fast\n'
elif command -v graphify >/dev/null 2>&1; then
  printf '\n=== Refreshing Graphify (fast/local, timeout %ss) ===\n' "$GRAPHIFY_TIMEOUT"
  if ! run_with_timeout "$GRAPHIFY_TIMEOUT" bash AI_Workflow_Kit/script/graphify_rebuild.sh fast; then
    echo "WARN: Graphify refresh did not finish successfully; update continues with the last valid graph/source tools." >&2
  fi
else
  echo "WARN: Graphify refresh requested, but graphify is not on PATH; update continues." >&2
fi

printf '\n=== Running workflow doctor ===\n'
bash AI_Workflow_Kit/script/workflow_doctor.sh

printf '\nWorkflow updated to v%s (%s).\n' "$UPSTREAM_VERSION" "$UPSTREAM_COMMIT"
printf 'Live state and existing model selections were preserved/recovered.\n'
printf 'Main context economy and Quick Worker Focus are installed as stable v3.3 features.\n'
printf 'Framework backup: %s\n' "$BACKUP_ROOT"
printf 'Restart OMP so updated extensions, agents, and skills are discovered.\n'
