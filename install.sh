#!/usr/bin/env bash
# Install or update Pavan's Workflow.
#
#   bash install.sh [TARGET]              install from this checkout into TARGET (default .)
#   bash install.sh --update [TARGET]     update TARGET from the latest release
#   bash <(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/install.sh) [TARGET]
#   bash <(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/install.sh) --update [TARGET]
#
# Options:
#   --ref <tag|branch>   use an exact upstream ref (default: newest vX.Y.Z tag, else main)
#   --refresh-graphify   (update) rebuild the Graphify index after updating
#
# Environment: WF_UPSTREAM_URL, WF_UPSTREAM_REF, WF_INSTALL_SKIP_GRAPHIFY=1,
#              WF_GRAPHIFY_INSTALL_TIMEOUT (seconds, default 120).
#
# The whole script lives in main() so bash has parsed it completely before any
# file is replaced (safe when a checkout updates itself).

set -euo pipefail

WF_TEMP_DIR=""
cleanup() { if [[ -n "$WF_TEMP_DIR" ]]; then rm -rf "$WF_TEMP_DIR"; fi; }
trap cleanup EXIT

usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

resolve_ref() {
  # Newest strict vX.Y.Z tag upstream, else main. Keep in sync with workflow_update.sh.
  local url="$1" requested="${2:-}" tag
  if [[ -n "$requested" ]]; then printf '%s\n' "$requested"; return; fi
  tag="$(git ls-remote --tags --refs --sort=-v:refname "$url" 'v*' 2>/dev/null \
    | awk -F/ '{print $NF}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
  if [[ -n "$tag" ]]; then printf '%s\n' "$tag"; else printf 'main\n'; fi
}

run_with_timeout() {
  local seconds="$1"; shift
  python3 - "$seconds" "$@" <<'PYTIMEOUT'
import os
import signal
import subprocess
import sys

seconds = float(sys.argv[1])
command = sys.argv[2:]
process = subprocess.Popen(command, start_new_session=True)
try:
    raise SystemExit(process.wait(timeout=seconds))
except subprocess.TimeoutExpired:
    print(f"WARN: timed out after {seconds:g}s: {' '.join(command)}", file=sys.stderr)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        try:
            process.wait(timeout=5)
            break
        except subprocess.TimeoutExpired:
            continue
    raise SystemExit(124)
PYTIMEOUT
}

ensure_graphify() {
  local target="$1" expected actual
  expected="$(awk '$1 == "graphify:" { in_graphify=1; next } in_graphify && $1 == "version:" { print $2; exit }' \
    "$target/AI_Workflow_Kit/vendor/dependencies.lock" 2>/dev/null || true)"
  expected="${expected:-0.9.46}"
  if ! command -v graphify >/dev/null 2>&1; then
    echo "Installing tested Graphify version $expected (package graphifyy)..."
    if command -v uv >/dev/null 2>&1; then
      uv tool install "graphifyy==$expected" || echo "WARN: Graphify install failed; source tools remain available." >&2
    elif command -v pipx >/dev/null 2>&1; then
      pipx install "graphifyy==$expected" || echo "WARN: Graphify install failed; source tools remain available." >&2
    else
      python3 -m pip install --user "graphifyy==$expected" || echo "WARN: Graphify install failed; install uv or pipx and retry." >&2
    fi
  else
    actual="$(graphify --version 2>/dev/null | awk '{print $NF}' || true)"
    if [[ "$actual" != "$expected" ]]; then
      echo "WARN: Graphify $actual is installed; this workflow release is pinned to $expected." >&2
    fi
  fi
}

main() {
  local upstream_url="${WF_UPSTREAM_URL:-https://github.com/Pavan-Gopa/Pavans-Workflow.git}"
  local mode="install" ref="${WF_UPSTREAM_REF:-}" target_input="." update_args=()
  while (( $# )); do
    case "$1" in
      --update|-u) mode="update" ;;
      --ref) [[ $# -ge 2 ]] || { echo "ERROR: --ref needs a value" >&2; return 2; }; ref="$2"; shift ;;
      --ref=*) ref="${1#--ref=}" ;;
      --refresh-graphify|--skip-graphify) update_args+=("$1") ;;
      -h|--help) usage; return 0 ;;
      -*) echo "ERROR: unknown option: $1" >&2; usage >&2; return 2 ;;
      *) target_input="$1" ;;
    esac
    shift
  done

  command -v git >/dev/null 2>&1 || { echo "ERROR: git is required." >&2; return 1; }
  command -v python3 >/dev/null 2>&1 || { echo "ERROR: Python 3.9+ is required." >&2; return 1; }
  [[ -d "$target_input" ]] || { echo "ERROR: target directory not found: $target_input" >&2; return 1; }
  local target_root script_dir source_root=""
  target_root="$(cd "$target_input" && pwd)"
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"

  # A real checkout next to this script is the source, unless an explicit ref
  # was requested or (for updates) the checkout is the project itself.
  if [[ -z "$ref" && -n "$script_dir" && -f "$script_dir/AI_Workflow_Kit/framework.manifest" ]]; then
    if [[ "$mode" == "install" || "$script_dir" != "$target_root" ]]; then
      source_root="$script_dir"
    fi
  fi
  if [[ -z "$source_root" ]]; then
    local resolved
    resolved="$(resolve_ref "$upstream_url" "$ref")"
    WF_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pavans-workflow.XXXXXX")"
    echo "Fetching Pavan's Workflow ($resolved) from $upstream_url"
    git clone -q --depth 1 --branch "$resolved" "$upstream_url" "$WF_TEMP_DIR/pw"
    source_root="$WF_TEMP_DIR/pw"
  fi

  if [[ "$mode" == "update" ]]; then
    bash "$source_root/AI_Workflow_Kit/script/workflow_update.sh" apply "$target_root" \
      --source "$source_root" ${update_args[@]+"${update_args[@]}"}
    return $?
  fi

  command -v omp >/dev/null 2>&1 || {
    echo "ERROR: OMP is required. Install: curl -fsSL https://omp.sh/install | sh" >&2
    return 1
  }
  local version
  version="$(tr -d '[:space:]' < "$source_root/AI_Workflow_Kit/VERSION")"
  printf '=== Installing Pavan'"'"'s Workflow v%s into %s ===\n' "$version" "$target_root"
  python3 "$source_root/AI_Workflow_Kit/script/workflow_framework.py" install \
    --source "$source_root" --target "$target_root"
  chmod +x "$target_root"/AI_Workflow_Kit/script/*.sh 2>/dev/null || true

  ensure_graphify "$target_root"
  if [[ "${WF_INSTALL_SKIP_GRAPHIFY:-0}" != "1" ]] && command -v graphify >/dev/null 2>&1; then
    if ! (cd "$target_root" && run_with_timeout "${WF_GRAPHIFY_INSTALL_TIMEOUT:-120}" \
        bash AI_Workflow_Kit/script/graphify_rebuild.sh fast); then
      echo "WARN: initial product graph was not built; source tools remain available." >&2
    fi
  fi
  bash "$target_root/AI_Workflow_Kit/script/workflow_doctor.sh"

  cat <<MESSAGE

Pavan's Workflow v$version is installed.

Next:
  1. Fill AI_Workflow_Kit/docs/PROJECT_CONTEXT.md (or let Main onboard you).
  2. Launch: bash AI_Workflow_Kit/script/omp_workflow.sh
  3. Alt+M -> Roles -> DEFAULT: persistent Main model + effort.
  4. Alt+M -> Roles: worker primary/backup pairs (keep Reviewer on a different model than Coder).
  5. Alt+W live dashboard · Alt+A Agent Hub · Alt+Q temporary Main backup.
MESSAGE
}

main ${1+"$@"}; exit $?
