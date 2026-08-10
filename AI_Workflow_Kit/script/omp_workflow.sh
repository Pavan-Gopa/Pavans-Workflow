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

cd "$PROJECT_ROOT"

INSTRUCTION="${*:-onboard}"
FALLBACK_CONFIG="$(mktemp -t pavans-workflow-fallback.XXXXXX)"
trap 'rm -f "$FALLBACK_CONFIG"' EXIT

bash "$SCRIPT_DIR/workflow_models.sh" overlay "$FALLBACK_CONFIG"
omp --config "$FALLBACK_CONFIG" --model "$OMP_MODEL" "/workflow $INSTRUCTION"
