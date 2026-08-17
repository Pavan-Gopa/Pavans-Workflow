#!/usr/bin/env bash
# Launch the file-backed workflow in one OMP session with progressive fallback.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v omp >/dev/null 2>&1; then
  echo "ERROR: omp is not on PATH." >&2
  exit 1
fi

for required in ".omp/config.yml" ".omp/extensions/workflow-dashboard.ts"; do
  if [[ ! -f "$PROJECT_ROOT/$required" ]]; then
    echo "ERROR: workflow runtime file is missing: $PROJECT_ROOT/$required" >&2
    exit 1
  fi
done

INSTRUCTION="${*:-onboard}"

# Check whether @workflow_orchestrator alias resolves; fall back to default model if not configured
if bash "$SCRIPT_DIR/workflow_models.sh" validate-level main >/dev/null 2>&1; then
  exec omp --cwd "$PROJECT_ROOT" --model "${WF_OMP_MODEL:-@workflow_orchestrator}" "/workflow $INSTRUCTION"
else
  echo "WARN: @workflow_orchestrator alias not configured or unavailable; launching Main on default model" >&2
  exec omp --cwd "$PROJECT_ROOT" "/workflow $INSTRUCTION"
fi
