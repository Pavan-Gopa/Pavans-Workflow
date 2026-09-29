#!/usr/bin/env bash
# End-to-end install / update / legacy-migration test with stub omp + graphify.
# CI only (not installed into projects). Runs the real shell entry points.
#
#   bash ci/e2e_install_update.sh            # uses this checkout as release v3.5.x
#   WF_E2E_LEGACY_REFS="<sha> ..."          # legacy releases to migrate from (default: 3.4.2 and 3.4.1)
#   WF_E2E_BASH=/bin/bash                    # interpreter for every nested bash (macOS 3.2 check)
#   WF_E2E_KEEP=1                            # keep the work directory for debugging

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wf-e2e.XXXXXX")"
if [[ "${WF_E2E_KEEP:-0}" == "1" ]]; then echo "work dir: $WORK"; else trap 'rm -rf "$WORK"' EXIT; fi
FRAMEWORK_URL="https://github.com/Pavan-Gopa/Pavans-Workflow.git"

pass() { printf 'PASS %s\n' "$*"; }
die() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
expect_file_text() { [[ "$(cat "$1")" == "$2" ]] || die "$1 changed: $(head -c 200 "$1")"; }

export HOME="$WORK/home" GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME" "$WORK/bin"
git config --global user.email ci@example.com
git config --global user.name ci
git config --global init.defaultBranch main
git config --global advice.detachedHead false
git config --global protocol.file.allow always

cat > "$WORK/bin/omp" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  --version) echo "omp 18.4.3" ;;
  "config get modelRoles --json") echo '{}' ;;
  "models --json") echo '[]' ;;
esac
exit 0
STUB
cat > "$WORK/bin/graphify" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == "--version" ]] && echo "graphify 0.9.46"
exit 0
STUB
chmod +x "$WORK/bin/omp" "$WORK/bin/graphify"
export PATH="$WORK/bin:$PATH" WF_INSTALL_SKIP_GRAPHIFY=1
SHIM_DIR="$WORK/bash-shim"
if [[ -n "${WF_E2E_BASH:-}" ]]; then
  # Every nested `bash` of the code under test resolves to this interpreter
  # (macOS CI: /bin/bash 3.2). Legacy fixtures are built without the shim.
  mkdir -p "$SHIM_DIR"
  ln -s "$WF_E2E_BASH" "$SHIM_DIR/bash"
  export PATH="$SHIM_DIR:$PATH"
  printf 'using %s\n' "$("$WF_E2E_BASH" --version | head -n 1)"
fi
fixture() { PATH="${PATH#"$SHIM_DIR:"}" "$@"; }

# A release = this checkout's files (tracked + new, minus deletions), tagged.
make_release() {
  local dest="$1" version="$2"
  mkdir -p "$dest"
  (cd "$REPO" && git ls-files -co --exclude-standard -z) | python3 -c '
import os, shutil, sys
src, dest = sys.argv[1], sys.argv[2]
for rel in sys.stdin.read().split("\0"):
    path = os.path.join(src, rel)
    if not rel or not os.path.isfile(path) or rel.startswith("node_modules/"):
        continue
    target = os.path.join(dest, rel)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copy2(path, target)
' "$REPO" "$dest"
  printf '%s\n' "$version" > "$dest/VERSION"
  printf '%s\n' "$version" > "$dest/AI_Workflow_Kit/VERSION"
  python3 - "$dest/AI_Workflow_Kit/vendor/dependencies.lock" "$version" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
open(path, "w", encoding="utf-8").write(re.sub(r"^workflow_version: .*$", f"workflow_version: {version}", text, flags=re.M))
PY
  git -C "$dest" init -q
  git -C "$dest" add -A
  git -C "$dest" commit -qm "release $version"
  git -C "$dest" tag "v$version"
}

new_product() {
  local dir="$1"
  mkdir -p "$dir/src"
  git -C "$dir" init -q
  printf '# Product\n' > "$dir/README.md"
  printf '1.2.3\n' > "$dir/VERSION"
  printf '# Product changelog\n' > "$dir/CHANGELOG.md"
  printf 'export const app = 1\n' > "$dir/src/app.ts"
  git -C "$dir" add -A
  git -C "$dir" commit -qm product
}

RELEASE="$WORK/release"
make_release "$RELEASE" "3.5.0"
printf 'export const obsolete = true;\n' > "$RELEASE/.omp/lib/zz-e2e-obsolete.ts"
git -C "$RELEASE" add -A && git -C "$RELEASE" commit -qm "3.5.0 fixture file" && git -C "$RELEASE" tag -f v3.5.0 >/dev/null
RELEASE_URL="file://$RELEASE"

# --- 1. fresh install into an existing product repository ------------------------------
PRODUCT="$WORK/Pavan's product"
new_product "$PRODUCT"
mkdir -p "$PRODUCT/.omp"
printf 'theme: dark\n' > "$PRODUCT/.omp/config.yml"
bash "$RELEASE/install.sh" "$PRODUCT" > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; die "install failed"; }
expect_file_text "$PRODUCT/README.md" "# Product"
expect_file_text "$PRODUCT/VERSION" "1.2.3"
expect_file_text "$PRODUCT/CHANGELOG.md" "# Product changelog"
grep -q 'theme: dark' "$PRODUCT/.omp/config.yml" || die "existing .omp/config.yml was not merged"
[[ -f "$PRODUCT/AI_Workflow_Kit/installed.manifest" ]] || die "install record missing"
grep -qi 'dust' -r "$PRODUCT/AI_Workflow_Kit/docs" && die "template leaked project data"
grep -q 'Workflow doctor: ready' "$WORK/install.log" || die "doctor did not pass after install"
pass "fresh install keeps product README/VERSION/CHANGELOG and merges .omp/config.yml"

set +e
bash "$RELEASE/install.sh" "$PRODUCT" > /dev/null 2>&1; rc=$?
set -e
[[ $rc -eq 3 ]] || die "second install should refuse with 3, got $rc"
CONFLICT="$WORK/conflict"
new_product "$CONFLICT"
mkdir -p "$CONFLICT/.omp"; printf 'mine\n' > "$CONFLICT/.omp/AGENTS.md"
set +e
bash "$RELEASE/install.sh" "$CONFLICT" > /dev/null 2>&1; rc=$?
set -e
[[ $rc -eq 4 ]] || die "conflicting install should refuse with 4, got $rc"
[[ ! -e "$CONFLICT/.omp/lib" ]] || die "conflicting install left partial files"
pass "install refuses re-install (3) and conflicts (4) without partial writes"

# --- 2. update from the newest release tag via the project's own updater ------------------
NEXT="$WORK/release-next"
make_release "$NEXT" "3.5.1"
printf 'export const added = true;\n' > "$NEXT/.omp/lib/zz-e2e-added.ts"
git -C "$NEXT" add -A && git -C "$NEXT" commit -qm "3.5.1 changes" && git -C "$NEXT" tag -f v3.5.1 >/dev/null
printf 'export default () => {};\n' > "$PRODUCT/.omp/extensions/my-custom.ts"
printf 'current_step: S9\n' > "$PRODUCT/AI_Workflow_Kit/docs/AI/STATE.yaml"
WF_UPSTREAM_URL="file://$NEXT" bash "$PRODUCT/AI_Workflow_Kit/script/workflow_update.sh" check "$PRODUCT" > "$WORK/check.log" 2>&1 \
  || { cat "$WORK/check.log"; die "update check failed"; }
grep -q '\[REMOVE\]  .omp/lib/zz-e2e-obsolete.ts' "$WORK/check.log" || { cat "$WORK/check.log"; die "check did not plan the removal"; }
grep -q '\[NEW\]     .omp/lib/zz-e2e-added.ts' "$WORK/check.log" || die "check did not plan the addition"
[[ -f "$PRODUCT/.omp/lib/zz-e2e-obsolete.ts" ]] || die "check must be read-only"
WF_UPSTREAM_URL="file://$NEXT" bash "$PRODUCT/AI_Workflow_Kit/script/workflow_update.sh" apply "$PRODUCT" > "$WORK/update.log" 2>&1 \
  || { cat "$WORK/update.log"; die "update apply failed"; }
[[ ! -e "$PRODUCT/.omp/lib/zz-e2e-obsolete.ts" ]] || die "removed framework file survived the update"
[[ -f "$PRODUCT/.omp/lib/zz-e2e-added.ts" ]] || die "new framework file missing"
[[ -f "$PRODUCT/.omp/extensions/my-custom.ts" ]] || die "custom extension was deleted"
grep -q "^current_step: S9$" "$PRODUCT/AI_Workflow_Kit/docs/AI/STATE.yaml" || die "project state was not preserved"
expect_file_text "$PRODUCT/README.md" "# Product"
expect_file_text "$PRODUCT/AI_Workflow_Kit/VERSION" "3.5.1"
grep -q 'Workflow doctor: ready' "$WORK/update.log" || die "doctor did not pass after update"
ls "$PRODUCT/.git/pavans-workflow/update-backups/"* > /dev/null 2>&1 || die "update backup missing"
pass "update from newest tag: removes deleted files, keeps custom files and state, backs up"

# --- 3. migration from legacy (pre-3.5) installs ------------------------------------------
legacy_source() {
  local ref="$1" dest="$2"
  if git -C "$REPO" cat-file -e "$ref^{commit}" 2>/dev/null \
     && git clone -q --no-checkout "$REPO" "$dest" && git -C "$dest" checkout -q "$ref"; then
    return 0
  fi
  rm -rf "$dest"
  git clone -q "$FRAMEWORK_URL" "$dest" 2>/dev/null && git -C "$dest" checkout -q "$ref" 2>/dev/null
}

legacy_product() {
  local dir="$1" src="$2"
  new_product "$dir"
  rm "$dir/VERSION" "$dir/CHANGELOG.md"  # the 3.4 installer refused projects that had them
  git -C "$dir" add -A && git -C "$dir" commit -qm "drop colliding files"
  fixture bash "$src/install.sh" "$dir" > "$WORK/legacy-install-$(basename "$dir").log" 2>&1 || true  # 3.4 doctor wants INSTALL.md
  [[ -d "$dir/AI_Workflow_Kit/experiments" ]] || { tail -20 "$WORK/legacy-install-$(basename "$dir").log"; die "legacy fixture did not install"; }
  git -C "$dir" add -A && git -C "$dir" commit -qm "workflow legacy install"
}

for LEGACY_REF in ${WF_E2E_LEGACY_REFS:-7171011 389f0bf}; do
  LEGACY_SRC="$WORK/legacy-src-$LEGACY_REF"
  if ! legacy_source "$LEGACY_REF" "$LEGACY_SRC"; then
    printf 'SKIP legacy migration from %s: unavailable\n' "$LEGACY_REF"
    continue
  fi
  label="$(tr -d '[:space:]' < "$LEGACY_SRC/VERSION")"

  # (a) documented path: new installer --update
  LEGACY="$WORK/legacy-$LEGACY_REF-curl"
  legacy_product "$LEGACY" "$LEGACY_SRC"
  bash "$NEXT/install.sh" --update "$LEGACY" > "$WORK/legacy-update.log" 2>&1 || { cat "$WORK/legacy-update.log"; die "$label update failed"; }
  [[ ! -e "$LEGACY/AI_Workflow_Kit/experiments" ]] || die "obsolete experiments/ survived ($label)"
  [[ ! -e "$LEGACY/AI_Workflow_Kit/script/workflow_experiment.sh" ]] || die "obsolete bridge survived ($label)"
  grep -q 'PAVANS_WORKFLOW_EXPERIMENT' "$LEGACY/.omp/config.yml" && die "legacy config marker survived ($label)"
  expect_file_text "$LEGACY/README.md" "# Product"
  expect_file_text "$LEGACY/AI_Workflow_Kit/VERSION" "3.5.1"
  grep -q 'no longer managed' "$WORK/legacy-update.log" || die "legacy root VERSION/CHANGELOG notice missing ($label)"
  grep -q 'Workflow doctor: ready' "$WORK/legacy-update.log" || die "doctor did not pass after $label migration"
  pass "$label -> 3.5 via install.sh --update: obsolete files removed, config repaired, README kept"

  # (b) the legacy in-project updater itself (old code overwrites itself mid-run)
  LEGACY2="$WORK/legacy-$LEGACY_REF-inproject"
  legacy_product "$LEGACY2" "$LEGACY_SRC"
  (cd "$LEGACY2" && WF_UPSTREAM_URL="file://$NEXT" WF_UPSTREAM_BRANCH=v3.5.1 bash AI_Workflow_Kit/script/workflow_update.sh apply) \
    > "$WORK/legacy-old-updater.log" 2>&1 || { cat "$WORK/legacy-old-updater.log"; die "$label in-project updater failed"; }
  grep -q 'Completing the legacy update with the 3.5+ manager' "$WORK/legacy-old-updater.log" \
    || { tail -20 "$WORK/legacy-old-updater.log"; die "$label updater did not reach the landing pad"; }
  [[ -f "$LEGACY2/AI_Workflow_Kit/installed.manifest" ]] || die "$label in-project update left no install record"
  expect_file_text "$LEGACY2/README.md" "# Product"
  [[ ! -e "$LEGACY2/INSTALL.md" ]] || die "$label: framework INSTALL.md the legacy updater created was left behind"
  grep -q 'Workflow doctor: ready' "$WORK/legacy-old-updater.log" || die "doctor did not pass after the $label in-project update"
  pass "$label in-project updater lands on the 3.5 manager and completes (README restored)"
done

# --- 4. template clone (in place) ---------------------------------------------------------
CLONE="$WORK/template-clone"
git clone -q "$RELEASE_URL" "$CLONE"
bash "$CLONE/install.sh" "$CLONE" > "$WORK/clone.log" 2>&1 || { cat "$WORK/clone.log"; die "in-place install failed"; }
[[ -f "$CLONE/AI_Workflow_Kit/docs/AI/STATE.yaml" ]] || die "state not rendered in place"
git -C "$CLONE" status --porcelain | grep -q 'installed.manifest' && die "installed.manifest must stay untracked in the framework checkout"
pass "template clone renders state in place"

echo "e2e install/update: all scenarios passed"
