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

check_script() {
  if [[ ! -f "$1" ]]; then
    printf 'FAIL %s\n' "$1" >&2
    failures=$((failures + 1))
    return
  fi
  if bash -n "$1"; then
    printf 'OK   shell syntax: %s\n' "$1"
  else
    printf 'FAIL shell syntax: %s\n' "$1" >&2
    failures=$((failures + 1))
  fi
  if [[ -x "$1" ]]; then
    printf 'OK   executable: %s\n' "$1"
  else
    printf 'WARN not executable: %s (launch with bash; installer repairs this)\n' "$1"
  fi
}

check_command omp
check_command graphify

check_path .omp/config.yml
check_path .omp/AGENTS.md
check_path .omp/commands/workflow.md
check_path .omp/commands/workflow-update.md
check_path .omp/commands/work-update.md
check_path .omp/extensions/workflow-dashboard.ts
check_path .omp/extensions/workflow-stats.ts
check_path .omp/lib/workflow-dashboard-core.ts
check_path .omp/lib/workflow-runtime-todo.ts
check_path .omp/lib/workflow-consistency.ts
check_path .omp/lib/workflow-migration.ts
check_path .omp/lib/workflow-migrate-cli.ts
check_path .omp/lib/workflow-model-readiness.ts
check_path .omp/lib/workflow-routing.ts
check_path .omp/lib/workflow-stats.ts
check_path .omp/lib/workflow-stats-runtime.ts
check_path .omp/tests/workflow-dashboard.selftest.ts
check_path .omp/tests/workflow-runtime-todo.selftest.ts
check_path .omp/tests/workflow-consistency.selftest.ts
check_path .omp/tests/workflow-migration.selftest.ts
check_path .omp/tests/workflow-model-readiness.selftest.ts
check_path .omp/tests/workflow-routing.selftest.ts
check_path .omp/tests/workflow-stats.selftest.ts
check_path grilling/SKILL.md
check_path AI_Workflow_Kit/docs/AI/STATE.yaml
check_path AI_Workflow_Kit/docs/AI/METRICS.md
check_path AI_Workflow_Kit/script/workflow_metrics.py
for script in checkpoint graphify_rebuild omp_workflow workflow_doctor workflow_metrics workflow_migrate workflow_models workflow_update; do
  check_script "AI_Workflow_Kit/script/$script.sh"
done

for role in coder reviewer tester architect security; do
  check_path ".omp/agents/workflow-$role.md"
  check_path ".omp/agents/workflow-$role-backup.md"
done

for alias in workflow_orchestrator workflow_coder workflow_reviewer workflow_tester workflow_architect workflow_security; do
  for configured_role in "$alias" "${alias}_backup"; do
    if grep -q "^[[:space:]]*$configured_role:" .omp/config.yml; then
      printf 'OK   model alias: %s\n' "$configured_role"
    else
      printf 'FAIL model alias: %s\n' "$configured_role" >&2
      failures=$((failures + 1))
    fi
  done
done

if [[ -f graphify-out/graph.json ]]; then
  printf 'OK   graphify-out/graph.json\n'
else
  printf 'WARN graphify-out/graph.json missing; run graphify_rebuild.sh after source exists\n'
fi

if bash AI_Workflow_Kit/script/workflow_metrics.sh self-check >/dev/null; then
  printf 'OK   workflow metrics runtime and private Git path\n'
else
  printf 'FAIL workflow metrics runtime/path check\n' >&2
  failures=$((failures + 1))
fi

if bash AI_Workflow_Kit/script/workflow_metrics.sh validate >/dev/null; then
  printf 'OK   workflow metrics readable event store\n'
else
  printf 'FAIL workflow metrics event validation\n' >&2
  failures=$((failures + 1))
fi

if bash AI_Workflow_Kit/script/workflow_metrics.sh selftest >/dev/null; then
  printf 'OK   workflow metrics deterministic selftest\n'
else
  printf 'FAIL workflow metrics deterministic selftest\n' >&2
  failures=$((failures + 1))
fi

if migrate_output="$(bash AI_Workflow_Kit/script/workflow_migrate.sh check 2>&1)"; then
  printf '%s\n' "$migrate_output"
else
  printf '%s\n' "$migrate_output" >&2
  printf 'FAIL workflow schema migration check\n' >&2
  failures=$((failures + 1))
fi

if command -v node >/dev/null 2>&1; then
  if node .omp/tests/workflow-dashboard.selftest.ts >/dev/null; then
    printf 'OK   workflow dashboard deterministic selftest\n'
  else
    printf 'FAIL workflow dashboard deterministic selftest\n' >&2
    failures=$((failures + 1))
  fi
  if node .omp/tests/workflow-stats.selftest.ts >/dev/null; then
    printf 'OK   workflow stats deterministic selftest\n'
  else
    printf 'FAIL workflow stats deterministic selftest\n' >&2
    failures=$((failures + 1))
  fi
  if node .omp/tests/workflow-runtime-todo.selftest.ts >/dev/null; then
    printf 'OK   workflow runtime todo deterministic selftest\n'
  else
    printf 'FAIL workflow runtime todo deterministic selftest\n' >&2
    failures=$((failures + 1))
  fi
  if node .omp/tests/workflow-consistency.selftest.ts >/dev/null; then
    printf 'OK   workflow consistency deterministic selftest\n'
  else
    printf 'FAIL workflow consistency deterministic selftest\n' >&2
    failures=$((failures + 1))
  fi
  if node .omp/tests/workflow-migration.selftest.ts >/dev/null; then
    printf 'OK   workflow migration deterministic selftest\n'
  else
    printf 'FAIL workflow migration deterministic selftest\n' >&2
    failures=$((failures + 1))
  fi
  if node .omp/tests/workflow-model-readiness.selftest.ts >/dev/null; then
    printf 'OK   workflow model readiness deterministic selftest\n'
  else
    printf 'FAIL workflow model readiness deterministic selftest\n' >&2
    failures=$((failures + 1))
  fi
  if node .omp/tests/workflow-routing.selftest.ts >/dev/null; then
    printf 'OK   workflow routing deterministic selftest\n'
  else
    printf 'FAIL workflow routing deterministic selftest\n' >&2
    failures=$((failures + 1))
  fi
else
  printf 'WARN command: node unavailable; dashboard selftests skipped (OMP runtime still validated on launch)\n'
fi

if (( failures > 0 )); then
  printf '\nWorkflow doctor: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf '\nWorkflow doctor: ready\n'
printf 'Launch: bash AI_Workflow_Kit/script/omp_workflow.sh\n'
