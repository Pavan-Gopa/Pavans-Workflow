#!/usr/bin/env python3
"""Manifest-driven install / update / verify for Pavan's Workflow.

One implementation behind install.sh, workflow_update.sh, and workflow_doctor.sh:

  workflow_framework.py install  --source S --target T
  workflow_framework.py update   --source S --target T [--check]
  workflow_framework.py verify   --target T
  workflow_framework.py render-state --target T [--source S]
  workflow_framework.py list     --source S
  workflow_framework.py legacy-cleanup --source S --target T

Guarantees:
  * Framework files come from AI_Workflow_Kit/framework.manifest only.
  * Project state is rendered from AI_Workflow_Kit/templates/ and never copied
    from a checkout that has been used as a project (no memory leaks between
    projects).
  * Files a previous release installed and that disappeared upstream are
    removed on update when unmodified; project-added files are never touched.
  * Every update is backed up and rolled back automatically on failure.

Standard library only; Python 3.9+ (macOS system python3).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

MANIFEST_REL = "AI_Workflow_Kit/framework.manifest"
RECORD_REL = "AI_Workflow_Kit/installed.manifest"
VERSION_REL = "AI_Workflow_Kit/VERSION"
TEMPLATES_REL = "AI_Workflow_Kit/templates"
TEMPLATE_ROOT_PREFIX = "AI_Workflow_Kit/"
CONFIG_REPAIR_REL = "AI_Workflow_Kit/script/workflow_config_repair.py"
KINDS = ("tree", "file", "seed", "state", "config")
IGNORED_NAMES = {".DS_Store", "__pycache__", ".pytest_cache"}
IGNORED_SUFFIXES = (".pyc", ".pyo", ".swp")

# Files and directories shipped by releases before 3.5.0 that no longer exist.
# Used only when a project has no installed.manifest yet (first 3.5+ update).
LEGACY_OBSOLETE = (
    "AI_Workflow_Kit/experiments",
    "AI_Workflow_Kit/script/workflow_experiment.sh",
    "AI_Workflow_Kit/script/workflow_experiment.selftest.sh",
    "AI_Workflow_Kit/script/workflow_experiment_config.py",
    "AI_Workflow_Kit/script/workflow_experiment_config.selftest.py",
    "AI_Workflow_Kit/script/workflow_hotkeys.py",
    "AI_Workflow_Kit/script/workflow_hotkeys.selftest.py",
    "AI_Workflow_Kit/script/workflow_lean.sh",
    "AI_Workflow_Kit/script/workflow_lean.selftest.sh",
    ".omp/commands/workflow-experiment.md",
    ".omp/extensions/workflow-context-economy.ts",
    ".omp/tests/workflow-context-economy-main-only.selftest.ts",
    ".omp/lib/workflow-model-readiness.ts",
    ".omp/tests/workflow-model-readiness.selftest.ts",
    "EXPERIMENT_CONTEXT_ECONOMY.md",
)
# Root files older releases copied into projects. They collide with ordinary
# product files, so 3.5+ never manages them; we only point them out.
LEGACY_ROOT_FILES = ("VERSION", "CHANGELOG.md")
# Root files the pre-3.5 updater overwrote in projects (legacy-cleanup restores).
LEGACY_UPDATER_CLOBBERED = ("README.md", "INSTALL.md", "CHANGELOG.md", "VERSION")
GRAPHIFYIGNORE_REQUIRED = ("/ui-designer/",)
GITIGNORE_REQUIRED = ("graphify-out/",)
FRAMEWORK_REPO_PATTERN = re.compile(r"github\.com[:/]Pavan-Gopa/Pavans-Workflow(\.git)?/?$", re.I)


class FrameworkError(RuntimeError):
    """User-facing failure with a stable exit code."""

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Entry:
    kind: str
    path: str


@dataclass
class Plan:
    add: list[str] = field(default_factory=list)
    update: list[str] = field(default_factory=list)
    overwrite_local: list[str] = field(default_factory=list)
    remove: list[str] = field(default_factory=list)
    keep_modified_obsolete: list[str] = field(default_factory=list)
    render_state: list[str] = field(default_factory=list)
    seed: list[str] = field(default_factory=list)
    config_changes: list[str] = field(default_factory=list)
    notices: list[str] = field(default_factory=list)

    def changed(self) -> bool:
        return bool(
            self.add or self.update or self.remove or self.render_state or self.seed or self.config_changes
        )

    def as_dict(self) -> dict[str, object]:
        return {key: value for key, value in self.__dict__.items()}


# ---------------------------------------------------------------------------
# helpers


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_version(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value or None


def version_tuple(value: str | None) -> tuple[int, int, int]:
    parts: list[int] = []
    for token in (value or "0").strip().lstrip("vV").split(".")[:3]:
        match = re.match(r"(\d+)", token)
        parts.append(int(match.group(1)) if match else 0)
    while len(parts) < 3:
        parts.append(0)
    return parts[0], parts[1], parts[2]


def ignored(rel: str) -> bool:
    parts = rel.split("/")
    return any(part in IGNORED_NAMES for part in parts) or rel.endswith(IGNORED_SUFFIXES)


def parse_manifest(path: Path) -> list[Entry]:
    if not path.is_file():
        raise FrameworkError(f"framework manifest missing: {path}")
    entries: list[Entry] = []
    seen: set[str] = set()
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = line.split()
        if len(fields) != 2 or fields[0] not in KINDS:
            raise FrameworkError(f"{path}:{number}: expected '<{'|'.join(KINDS)}> <path>', got {raw!r}")
        kind, rel = fields
        rel = rel.strip("/")
        if rel.startswith("..") or rel.startswith("/") or "/../" in f"/{rel}/":
            raise FrameworkError(f"{path}:{number}: path must stay inside the project: {rel}")
        if rel in seen:
            raise FrameworkError(f"{path}:{number}: duplicate manifest path {rel}")
        seen.add(rel)
        entries.append(Entry(kind, rel))
    return entries


def state_paths(entries: list[Entry]) -> set[str]:
    return {entry.path for entry in entries if entry.kind == "state"}


def template_for(rel: str) -> str:
    if not rel.startswith(TEMPLATE_ROOT_PREFIX):
        raise FrameworkError(f"state path must live under {TEMPLATE_ROOT_PREFIX}: {rel}")
    return f"{TEMPLATES_REL}/{rel[len(TEMPLATE_ROOT_PREFIX):]}"


def managed_files(source: Path, entries: list[Entry]) -> dict[str, Path]:
    """Framework-owned files (tree + file kinds) keyed by project-relative path."""
    excluded = state_paths(entries) | {RECORD_REL}
    files: dict[str, Path] = {}
    for entry in entries:
        root = source / entry.path
        if entry.kind == "file":
            if not root.is_file():
                raise FrameworkError(f"manifest file missing in source: {entry.path}")
            files[entry.path] = root
        elif entry.kind == "tree":
            if not root.is_dir():
                raise FrameworkError(f"manifest tree missing in source: {entry.path}")
            for path in sorted(root.rglob("*")):
                if not path.is_file() and not path.is_symlink():
                    continue
                rel = path.relative_to(source).as_posix()
                if ignored(rel) or rel in excluded:
                    continue
                files[rel] = path
    return files


def read_record(target: Path) -> tuple[str | None, dict[str, str]] | None:
    path = target / RECORD_REL
    if not path.is_file():
        return None
    version: str | None = None
    hashes: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("version "):
            version = line.split(None, 1)[1].strip()
            continue
        digest, _, rel = line.partition("  ")
        if re.fullmatch(r"[0-9a-f]{64}", digest) and rel:
            hashes[rel] = digest
    return version, hashes


def write_record(target: Path, version: str, rels: list[str]) -> None:
    lines = [
        "# Pavan's Workflow installed framework files. Generated by workflow_framework.py;",
        "# do not edit. Used to remove files a later release deletes and to report",
        "# local modifications of framework files.",
        f"version {version}",
    ]
    for rel in sorted(rels):
        path = target / rel
        if path.is_file():
            lines.append(f"{sha256(path)}  {rel}")
    atomic_write_text(target / RECORD_REL, "\n".join(lines) + "\n")


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_symlink() or (dst.exists() and not dst.is_file()):
        remove_path(dst)
    temporary = dst.with_name(f".{dst.name}.tmp-{os.getpid()}")
    shutil.copy2(src, temporary)
    os.replace(temporary, dst)


def remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def prune_empty_dirs(target: Path, rel: str) -> None:
    parent = (target / rel).parent
    while parent != target and parent.is_dir():
        try:
            parent.rmdir()
        except OSError:
            return
        parent = parent.parent


def common_git_dir(target: Path) -> Path | None:
    try:
        output = subprocess.run(
            ["git", "-C", str(target), "rev-parse", "--git-common-dir"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None
    path = Path(output)
    return path if path.is_absolute() else (target / path).resolve()


def git_origin(target: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(target), "remote", "get-url", "origin"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def load_config_repair(source: Path):
    module_path = source / CONFIG_REPAIR_REL
    spec = importlib.util.spec_from_file_location("workflow_config_repair", module_path)
    if spec is None or spec.loader is None:
        raise FrameworkError(f"cannot load {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ensure_lines(path: Path, required: tuple[str, ...]) -> list[str]:
    existing = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    missing = [line for line in required if line not in (item.strip() for item in existing)]
    if missing:
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        if text and not text.endswith("\n"):
            text += "\n"
        text += "\n".join(missing) + "\n"
        atomic_write_text(path, text)
    return missing


def target_version(target: Path) -> str | None:
    return read_version(target / VERSION_REL) or read_version(target / "VERSION")


def is_installed(target: Path) -> bool:
    return (target / RECORD_REL).is_file() or (target / "AI_Workflow_Kit/script/workflow_doctor.sh").is_file()


# ---------------------------------------------------------------------------
# state, seeds, config


def render_state(source: Path, target: Path, entries: list[Entry], dry_run: bool = False) -> list[str]:
    rendered: list[str] = []
    for entry in entries:
        if entry.kind != "state":
            continue
        destination = target / entry.path
        if destination.exists():
            continue
        template = source / template_for(entry.path)
        if not template.is_file():
            raise FrameworkError(f"state template missing: {template_for(entry.path)}")
        if not dry_run:
            copy_file(template, destination)
        rendered.append(entry.path)
    return rendered


def seed_files(source: Path, target: Path, entries: list[Entry], dry_run: bool = False) -> list[str]:
    seeded: list[str] = []
    for entry in entries:
        if entry.kind != "seed" or (target / entry.path).exists():
            continue
        if not dry_run:
            copy_file(source / entry.path, target / entry.path)
        seeded.append(entry.path)
    return seeded


def repair_config(source: Path, target: Path, dry_run: bool = False) -> list[str]:
    module = load_config_repair(source)
    upstream = source / ".omp/config.yml"
    config = target / ".omp/config.yml"
    if dry_run:
        if not config.exists():
            return ["create .omp/config.yml from upstream defaults / newest backup"]
        _, notes = module.normalize_config_text(
            config.read_text(encoding="utf-8"), upstream.read_text(encoding="utf-8")
        )
        return notes
    label, notes = module.repair_project(target, upstream, common_git_dir(target))
    errors = module.validate_config_text(config.read_text(encoding="utf-8"))
    if errors:
        raise FrameworkError("config repair left errors: " + "; ".join(errors))
    return [f"from {label}", *notes] if notes or label != "existing project config" else []


# ---------------------------------------------------------------------------
# install


def cmd_install(source: Path, target: Path) -> dict[str, object]:
    entries = parse_manifest(source / MANIFEST_REL)
    files = managed_files(source, entries)
    version = read_version(source / VERSION_REL) or "unknown"
    in_place = source.resolve() == target.resolve()
    notices: list[str] = []

    if not in_place:
        if is_installed(target):
            raise FrameworkError(
                "Pavan's Workflow is already installed here. Update it instead:\n"
                "  bash <(curl -fsSL https://raw.githubusercontent.com/Pavan-Gopa/Pavans-Workflow/main/install.sh) --update",
                3,
            )
        conflicts = [
            rel
            for rel, src in files.items()
            if (target / rel).exists() and (not (target / rel).is_file() or sha256(target / rel) != sha256(src))
        ]
        if conflicts:
            shown = "\n  ".join(conflicts[:40])
            more = f"\n  … and {len(conflicts) - 40} more" if len(conflicts) > 40 else ""
            raise FrameworkError(
                "These project files would be overwritten by the workflow install:\n  "
                f"{shown}{more}\nMove them aside or rename them, then run the installer again.",
                4,
            )
        for rel, src in files.items():
            copy_file(src, target / rel)
    else:
        origin = git_origin(target)
        if origin and FRAMEWORK_REPO_PATTERN.search(origin):
            notices.append(
                "This checkout's 'origin' is the Pavan's Workflow framework repository. Project work and "
                "workflow state must not be pushed there. Point origin at your product repository, e.g.:\n"
                "  git remote rename origin workflow-upstream\n"
                "  git remote add origin <your-product-repo-url>"
            )

    rendered = render_state(source, target, entries)
    seeded = seed_files(source, target, entries)
    config_notes = repair_config(source, target)
    graphify_added = ensure_lines(target / ".graphifyignore", GRAPHIFYIGNORE_REQUIRED)
    gitignore_added = ensure_lines(target / ".gitignore", GITIGNORE_REQUIRED)
    write_record(target, version, list(files))
    return {
        "action": "install",
        "version": version,
        "in_place": in_place,
        "installed_files": len(files),
        "rendered_state": rendered,
        "seeded": seeded,
        "config": config_notes,
        "graphifyignore_added": graphify_added,
        "gitignore_added": gitignore_added,
        "notices": notices,
    }


# ---------------------------------------------------------------------------
# update


def plan_update(source: Path, target: Path, entries: list[Entry], files: dict[str, Path]) -> Plan:
    plan = Plan()
    record = read_record(target)
    recorded = record[1] if record else {}

    for rel, src in files.items():
        destination = target / rel
        if not destination.exists() and not destination.is_symlink():
            plan.add.append(rel)
            continue
        if destination.is_file():
            current = sha256(destination)
            if current == sha256(src):
                continue
            if rel in recorded and recorded[rel] != current:
                plan.overwrite_local.append(rel)
        plan.update.append(rel)

    if record is not None:
        for rel, digest in sorted(recorded.items()):
            if rel in files:
                continue
            destination = target / rel
            if not destination.exists():
                continue
            if destination.is_file() and sha256(destination) == digest:
                plan.remove.append(rel)
            else:
                plan.keep_modified_obsolete.append(rel)
    else:
        for rel in LEGACY_OBSOLETE:
            if (target / rel).exists() and rel not in files:
                plan.remove.append(rel)

    plan.render_state = render_state(source, target, entries, dry_run=True)
    plan.seed = seed_files(source, target, entries, dry_run=True)
    plan.config_changes = repair_config(source, target, dry_run=True)
    missing_graphify = [
        line
        for line in GRAPHIFYIGNORE_REQUIRED
        if (target / ".graphifyignore").exists()
        and line not in (item.strip() for item in (target / ".graphifyignore").read_text(encoding="utf-8").splitlines())
    ]
    if missing_graphify:
        plan.config_changes.append(".graphifyignore: add " + ", ".join(missing_graphify))

    legacy_root = [rel for rel in LEGACY_ROOT_FILES if (target / rel).is_file()]
    if legacy_root and not (source.resolve() == target.resolve()):
        plan.notices.append(
            "Root " + ", ".join(legacy_root) + " came from an older workflow release and are no longer "
            "managed (the framework version now lives in AI_Workflow_Kit/VERSION). Delete them unless "
            "they belong to your product."
        )
    return plan


class Transaction:
    """Back up every touched path; roll everything back on failure."""

    def __init__(self, target: Path, backup_root: Path) -> None:
        self.target = target
        self.backup_root = backup_root
        self.backed_up: set[str] = set()
        self.created: list[str] = []

    def touch(self, rel: str) -> None:
        if rel in self.backed_up:
            return
        path = self.target / rel
        if path.exists() or path.is_symlink():
            backup = self.backup_root / rel
            backup.parent.mkdir(parents=True, exist_ok=True)
            if path.is_dir() and not path.is_symlink():
                shutil.copytree(path, backup, symlinks=True)
            else:
                shutil.copy2(path, backup, follow_symlinks=False)
        else:
            self.created.append(rel)
        self.backed_up.add(rel)

    def rollback(self) -> None:
        for rel in reversed(self.created):
            path = self.target / rel
            if path.exists() or path.is_symlink():
                remove_path(path)
        for rel in self.backed_up:
            backup = self.backup_root / rel
            if not (backup.exists() or backup.is_symlink()):
                continue
            path = self.target / rel
            if path.exists() or path.is_symlink():
                remove_path(path)
            path.parent.mkdir(parents=True, exist_ok=True)
            if backup.is_dir() and not backup.is_symlink():
                shutil.copytree(backup, path, symlinks=True)
            else:
                shutil.copy2(backup, path, follow_symlinks=False)


def backup_root_for(target: Path) -> Path:
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = common_git_dir(target)
    root = (base / "pavans-workflow" / "update-backups") if base else (target / ".pavans-workflow" / "update-backups")
    candidate = root / stamp
    suffix = 1
    while candidate.exists():
        candidate = root / f"{stamp}-{suffix}"
        suffix += 1
    return candidate


def cmd_update(source: Path, target: Path, check: bool) -> dict[str, object]:
    if source.resolve() == target.resolve():
        raise FrameworkError("update source and target are the same directory", 2)
    if not is_installed(target):
        raise FrameworkError(
            f"Pavan's Workflow is not installed in {target}. Install it with:\n  bash install.sh {target}", 3
        )
    entries = parse_manifest(source / MANIFEST_REL)
    files = managed_files(source, entries)
    upstream_version = read_version(source / VERSION_REL) or "unknown"
    local_version = target_version(target)
    if (
        not check
        and version_tuple(upstream_version) < version_tuple(local_version)
        and os.environ.get("WF_ALLOW_WORKFLOW_DOWNGRADE") != "1"
    ):
        raise FrameworkError(
            f"refusing workflow downgrade from v{local_version} to v{upstream_version}. "
            "Set WF_ALLOW_WORKFLOW_DOWNGRADE=1 only for an intentional rollback.",
            5,
        )

    legacy_cleanup: dict[str, object] | None = None
    if read_record(target) is None and not check:
        # First 3.5+ update of a legacy project: undo root files a pre-3.5
        # updater overwrote moments ago (only with its fresh backup).
        legacy_cleanup = cmd_legacy_cleanup(source, target, allow_remove=False)
    plan = plan_update(source, target, entries, files)
    clobbered = [
        rel
        for rel in ("README.md", "INSTALL.md")
        if (target / rel).is_file() and (source / rel).is_file() and sha256(target / rel) == sha256(source / rel)
        and source.resolve() != target.resolve()
    ]
    if clobbered:
        plan.notices.append(
            ", ".join(clobbered) + " is identical to the workflow's own copy — a pre-3.5 updater overwrote the "
            "project file. Restore it from <git-common-dir>/pavans-workflow/update-backups/ if it was yours."
        )
    result: dict[str, object] = {
        "action": "check" if check else "update",
        "from_version": local_version,
        "to_version": upstream_version,
        "plan": plan.as_dict(),
        "changed": plan.changed(),
    }
    if check:
        return result

    backup_root = backup_root_for(target)
    transaction = Transaction(target, backup_root)
    try:
        for rel in plan.add + plan.update:
            transaction.touch(rel)
            copy_file(files[rel], target / rel)
        for rel in plan.remove:
            transaction.touch(rel)
            remove_path(target / rel)
            prune_empty_dirs(target, rel)
        for rel in plan.render_state + plan.seed:
            transaction.touch(rel)
        render_state(source, target, entries)
        seed_files(source, target, entries)
        for rel in (".omp/config.yml", ".graphifyignore", RECORD_REL):
            transaction.touch(rel)
        result["config"] = repair_config(source, target)
        ensure_lines(target / ".graphifyignore", GRAPHIFYIGNORE_REQUIRED)
        write_record(target, upstream_version, list(files))
    except BaseException:
        transaction.rollback()
        raise
    result["backup"] = str(backup_root) if transaction.backed_up else None
    if legacy_cleanup and (legacy_cleanup.get("restored") or legacy_cleanup.get("removed")):
        result["legacy_cleanup"] = legacy_cleanup
    return result


# ---------------------------------------------------------------------------
# verify / legacy cleanup


def cmd_verify(target: Path) -> tuple[int, list[tuple[str, str]]]:
    lines: list[tuple[str, str]] = []
    try:
        entries = parse_manifest(target / MANIFEST_REL)
    except FrameworkError as error:
        return 1, [("FAIL", str(error))]
    for entry in entries:
        path = target / entry.path
        if entry.kind in ("tree",) and not path.is_dir():
            lines.append(("FAIL", f"framework directory missing: {entry.path}"))
        elif entry.kind in ("file", "config") and not path.is_file():
            lines.append(("FAIL", f"framework file missing: {entry.path}"))
        elif entry.kind == "state" and not path.is_file():
            lines.append(("FAIL", f"state file missing: {entry.path} (bash AI_Workflow_Kit/script/workflow_update.sh render-state)"))
        elif entry.kind == "seed" and not path.exists():
            lines.append(("WARN", f"seed file missing: {entry.path}"))
    record = read_record(target)
    version = read_version(target / VERSION_REL)
    if record is None:
        lines.append(("FAIL", f"{RECORD_REL} missing — finish the install/update: bash AI_Workflow_Kit/script/workflow_update.sh apply"))
    else:
        recorded_version, hashes = record
        if recorded_version != version:
            lines.append(("FAIL", f"installed.manifest records v{recorded_version} but {VERSION_REL} is v{version}"))
        missing = [rel for rel in hashes if not (target / rel).is_file()]
        modified = [rel for rel in hashes if (target / rel).is_file() and sha256(target / rel) != hashes[rel]]
        for rel in missing:
            lines.append(("FAIL", f"framework file missing: {rel}"))
        for rel in modified:
            if rel == RECORD_REL:
                continue
            lines.append(("WARN", f"framework file modified locally (next update overwrites it, with backup): {rel}"))
        if not missing:
            lines.append(("OK", f"framework files present: {len(hashes)} (v{recorded_version})"))
    for rel in LEGACY_OBSOLETE:
        if (target / rel).exists():
            lines.append(("WARN", f"obsolete pre-3.5 path still present: {rel} (run workflow_update.sh apply)"))
    code = 1 if any(level == "FAIL" for level, _ in lines) else 0
    return code, lines


def recent_legacy_backup(target: Path, max_age_seconds: int = 7200) -> Path | None:
    """Newest update backup, only if it was created moments ago by the running legacy updater."""
    base = common_git_dir(target)
    root = (base / "pavans-workflow" / "update-backups") if base else None
    if root is None or not root.is_dir():
        return None
    candidates = sorted((path for path in root.iterdir() if path.is_dir()), key=lambda item: item.name)
    if not candidates:
        return None
    newest = candidates[-1]
    try:
        stamp = _dt.datetime.strptime(newest.name[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=_dt.timezone.utc)
    except ValueError:
        return None
    age = (_dt.datetime.now(_dt.timezone.utc) - stamp).total_seconds()
    return newest if 0 <= age <= max_age_seconds else None


def cmd_legacy_cleanup(source: Path, target: Path, allow_remove: bool = True) -> dict[str, object]:
    """Undo root-file clobbering by a pre-3.5 workflow_update.sh that is running this release.

    Restores files from the legacy updater's fresh backup. Removing a file the
    legacy updater created is allowed only from the compatibility shim, where
    we know that updater just ran.
    """
    backup = recent_legacy_backup(target)
    restored: list[str] = []
    removed: list[str] = []
    if backup is None:
        # Without the legacy updater's fresh backup we cannot tell a product
        # file from a framework copy, so change nothing.
        return {"action": "legacy-cleanup", "backup": None, "restored": restored, "removed": removed}
    for rel in LEGACY_UPDATER_CLOBBERED:
        current = target / rel
        upstream = source / rel
        if not current.is_file() or not upstream.is_file() or sha256(current) != sha256(upstream):
            continue
        previous = backup / rel
        if previous.is_file():
            copy_file(previous, current)
            restored.append(rel)
        elif allow_remove and rel in ("README.md", "INSTALL.md"):
            current.unlink()
            removed.append(rel)
    return {"action": "legacy-cleanup", "backup": str(backup) if backup else None, "restored": restored, "removed": removed}


# ---------------------------------------------------------------------------
# CLI


def print_result(result: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return
    action = result.get("action")
    if action == "install":
        print(f"OK   installed Pavan's Workflow v{result['version']} ({result['installed_files']} framework files)")
        for rel in result["rendered_state"]:  # type: ignore[union-attr]
            print(f"OK   rendered state template {rel}")
        for rel in result["seeded"]:  # type: ignore[union-attr]
            print(f"OK   seeded {rel}")
        for note in result["config"]:  # type: ignore[union-attr]
            print(f"OK   config: {note}")
        for notice in result["notices"]:  # type: ignore[union-attr]
            print(f"NOTE {notice}")
        return
    if action in ("check", "update"):
        plan = result["plan"]
        assert isinstance(plan, dict)
        header = "Workflow update check (read-only)" if action == "check" else "Workflow update"
        print(f"=== {header}: v{result['from_version']} -> v{result['to_version']} ===")
        labels = (
            ("add", "[NEW]     "),
            ("update", "[UPDATE]  "),
            ("remove", "[REMOVE]  "),
            ("render_state", "[STATE]   "),
            ("seed", "[SEED]    "),
            ("config_changes", "[CONFIG]  "),
        )
        for key, label in labels:
            for item in plan[key]:
                print(f"{label}{item}")
        for rel in plan["overwrite_local"]:
            print(f"[LOCAL]   {rel} was modified locally; replaced (backup kept)")
        for rel in plan["keep_modified_obsolete"]:
            print(f"[KEEP]    {rel} is obsolete but modified locally; left in place")
        for notice in plan["notices"]:
            print(f"NOTE      {notice}")
        if not result["changed"]:
            print("Already up to date.")
        if result.get("backup"):
            print(f"Backup: {result['backup']}")
        return
    if action == "legacy-cleanup":
        for rel in result["restored"]:  # type: ignore[union-attr]
            print(f"OK   restored project {rel} overwritten by the legacy updater")
        for rel in result["removed"]:  # type: ignore[union-attr]
            print(f"OK   removed framework {rel} added by the legacy updater")
        return
    print(json.dumps(result, indent=2, ensure_ascii=False))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("install", "update", "legacy-cleanup"):
        command = sub.add_parser(name)
        command.add_argument("--source", type=Path, required=True)
        command.add_argument("--target", type=Path, required=True)
        command.add_argument("--json", action="store_true")
        if name == "update":
            command.add_argument("--check", action="store_true")
    verify = sub.add_parser("verify")
    verify.add_argument("--target", type=Path, required=True)
    verify.add_argument("--json", action="store_true")
    render = sub.add_parser("render-state")
    render.add_argument("--target", type=Path, required=True)
    render.add_argument("--source", type=Path)
    listing = sub.add_parser("list")
    listing.add_argument("--source", type=Path, required=True)
    listing.add_argument("--kind", choices=KINDS)
    args = parser.parse_args(argv)

    try:
        if args.command == "install":
            print_result(cmd_install(args.source.resolve(), args.target.resolve()), args.json)
        elif args.command == "update":
            print_result(cmd_update(args.source.resolve(), args.target.resolve(), args.check), args.json)
        elif args.command == "legacy-cleanup":
            print_result(cmd_legacy_cleanup(args.source.resolve(), args.target.resolve()), args.json)
        elif args.command == "verify":
            code, lines = cmd_verify(args.target.resolve())
            if args.json:
                print(json.dumps({"ok": code == 0, "lines": lines}, indent=2))
            else:
                for level, message in lines:
                    print(f"{level:<4} {message}", file=sys.stderr if level != "OK" else sys.stdout)
            return code
        elif args.command == "render-state":
            target = args.target.resolve()
            source = (args.source or target).resolve()
            entries = parse_manifest(source / MANIFEST_REL)
            for rel in render_state(source, target, entries):
                print(f"OK   rendered state template {rel}")
        elif args.command == "list":
            source = args.source.resolve()
            entries = parse_manifest(source / MANIFEST_REL)
            if args.kind in (None, "tree", "file"):
                for rel in managed_files(source, entries):
                    print(rel)
            for entry in entries:
                if args.kind in (None, entry.kind) and entry.kind not in ("tree", "file"):
                    print(entry.path)
    except FrameworkError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return error.code
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
