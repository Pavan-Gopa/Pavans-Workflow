#!/usr/bin/env bash
# Launch the file-backed workflow in one OMP session.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OMP_MODEL="${WF_OMP_MODEL:-@workflow_orchestrator}"

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
exec omp --cwd "$PROJECT_ROOT" --model "$OMP_MODEL" "/workflow $INSTRUCTION"
