#!/usr/bin/env bash
# Validate the portable OMP workflow installation without invoking a model.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

failures=0

check_path() {
  if [[ -e "$1" ]]; then
    printf 'OK   %s\n' "$1"
  else
    printf 'FAIL %s\n' "$1" >&2
    failures=$((failures + 1))
  fi
}

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    printf 'OK   command: %s\n' "$1"
  else
    printf 'FAIL command: %s\n' "$1" >&2
    failures=$((failures + 1))
  fi
}

check_command omp
check_command graphify

check_path .omp/config.yml
check_path .omp/AGENTS.md
check_path .omp/commands/workflow.md
check_path grilling/SKILL.md
check_path AI_Workflow_Kit/docs/AI/STATE.yaml

for role in coder reviewer tester architect security; do
  check_path ".omp/agents/workflow-$role.md"
done

for alias in workflow_orchestrator workflow_coder workflow_reviewer workflow_tester workflow_architect workflow_security; do
  if grep -q "^[[:space:]]*$alias:" .omp/config.yml; then
    printf 'OK   model alias: %s\n' "$alias"
  else
    printf 'FAIL model alias: %s\n' "$alias" >&2
    failures=$((failures + 1))
  fi
done

if [[ -f graphify-out/graph.json ]]; then
  printf 'OK   graphify-out/graph.json\n'
else
  printf 'WARN graphify-out/graph.json missing; run graphify_rebuild.sh after source exists\n'
fi

if (( failures > 0 )); then
  printf '\nWorkflow doctor: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nWorkflow doctor: ready\n'
printf 'Launch: ./AI_Workflow_Kit/script/omp_workflow.sh\n'
