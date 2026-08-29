#!/usr/bin/env bash
# Apply or roll back the lean-pipeline experiment overlay.
#
# Usage:
#   install.sh apply [project]
#   install.sh check [project]
#   install.sh doctor [project]
#   install.sh rollback [project]
#
# Live STEPS.md, PROJECT_CONTEXT, reports, product code, and model-role
# selections are never replaced. STATE.yaml receives an additive pipeline
# block only when that key is missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ACTION="apply"
TARGET="${2:-${1:-$PWD}}"

if [[ "${1:-}" == "apply" || "${1:-}" == "check" || "${1:-}" == "doctor" || "${1:-}" == "rollback" || "${1:-}" == "status" ]]; then
  ACTION="$1"
  TARGET="${2:-$PWD}"
elif [[ -n "${1:-}" && ( "$1" == /* || -d "$1" ) ]]; then
  ACTION="apply"
  TARGET="$1"
fi

MANIFEST="$SCRIPT_DIR/manifest.txt"
MARKER_REL=".omp/workflow-lean-pipeline.json"
PIPELINE_COMMENT="# Lean-pipeline experiment. Default standard keeps Coder -> Reviewer -> Tester."
VERSION_ID="3.4.0-exp.lean"

say() { printf 'OK   %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

absolute_dir() {
  local path="$1"
  [[ -d "$path" ]] || fail "project directory not found: $path"
  (cd "$path" && pwd)
}

manifest_paths() {
  grep -vE '^[[:space:]]*(#|$)' "$MANIFEST"
}

git_common_dir() {
  local project="$1"
  local common
  common="$(git -C "$project" rev-parse --git-common-dir 2>/dev/null || echo "$project/.git")"
  case "$common" in
    /*) printf '%s\n' "$common" ;;
    *) printf '%s\n' "$project/$common" ;;
  esac
}

marker_path() { printf '%s/%s\n' "$1" "$MARKER_REL"; }

read_marker_backup() {
  python3 - "$1" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
data = json.loads(path.read_text(encoding="utf-8"))
print(data.get("backup") or "")
print("1" if data.get("state_pipeline_added") else "0")
for item in data.get("added_files") or []:
    print(item)
PY
}

write_marker() {
  local project="$1" backup="$2" added_file="$3" state_added="$4" commit="$5"
  python3 - "$project/$MARKER_REL" "$backup" "$added_file" "$state_added" "$commit" "$VERSION_ID" <<'PY'
import json, pathlib, sys
from datetime import datetime, timezone
marker, backup, added_path, state_added, commit, version = sys.argv[1:7]
added = [line.strip() for line in pathlib.Path(added_path).read_text(encoding="utf-8").splitlines() if line.strip()]
payload = {
    "name": "lean-pipeline",
    "version": version,
    "installed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "backup": backup,
    "source_commit": commit,
    "state_pipeline_added": state_added == "1",
    "added_files": added,
}
path = pathlib.Path(marker)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
}

ensure_pipeline_block() {
  python3 - "$1/AI_Workflow_Kit/docs/AI/STATE.yaml" "$PIPELINE_COMMENT" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
comment = sys.argv[2]
if not path.is_file():
    raise SystemExit(2)
text = path.read_text(encoding="utf-8")
if any(line.startswith("pipeline:") for line in text.splitlines()):
    print("0")
    raise SystemExit(0)
block = (
    "\n"
    + comment + "\n"
    + "pipeline:\n"
    + "  profile: standard\n"
    + "  authorized_by: null\n"
    + "  authorized_at: null\n"
    + "  quick_forbidden: false\n"
    + "  note: null\n"
)
if "\nnext_actor:" in text:
    text = text.replace("\nnext_actor:", block + "\nnext_actor:", 1)
else:
    text = text.rstrip() + "\n" + block
path.write_text(text, encoding="utf-8")
print("1")
PY
}

remove_pipeline_block() {
  python3 - "$1/AI_Workflow_Kit/docs/AI/STATE.yaml" "$PIPELINE_COMMENT" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
comment = sys.argv[2]
if not path.is_file():
    raise SystemExit(0)
text = path.read_text(encoding="utf-8")
pattern = re.compile(
    r"\n?" + re.escape(comment) + r"\npipeline:\n(?:  [^\n]*\n)*",
)
path.write_text(pattern.sub("\n", text, count=1), encoding="utf-8")
PY
}

omp_looks_live() {
  local project="$1"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -fl omp >/dev/null 2>&1 || return 1
    # Best-effort: do not hard-fail; caller warns.
    return 0
  fi
  return 1
}

require_source() {
  [[ -f "$MANIFEST" ]] || fail "missing experiment manifest: $MANIFEST"
  local rel
  while IFS= read -r rel; do
    [[ -e "$SOURCE_ROOT/$rel" ]] || fail "experiment source missing: $rel"
  done < <(manifest_paths)
}

copy_tree() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [[ -d "$src" ]]; then
    rm -rf "$dst"
    cp -R "$src" "$dst"
  else
    cp -p "$src" "$dst"
  fi
}

apply_action() {
  local project
  project="$(absolute_dir "$TARGET")"
  [[ -f "$project/.omp/config.yml" ]] || fail "existing workflow config is required: $project/.omp/config.yml"
  require_source
  if omp_looks_live "$project"; then
    warn "an omp process appears to be running; close it before apply if this is the live project"
  fi
  if [[ -f "$(marker_path "$project")" ]]; then
    fail "lean-pipeline is already installed. rollback first, or doctor to inspect"
  fi

  local common stamp backup commit added_list
  common="$(git_common_dir "$project")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$common/pavans-workflow/experiment-backups/lean-pipeline/$stamp"
  mkdir -p "$backup"
  commit="$(git -C "$SOURCE_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  added_list="$(mktemp)"
  trap 'rm -f "$added_list"' RETURN

  local rel
  while IFS= read -r rel; do
    if [[ -e "$project/$rel" ]]; then
      mkdir -p "$backup/$(dirname "$rel")"
      copy_tree "$project/$rel" "$backup/$rel"
    else
      printf '%s\n' "$rel" >> "$added_list"
    fi
    copy_tree "$SOURCE_ROOT/$rel" "$project/$rel"
    say "synced $rel"
  done < <(manifest_paths)

  chmod +x "$project"/AI_Workflow_Kit/script/*.sh 2>/dev/null || true
  chmod +x "$project"/AI_Workflow_Kit/script/*.py 2>/dev/null || true
  chmod +x "$project/AI_Workflow_Kit/experiments/lean-pipeline/install.sh" 2>/dev/null || true

  local state_added="0"
  if state_added="$(ensure_pipeline_block "$project")"; then
    :
  else
    fail "STATE.yaml missing; cannot add pipeline profile defaults"
  fi

  write_marker "$project" "$backup" "$added_list" "$state_added" "$commit"
  printf '%s\n' "$MARKER_REL" >> "$backup/ADDED_FILES.txt"
  say "marker $MARKER_REL"
  printf '\nLean pipeline applied to %s\n' "$project"
  printf 'Backup: %s\n' "$backup"
  printf 'Restart OMP. Rollback with:\n  bash AI_Workflow_Kit/experiments/lean-pipeline/install.sh rollback\n'
}

rollback_action() {
  local project
  project="$(absolute_dir "$TARGET")"
  local marker
  marker="$(marker_path "$project")"
  [[ -f "$marker" ]] || fail "lean-pipeline is not installed (missing $MARKER_REL)"

  local backup state_added
  local -a added=()
  {
    IFS= read -r backup
    IFS= read -r state_added
    while IFS= read -r line; do
      [[ -n "$line" ]] && added+=("$line")
    done
  } < <(read_marker_backup "$marker" || true)
  [[ -n "$backup" && -d "$backup" ]] || fail "backup directory missing: ${backup:-unset}"

  local rel
  while IFS= read -r rel; do
    if [[ -e "$backup/$rel" ]]; then
      copy_tree "$backup/$rel" "$project/$rel"
      say "restored $rel"
    fi
  done < <(manifest_paths)

  for rel in "${added[@]}"; do
    rm -rf "$project/$rel"
    say "removed added $rel"
  done
  rm -f "$marker"
  if [[ "$state_added" == "1" ]]; then
    remove_pipeline_block "$project"
    say "removed additive STATE.yaml pipeline block"
  fi
  printf '\nLean pipeline rolled back in %s\n' "$project"
  printf 'Restart OMP so the restored agents and extensions load.\n'
}

check_action() {
  local project
  project="$(absolute_dir "$TARGET")"
  if [[ -f "$(marker_path "$project")" ]]; then
    python3 - "$(marker_path "$project")" <<'PY'
import json, pathlib, sys
data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(f"installed: {data.get('name')} {data.get('version')}")
print(f"installed_at: {data.get('installed_at')}")
print(f"backup: {data.get('backup')}")
PY
  else
    echo "lean-pipeline is not installed"
  fi
  require_source
  local rel changed=0
  while IFS= read -r rel; do
    if [[ ! -e "$project/$rel" ]]; then
      printf '[MISSING]  %s\n' "$rel"; changed=1
    elif [[ -f "$SOURCE_ROOT/$rel" && -f "$project/$rel" ]] && ! cmp -s "$SOURCE_ROOT/$rel" "$project/$rel"; then
      printf '[DIFFERS]  %s\n' "$rel"; changed=1
    fi
  done < <(manifest_paths)
  (( changed == 0 )) && echo "Overlay matches this checkout."
}

doctor_action() {
  local project
  project="$(absolute_dir "$TARGET")"
  local failures=0
  check() {
    local label="$1"; shift
    if "$@" >/dev/null 2>&1; then
      printf 'OK   %s\n' "$label"
    else
      printf 'FAIL %s\n' "$label" >&2
      failures=$((failures + 1))
    fi
  }
  check "marker present" test -f "$(marker_path "$project")"
  check "gates helper" test -f "$project/AI_Workflow_Kit/script/workflow_gates.py"
  check "security scope helper" test -f "$project/AI_Workflow_Kit/script/workflow_security_scope.py"
  check "lean contract" test -f "$project/AI_Workflow_Kit/docs/AI/LEAN_PIPELINE.md"
  check "worker input digest" test -f "$project/AI_Workflow_Kit/docs/AI/WORKER_INPUT_DIGEST.md"
  check "gates selftest" python3 "$project/AI_Workflow_Kit/script/workflow_gates.selftest.py"
  check "security scope selftest" python3 "$project/AI_Workflow_Kit/script/workflow_security_scope.selftest.py"
  if grep -q 'quick_profile_close' "$project/.omp/lib/workflow-routing.ts"; then
    ok_label="routing knows quick profile"
    printf 'OK   %s\n' "$ok_label"
  else
    printf 'FAIL routing knows quick profile\n' >&2
    failures=$((failures + 1))
  fi
  if [[ $failures -eq 0 ]]; then
    printf '\nLean pipeline looks healthy. Restart OMP if you just applied it.\n'
  else
    printf '\n%s check(s) failed.\n' "$failures" >&2
    exit 1
  fi
}

case "$ACTION" in
  apply) apply_action ;;
  rollback) rollback_action ;;
  check|status) check_action ;;
  doctor) doctor_action ;;
  *) fail "unknown action: $ACTION (apply|check|doctor|rollback)" ;;
esac
