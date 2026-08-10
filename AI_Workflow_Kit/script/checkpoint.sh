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
#   WF_PROJECT_PREFIX   tag/commit prefix (default: proj)
#   WF_STAGE_PATHS      explicit whitespace-separated paths relative to git root;
#                       use newline separation for paths containing spaces.
#                       Required whenever dirty work should be committed.
#   WF_PUSH_CHECKPOINTS set to 1 to push branch and tag (default: local only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRODUCT_PREFIX="${WF_PROJECT_PREFIX:-proj}"
PUSH_CHECKPOINTS="${WF_PUSH_CHECKPOINTS:-0}"

die() { echo "error: $*" >&2; exit 1; }

case "$PUSH_CHECKPOINTS" in
  0|1) ;;
  *) die "WF_PUSH_CHECKPOINTS must be 0 or 1" ;;
esac

cd "$PROJECT_ROOT"
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git work tree"
cd "$GIT_ROOT"

# Resolve the explicitly authorized commit scope. With no scope, checkpoints may
# tag a clean HEAD but never absorb working-tree changes.
STAGE_PATHS=()
if [[ -n "${WF_STAGE_PATHS:-}" ]]; then
  if [[ "$WF_STAGE_PATHS" == *$'\n'* ]]; then
    while IFS= read -r stage_path; do
      [[ -n "$stage_path" ]] && STAGE_PATHS+=("$stage_path")
    done <<<"$WF_STAGE_PATHS"
  else
    # shellcheck disable=SC2206
    STAGE_PATHS=($WF_STAGE_PATHS)
  fi
fi

for ((i = 0; i < ${#STAGE_PATHS[@]}; i++)); do
  stage_path="${STAGE_PATHS[$i]}"
  stage_path="${stage_path#./}"
  stage_path="${stage_path%/}"
  [[ -n "$stage_path" ]] || die "WF_STAGE_PATHS contains an empty path"
  [[ "$stage_path" != /* ]] || die "stage path must be relative to git root: $stage_path"
  if [[ "/$stage_path/" == *"/../"* ]]; then
    die "stage path may not traverse outside git root: $stage_path"
  fi
  STAGE_PATHS[$i]="$stage_path"
done

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

resolve_push_remote() {
  local remote
  local url
  while IFS= read -r remote; do
    [[ -n "$remote" ]] || continue
    url="$(git remote get-url --push "$remote" 2>/dev/null || true)"
    if [[ -n "$url" && "$url" != "DISABLED" && "$url" != *"DISABLED"* ]]; then
      printf '%s\n' "$remote"
      return 0
    fi
  done < <(git remote)
  return 1
}

push_checkpoint() {
  local tag="$1"
  if [[ "$PUSH_CHECKPOINTS" != "1" ]]; then
    echo "checkpoint kept local (set WF_PUSH_CHECKPOINTS=1 to push branch and tag)"
    return 0
  fi
  local remote
  if remote="$(resolve_push_remote)"; then
    echo "→ git push $remote HEAD"
    git push -u "$remote" HEAD || echo "warn: push branch failed — local commit/tag kept"
    echo "→ git push $remote $tag"
    git push "$remote" "$tag" || echo "warn: push tag failed — local tag kept"
  else
    echo "warn: push requested but no pushable remote exists — commit/tag are LOCAL ONLY"
  fi
}

changed_paths() {
  git diff --name-only -z
  git diff --cached --name-only -z
  git ls-files --others --exclude-standard -z
}

path_is_allowed() {
  local changed="$1"
  local allowed
  for allowed in "${STAGE_PATHS[@]}"; do
    if [[ "$allowed" == "." || "$changed" == "$allowed" || "$changed" == "$allowed/"* ]]; then
      return 0
    fi
  done
  return 1
}

assert_scope_safe() {
  local changed
  local unsafe=()
  while IFS= read -r -d '' changed; do
    if ! path_is_allowed "$changed"; then
      unsafe+=("$changed")
    fi
  done < <(changed_paths)

  if (( ${#unsafe[@]} > 0 )); then
    echo "error: changed paths exist outside the authorized checkpoint scope:" >&2
    printf '  %s\n' "${unsafe[@]}" >&2
    if (( ${#STAGE_PATHS[@]} == 0 )); then
      echo "Set WF_STAGE_PATHS explicitly, or commit/stash the changes before checkpointing." >&2
    else
      echo "Commit/stash unrelated changes or deliberately expand WF_STAGE_PATHS." >&2
    fi
    exit 1
  fi
}

stage_scoped() {
  local p
  for p in "${STAGE_PATHS[@]}"; do
    git add -A -- "$p"
  done
}

commit_if_dirty_scoped() {
  local message="$1"
  assert_scope_safe
  if (( ${#STAGE_PATHS[@]} == 0 )); then
    echo "clean worktree and no WF_STAGE_PATHS — tagging current HEAD without a commit"
    return 0
  fi
  stage_scoped
  if git diff --cached --quiet; then
    echo "nothing staged under authorized scope — no new commit"
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
  push_checkpoint "$tag"
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
  push_checkpoint "$tag"
  echo "POST-CHECK DONE: $tag"
}

cmd_list() {
  echo "=== ${PRODUCT_PREFIX}/* tags ==="
  git tag -l "${PRODUCT_PREFIX}/*" --sort=creatordate
  echo "=== authorized stage paths ==="
  if (( ${#STAGE_PATHS[@]} > 0 )); then
    printf '  %s\n' "${STAGE_PATHS[@]}"
  else
    echo "  (none; dirty checkpoints require WF_STAGE_PATHS)"
  fi
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
  WF_PROJECT_PREFIX    default: proj
  WF_STAGE_PATHS       explicit paths relative to git root; required for dirty
                       checkpoints. Use "." only to authorize the whole repo.
  WF_PUSH_CHECKPOINTS  1 pushes branch and tag; default 0 keeps both local.

Tags: <prefix>/pre-<step>, <prefix>/<step>-done
Refuses changed paths outside WF_STAGE_PATHS.
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
