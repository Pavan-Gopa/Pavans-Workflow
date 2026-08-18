#!/usr/bin/env bash
# Validate a Pavan's Workflow v3 installation without invoking a model.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

failures=0
warnings=0

ok() { printf 'OK   %s\n' "$1"; }
warn() { printf 'WARN %s\n' "$1" >&2; warnings=$((warnings + 1)); }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

check_path() {
  [[ -e "$1" ]] && ok "$1" || fail "$1"
}

check_command() {
  command -v "$1" >/dev/null 2>&1 && ok "command: $1" || fail "command: $1"
}

check_script() {
  if [[ ! -f "$1" ]]; then fail "$1"; return; fi
  bash -n "$1" && ok "shell syntax: $1" || fail "shell syntax: $1"
  [[ -x "$1" ]] && ok "executable: $1" || warn "not executable: $1 (launch with bash)"
}

check_command omp
check_command graphify
check_command python3

for path in \
  VERSION CHANGELOG.md .graphifyignore \
  .omp/config.yml .omp/AGENTS.md .omp/commands/workflow.md \
  .omp/extensions/workflow-dashboard.ts .omp/extensions/workflow-stats.ts \
  .omp/lib/workflow-stats.ts .omp/lib/workflow-stats-runtime.ts \
  .omp/tests/workflow-stats.selftest.ts \
  grilling/SKILL.md ponytail/SKILL.md ponytail/UPSTREAM.md \
  ponytail-review/SKILL.md ponytail-audit/SKILL.md ponytail-debt/SKILL.md \
  AI_Workflow_Kit/vendor/dependencies.lock AI_Workflow_Kit/vendor/ponytail.LICENSE \
  AI_Workflow_Kit/docs/AI/STATE.yaml AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md \
  AI_Workflow_Kit/docs/AI/METRICS.md; do
  check_path "$path"
done

if [[ "$(tr -d '[:space:]' < VERSION 2>/dev/null || true)" == "3.0.0" ]]; then
  ok "workflow version: 3.0.0"
else
  fail "VERSION must be 3.0.0"
fi

for script in checkpoint graphify_rebuild omp_workflow workflow_doctor workflow_metrics workflow_migrate workflow_models workflow_update; do
  check_script "AI_Workflow_Kit/script/$script.sh"
done

for role in coder reviewer tester architect security; do
  check_path ".omp/agents/workflow-$role.md"
  check_path ".omp/agents/workflow-$role-backup.md"
done

for file in .omp/agents/workflow-coder.md .omp/agents/workflow-coder-backup.md; do
  grep -Eq '^autoloadSkills:[[:space:]]*\["ponytail"\]' "$file" \
    && ok "Ponytail autoload: $file" \
    || fail "Ponytail must autoload in $file"
done

for file in \
  .omp/agents/workflow-reviewer.md .omp/agents/workflow-tester.md \
  .omp/agents/workflow-architect.md .omp/agents/workflow-security.md; do
  if grep -Eq 'autoloadSkills:.*ponytail' "$file"; then
    fail "Ponytail must not autoload in $file"
  else
    ok "Ponytail excluded: $file"
  fi
done

STATS_EXTENSION=.omp/extensions/workflow-stats.ts
if grep -Eq 'session_start|session_switch|turn_end|setWidget|task:subagent:lifecycle' "$STATS_EXTENSION"; then
  fail "OMP Stats must have no automatic startup/widget/lifecycle hooks"
else
  ok "OMP Stats is explicit-only"
fi
grep -q 'status: snapshot.status === "idle" ? "manual"' .omp/lib/workflow-stats-runtime.ts \
  && ok "Alt+W manual Stats footer" \
  || fail "Alt+W must expose the manual Stats URL"

EXPECTED_GRAPHIFY="$(awk '/^  version:/{print $2; exit}' AI_Workflow_Kit/vendor/dependencies.lock 2>/dev/null || true)"
ACTUAL_GRAPHIFY="$(graphify --version 2>/dev/null | awk '{print $NF}' || true)"
if [[ -n "$EXPECTED_GRAPHIFY" && "$ACTUAL_GRAPHIFY" == "$EXPECTED_GRAPHIFY" ]]; then
  ok "graphify version: $ACTUAL_GRAPHIFY"
elif [[ -n "$ACTUAL_GRAPHIFY" ]]; then
  warn "graphify $ACTUAL_GRAPHIFY installed; v3 was validated with $EXPECTED_GRAPHIFY"
fi

if [[ -f graphify-out/graph.json ]]; then
  if python3 - <<'PY'
import json, pathlib
p = pathlib.Path('graphify-out/graph.json')
d = json.loads(p.read_text(encoding='utf-8'))
assert isinstance(d, dict)
assert isinstance(d.get('nodes'), list)
assert len(d['nodes']) > 0
PY
  then
    ok "graphify-out/graph.json valid"
    if graphify query "project entry points" --graph graphify-out/graph.json --budget 64 >/dev/null 2>&1; then
      ok "Graphify smoke query"
    else
      warn "Graphify graph parses, but smoke query failed"
    fi
  else
    fail "graphify-out/graph.json invalid"
  fi
else
  warn "graphify-out/graph.json missing; run graphify_rebuild.sh fast after product source exists"
fi

if bash AI_Workflow_Kit/script/workflow_metrics.sh self-check >/dev/null; then
  ok "workflow metrics runtime/private path"
else
  fail "workflow metrics runtime/private path"
fi
if bash AI_Workflow_Kit/script/workflow_metrics.sh validate >/dev/null; then
  ok "workflow metrics event store"
else
  fail "workflow metrics event store"
fi
if bash AI_Workflow_Kit/script/workflow_metrics.sh selftest >/dev/null; then
  ok "workflow metrics deterministic selftest"
else
  fail "workflow metrics deterministic selftest"
fi

if migrate_output="$(bash AI_Workflow_Kit/script/workflow_migrate.sh check 2>&1)"; then
  printf '%s\n' "$migrate_output"
else
  printf '%s\n' "$migrate_output" >&2
  fail "workflow schema migration check"
fi

if command -v node >/dev/null 2>&1; then
  for test in .omp/tests/*.selftest.ts; do
    if node "$test" >/dev/null; then ok "selftest: $test"; else fail "selftest: $test"; fi
  done
else
  warn "node unavailable; OMP TypeScript selftests skipped"
fi

if (( failures > 0 )); then
  printf '\nWorkflow doctor: %d failure(s), %d warning(s)\n' "$failures" "$warnings" >&2
  exit 1
fi
printf '\nWorkflow doctor: ready (%d warning(s))\n' "$warnings"
printf 'Version: 3.0.0\n'
printf 'Launch: bash AI_Workflow_Kit/script/omp_workflow.sh\n'
