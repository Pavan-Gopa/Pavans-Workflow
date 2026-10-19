#!/usr/bin/env bash
# Deterministic selftest for workflow_models.sh validate-role (stub `omp`, no real model catalog needed).
set -euo pipefail

main() {
  local here temp bin out
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  temp="$(mktemp -d "${TMPDIR:-/tmp}/wf-models-test.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$temp'" EXIT
  bin="$temp/bin"
  mkdir -p "$bin" "$temp/project/AI_Workflow_Kit/script"
  cp "$here/workflow_models.sh" "$temp/project/AI_Workflow_Kit/script/workflow_models.sh"

  cat > "$temp/models.json" <<'JSON'
[{"provider":"p","id":"strong"},{"provider":"p","id":"strong-b"},{"provider":"q","id":"fast"}]
JSON
  cat > "$bin/omp" <<STUB
#!/usr/bin/env bash
case "\$*" in
  "config get modelRoles --json") cat "$temp/roles.json" ;;
  "models --json") cat "$temp/models.json" ;;
  *) exit 1 ;;
esac
STUB
  chmod +x "$bin/omp"

  fail() { echo "workflow_models.selftest: FAIL: $*" >&2; exit 1; }
  run() { PATH="$bin:$PATH" bash "$temp/project/AI_Workflow_Kit/script/workflow_models.sh" "$@" 2>&1; }

  # Every core/optional role resolves, with a distinct Fast Coder and no Fast Coder backup configured yet.
  python3 - "$temp/roles.json" <<'PY'
import json, sys
roles = {}
for role in ("orchestrator", "coder", "reviewer", "tester", "architect", "security", "design_advisor", "designer"):
    roles[f"workflow_{role}"] = "p/strong"
    roles[f"workflow_{role}_backup"] = "p/strong-b"
roles["workflow_coder_fast"] = "q/fast"
json.dump(roles, open(sys.argv[1], "w"))
PY

  # The router's returned agent validates against the Fast Coder alias, in every spelling.
  for spelling in coder_fast workflow_coder_fast workflow-coder-fast; do
    out="$(run validate-role "$spelling")" || fail "validate-role $spelling: $out"
    [[ "$out" == *"Fast Coder primary model verified (q/fast)"* ]] || fail "validate-role $spelling output: $out"
  done

  # A Fast Coder pointing at an unavailable model is reported, not silently accepted via the strong Coder.
  python3 - "$temp/roles.json" <<'PY'
import json, sys
roles = json.load(open(sys.argv[1]))
roles["workflow_coder_fast"] = "q/missing"
json.dump(roles, open(sys.argv[1], "w"))
PY
  if out="$(run validate-role coder_fast)"; then fail "unavailable fast model must fail: $out"; fi
  [[ "$out" == *"Fast Coder primary role 'workflow_coder_fast'"* ]] || fail "unavailable message: $out"
  out="$(run validate-role coder)" || fail "strong coder still validates: $out"

  # An unset Fast Coder backup is refused with the escalation path; validate/status still pass without it.
  if out="$(run validate-role coder_fast backup)"; then fail "missing fast backup must fail: $out"; fi
  [[ "$out" == *"workflow_coder_fast_backup"*"escalate to the strong Coder"* ]] || fail "missing fast backup message: $out"

  # Backup dispatch validates the agent actually being started: `-backup` agent spellings select the role's backup.
  for spelling in "coder backup" workflow-coder-backup workflow_coder_backup workflow-reviewer-backup; do
    # shellcheck disable=SC2086
    out="$(run validate-role $spelling)" || fail "validate-role $spelling: $out"
    [[ "$out" == *"backup model verified (p/strong-b)"* ]] || fail "validate-role $spelling output: $out"
  done
  if out="$(run validate-role workflow-coder-fast-backup)"; then fail "missing fast backup agent must fail: $out"; fi
  [[ "$out" == *"escalate to the strong Coder"* ]] || fail "missing fast backup agent message: $out"
  if out="$(run validate-role workflow-nonsense-backup)"; then fail "unknown backup agent must fail: $out"; fi

  # status/validate never demand a Fast Coder backup.
  out="$(run validate)" || fail "validate must not require a Fast Coder backup: $out"

  # A configured Fast Coder backup validates for the backup agent in every spelling.
  python3 - "$temp/roles.json" <<'PY'
import json, sys
roles = json.load(open(sys.argv[1]))
roles["workflow_coder_fast"] = "q/fast"
roles["workflow_coder_fast_backup"] = "p/strong-b"
json.dump(roles, open(sys.argv[1], "w"))
PY
  for spelling in "coder_fast backup" workflow-coder-fast-backup workflow_coder_fast_backup; do
    # shellcheck disable=SC2086
    out="$(run validate-role $spelling)" || fail "validate-role $spelling: $out"
    [[ "$out" == *"Fast Coder backup model verified (p/strong-b)"* ]] || fail "validate-role $spelling output: $out"
  done

  echo "workflow_models.selftest: PASS"
}

main "$@"
