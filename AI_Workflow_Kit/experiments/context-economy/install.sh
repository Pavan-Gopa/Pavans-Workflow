#!/usr/bin/env bash
# Install/repair the Main-only context-economy v3 experiment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET="${1:-$PWD}"
TARGET="$(cd "$TARGET" && pwd)"
TEMP_ROOT="$(mktemp -d -t pavans-context-economy-v3.XXXXXX)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
ARCHIVE="$TEMP_ROOT/context-economy-v3.tar.bz2"
EXTRACTED="$TEMP_ROOT/source"
CHECKSUM_FILE="$SCRIPT_DIR/context-economy-v3.sha256"

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "ERROR: tar is required." >&2; exit 1; }
[[ -f "$CHECKSUM_FILE" ]] || { echo "ERROR: v3 checksum file is missing." >&2; exit 1; }

python3 - "$SCRIPT_DIR" "$CHECKSUM_FILE" "$ARCHIVE" <<'PY'
import base64
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
expected = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").strip().split()[0]
parts = sorted(root.glob("context-economy-v3.tar.bz2.b64.part-*.txt"))
if not parts:
    raise SystemExit("ERROR: context-economy v3 package chunks are missing")
raw = base64.b64decode(b"".join(part.read_bytes() for part in parts), validate=False)
actual = hashlib.sha256(raw).hexdigest()
if actual != expected:
    raise SystemExit(f"ERROR: v3 package checksum mismatch: expected {expected}, got {actual}")
pathlib.Path(sys.argv[3]).write_bytes(raw)
PY

mkdir -p "$EXTRACTED"
tar -xjf "$ARCHIVE" -C "$EXTRACTED"

WF_CONTEXT_ECONOMY_SOURCE_ROOT="$EXTRACTED" \
WF_CONTEXT_ECONOMY_BASE_ROOT="$SOURCE_ROOT" \
  bash "$EXTRACTED/AI_Workflow_Kit/experiments/context-economy/v3/apply.sh" "$TARGET"

# The context-economy package is allowed to change compaction, model cycling,
# worker prompts, and its own experiment helpers, but it must never fork the
# workflow control plane. v3's historical overlay carried a shadow Alt+W panel
# that could show 0/0 progress while the real file-backed workflow was already
# running. Re-apply the canonical dashboard/statistics stack from the branch
# after the experiment overlay so Alt+W, live-step tracking, runtime TODO, and
# manual OMP Stats stay exactly aligned with the production workflow.
CONTROL_PLANE_FILES=(
  ".omp/extensions/workflow-dashboard.ts"
  ".omp/extensions/workflow-stats.ts"
  ".omp/lib/workflow-consistency.ts"
  ".omp/lib/workflow-dashboard-core.ts"
  ".omp/lib/workflow-dashboard-data.ts"
  ".omp/lib/workflow-dashboard-extension.ts"
  ".omp/lib/workflow-dashboard-panel.ts"
  ".omp/lib/workflow-dashboard-viewport.ts"
  ".omp/lib/workflow-live-step.ts"
  ".omp/lib/workflow-routing.ts"
  ".omp/lib/workflow-runtime-todo.ts"
  ".omp/lib/workflow-stats-runtime.ts"
  ".omp/lib/workflow-stats.ts"
)

for rel in "${CONTROL_PLANE_FILES[@]}"; do
  src="$SOURCE_ROOT/$rel"
  dst="$TARGET/$rel"
  [[ -f "$src" ]] || { echo "ERROR: canonical control-plane file is missing: $rel" >&2; exit 1; }
  mkdir -p "$(dirname "$dst")"
  if [[ ! -e "$dst" || ! "$src" -ef "$dst" ]]; then
    cp "$src" "$dst"
  fi
  cmp -s "$src" "$dst" || { echo "ERROR: failed to restore canonical control-plane file: $rel" >&2; exit 1; }
done

printf '%s\n' "Context-economy v3 installed with canonical Alt+W dashboard and OMP Stats control plane."
