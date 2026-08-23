#!/usr/bin/env bash
# Apply/rollback smoke test in a throwaway project.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALLER="$ROOT/AI_Workflow_Kit/experiments/lean-pipeline/install.sh"
TMP="$(mktemp -d -t lean-pipeline-selftest.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

git init -q "$TMP"
mkdir -p "$TMP/.omp" "$TMP/AI_Workflow_Kit/docs/AI"
printf 'workflow_orchestrator: "@default"\n' > "$TMP/.omp/config.yml"
printf 'OLD_AGENTS\n' > "$TMP/.omp/AGENTS.md"
printf 'current_step: S0\nnext_actor: orchestrator\n' > "$TMP/AI_Workflow_Kit/docs/AI/STATE.yaml"

bash "$INSTALLER" apply "$TMP" >/dev/null
[[ -f "$TMP/.omp/workflow-lean-pipeline.json" ]]
grep -q 'Lean Pipeline' "$TMP/AI_Workflow_Kit/docs/AI/LEAN_PIPELINE.md"
grep -q 'profile: standard' "$TMP/AI_Workflow_Kit/docs/AI/STATE.yaml"
! grep -q 'OLD_AGENTS' "$TMP/.omp/AGENTS.md"

bash "$INSTALLER" rollback "$TMP" >/dev/null
[[ ! -f "$TMP/.omp/workflow-lean-pipeline.json" ]]
[[ ! -f "$TMP/AI_Workflow_Kit/docs/AI/LEAN_PIPELINE.md" ]]
grep -q 'OLD_AGENTS' "$TMP/.omp/AGENTS.md"
! grep -q 'pipeline:' "$TMP/AI_Workflow_Kit/docs/AI/STATE.yaml"

echo "workflow_lean.selftest: PASS"
