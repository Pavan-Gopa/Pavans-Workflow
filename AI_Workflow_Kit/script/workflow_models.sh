#!/usr/bin/env bash
# Inspect and validate primary/backup role assignments for manual failover
# and progressive onboarding readiness.
#
# Usage:
#   workflow_models.sh status
#   workflow_models.sh validate
#   workflow_models.sh validate-level <main|execution|quality|full|design>
#   workflow_models.sh validate-role <role> [backup]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACTION="${1:-status}"
ARG2="${2:-}"
ARG3="${3:-}"

command -v omp >/dev/null 2>&1 || { echo "ERROR: omp is not on PATH." >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required." >&2; exit 1; }

case "$ACTION" in
  status|validate|validate-level|validate-role) ;;
  *)
    echo "Usage: $0 [status | validate | validate-level <level> | validate-role <role> [backup]]" >&2
    exit 2
    ;;
esac

cd "$PROJECT_ROOT"
ROLES_JSON="$(mktemp -t pavans-workflow-roles.XXXXXX)"
CATALOG_JSON="$(mktemp -t pavans-workflow-models.XXXXXX)"
trap 'rm -f "$ROLES_JSON" "$CATALOG_JSON"' EXIT

omp config get modelRoles --json >"$ROLES_JSON" 2>/dev/null || echo "{}" >"$ROLES_JSON"
omp models --json >"$CATALOG_JSON" 2>/dev/null || echo "[]" >"$CATALOG_JSON"

python3 - "$ACTION" "$ARG2" "$ARG3" "$ROLES_JSON" "$CATALOG_JSON" <<'PY'
import json
import re
import sys
from pathlib import Path

ACTION, ARG2, ARG3, ROLES_PATH, CATALOG_PATH = sys.argv[1:6]

ROLE_MAP = {
    "orchestrator": ("Orchestrator", "workflow_orchestrator", "workflow_orchestrator_backup", False),
    "coder": ("Coder", "workflow_coder", "workflow_coder_backup", False),
    "reviewer": ("Reviewer", "workflow_reviewer", "workflow_reviewer_backup", False),
    "tester": ("Tester", "workflow_tester", "workflow_tester_backup", False),
    "architect": ("Architect", "workflow_architect", "workflow_architect_backup", False),
    "security": ("Security", "workflow_security", "workflow_security_backup", False),
    "design_advisor": ("Design Advisor", "workflow_design_advisor", "workflow_design_advisor_backup", True),
    "designer": ("Designer", "workflow_designer", "workflow_designer_backup", True),
}

CORE_ROLES = ["orchestrator", "coder", "reviewer", "tester", "architect", "security"]
OPTIONAL_ROLES = ["design_advisor", "designer"]
ORDERED_ROLES = CORE_ROLES + OPTIONAL_ROLES

LEVEL_ROLES = {
    "main": ["orchestrator"],
    "execution": ["orchestrator", "coder"],
    "quality": ["orchestrator", "coder", "reviewer", "tester"],
    "full": CORE_ROLES,
    "design": OPTIONAL_ROLES,
}

EFFORTS = {"minimal", "low", "medium", "high", "xhigh", "max", "auto"}

try:
    roles_document = json.loads(Path(ROLES_PATH).read_text())
    roles = roles_document.get("value", roles_document) if isinstance(roles_document, dict) else {}
    if not isinstance(roles, dict):
        roles = {}
except Exception:
    roles = {}

try:
    catalog_document = json.loads(Path(CATALOG_PATH).read_text())
    models = catalog_document.get("models", catalog_document) if isinstance(catalog_document, dict) else catalog_document
    if not isinstance(models, list):
        models = []
except Exception:
    models = []

available = {
    (item.get("provider"), item.get("id"))
    for item in models
    if isinstance(item, dict) and isinstance(item.get("provider"), str) and isinstance(item.get("id"), str)
}

default_model_selector = None
if models and isinstance(models[0], dict) and "provider" in models[0] and "id" in models[0]:
    default_model_selector = f"{models[0]['provider']}/{models[0]['id']}"

def concrete_role(name, stack=()):
    value = roles.get(name)
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    match = re.fullmatch(r"@([^:]+)(?::(minimal|low|medium|high|xhigh|max|auto))?", value)
    if not match:
        return value
    target, override = match.groups()
    if target == "default":
        resolved = default_model_selector
    elif target in stack:
        return None
    else:
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

def evaluate_role(role_key):
    label, primary_alias, backup_alias, optional = ROLE_MAP[role_key]
    primary = concrete_role(primary_alias)
    backup = concrete_role(backup_alias)
    primary_ok = selector_identity(primary) is not None
    backup_ok = selector_identity(backup) is not None
    same_provider = bool(primary_ok and backup_ok and provider_of(primary) == provider_of(backup))
    return {
        "key": role_key,
        "label": label,
        "primary_alias": primary_alias,
        "backup_alias": backup_alias,
        "primary": primary,
        "backup": backup,
        "primary_ok": primary_ok,
        "backup_ok": backup_ok,
        "same_provider": same_provider,
        "optional": optional,
    }

if ACTION == "status":
    print("Role            Primary                                      Backup                                       Status")
    print("--------------  -------------------------------------------  -------------------------------------------  ----------------")
    for key in ORDERED_ROLES:
        info = evaluate_role(key)
        notes = []
        if not info["primary"]:
            notes.append("primary missing (optional)" if info["optional"] else "primary missing")
        elif not info["primary_ok"]:
            notes.append("primary unavailable")
        if not info["backup"]:
            notes.append("backup missing (optional)")
        elif not info["backup_ok"]:
            notes.append("backup unavailable")
        if info["same_provider"]:
            notes.append("same-provider warning")
        status = ", ".join(notes) if notes else "ready"
        print(f"{info['label']:<14}  {(info['primary'] or '-'):43.43}  {(info['backup'] or '-'):43.43}  {status}")
    sys.exit(0)

if ACTION == "validate":
    errors = []
    for key in ORDERED_ROLES:
        info = evaluate_role(key)
        if not info["primary_ok"]:
            errors.append(f"{info['label']} primary ({info['primary'] or 'missing'})")
        if not info["backup_ok"]:
            errors.append(f"{info['label']} backup ({info['backup'] or 'missing'})")
    if errors:
        print("ERROR: unresolved model pairs: " + ", ".join(errors), file=sys.stderr)
        sys.exit(1)
    print("OK: all 8 primary and backup model roles verified")
    sys.exit(0)

if ACTION == "validate-level":
    level = ARG2.lower().strip()
    if level not in LEVEL_ROLES:
        print("ERROR: unknown readiness level. Choose: main, execution, quality, full, design", file=sys.stderr)
        sys.exit(2)
    checked_keys = LEVEL_ROLES[level]
    errors = []
    for key in checked_keys:
        info = evaluate_role(key)
        if not info["primary_ok"]:
            errors.append(f"{info['label']} primary ({info['primary'] or 'missing'})")
        if level in {"full", "design"} and not info["backup_ok"]:
            errors.append(f"{info['label']} backup ({info['backup'] or 'missing'})")
    if errors:
        print(f"ERROR: readiness level '{level}' not satisfied: " + ", ".join(errors), file=sys.stderr)
        sys.exit(1)
    print(f"OK: readiness level '{level}' satisfied ({len(checked_keys)} roles verified)")
    sys.exit(0)

if ACTION == "validate-role":
    raw_role = ARG2.lower().strip().replace("workflow_", "").replace("-", "_")
    target_backup = ARG3.lower().strip() == "backup"
    if raw_role not in ROLE_MAP:
        choices = ", ".join(ORDERED_ROLES)
        print(f"ERROR: unknown role '{ARG2}'. Choose from: {choices}", file=sys.stderr)
        sys.exit(2)
    info = evaluate_role(raw_role)
    if target_backup:
        if not info["backup_ok"]:
            print(f"ERROR: {info['label']} backup role '{info['backup_alias']}' ({info['backup'] or 'missing'}) is not available", file=sys.stderr)
            sys.exit(1)
        print(f"OK: {info['label']} backup model verified ({info['backup']})")
    else:
        if not info["primary_ok"]:
            print(f"ERROR: {info['label']} primary role '{info['primary_alias']}' ({info['primary'] or 'missing'}) is not available", file=sys.stderr)
            sys.exit(1)
        print(f"OK: {info['label']} primary model verified ({info['primary']})")
    sys.exit(0)
PY
