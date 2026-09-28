#!/usr/bin/env bash
# Safe explicit update of Pavan's Workflow framework files.
#
#   workflow_update.sh check        [PROJECT] [--ref REF]     read-only plan
#   workflow_update.sh apply        [PROJECT] [--ref REF] [--refresh-graphify]
#   workflow_update.sh render-state [PROJECT]                 recreate missing state files
#
# Default source: the newest upstream vX.Y.Z release tag (falls back to main).
# --source DIR uses an already downloaded release instead of cloning.
#
# Preserved: live state/plan/report files, product code, model selections,
# custom .omp files, custom .graphifyignore rules, and the Graphify index.
# Framework files are replaced from AI_Workflow_Kit/framework.manifest; every
# apply is backed up under <git-common-dir>/pavans-workflow/update-backups/
# and rolled back automatically if it fails.
#
# The script body lives in main() and the downloaded release performs the
# update, so replacing this very file during apply is safe.
#
# Legacy landing pad: a pre-3.5 copy of this script overwrites itself while it
# copies framework files, and bash then resumes reading THIS file at the byte
# where the old loop ended (offsets 3.9-8.4 KB across 3.0-3.4). The block of
# whitespace-only lines below spans those offsets, so the old process lands on
# the handover line and finishes the update with the 3.5+ manager instead of
# stopping silently. Keep the pad lines whitespace-only (ci/repo_checks.py).

                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
                                                               
# legacy landing: runs only inside a pre-3.5 updater process (TEMP_CLONE/PROJECT_ROOT are its variables)
if [[ -n "${TEMP_CLONE:-}" && -n "${PROJECT_ROOT:-}" && "$(basename "${TEMP_CLONE:-x}")" == pavans-workflow-update.* \
      && -f "${TEMP_CLONE:-/nonexistent}/AI_Workflow_Kit/framework.manifest" ]]; then
  echo "Completing the legacy update with the 3.5+ manager"
  WF_LEGACY_ARGS=(apply "$PROJECT_ROOT" --source "$TEMP_CLONE")
  if [[ "${REFRESH_GRAPHIFY:-0}" == "1" ]]; then WF_LEGACY_ARGS+=(--refresh-graphify); fi
  WF_LEGACY_UPDATER_RAN=1 bash "$TEMP_CLONE/AI_Workflow_Kit/script/workflow_update.sh" "${WF_LEGACY_ARGS[@]}"
  exit $?
fi

set -euo pipefail
# Helpers and selftests must not leave __pycache__ in the project.
export PYTHONDONTWRITEBYTECODE=1

WF_CLEANUP_DIR=""
cleanup() { if [[ -n "$WF_CLEANUP_DIR" ]]; then rm -rf "$WF_CLEANUP_DIR"; fi; }
trap cleanup EXIT

resolve_ref() {
  # Newest strict vX.Y.Z tag upstream, else main. Keep in sync with install.sh.
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

main() {
  local action="apply" project="$PWD" source="" ref="${WF_UPSTREAM_REF:-}"
  local refresh_graphify="${WF_UPDATE_REFRESH_GRAPHIFY:-0}"
  local upstream_url="${WF_UPSTREAM_URL:-https://github.com/Pavan-Gopa/Pavans-Workflow.git}"
  while (( $# )); do
    case "$1" in
      check|apply|render-state) action="$1" ;;
      --source) [[ $# -ge 2 ]] || { echo "ERROR: --source needs a directory" >&2; return 2; }; source="$2"; shift ;;
      --ref) [[ $# -ge 2 ]] || { echo "ERROR: --ref needs a value" >&2; return 2; }; ref="$2"; shift ;;
      --ref=*) ref="${1#--ref=}" ;;
      --refresh-graphify) refresh_graphify=1 ;;
      --skip-graphify) refresh_graphify=0 ;;
      -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      -*) echo "ERROR: unknown option: $1" >&2; return 2 ;;
      *)
        if [[ -d "$1" ]]; then project="$1"; else echo "ERROR: project directory not found: $1" >&2; return 2; fi
        ;;
    esac
    shift
  done
  command -v git >/dev/null 2>&1 || { echo "ERROR: git is required." >&2; return 1; }
  command -v python3 >/dev/null 2>&1 || { echo "ERROR: Python 3.9+ is required." >&2; return 1; }
  project="$(cd "$project" && pwd)"

  if [[ "$action" == "render-state" ]]; then
    python3 "$project/AI_Workflow_Kit/script/workflow_framework.py" render-state --target "$project"
    return $?
  fi

  if [[ -z "$source" ]]; then
    # Download the release, then hand over to ITS copy of this script so the
    # update never executes a file it is replacing.
    local resolved temp
    resolved="$(resolve_ref "$upstream_url" "$ref")"
    temp="$(mktemp -d "${TMPDIR:-/tmp}/pavans-workflow-update.XXXXXX")"
    WF_CLEANUP_DIR="$temp"
    echo "Fetching Pavan's Workflow ($resolved) from $upstream_url"
    git clone -q --depth 1 --branch "$resolved" "$upstream_url" "$temp/pw"
    if [[ ! -f "$temp/pw/AI_Workflow_Kit/framework.manifest" ]]; then
      echo "ERROR: $resolved predates 3.5 (no AI_Workflow_Kit/framework.manifest); this updater cannot install it." >&2
      return 1
    fi
    local handoff=("$action" "$project" --source "$temp/pw")
    if [[ "$refresh_graphify" == "1" ]]; then handoff+=(--refresh-graphify); fi
    WF_CLEANUP_DIR=""
    # The downloaded copy removes its own temp dir (validated below).
    WF_UPDATE_OWNED_TEMP="$temp" exec bash "$temp/pw/AI_Workflow_Kit/script/workflow_update.sh" "${handoff[@]}"
  fi
  source="$(cd "$source" && pwd)"
  local owned="${WF_UPDATE_OWNED_TEMP:-}"
  unset WF_UPDATE_OWNED_TEMP
  if [[ -n "$owned" && "$source" == "$owned/pw" && "$(basename "$owned")" == pavans-workflow-update.* ]]; then
    WF_CLEANUP_DIR="$owned"
  fi
  if [[ ! -f "$source/AI_Workflow_Kit/framework.manifest" ]]; then
    echo "ERROR: $source is not a 3.5+ release (no AI_Workflow_Kit/framework.manifest)." >&2
    return 1
  fi

  local framework="$source/AI_Workflow_Kit/script/workflow_framework.py"
  local commit
  commit="$(git -C "$source" rev-parse --short HEAD 2>/dev/null || echo local)"

  if [[ "$action" == "check" ]]; then
    python3 "$framework" update --check --source "$source" --target "$project"
    return $?
  fi

  echo "Source: $source ($commit)"
  local legacy_flag=()
  if [[ "${WF_LEGACY_UPDATER_RAN:-0}" == "1" ]]; then legacy_flag=(--legacy-updater-ran); fi
  python3 "$framework" update --source "$source" --target "$project" ${legacy_flag[@]+"${legacy_flag[@]}"}
  chmod +x "$project"/AI_Workflow_Kit/script/*.sh 2>/dev/null || true

  local status=0
  printf '\n=== Migrating durable state ===\n'
  if ! bash "$project/AI_Workflow_Kit/script/workflow_migrate.sh" apply; then
    echo "ERROR: state migration failed; framework files were updated, state was left unchanged." >&2
    status=1
  fi

  if [[ "$refresh_graphify" != "1" ]]; then
    printf '\n=== Graphify refresh deferred (default) ===\n'
    printf 'Refresh later with: bash AI_Workflow_Kit/script/graphify_rebuild.sh fast\n'
  elif command -v graphify >/dev/null 2>&1; then
    printf '\n=== Refreshing Graphify (fast/local, timeout %ss) ===\n' "${WF_GRAPHIFY_UPDATE_TIMEOUT:-120}"
    if ! (cd "$project" && run_with_timeout "${WF_GRAPHIFY_UPDATE_TIMEOUT:-120}" bash AI_Workflow_Kit/script/graphify_rebuild.sh fast); then
      echo "WARN: Graphify refresh did not finish; the last valid graph and source tools remain available." >&2
    fi
  else
    echo "WARN: Graphify refresh requested, but graphify is not on PATH." >&2
  fi

  printf '\n=== Running workflow doctor ===\n'
  bash "$project/AI_Workflow_Kit/script/workflow_doctor.sh" || status=1

  local version
  version="$(tr -d '[:space:]' < "$project/AI_Workflow_Kit/VERSION")"
  printf '\nWorkflow updated to v%s (%s).\n' "$version" "$commit"
  printf 'Restart OMP so updated extensions, agents, skills, and model tags load.\n'
  return "$status"
}

main ${1+"$@"}; exit $?
