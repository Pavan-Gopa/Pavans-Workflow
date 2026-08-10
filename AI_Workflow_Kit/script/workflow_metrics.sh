#!/usr/bin/env bash
# Launch the dependency-free metrics helper through the workflow's Graphify Python prerequisite.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/workflow_metrics.py"
COMMAND="${1:-}"

if command -v python3 >/dev/null 2>&1; then
  exec python3 "$HELPER" "$@"
fi

if command -v uv >/dev/null 2>&1; then
  exec uv run --no-project "$HELPER" "$@"
fi

PIPX_HOME_VALUE="${PIPX_HOME:-$HOME/.local/pipx}"
for python_path in \
  "$PIPX_HOME_VALUE/venvs/graphifyy/bin/python" \
  "$PIPX_HOME_VALUE/venvs/graphify/bin/python"; do
  if [[ -x "$python_path" ]]; then
    exec "$python_path" "$HELPER" "$@"
  fi
done

printf 'WARN metrics unavailable: Python runtime from the required Graphify installation was not found\n' >&2
case "$COMMAND" in
  self-check|selftest|validate)
    exit 1
    ;;
  *)
    # Observer failure must never control or block the product workflow.
    exit 0
    ;;
esac
