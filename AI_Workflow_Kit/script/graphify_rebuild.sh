#!/usr/bin/env bash
# graphify_rebuild.sh — rebuild project knowledge graph (agent token savings)
#
# Dev-workflow tool — NOT product code. Agents prefer:
#   graphify query | explain | path
# over dumping whole source trees.
#
# Usage (from project root that contains AI_Workflow_Kit/):
#   ./AI_Workflow_Kit/script/graphify_rebuild.sh
#   ./AI_Workflow_Kit/script/graphify_rebuild.sh --force
#
# Requires: `graphify` on PATH (e.g. uv tool install graphifyy)
#
# Env:
#   WF_GRAPHIFY_ROOT   path to scan (default: project root = parent of AI_Workflow_Kit)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCAN_ROOT="${WF_GRAPHIFY_ROOT:-$PROJECT_ROOT}"
OUT_DIR="$PROJECT_ROOT/graphify-out"
GRAPH_JSON="$OUT_DIR/graph.json"

cd "$PROJECT_ROOT"

if ! command -v graphify &>/dev/null; then
  echo "ERROR: graphify not on PATH." >&2
  echo "Install: uv tool install graphifyy" >&2
  echo "Or skip Graphify and rely on PROJECT_CONTEXT.md + scoped file reads." >&2
  exit 1
fi

EXTRACT_ARGS=(--out "$PROJECT_ROOT" --no-cluster)
if [[ "${1:-}" == "--force" ]] || [[ "${GRAPHIFY_FORCE:-}" == "1" ]]; then
  EXTRACT_ARGS+=(--force)
fi

echo "Rebuilding knowledge graph"
echo "  scan root: $SCAN_ROOT"
echo "  output:    $GRAPH_JSON"
mkdir -p "$OUT_DIR"

build_graph() {
  if graphify extract "$SCAN_ROOT" "${EXTRACT_ARGS[@]}"; then
    return 0
  fi

  echo "warn: semantic extraction unavailable; retrying local AST code-only build" >&2
  graphify extract "$SCAN_ROOT" "${EXTRACT_ARGS[@]}" --code-only
}

# Incremental updates are local and deterministic. A first build tries semantic
# extraction, then degrades to code-only when no supported LLM backend is set.
if [[ -f "$GRAPH_JSON" ]]; then
  if ! graphify update "$SCAN_ROOT" --no-cluster; then
    echo "warn: graphify update failed; rebuilding from source" >&2
    build_graph
  fi
else
  build_graph
fi

if [[ -f "$GRAPH_JSON" ]]; then
  NODES=$(python3 -c 'import json,sys;g=json.load(open(sys.argv[1]));print(len(g.get("nodes",g if isinstance(g,list) else [])))' "$GRAPH_JSON" 2>/dev/null || echo "?")
  echo "OK: graphify-out/graph.json ready (nodes≈$NODES)"
  echo "Query examples:"
  echo "  graphify explain \"SomeSymbol\" --graph \"$GRAPH_JSON\""
  echo "  graphify path \"ModuleA\" \"ModuleB\" --graph \"$GRAPH_JSON\""
  echo "  graphify query \"where is X handled\" --graph \"$GRAPH_JSON\""
else
  echo "WARN: graph.json not found after rebuild — inspect graphify output above." >&2
  exit 1
fi
