#!/usr/bin/env python3
"""Framework-repository hygiene checks (CI only; never installed into projects).

1. No project state is tracked here: manifest `state` paths and
   AI_Workflow_Kit/installed.manifest must not be committed (templates only).
2. One version everywhere: VERSION, AI_Workflow_Kit/VERSION, dependencies.lock,
   the newest CHANGELOG entry, the README badge, and INSTALL.md agree.
3. No release numbers in contract/role docs (they drift); history lives in CHANGELOG.
4. Every tracked framework file is shipped by the manifest (or explicitly exempt).
5. Docs reference only rule IDs that TEAM_CONTRACT.md defines, and no removed scripts.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "AI_Workflow_Kit" / "script"))
import workflow_framework as fw  # noqa: E402

FRAMEWORK_PREFIXES = (".omp/", "AI_Workflow_Kit/", "grilling/", "ponytail/", "ponytail-review/",
                      "ponytail-audit/", "ponytail-debt/", "ui-designer/")
NOT_SHIPPED = {
    # Lives only here so pre-3.5 updaters can finish an update (see its header).
    "AI_Workflow_Kit/experiments/context-economy/install.sh",
}
CONTRACT_DOCS = ("AI_Workflow_Kit/docs/", ".omp/AGENTS.md", ".omp/agents/", ".omp/commands/", "PIPELINE.md",
                 "ORCHESTRATOR_FIRST_PROMPT.md", "AI_Workflow_Kit/templates/")
# Byte offsets where pre-3.5 workflow_update.sh copies (3.0.0-3.4.2) resume reading
# after their copy loop overwrote them (computed from git history).
LEGACY_RESUME_OFFSETS = (3967, 3976, 3986, 4076, 6913, 7413, 7561, 7922, 8406)
# Files that must name removed paths in order to clean them up.
LEGACY_AWARE = {"AI_Workflow_Kit/script/workflow_framework.py", "AI_Workflow_Kit/script/workflow_framework.selftest.py"}
REMOVED_REFERENCES = ("workflow_experiment.sh", "workflow_lean.sh", "experiments/lean-pipeline",
                      "EXPERIMENT_CONTEXT_ECONOMY", "workflow_experiment_config")


def tracked() -> list[str]:
    output = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], check=True, capture_output=True, text=True).stdout
    return [path for path in output.split("\0") if path and (ROOT / path).exists()]


def main() -> int:
    errors: list[str] = []
    files = tracked()
    entries = fw.parse_manifest(ROOT / fw.MANIFEST_REL)

    # 1. no tracked project state
    state = {entry.path for entry in entries if entry.kind == "state"} | {fw.RECORD_REL}
    for path in files:
        if path in state:
            errors.append(f"project state must not be committed to the framework repo: {path} (edit AI_Workflow_Kit/templates/ instead)")
    for entry in entries:
        if entry.kind == "state" and not (ROOT / fw.template_for(entry.path)).is_file():
            errors.append(f"state template missing: {fw.template_for(entry.path)}")

    # 2. one version
    version = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    checks = {
        "AI_Workflow_Kit/VERSION": (ROOT / "AI_Workflow_Kit/VERSION").read_text(encoding="utf-8").strip(),
        "dependencies.lock workflow_version": re.search(r"^workflow_version:\s*(\S+)", (ROOT / "AI_Workflow_Kit/vendor/dependencies.lock").read_text(encoding="utf-8"), re.M).group(1),  # type: ignore[union-attr]
        "CHANGELOG newest entry": re.search(r"^## (\d+\.\d+\.\d+)", (ROOT / "CHANGELOG.md").read_text(encoding="utf-8"), re.M).group(1),  # type: ignore[union-attr]
        "README badge": re.search(r"badge/version-(\d+\.\d+\.\d+)-", (ROOT / "README.md").read_text(encoding="utf-8")).group(1),  # type: ignore[union-attr]
    }
    install_versions = set(re.findall(r"^(\d+\.\d+\.\d+)$", (ROOT / "INSTALL.md").read_text(encoding="utf-8"), re.M))
    if install_versions and install_versions != {version}:
        errors.append(f"INSTALL.md expected version {sorted(install_versions)} != VERSION {version}")
    for label, value in checks.items():
        if value != version:
            errors.append(f"{label} is {value}, VERSION is {version}")

    # 3. no release numbers in contract docs
    for path in files:
        if not path.endswith(".md") or not path.startswith(CONTRACT_DOCS):
            continue
        for number, line in enumerate((ROOT / path).read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\b(?:Workflow\s+)?v\d+\.\d+(?:\.\d+)?\b", line) and "ponytail" not in path:
                errors.append(f"{path}:{number}: release number in a contract doc (move history to CHANGELOG.md): {line.strip()}")

    # 4. manifest coverage
    shipped = set(fw.managed_files(ROOT, entries)) | {fw.template_for(entry.path) for entry in entries if entry.kind == "state"}
    shipped |= {entry.path for entry in entries if entry.kind in ("seed", "config", "file")}
    for path in files:
        if path.startswith(FRAMEWORK_PREFIXES) and path not in shipped and path not in NOT_SHIPPED:
            errors.append(f"tracked framework file is not shipped by framework.manifest: {path}")

    # 5. rule IDs and removed references
    contract = (ROOT / "AI_Workflow_Kit/docs/AI/TEAM_CONTRACT.md").read_text(encoding="utf-8")
    defined = set(re.findall(r"^\| (R\d+) \|", contract, re.M))
    for path in files:
        if not path.endswith((".md", ".ts", ".py", ".sh")) or path.startswith("ci/") or path == "CHANGELOG.md":
            continue
        text = (ROOT / path).read_text(encoding="utf-8", errors="replace")
        if path.endswith(".md"):
            for rule in set(re.findall(r"\bR(\d{1,2})\b", text)):
                if f"R{rule}" not in defined:
                    errors.append(f"{path}: references undefined rule R{rule}")
        for removed in REMOVED_REFERENCES:
            if removed in text and path not in LEGACY_AWARE:
                errors.append(f"{path}: references removed {removed}")

    # 6. legacy landing pad in workflow_update.sh (see its header): pre-3.5
    #    updaters resume reading at these byte offsets after overwriting themselves.
    updater = (ROOT / "AI_Workflow_Kit/script/workflow_update.sh").read_bytes()
    landing = updater.find(b"# legacy landing")
    for offset in LEGACY_RESUME_OFFSETS:
        if landing < 0 or offset >= landing or updater[offset:offset + 1] not in (b" ", b"\n"):
            errors.append(f"workflow_update.sh: byte {offset} must lie in the whitespace landing pad before '# legacy landing'")
    pad = updater[min(LEGACY_RESUME_OFFSETS):landing] if landing > 0 else b""
    if pad.strip(b" \n"):
        errors.append("workflow_update.sh: the landing pad must contain only spaces and newlines")

    if errors:
        print("\n".join(f"FAIL {error}" for error in errors), file=sys.stderr)
        return 1
    print(f"OK   repository checks ({len(files)} tracked files, v{version}, rules {min(defined)}..R{max(int(r[1:]) for r in defined)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
