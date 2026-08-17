#!/usr/bin/env bash
# Automated, deterministic update for Pavan's OMP Workflow framework.
#
# Usage:
#   workflow_update.sh check    # show differences against upstream main without editing
#   workflow_update.sh apply    # safely pull framework updates, migrate schema, and run doctor
#   workflow_update.sh          # defaults to apply
#
# Preserved files (NEVER overwritten):
#   - .omp/config.yml (user model mappings and provider settings)
#   - AI_Workflow_Kit/docs/AI/STATE.yaml (live project state; schema migrated in-place)
#   - AI_Workflow_Kit/docs/STEPS.md (project cards; migrated in-place)
#   - AI_Workflow_Kit/docs/PROJECT_CONTEXT.md (project context)
#   - AI_Workflow_Kit/docs/DECISIONS.md (ADRs)
#   - AI_Workflow_Kit/docs/AI/FEEDBACK.md, REPORT.md, BUG_REPORT.md, SECURITY_REPORT.md

set -euo pipefail

ACTION="apply"
TARGET_DIR="$PWD"

for arg in "$@"; do
  case "$arg" in
    check|apply) ACTION="$arg" ;;
    *)
      if [[ -d "$arg" ]]; then
        TARGET_DIR="$(cd "$arg" && pwd)"
      fi
      ;;
  esac
done

PROJECT_ROOT="$TARGET_DIR"
UPSTREAM_URL="${WF_UPSTREAM_URL:-https://github.com/Pavan-Gopa/Pavans-Workflow.git}"
UPSTREAM_BRANCH="${WF_UPSTREAM_BRANCH:-main}"

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required to update the workflow." >&2
  exit 1
fi

TEMP_CLONE="$(mktemp -d -t pavans-workflow-update.XXXXXX)"
cleanup() {
  rm -rf "$TEMP_CLONE"
}
trap cleanup EXIT

printf 'Fetching upstream workflow from %s (%s)...\n' "$UPSTREAM_URL" "$UPSTREAM_BRANCH"
git clone --depth 1 --branch "$UPSTREAM_BRANCH" --quiet "$UPSTREAM_URL" "$TEMP_CLONE"

UPSTREAM_COMMIT="$(git -C "$TEMP_CLONE" rev-parse --short HEAD)"
UPSTREAM_DATE="$(git -C "$TEMP_CLONE" log -1 --format="%cd (%cr)" --date=short)"
printf 'Upstream commit: %s · %s\n\n' "$UPSTREAM_COMMIT" "$UPSTREAM_DATE"

cd "$PROJECT_ROOT"

# List of framework surfaces to manage
FRAMEWORK_PATHS=(
  ".omp/AGENTS.md"
  ".omp/agents"
  ".omp/commands"
  ".omp/extensions"
  ".omp/lib"
  ".omp/tests"
  "grilling"
  "AI_Workflow_Kit/script"
  "AI_Workflow_Kit/docs/AI/ORCHESTRATOR.md"
  "AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md"
  "AI_Workflow_Kit/docs/AI/METRICS.md"
  "PIPELINE.md"
  "ORCHESTRATOR_FIRST_PROMPT.md"
  "INSTALL.md"
  "README.md"
)

if [[ "$ACTION" == "check" ]]; then
  printf '=== Workflow Update Check (Dry Run) ===\n'
  has_diff=0
  for item in "${FRAMEWORK_PATHS[@]}"; do
    if [[ -d "$TEMP_CLONE/$item" ]]; then
      if [[ ! -d "$PROJECT_ROOT/$item" ]]; then
        printf '[NEW DIR]  %s\n' "$item"
        has_diff=1
      else
        diff_out="$(diff -rq --exclude=".git" --exclude=".DS_Store" --exclude="*.bak*" --exclude="*.lock" "$PROJECT_ROOT/$item" "$TEMP_CLONE/$item" 2>/dev/null || true)"
        if [[ -n "$diff_out" ]]; then
          printf '[MODIFIED] %s\n' "$item"
          printf '%s\n' "$diff_out" | sed 's/^/  /'
          has_diff=1
        fi
      fi
    elif [[ -f "$TEMP_CLONE/$item" ]]; then
      if [[ ! -f "$PROJECT_ROOT/$item" ]]; then
        printf '[NEW FILE] %s\n' "$item"
        has_diff=1
      elif ! cmp -s "$PROJECT_ROOT/$item" "$TEMP_CLONE/$item"; then
        printf '[MODIFIED] %s\n' "$item"
        has_diff=1
      fi
    fi
  done
  if (( has_diff == 0 )); then
    printf 'Workflow is already up to date with upstream %s (%s).\n' "$UPSTREAM_BRANCH" "$UPSTREAM_COMMIT"
  else
    printf '\nRun `bash AI_Workflow_Kit/script/workflow_update.sh apply` or `/work-update` to apply.\n'
  fi
  exit 0
fi

# Apply mode
printf '=== Applying Workflow Update ===\n'

for item in "${FRAMEWORK_PATHS[@]}"; do
  if [[ -d "$TEMP_CLONE/$item" ]]; then
    mkdir -p "$PROJECT_ROOT/$item"
    # Copy directory contents recursively
    cp -R "$TEMP_CLONE/$item/"* "$PROJECT_ROOT/$item/" 2>/dev/null || true
    printf 'OK   synced %s/\n' "$item"
  elif [[ -f "$TEMP_CLONE/$item" ]]; then
    mkdir -p "$(dirname "$PROJECT_ROOT/$item")"
    cp "$TEMP_CLONE/$item" "$PROJECT_ROOT/$item"
    printf 'OK   synced %s\n' "$item"
  fi
done

# Ensure all scripts are executable
chmod +x "$PROJECT_ROOT/AI_Workflow_Kit/script/"*.sh 2>/dev/null || true

# Run schema migration for in-place cards upgrade
printf '\n=== Migrating Step Cards and State Schema ===\n'
if [[ -f "$PROJECT_ROOT/AI_Workflow_Kit/script/workflow_migrate.sh" ]]; then
  bash "$PROJECT_ROOT/AI_Workflow_Kit/script/workflow_migrate.sh" apply || true
fi

# Rebuild graphify if available
if [[ -f "$PROJECT_ROOT/graphify-out/graph.json" && -f "$PROJECT_ROOT/AI_Workflow_Kit/script/graphify_rebuild.sh" ]]; then
  printf '\n=== Rebuilding Graphify Navigation Index ===\n'
  bash "$PROJECT_ROOT/AI_Workflow_Kit/script/graphify_rebuild.sh" || true
fi

# Run workflow doctor
printf '\n=== Running Workflow Doctor Post-Update ===\n'
if [[ -f "$PROJECT_ROOT/AI_Workflow_Kit/script/workflow_doctor.sh" ]]; then
  bash "$PROJECT_ROOT/AI_Workflow_Kit/script/workflow_doctor.sh"
fi

printf '\nWorkflow update completed successfully to commit %s!\n' "$UPSTREAM_COMMIT"
printf 'Your model configurations in .omp/config.yml were preserved intact.\n'
