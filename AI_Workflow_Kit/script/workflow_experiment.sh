#!/usr/bin/env bash
# Distribution bridge for the Main-only context-economy experiment branch.
# Installed projects carry the full manager from the verified v3 package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACTION="${1:-}"

if [[ "$ACTION" != "_apply-source" ]]; then
  echo "ERROR: this branch entrypoint is an update bridge." >&2
  echo "Install with AI_Workflow_Kit/experiments/context-economy/install.sh." >&2
  echo "Run status/doctor/update/rollback from an installed project." >&2
  exit 2
fi
shift

TARGET="${1:-$PWD}"
exec bash "$REPO_ROOT/AI_Workflow_Kit/experiments/context-economy/install.sh" "$TARGET"
