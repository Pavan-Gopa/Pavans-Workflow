#!/usr/bin/env bash
# checkpoint.sh — scoped git checkpoints for the universal AI workflow kit
#
# Stages only this project tree (or WF_STAGE_PATHS). Never blindly git add -A
# on a monorepo parent.
#
# Usage (from project root that contains AI_Workflow_Kit/):
#   bash AI_Workflow_Kit/script/checkpoint.sh pre S1
#   bash AI_Workflow_Kit/script/checkpoint.sh post S1 "short description"
#   bash AI_Workflow_Kit/script/checkpoint.sh list
#   bash AI_Workflow_Kit/script/checkpoint.sh rollback pre|post S1
#
# Env:
#   WF_PROJECT_PREFIX  tag/commit prefix (default: proj)
#   WF_STAGE_PATHS     space-separated paths relative to git root to stage
#                      (default: auto — this project root as "." if nested repo,
#                       or relative path from monorepo root to this project)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRODUCT_PREFIX="${WF_PROJECT_PREFIX:-proj}"

die() { echo "error: $*" >&2; exit 1; }

cd "$PROJECT_ROOT"
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git work tree"
cd "$GIT_ROOT"

# Resolve what to stage
if [[ -n "${WF_STAGE_PATHS:-}" ]]; then
  # shellcheck disable=SC2206
  STAGE_PATHS=($WF_STAGE_PATHS)
elif [[ "$GIT_ROOT" == "$PROJECT_ROOT" ]]; then
  STAGE_PATHS=(".")
else
  REL_FROM_ROOT="${PROJECT_ROOT#"$GIT_ROOT"/}"
  if [[ "$REL_FROM_ROOT" == "$PROJECT_ROOT" || -z "$REL_FROM_ROOT" ]]; then
    die "could not resolve project path relative to git root; set WF_STAGE_PATHS"
  fi
  STAGE_PATHS=("$REL_FROM_ROOT")
fi

resolve_step() {
  local step="${1:-}"
  if [[ -z "$step" ]]; then
    die "step id required (e.g. S0, S1, B1, feature-auth)"
  fi
  # Allow freeform step ids: letters, digits, dots, underscores, hyphens
  if [[ ! "$step" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    die "invalid step id: $step (use letters, digits, . _ -)"
  fi
}

pre_tag_for()  { echo "${PRODUCT_PREFIX}/pre-${1}"; }
post_tag_for() { echo "${PRODUCT_PREFIX}/${1}-done"; }

has_remote_push() {
  local url
  url="$(git remote get-url origin 2>/dev/null || true)"
  if [[ -z "$url" ]]; then
    url="$(git remote -v 2>/dev/null | awk '/\(push\)/{print $2; exit}')"
  fi
  [[ -n "$url" && "$url" != "DISABLED" && "$url" != *"DISABLED"* ]]
}

push_all() {
  local tag="$1"
  if has_remote_push; then
    local remote
    remote="$(git remote | head -1)"
    echo "→ git push $remote HEAD"
    git push -u "$remote" HEAD || echo "warn: push branch failed — local commit/tag kept"
    echo "→ git push $remote $tag"
    git push "$remote" "$tag" || echo "warn: push tag failed — local tag kept"
  else
    echo "warn: no pushable remote (DISABLED or missing) — commit/tag are LOCAL ONLY"
    echo "      human: enable remote and run: git push && git push --tags"
  fi
}

stage_scoped() {
  local p
  for p in "${STAGE_PATHS[@]}"; do
    if [[ "$p" == "." ]]; then
      git add -A -- .
    else
      git add -A -- "$p"
    fi
  done
}

commit_if_dirty_scoped() {
  local message="$1"
  stage_scoped
  if git diff --cached --quiet; then
    echo "nothing staged under project scope — no new commit"
    return 0
  fi
  git commit -m "$message"
  echo "committed: $message"
}

cmd_pre() {
  local step="$1"
  resolve_step "$step"
  local tag
  tag="$(pre_tag_for "$step")"
  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "tag $tag already exists → $(git rev-parse --short "$tag")"
    echo "skipping pre-commit (checkpoint already taken)"
    return 0
  fi
  commit_if_dirty_scoped "chore(${PRODUCT_PREFIX}): checkpoint before ${step}"
  git tag -a "$tag" -m "${PRODUCT_PREFIX} checkpoint before ${step}"
  echo "created tag $tag → $(git rev-parse --short HEAD)"
  push_all "$tag"
  echo "PRE-CHECK DONE: $tag"
}

cmd_post() {
  local step="$1"
  local detail="${2:-done}"
  resolve_step "$step"
  local tag
  tag="$(post_tag_for "$step")"
  if git rev-parse "$tag" >/dev/null 2>&1; then
    die "tag $tag already exists — refuse to overwrite. Delete manually if intentional."
  fi
  commit_if_dirty_scoped "feat(${PRODUCT_PREFIX}): ${step} — ${detail}"
  git tag -a "$tag" -m "${PRODUCT_PREFIX} ${step} done: ${detail}"
  echo "created tag $tag → $(git rev-parse --short HEAD)"
  push_all "$tag"
  echo "POST-CHECK DONE: $tag"
}

cmd_list() {
  echo "=== ${PRODUCT_PREFIX}/* tags ==="
  git tag -l "${PRODUCT_PREFIX}/*" --sort=creatordate
  echo "=== stage paths ==="
  printf '  %s\n' "${STAGE_PATHS[@]}"
  echo "=== recent commits (15) ==="
  git log --oneline --decorate -15
}

cmd_rollback() {
  local kind="$1"
  local step="$2"
  resolve_step "$step"
  local tag
  case "$kind" in
    pre) tag="$(pre_tag_for "$step")" ;;
    post|done) tag="$(post_tag_for "$step")" ;;
    *) die "rollback kind must be pre|post, got: $kind" ;;
  esac
  git rev-parse "$tag" >/dev/null 2>&1 || die "missing tag $tag"
  echo "WARNING: hard reset to $tag ($(git rev-parse --short "$tag"))"
  echo "Uncommitted work will be lost. Press Ctrl+C within 3s to abort..."
  sleep 3
  git reset --hard "$tag"
  echo "reset to $tag"
}

usage() {
  cat <<EOF
Usage:
  bash AI_Workflow_Kit/script/checkpoint.sh pre <step>
  bash AI_Workflow_Kit/script/checkpoint.sh post <step> [description]
  bash AI_Workflow_Kit/script/checkpoint.sh list
  bash AI_Workflow_Kit/script/checkpoint.sh rollback pre|post <step>

Env:
  WF_PROJECT_PREFIX   default: proj
  WF_STAGE_PATHS      paths relative to git root (default: auto)

Tags: <prefix>/pre-<step>, <prefix>/<step>-done
Stages only this project scope — never whole monorepo by accident.
EOF
}

main() {
  local action="${1:-}"
  shift || true
  case "$action" in
    pre) cmd_pre "${1:-}" ;;
    post) cmd_post "${1:-}" "${2:-done}" ;;
    list) cmd_list ;;
    rollback) cmd_rollback "${1:-}" "${2:-}" ;;
    -h|--help|help|"") usage; exit 0 ;;
    *) die "unknown action: $action" ;;
  esac
}

main "$@"
