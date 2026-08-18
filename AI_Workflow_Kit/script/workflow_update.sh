#!/usr/bin/env bash
# Safe explicit update of Pavan's Workflow framework.
#
# Usage:
#   workflow_update.sh check
#   workflow_update.sh apply   # default
#
# Preserved: .omp/config.yml and all live project state/plan/report files.

set -euo pipefail

ACTION="apply"
TARGET_DIR="$PWD"
for arg in "$@"; do
  case "$arg" in
    check|apply) ACTION="$arg" ;;
    *) [[ -d "$arg" ]] && TARGET_DIR="$(cd "$arg" && pwd)" ;;
  esac
done

PROJECT_ROOT="$TARGET_DIR"
UPSTREAM_URL="${WF_UPSTREAM_URL:-https://github.com/Pavan-Gopa/Pavans-Workflow.git}"
UPSTREAM_BRANCH="${WF_UPSTREAM_BRANCH:-main}"
TEMP_CLONE="$(mktemp -d -t pavans-workflow-update.XXXXXX)"
trap 'rm -rf "$TEMP_CLONE"' EXIT

command -v git >/dev/null 2>&1 || { echo "ERROR: git is required." >&2; exit 1; }
git clone --depth 1 --branch "$UPSTREAM_BRANCH" --quiet "$UPSTREAM_URL" "$TEMP_CLONE"
UPSTREAM_COMMIT="$(git -C "$TEMP_CLONE" rev-parse --short HEAD)"
UPSTREAM_VERSION="$(tr -d '[:space:]' < "$TEMP_CLONE/VERSION" 2>/dev/null || echo unknown)"

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
  "AI_Workflow_Kit/script"
  "AI_Workflow_Kit/vendor"
  "AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md"
  "AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md"
  "AI_Workflow_Kit/docs/AI/METRICS.md"
  "AI_Workflow_Kit/docs/AI/ARCHITECT.md"
  "AI_Workflow_Kit/docs/AI/KICK_CODER.md"
  "AI_Workflow_Kit/docs/AI/KICK_REVIEWER.md"
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
      if ! diff -qr --exclude=.DS_Store --exclude='*.lock' "$dst" "$src" >/dev/null 2>&1; then
        printf '[MODIFIED] %s\n' "$item"; changed=1
      fi
    elif ! cmp -s "$dst" "$src"; then
      printf '[MODIFIED] %s\n' "$item"; changed=1
    fi
  done
  [[ -e .graphifyignore ]] || { printf '[NEW]      .graphifyignore\n'; changed=1; }
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

echo "=== Applying Workflow v$UPSTREAM_VERSION ==="
for item in "${FRAMEWORK_PATHS[@]}"; do
  [[ -e "$TEMP_CLONE/$item" ]] || continue
  if [[ -d "$TEMP_CLONE/$item" ]]; then
    case "$item" in
      ponytail|ponytail-review|ponytail-audit|ponytail-debt|AI_Workflow_Kit/vendor)
        copy_exact_dir "$item"
        ;;
      *) copy_overlay_dir "$item" ;;
    esac
  else
    copy_file "$item"
  fi
done

if [[ ! -e "$PROJECT_ROOT/.graphifyignore" ]]; then
  cp "$TEMP_CLONE/.graphifyignore" "$PROJECT_ROOT/.graphifyignore"
  echo "OK   installed .graphifyignore"
else
  echo "KEEP existing .graphifyignore"
fi

chmod +x "$PROJECT_ROOT"/AI_Workflow_Kit/script/*.sh 2>/dev/null || true

printf '\n=== Migrating durable state ===\n'
bash AI_Workflow_Kit/script/workflow_migrate.sh apply || true

if command -v graphify >/dev/null 2>&1; then
  printf '\n=== Refreshing Graphify (fast/local) ===\n'
  bash AI_Workflow_Kit/script/graphify_rebuild.sh fast || true
fi

printf '\n=== Running workflow doctor ===\n'
bash AI_Workflow_Kit/script/workflow_doctor.sh

printf '\nWorkflow updated to v%s (%s).\n' "$UPSTREAM_VERSION" "$UPSTREAM_COMMIT"
printf 'Live state and .omp/config.yml were preserved.\n'
printf 'Framework backup: %s\n' "$BACKUP_ROOT"
printf 'Restart OMP so updated extensions, agents, and skills are discovered.\n'
