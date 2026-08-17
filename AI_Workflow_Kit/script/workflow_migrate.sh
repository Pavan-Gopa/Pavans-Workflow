#!/usr/bin/env bash
# Idempotent schema v2 migration for workflow STEPS.md and STATE.yaml.
#
#   workflow_migrate.sh check   read-only diagnostics (exit 1 on FAIL)
#   workflow_migrate.sh apply   add stable IDs + schema_version (with backups)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

command="${1:-check}"
case "$command" in
  check|apply) ;;
  *)
    echo "usage: workflow_migrate.sh check|apply" >&2
    exit 2
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL node is required for the migration helper" >&2
  exit 1
fi

exec node --no-warnings --experimental-strip-types .omp/lib/workflow-migrate-cli.ts "$command" "$PROJECT_ROOT"
