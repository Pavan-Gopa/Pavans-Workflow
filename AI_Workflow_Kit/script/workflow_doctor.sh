#!/usr/bin/env bash
# Validate a Pavan's Workflow v3.4.2 installation without invoking a model.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

failures=0
warnings=0
ok()   { printf 'OK   %s\n' "$1"; }
warn() { printf 'WARN %s\n' "$1" >&2; warnings=$((warnings + 1)); }
fail() { printf 'FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }
check_path() { [[ -e "$1" ]] && ok "$1" || fail "$1"; }
check_command() { command -v "$1" >/dev/null 2>&1 && ok "command: $1" || fail "command: $1"; }
check_script() {
  if [[ ! -f "$1" ]]; then fail "$1"; return; fi
  bash -n "$1" && ok "shell syntax: $1" || fail "shell syntax: $1"
  [[ -x "$1" ]] && ok "executable: $1" || warn "not executable: $1 (launch with bash)"
}

check_command omp
check_command graphify
check_command python3

for path in \
  VERSION CHANGELOG.md README.md INSTALL.md .graphifyignore \
  .omp/config.yml .omp/AGENTS.md .omp/commands/workflow.md \
  .omp/extensions/workflow-dashboard.ts .omp/extensions/workflow-stats.ts \
  .omp/extensions/workflow-main-model-sync.ts .omp/extensions/workflow-quick-focus.ts \
  .omp/lib/workflow-main-model-sync.ts .omp/lib/workflow-live-step.ts \
  .omp/lib/workflow-model-readiness.ts .omp/lib/workflow-dashboard-data.ts \
  .omp/lib/workflow-dashboard-panel.ts .omp/lib/workflow-dashboard-extension.ts \
  .omp/lib/workflow-dashboard-viewport.ts .omp/lib/workflow-stats.ts \
  .omp/lib/workflow-stats-runtime.ts \
  .omp/tests/workflow-main-model-sync.selftest.ts .omp/tests/workflow-quick-focus.selftest.ts \
  .omp/tests/workflow-live-step.selftest.ts .omp/tests/workflow-stats.selftest.ts \
  .omp/tests/workflow-dashboard-viewport.selftest.ts .omp/tests/workflow-dashboard-mount.selftest.ts \
  grilling/SKILL.md ponytail/SKILL.md ponytail/UPSTREAM.md \
  ponytail-review/SKILL.md ponytail-audit/SKILL.md ponytail-debt/SKILL.md \
  ui-designer/SKILL.md ui-designer/references/visual-hierarchy.md \
  ui-designer/references/interaction-states.md ui-designer/references/responsive-layout.md \
  ui-designer/references/accessibility.md ui-designer/references/visual-verification.md \
  AI_Workflow_Kit/vendor/dependencies.lock AI_Workflow_Kit/vendor/ponytail.LICENSE \
  AI_Workflow_Kit/docs/AI/STATE.yaml AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md \
  AI_Workflow_Kit/docs/AI/METRICS.md AI_Workflow_Kit/docs/AI/MODELS.md \
  AI_Workflow_Kit/docs/AI/DESIGNER.md AI_Workflow_Kit/docs/AI/KICK_DESIGNER.md \
  AI_Workflow_Kit/experiments/context-economy/install.sh \
  AI_Workflow_Kit/script/workflow_config_repair.py \
  AI_Workflow_Kit/script/workflow_config_repair.selftest.py; do
  check_path "$path"
done

WF_VERSION="$(tr -d '[:space:]' < VERSION 2>/dev/null || true)"
if [[ "$WF_VERSION" == "3.4.2" ]]; then
  ok "workflow version: 3.4.2"
else
  fail "VERSION must be 3.4.2 (found ${WF_VERSION:-<empty>})"
fi

LOCK_VERSION="$(awk '$1 == "workflow_version:" { print $2; exit }' AI_Workflow_Kit/vendor/dependencies.lock 2>/dev/null || true)"
if [[ "$LOCK_VERSION" == "$WF_VERSION" ]]; then
  ok "dependency lock workflow version: $LOCK_VERSION"
else
  fail "dependencies.lock workflow_version must match VERSION"
fi

for script in AI_Workflow_Kit/script/*.sh install.sh; do
  [[ -e "$script" ]] && check_script "$script"
done

if python3 AI_Workflow_Kit/script/workflow_config_repair.py check .omp/config.yml >/dev/null; then
  ok "project YAML/model-role/task-policy guard"
else
  fail ".omp/config.yml violates the canonical workflow policy"
fi

RUNTIME_MS="$(awk '$1 == "maxRuntimeMs:" { print $2; exit }' .omp/config.yml 2>/dev/null || true)"
REQUEST_BUDGET="$(awk '$1 == "softRequestBudget:" { print $2; exit }' .omp/config.yml 2>/dev/null || true)"
if [[ "$RUNTIME_MS" =~ ^[0-9]+$ ]] && (( RUNTIME_MS >= 14400000 )) && [[ "$REQUEST_BUDGET" == "0" ]]; then
  ok "task runtime policy: >=4h hard wall, request-count forced stop disabled"
else
  fail "task runtime policy requires maxRuntimeMs>=14400000 and softRequestBudget=0"
fi

if python3 - .omp/extensions/workflow-main-model-sync.ts <<'PY' >/dev/null
from pathlib import Path
import re
import sys
source = Path(sys.argv[1]).read_text(encoding="utf-8")
code = re.sub(r"^[ \t]*//.*$", "", source, flags=re.MULTILINE)
assert "shouldRepairMainAlias(ctx.hasUI)" in code
assert "session_start" in code and "session_switch" in code
for forbidden in (r"setInterval\s*\(", r"pi\.setModel\s*\(", r"setThinkingLevel\s*\("):
    assert re.search(forbidden, code) is None, forbidden
PY
then
  ok "Main alias guard is interactive-only and cannot race OMP's effort picker"
else
  fail "Main alias guard must not poll or mutate the live model/thinking level"
fi

if grep -q 'InputController' .omp/extensions/workflow-quick-focus.ts \
   && grep -q 'ctx.focusAgentSession(workerId)' .omp/extensions/workflow-quick-focus.ts \
   && grep -q 'ctx.unfocusSession()' .omp/extensions/workflow-quick-focus.ts \
   && grep -q 'return undefined' .omp/extensions/workflow-quick-focus.ts; then
  ok "Quick Worker Focus preserves contextual native Tab passthrough"
else
  fail "Quick Worker Focus wiring is incomplete"
fi

for role in coder reviewer tester architect security design-advisor designer; do
  check_path ".omp/agents/workflow-$role.md"
  check_path ".omp/agents/workflow-$role-backup.md"
done

for alias in \
  workflow_orchestrator workflow_coder workflow_reviewer workflow_tester \
  workflow_architect workflow_security workflow_design_advisor workflow_designer; do
  for configured in "$alias" "${alias}_backup"; do
    grep -q "^[[:space:]]*$configured:" .omp/config.yml \
      && ok "model alias: $configured" \
      || fail "model alias: $configured"
  done
done

for file in .omp/agents/workflow-coder.md .omp/agents/workflow-coder-backup.md; do
  grep -Eq '^autoloadSkills:[[:space:]]*\["ponytail"\]' "$file" \
    && ok "Ponytail autoload: $file" \
    || fail "Ponytail must autoload in $file"
done

for file in \
  .omp/agents/workflow-design-advisor.md .omp/agents/workflow-design-advisor-backup.md \
  .omp/agents/workflow-designer.md .omp/agents/workflow-designer-backup.md; do
  grep -Eq '^autoloadSkills:[[:space:]]*\["ui-designer"\]' "$file" \
    && ok "UI Designer autoload: $file" \
    || fail "ui-designer must autoload in $file"
  grep -Eq 'autoloadSkills:.*ponytail' "$file" \
    && fail "Ponytail must not autoload in $file" \
    || ok "Ponytail excluded: $file"
done

if grep -q 'workflow-dashboard-extension' .omp/extensions/workflow-dashboard.ts \
   && grep -q 'applyLiveStep' .omp/lib/workflow-dashboard-panel.ts \
   && grep -q 'currentWorkItemId' .omp/lib/workflow-live-step.ts \
   && grep -q 'ScrollView' .omp/lib/workflow-dashboard-panel.ts \
   && grep -q 'routeSgrMouseInput' .omp/lib/workflow-dashboard-panel.ts \
   && grep -q 'fullscreen: true' .omp/lib/workflow-dashboard-panel.ts \
   && grep -q 'mouseTracking: true' .omp/lib/workflow-dashboard-panel.ts; then
  ok "Alt+W live cursor and fullscreen scrolling contract"
else
  fail "Alt+W dashboard contract is incomplete"
fi

STATS_EXTENSION=.omp/extensions/workflow-stats.ts
STATS_RUNTIME=.omp/lib/workflow-stats-runtime.ts
if grep -Eq 'session_start|session_switch|turn_end|setWidget|task:subagent:lifecycle' "$STATS_EXTENSION"; then
  fail "OMP Stats must have no automatic startup/widget/lifecycle hooks"
else
  ok "OMP Stats is explicit-only"
fi
if grep -q 'spawn(' "$STATS_RUNTIME" \
   && grep -q '"omp"' "$STATS_RUNTIME" \
   && grep -q '"stats"' "$STATS_RUNTIME" \
   && ! grep -q 'STATS_HEADER_VALUE' "$STATS_RUNTIME"; then
  ok "OMP Stats delegates lifecycle/security to native omp stats"
else
  fail "OMP Stats native delegation is incomplete"
fi

CONTEXT_FILES=(
  .omp/workflow-context-policy.json
  .omp/lib/workflow-context-economy-core.ts
  .omp/lib/workflow-context-economy.ts
  .omp/lib/workflow-context-snapshot.ts
  AI_Workflow_Kit/docs/AI/CONTEXT_ECONOMY.md
  AI_Workflow_Kit/docs/AI/WORKER_OUTPUT_BUDGET.md
)
context_missing=0
for path in "${CONTEXT_FILES[@]}"; do [[ -f "$path" ]] || context_missing=$((context_missing + 1)); done
if (( context_missing == 0 )); then
  ok "Main-only context-economy payload installed"
  policy_ok=1
  python3 - .omp/workflow-context-policy.json <<'PYCONTEXT' || policy_ok=0
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert data["softArmPercent"] == 23
assert data["hardThresholdPercent"] == 28
assert data["rearmPercent"] < data["softArmPercent"]
assert data["methodOrder"] == ["shake", "soft"]
PYCONTEXT
  if (( policy_ok )); then
    ok "context-economy policy: Main-only 23/28 guardrails"
  else
    fail "context-economy policy is present but its Main-only guardrails are invalid"
  fi
else
  if [[ -f AI_Workflow_Kit/experiments/context-economy/context-economy-v3.sha256 ]]; then
    warn "context payload is packaged but not extracted; run install.sh or workflow_update.sh apply"
  else
    fail "Main-only context-economy payload is missing"
  fi
fi

run_typescript_selftest() {
  local test="$1"
  if command -v node >/dev/null 2>&1 && node --experimental-strip-types -e 'void 0' >/dev/null 2>&1; then
    NODE_NO_WARNINGS=1 node --experimental-strip-types "$test" >/dev/null
  elif command -v bun >/dev/null 2>&1; then
    bun "$test" >/dev/null
  elif command -v tsx >/dev/null 2>&1; then
    tsx "$test" >/dev/null
  else
    return 125
  fi
}

ts_runner_available=0
for candidate in node bun tsx; do command -v "$candidate" >/dev/null 2>&1 && ts_runner_available=1 && break; done
if (( ts_runner_available == 1 )); then
  for test in .omp/tests/*.selftest.ts; do
    status=0
    run_typescript_selftest "$test" || status=$?
    if (( status == 0 )); then
      ok "selftest: $test"
    elif (( status == 125 )); then
      warn "TypeScript runner unavailable; remaining OMP selftests skipped"
      break
    else
      fail "selftest: $test"
    fi
  done
else
  warn "Node/Bun/tsx unavailable; OMP TypeScript selftests skipped"
fi

for test in AI_Workflow_Kit/script/*.selftest.py; do
  [[ -f "$test" ]] || continue
  python3 "$test" >/dev/null && ok "selftest: $test" || fail "selftest: $test"
done
for test in AI_Workflow_Kit/script/*.selftest.sh; do
  [[ -f "$test" ]] || continue
  bash "$test" >/dev/null && ok "selftest: $test" || fail "selftest: $test"
done

run_bounded() {
  local seconds="$1"; shift
  python3 - "$seconds" "$@" <<'PYTIMEOUT'
import subprocess
import sys

seconds = float(sys.argv[1])
command = sys.argv[2:]
try:
    completed = subprocess.run(command, timeout=seconds, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
raise SystemExit(completed.returncode)
PYTIMEOUT
}

EXPECTED_GRAPHIFY="$(awk '$1 == "graphify:" { in_graphify=1; next } in_graphify && $1 == "version:" { print $2; exit }' AI_Workflow_Kit/vendor/dependencies.lock 2>/dev/null || true)"
ACTUAL_GRAPHIFY="$(graphify --version 2>/dev/null | awk '{print $NF}' || true)"
if [[ -n "$EXPECTED_GRAPHIFY" && "$ACTUAL_GRAPHIFY" == "$EXPECTED_GRAPHIFY" ]]; then
  ok "graphify version: $ACTUAL_GRAPHIFY"
elif [[ -n "$ACTUAL_GRAPHIFY" ]]; then
  warn "graphify $ACTUAL_GRAPHIFY installed; workflow v$WF_VERSION pins $EXPECTED_GRAPHIFY"
fi

if [[ -f graphify-out/graph.json ]]; then
  if python3 - <<'PYGRAPH'
import json
import pathlib

path = pathlib.Path("graphify-out/graph.json")
data = json.loads(path.read_text(encoding="utf-8"))
assert isinstance(data, dict)
assert isinstance(data.get("nodes"), list)
assert data["nodes"]
PYGRAPH
  then
    ok "graphify-out/graph.json valid"
    if run_bounded 20 graphify query "project entry points" --graph graphify-out/graph.json --budget 64; then
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

if git rev-parse --git-common-dir >/dev/null 2>&1; then
  bash AI_Workflow_Kit/script/workflow_metrics.sh self-check >/dev/null \
    && ok "workflow metrics runtime/private path" \
    || fail "workflow metrics runtime/private path"
  bash AI_Workflow_Kit/script/workflow_metrics.sh validate >/dev/null \
    && ok "workflow metrics event store" \
    || fail "workflow metrics event store"
else
  warn "metrics store unavailable outside a Git worktree; observer stays passive"
fi
bash AI_Workflow_Kit/script/workflow_metrics.sh selftest >/dev/null \
  && ok "workflow metrics deterministic selftest" \
  || fail "workflow metrics deterministic selftest"

if migrate_output="$(bash AI_Workflow_Kit/script/workflow_migrate.sh check 2>&1)"; then
  printf '%s\n' "$migrate_output"
else
  printf '%s\n' "$migrate_output" >&2
  fail "workflow schema migration check"
fi

if (( failures > 0 )); then
  printf '\nWorkflow doctor: %d failure(s), %d warning(s)\n' "$failures" "$warnings" >&2
  exit 1
fi
printf '\nWorkflow doctor: ready (%d warning(s))\n' "$warnings"
printf 'Version: %s\n' "$WF_VERSION"
printf 'Launch: bash AI_Workflow_Kit/script/omp_workflow.sh\n'
