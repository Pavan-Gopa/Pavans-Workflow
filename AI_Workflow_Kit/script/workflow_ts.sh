#!/usr/bin/env bash
# Shared TypeScript runner for workflow helpers (sourced, not executed).
#
#   source AI_Workflow_Kit/script/workflow_ts.sh
#   wf_ts_runner            # prints: node | bun | tsx | (nothing)
#   wf_run_ts file.ts args  # runs with the first available runner; 125 = none
#
# Node needs --experimental-strip-types (Node >= 22.6). Bun (bundled with OMP)
# and tsx run TypeScript natively.

wf_ts_runner() {
  if command -v node >/dev/null 2>&1 && node --no-warnings --experimental-strip-types -e 'void 0' >/dev/null 2>&1; then
    printf 'node\n'
  elif command -v bun >/dev/null 2>&1; then
    printf 'bun\n'
  elif command -v tsx >/dev/null 2>&1; then
    printf 'tsx\n'
  fi
}

wf_run_ts() {
  local runner
  runner="$(wf_ts_runner)"
  case "$runner" in
    node) NODE_NO_WARNINGS=1 node --no-warnings --experimental-strip-types "$@" ;;
    bun) bun "$@" ;;
    tsx) tsx "$@" ;;
    *) return 125 ;;
  esac
}
