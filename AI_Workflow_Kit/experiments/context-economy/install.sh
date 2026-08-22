#!/usr/bin/env bash
# Install, verify, or remove the context-economy experiment overlay.
#
# Strategy: native hard boundary + extension soft window.
#   - OMP native threshold maintenance owns the hard ceiling at 28%:
#     compaction.enabled=true, thresholdPercent=28, midTurnEnabled=true,
#     autoContinue=true. The core compacts mid-turn at tool-loop boundaries,
#     so continuous autonomous runs are compacted without waiting for pauses.
#   - The extension owns the soft window 23-28%: it compacts only when Main is
#     fully settled (no active workers, no async jobs, no queued messages).
#
# Managed config sections in the project .omp/config.yml: cycleOrder,
# contextPromotion, compaction. Everything else — including modelRoles and the
# DEFAULT model slot — is preserved untouched.
#
# Rollback: this script never touches product files or workflow state. Restore
# the managed config sections from project git history (or your pre-experiment
# baseline) and delete the additive files listed in EXPERIMENT_FILES below.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ACTION="${1:-install}"
TARGET="${2:-$PWD}"

EXPERIMENT_FILES=(
  ".omp/workflow-context-policy.json"
  ".omp/lib/workflow-context-economy-core.ts"
  ".omp/lib/workflow-context-economy.ts"
  ".omp/lib/workflow-context-snapshot.ts"
  ".omp/lib/workflow-dashboard-extension.ts"
  ".omp/lib/workflow-dashboard-panel.ts"
  ".omp/tests/workflow-context-economy.selftest.ts"
  "AI_Workflow_Kit/docs/AI/CONTEXT_ECONOMY.md"
  "AI_Workflow_Kit/docs/AI/WORKER_OUTPUT_BUDGET.md"
  "AI_Workflow_Kit/script/workflow_experiment_config.py"
  "AI_Workflow_Kit/script/workflow_experiment_config.selftest.py"
)

# Earlier experiment revisions installed a standalone monolithic extension in
# extensions/ plus a main-only selftest. Both are superseded by the lib/ modules
# wired through workflow-dashboard-extension.ts; stale copies would register a
# second compaction controller alongside the current one.
LEGACY_FILES=(
  ".omp/extensions/workflow-context-economy.ts"
  ".omp/tests/workflow-context-economy-main-only.selftest.ts"
)

say()  { printf 'OK   %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

absolute_dir() {
  local path="$1"
  [[ -d "$path" ]] || { echo "ERROR: project directory not found: $path" >&2; exit 1; }
  (cd "$path" && pwd)
}

check_policy() {
  python3 - "$1/.omp/workflow-context-policy.json" <<'PY'
import json, pathlib, sys
data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert data["softArmPercent"] == 23
assert data["hardThresholdPercent"] == 28
assert data["rearmPercent"] < data["softArmPercent"]
assert data["methodOrder"] == ["shake", "soft"]
PY
}

doctor_action() {
  local project
  project="$(absolute_dir "$TARGET")"
  local failures=0
  check() {
    local label="$1"; shift
    if "$@" >/dev/null; then
      printf 'OK   %s\n' "$label"
    else
      printf 'FAIL %s\n' "$label" >&2
      failures=$((failures + 1))
    fi
  }
  check "experiment policy JSON" check_policy "$project"
  check "config patcher selftest" python3 "$project/AI_Workflow_Kit/script/workflow_experiment_config.selftest.py"
  check "managed config sections" python3 "$project/AI_Workflow_Kit/script/workflow_experiment_config.py" check "$project/.omp/config.yml"
  for rel in "${EXPERIMENT_FILES[@]}"; do
    check "installed: $rel" test -f "$project/$rel"
  done
  for rel in "${LEGACY_FILES[@]}"; do
    check "legacy removed: $rel" test ! -e "$project/$rel"
  done
  if [[ $failures -eq 0 ]]; then
    printf '\nContext economy is healthy. Restart OMP to load updated extensions.\n'
  else
    printf '\n%s check(s) failed.\n' "$failures" >&2
    exit 1
  fi
}

install_action() {
  local project
  project="$(absolute_dir "$TARGET")"
  [[ -f "$project/.omp/config.yml" ]] || fail "existing workflow config is required: $project/.omp/config.yml"

  local rel
  for rel in "${EXPERIMENT_FILES[@]}"; do
    [[ -f "$SOURCE_ROOT/$rel" ]] || fail "experiment source missing: $rel"
    mkdir -p "$project/$(dirname "$rel")"
    if [[ ! -f "$project/$rel" ]] || ! cmp -s "$SOURCE_ROOT/$rel" "$project/$rel"; then
      cp -p "$SOURCE_ROOT/$rel" "$project/$rel"
      say "synced $rel"
    fi
  done

  for rel in "${LEGACY_FILES[@]}"; do
    if [[ -f "$project/$rel" ]]; then
      rm -f "$project/$rel"
      say "removed legacy $rel"
    fi
  done

  python3 "$project/AI_Workflow_Kit/script/workflow_experiment_config.py" apply "$project/.omp/config.yml"

  # Existing installs may carry an explicit workflow_orchestrator assignment.
  # DEFAULT is the authoritative Main slot; retain the user's selected DEFAULT
  # and only turn the orchestrator role into an alias.
  python3 - "$project/.omp/config.yml" <<'PY'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
lines = text.splitlines()
header = None
for index, line in enumerate(lines):
    if re.match(r"^\s*modelRoles\s*:\s*(?:#.*)?$", line):
        header = index
        break
if header is None:
    raise SystemExit(f"ERROR: modelRoles block is missing in {path}")
base_indent = len(lines[header]) - len(lines[header].lstrip(" "))
end = len(lines)
for index in range(header + 1, len(lines)):
    stripped = lines[index].strip()
    if not stripped or stripped.startswith("#"):
        continue
    indent = len(lines[index]) - len(lines[index].lstrip(" "))
    if indent <= base_indent:
        end = index
        break
role_index = None
child_indent = " " * (base_indent + 2)
for index in range(header + 1, end):
    match = re.match(r"^(\s+)([A-Za-z0-9_.-]+)\s*:", lines[index])
    if not match:
        continue
    child_indent = match.group(1)
    if match.group(2) == "workflow_orchestrator":
        role_index = index
        break
replacement = f'{child_indent}workflow_orchestrator: "@default"'
if role_index is None:
    lines.insert(header + 1, replacement)
else:
    comment = ""
    if " #" in lines[role_index]:
        comment = " #" + lines[role_index].split(" #", 1)[1]
    lines[role_index] = replacement + comment
path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
PY

  grep -Eq '^[[:space:]]*workflow_orchestrator:[[:space:]]*"@default"([[:space:]]|$)' "$project/.omp/config.yml" || {
    fail "workflow_orchestrator is not bound to @default after install."
  }
  grep -q '^## Canonical state-transition transaction$' "$project/.omp/AGENTS.md" || {
    fail "strict Main state-transition contract is missing after install."
  }

  say "compaction: enabled at 28% hard threshold with mid-turn boundaries"
  say "floating soft window: arm 23% · upper target 28% · reset 18% · shake->soft"

  WF_CONTEXT_ECONOMY_DOCTOR_TARGET="$project" bash "$SCRIPT_DIR" doctor "$project"
  printf '\nContext economy installed from %s.\n' "$(git -C "$SOURCE_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'Restart OMP before continuing so the updated extensions load.\n'
}

remove_action() {
  local project
  project="$(absolute_dir "$TARGET")"
  local rel
  for rel in "${EXPERIMENT_FILES[@]}" "${LEGACY_FILES[@]}"; do
    if [[ -f "$project/$rel" ]]; then
      rm -f "$project/$rel"
      say "removed $rel"
    fi
  done
  printf 'Managed config sections were left as-is; restore them from git history if needed.\n'
}

case "$ACTION" in
  install|update)
    install_action
    ;;
  doctor|status)
    doctor_action
    ;;
  remove)
    remove_action
    ;;
  *)
    cat >&2 <<'USAGE'
Usage:
  install.sh [install|update] [project]   # install or refresh the overlay
  install.sh [doctor|status] [project]    # verify the installed overlay
  install.sh remove [project]             # delete additive files (keep config)
USAGE
    exit 2
    ;;
esac
