#!/usr/bin/env bash
# Build or refresh the project Graphify index with an explicit cost profile.
#
# Usage:
#   graphify_rebuild.sh [fast|deep|semantic|force]
#
# fast      incremental, local AST code-only, no clustering (default)
# deep      incremental, local AST code-only, clustering enabled
# semantic  incremental, allows configured semantic extraction for docs/media
# force     full local AST code-only rebuild, no clustering

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCAN_ROOT="${WF_GRAPHIFY_ROOT:-$PROJECT_ROOT}"
OUT_DIR="$PROJECT_ROOT/graphify-out"
GRAPH_JSON="$OUT_DIR/graph.json"
LAST_GOOD="$OUT_DIR/graph.last-good.json"
MODE="${1:-fast}"

if [[ "$MODE" == "--force" ]]; then MODE="force"; fi
case "$MODE" in
  fast|deep|semantic|force) ;;
  *)
    echo "Usage: $0 [fast|deep|semantic|force]" >&2
    exit 2
    ;;
esac

cd "$PROJECT_ROOT"

if ! command -v graphify >/dev/null 2>&1; then
  echo "ERROR: graphify is not on PATH." >&2
  echo "Install the tested version: uv tool install 'graphifyy==0.9.46'" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

validate_graph() {
  local file="$1"
  python3 - "$file" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception as exc:
    print(f"invalid JSON: {exc}", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(data, dict):
    print("graph root is not an object", file=sys.stderr)
    raise SystemExit(1)
nodes = data.get("nodes")
if not isinstance(nodes, list):
    print("graph nodes is not a list", file=sys.stderr)
    raise SystemExit(1)
if not nodes:
    print("graph contains zero nodes", file=sys.stderr)
    raise SystemExit(1)
print(len(nodes))
PY
}

if [[ -f "$GRAPH_JSON" ]] && validate_graph "$GRAPH_JSON" >/dev/null 2>&1; then
  cp "$GRAPH_JSON" "$LAST_GOOD"
fi

ARGS=(extract "$SCAN_ROOT" --out "$PROJECT_ROOT")
case "$MODE" in
  fast)
    ARGS+=(--code-only --no-cluster)
    ;;
  deep)
    ARGS+=(--code-only)
    ;;
  semantic)
    ;;
  force)
    ARGS+=(--code-only --no-cluster --force)
    ;;
esac

printf 'Graphify profile: %s\n' "$MODE"
printf '  scan root: %s\n' "$SCAN_ROOT"
printf '  output:    %s\n' "$GRAPH_JSON"

set +e
graphify "${ARGS[@]}"
status=$?
set -e

if (( status != 0 )) || [[ ! -f "$GRAPH_JSON" ]] || ! nodes="$(validate_graph "$GRAPH_JSON" 2>/dev/null)"; then
  echo "WARN: Graphify refresh did not produce a valid non-empty graph." >&2
  if [[ -f "$LAST_GOOD" ]] && validate_graph "$LAST_GOOD" >/dev/null 2>&1; then
    cp "$LAST_GOOD" "$GRAPH_JSON"
    echo "RESTORED: graphify-out/graph.last-good.json" >&2
  fi
  exit 1
fi

cp "$GRAPH_JSON" "$LAST_GOOD"
printf 'OK: graphify-out/graph.json ready (%s nodes)\n' "$nodes"
printf 'Query: graphify query "<question>" --graph "%s" --budget 1200\n' "$GRAPH_JSON"
