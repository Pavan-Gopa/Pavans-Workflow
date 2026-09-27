#!/usr/bin/env bash
# Idempotent schema v2 migration for workflow STEPS.md and STATE.yaml.
#
#   workflow_migrate.sh check   read-only diagnostics (exit 1 on FAIL)
#   workflow_migrate.sh apply   add stable IDs + schema_version (with backups)

set -euo pipefail

main() {
  local script_dir project_root command="${1:-check}" status=0
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  project_root="$(cd "$script_dir/../.." && pwd)"
  case "$command" in
    check|apply) ;;
    *) echo "usage: workflow_migrate.sh check|apply" >&2; return 2 ;;
  esac
  # shellcheck source=workflow_ts.sh
  source "$script_dir/workflow_ts.sh"
  cd "$project_root"
  wf_run_ts .omp/lib/workflow-migrate-cli.ts "$command" "$project_root" || status=$?
  if (( status == 125 )); then
    echo "FAIL the migration helper needs Node >= 22.6, Bun, or tsx on PATH" >&2
    return 1
  fi
  return "$status"
}

main ${1+"$@"}; exit $?
