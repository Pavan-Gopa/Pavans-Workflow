#!/usr/bin/env bash
# Validate a Pavan's Workflow installation without invoking a model.
#
#   bash AI_Workflow_Kit/script/workflow_doctor.sh
#
# FAIL = the workflow cannot run correctly; WARN = degraded or advisory.

set -euo pipefail
# Helpers and selftests must not leave __pycache__ in the project.
export PYTHONDONTWRITEBYTECODE=1

main() {
  local script_dir project_root
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  project_root="$(cd "$script_dir/../.." && pwd)"
  cd "$project_root"
  # shellcheck source=workflow_ts.sh
  source "$script_dir/workflow_ts.sh"

  local failures=0 warnings=0
  ok()   { printf 'OK   %s\n' "$1"; }
  warn() { printf 'WARN %s\n' "$1" >&2; warnings=$((warnings + 1)); }
  fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

  # --- tools -----------------------------------------------------------------
  local tool
  for tool in omp python3 git; do
    if command -v "$tool" >/dev/null 2>&1; then ok "command: $tool"; else fail "command: $tool"; fi
  done
  if command -v graphify >/dev/null 2>&1; then ok "command: graphify"; else warn "graphify not on PATH (navigation falls back to source tools)"; fi
  local tested_omp actual_omp
  tested_omp="$(awk '$1 == "omp:" { in_omp=1; next } in_omp && $1 == "version:" { print $2; exit }' AI_Workflow_Kit/vendor/dependencies.lock 2>/dev/null || true)"
  actual_omp="$(omp --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
  if [[ -n "$tested_omp" && -n "$actual_omp" ]]; then
    if [[ "${actual_omp%%.*}" == "${tested_omp%%.*}" ]]; then
      ok "omp $actual_omp (tested with $tested_omp)"
    else
      warn "omp $actual_omp differs in major version from the tested $tested_omp; Quick Focus and the guard hooks may degrade"
    fi
  fi
  local runner
  runner="$(wf_ts_runner)"
  if [[ -n "$runner" ]]; then ok "TypeScript runner: $runner"; else warn "no TypeScript runner (Node >= 22.6, Bun, or tsx); TS selftests and migrations skipped"; fi

  # --- framework files (manifest) -----------------------------------------------
  local line level message
  while IFS= read -r line; do
    level="${line%% *}"; message="${line#* }"; message="${message#"${message%%[![:space:]]*}"}"
    case "$level" in
      OK) ok "$message" ;;
      WARN) warn "$message" ;;
      FAIL) fail "$message" ;;
    esac
  done < <(python3 AI_Workflow_Kit/script/workflow_framework.py verify --target "$project_root" 2>&1 || true)

  local wf_version lock_version
  wf_version="$(tr -d '[:space:]' < AI_Workflow_Kit/VERSION 2>/dev/null || true)"
  lock_version="$(awk '$1 == "workflow_version:" { print $2; exit }' AI_Workflow_Kit/vendor/dependencies.lock 2>/dev/null || true)"
  if [[ -n "$wf_version" && "$lock_version" == "$wf_version" ]]; then
    ok "workflow version: $wf_version"
  else
    fail "AI_Workflow_Kit/VERSION (${wf_version:-missing}) must match dependencies.lock workflow_version (${lock_version:-missing})"
  fi

  local script
  for script in AI_Workflow_Kit/script/*.sh; do
    [[ -f "$script" ]] || continue
    if bash -n "$script"; then ok "shell syntax: $script"; else fail "shell syntax: $script"; fi
  done

  # --- configuration --------------------------------------------------------------
  if python3 AI_Workflow_Kit/script/workflow_config_repair.py check .omp/config.yml >/dev/null; then
    ok "config: roles, Main alias, task policy, Main-only context economy"
  else
    fail ".omp/config.yml violates the workflow policy (repair: bash AI_Workflow_Kit/script/workflow_update.sh apply)"
  fi
  while IFS= read -r line; do
    case "$line" in
      WARN*) warn "${line#WARN }" ;;
      OK*) ok "${line#OK   }" ;;
    esac
  done < <(python3 AI_Workflow_Kit/script/workflow_model_diversity.py --config .omp/config.yml 2>&1 || true)

  if python3 - .omp/workflow-context-policy.json <<'PYCONTEXT' >/dev/null 2>&1
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert data["softArmPercent"] == 23
assert data["hardThresholdPercent"] == 28
assert data["rearmPercent"] < data["softArmPercent"]
assert data["methodOrder"] == ["shake", "soft"]
PYCONTEXT
  then
    ok "context-economy policy: Main-only 23/28 guardrails"
  else
    fail ".omp/workflow-context-policy.json is missing or invalid"
  fi

  # --- agents ------------------------------------------------------------------------
  local role file
  for role in coder reviewer tester architect security design-advisor designer; do
    for file in ".omp/agents/workflow-$role.md" ".omp/agents/workflow-$role-backup.md"; do
      [[ -f "$file" ]] || { fail "agent missing: $file"; continue; }
    done
  done
  for file in .omp/agents/workflow-coder.md .omp/agents/workflow-coder-backup.md; do
    if grep -Eq '^autoloadSkills:[[:space:]]*\["ponytail"\]' "$file" 2>/dev/null; then ok "Ponytail autoload: $file"; else fail "Ponytail must autoload in $file"; fi
  done
  for file in .omp/agents/workflow-design-advisor.md .omp/agents/workflow-design-advisor-backup.md \
              .omp/agents/workflow-designer.md .omp/agents/workflow-designer-backup.md; do
    if grep -Eq '^autoloadSkills:[[:space:]]*\["ui-designer"\]' "$file" 2>/dev/null && ! grep -Eq 'autoloadSkills:.*ponytail' "$file"; then
      ok "UI Designer autoload (no Ponytail): $file"
    else
      fail "$file must autoload ui-designer and not ponytail"
    fi
  done
  for file in .omp/agents/workflow-reviewer.md .omp/agents/workflow-architect.md \
              .omp/agents/workflow-security.md .omp/agents/workflow-design-advisor.md; do
    if grep -Eq '^tools:.*"(edit|write)"' "$file" 2>/dev/null; then
      fail "read-only role must not have edit/write tools: $file"
    fi
  done
  ok "read-only roles have no edit/write tools; the workflow guard blocks out-of-scope worker edits"

  # --- selftests ------------------------------------------------------------------------
  local test status
  if [[ -n "$runner" ]]; then
    for test in .omp/tests/*.selftest.ts; do
      [[ -f "$test" ]] || continue
      status=0
      wf_run_ts "$test" >/dev/null 2>&1 || status=$?
      if (( status == 0 )); then ok "selftest: $test"; else fail "selftest: $test"; fi
    done
  fi
  for test in AI_Workflow_Kit/script/*.selftest.py; do
    [[ -f "$test" ]] || continue
    if python3 "$test" >/dev/null 2>&1; then ok "selftest: $test"; else fail "selftest: $test"; fi
  done
  for test in AI_Workflow_Kit/script/*.selftest.sh; do
    [[ -f "$test" ]] || continue
    if bash "$test" >/dev/null 2>&1; then ok "selftest: $test"; else fail "selftest: $test"; fi
  done

  # --- graphify (advisory) ------------------------------------------------------------
  local expected_graphify actual_graphify
  expected_graphify="$(awk '$1 == "graphify:" { in_graphify=1; next } in_graphify && $1 == "version:" { print $2; exit }' AI_Workflow_Kit/vendor/dependencies.lock 2>/dev/null || true)"
  actual_graphify="$(graphify --version 2>/dev/null | awk '{print $NF}' || true)"
  if [[ -n "$actual_graphify" && "$actual_graphify" == "$expected_graphify" ]]; then
    ok "graphify version: $actual_graphify"
  elif [[ -n "$actual_graphify" ]]; then
    warn "graphify $actual_graphify installed; this release pins $expected_graphify"
  fi
  if [[ -f graphify-out/graph.json ]]; then
    if python3 -c 'import json,sys; d=json.load(open("graphify-out/graph.json")); assert isinstance(d.get("nodes"), list) and d["nodes"]' 2>/dev/null; then
      ok "graphify-out/graph.json valid"
    else
      warn "graphify-out/graph.json is invalid; rebuild with graphify_rebuild.sh fast"
    fi
  else
    warn "graphify-out/graph.json missing; run graphify_rebuild.sh fast once product source exists"
  fi
  # Project rules that force every agent through Graphify or make workers refresh it (R20).
  local graphify_rules graphify_rule
  graphify_rules="$(python3 AI_Workflow_Kit/script/workflow_graphify_rules.py . 2>/dev/null || true)"
  if [[ -n "$graphify_rules" ]]; then
    warn "project rules make every agent run or refresh Graphify — workers pay for it on every step; R20 leaves graph freshness to Main (remove or narrow these lines):"
    while IFS= read -r graphify_rule; do printf '     %s\n' "$graphify_rule" >&2; done <<<"$graphify_rules"
  fi

  # --- metrics, guard store, migrations ------------------------------------------------
  if git rev-parse --git-common-dir >/dev/null 2>&1; then
    if bash AI_Workflow_Kit/script/workflow_metrics.sh self-check >/dev/null 2>&1 \
       && bash AI_Workflow_Kit/script/workflow_metrics.sh validate >/dev/null 2>&1; then
      ok "workflow metrics store"
    else
      fail "workflow metrics store (bash AI_Workflow_Kit/script/workflow_metrics.sh validate)"
    fi
    local guard_mode
    if python3 AI_Workflow_Kit/script/workflow_guard.py status --json >/dev/null 2>&1; then
      guard_mode="$(python3 AI_Workflow_Kit/script/workflow_guard.py mode 2>/dev/null || true)"
      case "$guard_mode" in
        "guard mode: enforce"*|"") ok "workflow guard store${guard_mode:+ (${guard_mode#guard mode: })}" ;;
        *) warn "workflow ${guard_mode} — worker boundaries are not enforced (python3 AI_Workflow_Kit/script/workflow_guard.py mode enforce)" ;;
      esac
    else
      fail "workflow guard store (python3 AI_Workflow_Kit/script/workflow_guard.py status)"
    fi
  else
    warn "not a git worktree: metrics and the worker guard are unavailable"
  fi
  if bash AI_Workflow_Kit/script/workflow_metrics.sh selftest >/dev/null 2>&1; then
    ok "workflow metrics deterministic selftest"
  else
    fail "workflow metrics deterministic selftest"
  fi
  local migrate_output
  if [[ -n "$runner" ]]; then
    if migrate_output="$(bash AI_Workflow_Kit/script/workflow_migrate.sh check 2>&1)"; then
      printf '%s\n' "$migrate_output"
    else
      printf '%s\n' "$migrate_output" >&2
      fail "workflow schema migration check"
    fi
  fi

  if (( failures > 0 )); then
    printf '\nWorkflow doctor: %d failure(s), %d warning(s)\n' "$failures" "$warnings" >&2
    return 1
  fi
  printf '\nWorkflow doctor: ready (%d warning(s))\n' "$warnings"
  printf 'Version: %s\n' "$wf_version"
  printf 'Launch: bash AI_Workflow_Kit/script/omp_workflow.sh\n'
}

main ${1+"$@"}; exit $?
