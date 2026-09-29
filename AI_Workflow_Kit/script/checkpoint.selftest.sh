#!/usr/bin/env bash
# Deterministic selftest for checkpoint.sh scoping in a shared worktree.
set -euo pipefail

main() {
  local here temp project out
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  temp="$(mktemp -d "${TMPDIR:-/tmp}/wf-checkpoint-test.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$temp'" EXIT
  project="$temp/project"
  mkdir -p "$project/AI_Workflow_Kit/script" "$project/src" "$project/other"
  cp "$here/checkpoint.sh" "$project/AI_Workflow_Kit/script/checkpoint.sh"
  cd "$project"
  git init -q
  git config user.email t@example.com
  git config user.name t
  echo a > src/a.ts
  echo o > other/o.ts
  git add -A
  git commit -qm base

  fail() { echo "checkpoint.selftest: FAIL: $*" >&2; exit 1; }
  run() { WF_PUSH_CHECKPOINTS=0 bash AI_Workflow_Kit/script/checkpoint.sh "$@" 2>&1; }

  # Clean worktree, no scope: tag HEAD.
  out="$(run pre S1)" || fail "clean pre: $out"
  git rev-parse -q --verify proj/pre-S1 >/dev/null || fail "pre tag missing"

  # The step's work plus a parallel session's edits (one of them staged).
  echo a2 > src/a.ts
  echo new > src/new.ts
  echo o2 > other/o.ts
  echo staged > other/staged.ts
  git add other/staged.ts

  # Dirty worktree without a scope still refuses: say what to commit.
  if out="$(run post S1 x)"; then fail "unscoped dirty post must refuse"; fi
  [[ "$out" == *"WF_STAGE_PATHS is not set"* ]] || fail "unscoped message: $out"

  # Strict mode keeps the old refusal.
  if out="$(WF_STAGE_PATHS=src WF_CHECKPOINT_STRICT=1 run post S1 x)"; then fail "strict must refuse"; fi
  [[ "$out" == *"outside the authorized checkpoint scope"* ]] || fail "strict message: $out"

  # Default: commit only the scope, leave everything else exactly as it was.
  out="$(WF_STAGE_PATHS=src run post S1 "scoped")" || fail "scoped post: $out"
  [[ "$out" == *"2 changed path(s) outside WF_STAGE_PATHS stay uncommitted"* ]] || fail "note missing: $out"
  [[ "$(git show --name-only --format= HEAD | sort | tr '\n' ' ')" == "src/a.ts src/new.ts " ]] || fail "commit content: $(git show --stat HEAD)"
  [[ "$(git status --porcelain | sort | tr '\n' '|')" == " M other/o.ts|A  other/staged.ts|" ]] || fail "others' changes altered: $(git status --porcelain)"
  git rev-parse -q --verify proj/S1-done >/dev/null || fail "post tag missing"

  # Scope entries that match nothing (never created, ignored) are skipped.
  printf 'dist/\n' > .gitignore
  git add .gitignore && git commit -qm ignore -- .gitignore
  mkdir -p dist && echo built > dist/app.js
  echo a3 > src/a.ts
  out="$(WF_STAGE_PATHS=$'src\nsrc/never-created.ts\ndist' run post S1b "missing paths")" || fail "missing scope paths: $out"
  [[ "$out" == *"nothing to stage under src/never-created.ts"* && "$out" == *"nothing to stage under dist"* ]] || fail "skip notes: $out"
  [[ "$(git show --name-only --format= HEAD | tr '\n' ' ')" == "src/a.ts " ]] || fail "missing-path commit: $(git show --stat HEAD)"

  # A staged rename is committed whole, even though its source no longer exists.
  git mv src/new.ts src/renamed.ts
  out="$(WF_STAGE_PATHS=$'src/new.ts\nsrc/renamed.ts' run post S1c "rename")" || fail "rename: $out"
  [[ "$(git show --name-status --format= HEAD | tr '\t\n' ' |')" == "R100 src/new.ts src/renamed.ts|" ]] || fail "rename commit: $(git show --stat HEAD)"
  [[ -z "$(git diff --cached --name-only -- src)" ]] || fail "rename left staged changes"

  # An ignored folder with tracked files still checkpoints its tracked changes.
  git add -f dist/app.js && git commit -qm "track build" -- dist/app.js
  echo rebuilt > dist/app.js
  out="$(WF_STAGE_PATHS=dist run post S1d "ignored tracked")" || fail "ignored tracked: $out"
  [[ "$(git show --name-only --format= HEAD | tr '\n' ' ')" == "dist/app.js " ]] || fail "ignored tracked commit: $(git show --stat HEAD)"

  # A scope with nothing in it makes no commit but still tags.
  out="$(WF_STAGE_PATHS=src run pre S2)" || fail "empty scope pre: $out"
  [[ "$out" == *"nothing staged under authorized scope"* ]] || fail "empty scope message: $out"
  [[ "$(git rev-parse "proj/pre-S2^{commit}")" == "$(git rev-parse "proj/S1d-done^{commit}")" ]] || fail "empty scope moved HEAD"

  echo "checkpoint.selftest: PASS"
}

main "$@"
