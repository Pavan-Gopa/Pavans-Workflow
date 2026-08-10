#!/usr/bin/env bash
# Inspect primary/backup role assignments and build the runtime fallback overlay.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACTION="${1:-status}"
OUTPUT_PATH="${2:-}"

if ! command -v omp >/dev/null 2>&1; then
  echo "ERROR: omp is not on PATH." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required to inspect workflow model pairs." >&2
  exit 1
fi

case "$ACTION" in
  status|validate|overlay) ;;
  *)
    echo "Usage: $0 [status|validate|overlay <output-file>]" >&2
    exit 2
    ;;
esac

if [[ "$ACTION" == "overlay" && -z "$OUTPUT_PATH" ]]; then
  echo "ERROR: overlay requires an output file." >&2
  exit 2
fi

cd "$PROJECT_ROOT"
ROLES_JSON="$(mktemp -t pavans-workflow-roles.XXXXXX)"
CATALOG_JSON="$(mktemp -t pavans-workflow-models.XXXXXX)"
trap 'rm -f "$ROLES_JSON" "$CATALOG_JSON"' EXIT

omp config get modelRoles --json >"$ROLES_JSON"
if [[ "$ACTION" != "overlay" ]]; then
  omp models --json >"$CATALOG_JSON"
else
  printf '{"models":[]}' >"$CATALOG_JSON"
fi

python3 - "$ACTION" "$ROLES_JSON" "$CATALOG_JSON" "$OUTPUT_PATH" <<'PY'
import json
import re
import sys
from pathlib import Path

ACTION, ROLES_PATH, CATALOG_PATH, OUTPUT_PATH = sys.argv[1:]
PAIRS = (
    ("Orchestrator", "workflow_orchestrator", "workflow_orchestrator_backup"),
    ("Architect", "workflow_architect", "workflow_architect_backup"),
    ("Coder", "workflow_coder", "workflow_coder_backup"),
    ("Reviewer", "workflow_reviewer", "workflow_reviewer_backup"),
    ("Tester", "workflow_tester", "workflow_tester_backup"),
    ("Security", "workflow_security", "workflow_security_backup"),
)
EFFORTS = {"minimal", "low", "medium", "high", "xhigh", "max", "auto"}

roles_document = json.loads(Path(ROLES_PATH).read_text())
roles = roles_document.get("value", roles_document)
if not isinstance(roles, dict):
    raise SystemExit("ERROR: omp returned an invalid modelRoles document")

catalog_document = json.loads(Path(CATALOG_PATH).read_text())
models = catalog_document.get("models", catalog_document) if isinstance(catalog_document, dict) else catalog_document
if not isinstance(models, list):
    models = []
available = {
    (item.get("provider"), item.get("id"))
    for item in models
    if isinstance(item, dict) and isinstance(item.get("provider"), str) and isinstance(item.get("id"), str)
}

def concrete_role(name, stack=()):
    value = roles.get(name)
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    match = re.fullmatch(r"@([^:]+)(?::(minimal|low|medium|high|xhigh|max|auto))?", value)
    if not match:
        return value
    target, override = match.groups()
    if target in stack:
        return None
    resolved = concrete_role(target, stack + (name,))
    if not resolved or not override:
        return resolved
    provider, separator, model_id = resolved.partition("/")
    if not separator:
        return None
    for effort in EFFORTS:
        suffix = f":{effort}"
        if model_id.endswith(suffix):
            model_id = model_id[:-len(suffix)]
            break
    return f"{provider}/{model_id}:{override}"

def selector_identity(selector):
    if not selector or "/" not in selector:
        return None
    provider, model_id = selector.split("/", 1)
    if (provider, model_id) in available:
        return provider, model_id
    suffix = model_id.rsplit(":", 1)
    if len(suffix) == 2 and suffix[1] in EFFORTS and (provider, suffix[0]) in available:
        return provider, suffix[0]
    return None

def provider_of(selector):
    return selector.split("/", 1)[0] if selector and "/" in selector else None

if ACTION == "overlay":
    chains = {}
    missing = []
    for label, primary_role, backup_role in PAIRS:
        backup = concrete_role(backup_role)
        if backup and "/" in backup:
            chains[primary_role] = [backup]
        else:
            missing.append(f"{label} ({backup_role})")
    overlay = {
        "retry": {
            "enabled": True,
            "modelFallback": True,
            "fallbackRevertPolicy": "never",
            "fallbackChains": chains,
        }
    }
    Path(OUTPUT_PATH).write_text(json.dumps(overlay, indent=2) + "\n")
    if missing:
        print("WARN: no runtime fallback for " + ", ".join(missing), file=sys.stderr)
    raise SystemExit(0)

print("Role         Primary                                      Backup                                       Status")
print("-----------  -------------------------------------------  -------------------------------------------  ----------------")
errors = []
for label, primary_role, backup_role in PAIRS:
    primary = concrete_role(primary_role)
    backup = concrete_role(backup_role)
    primary_ok = selector_identity(primary) is not None
    backup_ok = selector_identity(backup) is not None
    notes = []
    if not primary:
        notes.append("primary missing")
    elif not primary_ok:
        notes.append("primary unavailable")
    if not backup:
        notes.append("backup missing")
    elif not backup_ok:
        notes.append("backup unavailable")
    if primary_ok and backup_ok and provider_of(primary) == provider_of(backup):
        notes.append("same-provider warning")
    status = ", ".join(notes) if notes else "ready"
    print(f"{label:<11}  {(primary or '-'):43.43}  {(backup or '-'):43.43}  {status}")
    if not primary_ok or not backup_ok:
        errors.append(label)

if errors:
    print("\nERROR: unresolved model pairs: " + ", ".join(errors), file=sys.stderr)
    raise SystemExit(1)
PY
