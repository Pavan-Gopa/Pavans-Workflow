#!/usr/bin/env bash
# Legacy compatibility shim — lives only in the framework repository and is
# never installed into projects.
#
# A pre-3.5 AI_Workflow_Kit/script/workflow_update.sh copies framework files
# from a downloaded release and then runs THIS path from that download. Finish
# that update with the 3.5+ manifest manager so obsolete files are removed,
# state templates are rendered, and root README/INSTALL/CHANGELOG/VERSION files
# the old updater overwrote are restored from its backup.

set -euo pipefail

main() {
  local source_root target
  source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  target="${1:-$PWD}"
  [[ -d "$target" ]] || target="$PWD"
  target="$(cd "$target" && pwd)"
  echo "Completing a legacy workflow update with the $(tr -d '[:space:]' < "$source_root/AI_Workflow_Kit/VERSION") manager"
  python3 "$source_root/AI_Workflow_Kit/script/workflow_framework.py" legacy-cleanup \
    --source "$source_root" --target "$target"
  python3 "$source_root/AI_Workflow_Kit/script/workflow_framework.py" update \
    --source "$source_root" --target "$target"
}

main ${1+"$@"}; exit $?
