#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

DESIGN_DEFAULTS = (
    ("workflow_design_advisor", "@workflow_reviewer"),
    ("workflow_designer", "@workflow_architect"),
    ("workflow_design_advisor_backup", "@workflow_reviewer_backup"),
    ("workflow_designer_backup", "@workflow_architect_backup"),
)

# Workflow-owned task safety policy. Existing project model mappings remain
# user-owned, but these two guards are framework behavior and therefore migrate
# with workflow updates.
TASK_POLICY = (
    ("maxRuntimeMs", "14400000"),  # 4 hours
    ("softRequestBudget", "0"),    # disable request-count forced-yield guard
)

MODEL_ROLES_HEADER = re.compile(r"^(?P<indent>[ \t]*)modelRoles:[ \t]*(?:#.*)?$")
SECTION_HEADER = re.compile(r"^(?P<indent>[ \t]*)(?P<key>[A-Za-z0-9_.-]+):[ \t]*(?:#.*)?$")
ROLE_LINE = re.compile(r"^(?P<indent>[ \t]+)(?P<key>[A-Za-z0-9_.-]+):(?P<rest>.*)$")
BARE_ALIAS_VALUE = re.compile(r"^(?P<space>[ \t]*)(?P<alias>@[^\s#]+)(?P<tail>[ \t]*(?:#.*)?)$")


def _indent_width(line: str) -> int:
    return len(line) - len(line.lstrip(" \t"))


def _section_bounds(lines: list[str], section: str) -> tuple[int, int, str] | None:
    for start, line in enumerate(lines):
        match = SECTION_HEADER.match(line)
        if not match or match.group("key") != section:
            continue
        base_width = len(match.group("indent"))
        end = len(lines)
        for index in range(start + 1, len(lines)):
            candidate = lines[index]
            stripped = candidate.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if _indent_width(candidate) <= base_width:
                end = index
                break
        child_indent = " " * (base_width + 2)
        for candidate in lines[start + 1:end]:
            child_match = ROLE_LINE.match(candidate)
            if child_match and _indent_width(candidate) > base_width:
                child_indent = child_match.group("indent")
                break
        return start, end, child_indent
    return None


def _model_roles_bounds(lines: list[str]) -> tuple[int, int, str] | None:
    return _section_bounds(lines, "modelRoles")


def _quote_bare_aliases(lines: list[str], start: int, end: int) -> tuple[list[str], int]:
    repaired = list(lines)
    count = 0
    for index in range(start + 1, end):
        role_match = ROLE_LINE.match(repaired[index])
        if not role_match:
            continue
        value_match = BARE_ALIAS_VALUE.match(role_match.group("rest"))
        if not value_match:
            continue
        repaired[index] = (
            f"{role_match.group('indent')}{role_match.group('key')}:"
            f"{value_match.group('space')}\"{value_match.group('alias')}\""
            f"{value_match.group('tail')}"
        )
        count += 1
    return repaired, count


def _normalize_task_policy(lines: list[str], notes: list[str]) -> list[str]:
    bounds = _section_bounds(lines, "task")
    if bounds is None:
        block = ["", "task:", *[f"  {key}: {value}" for key, value in TASK_POLICY]]
        lines.extend(block)
        notes.append("created task policy block (4h runtime; request budget disabled)")
        return lines

    start, end, child_indent = bounds
    positions: dict[str, list[int]] = {}
    for index in range(start + 1, end):
        match = ROLE_LINE.match(lines[index])
        if match:
            positions.setdefault(match.group("key"), []).append(index)

    changed: list[str] = []
    missing: list[tuple[str, str]] = []
    for key, value in TASK_POLICY:
        indexes = positions.get(key, [])
        if not indexes:
            missing.append((key, value))
            continue
        first = indexes[0]
        match = ROLE_LINE.match(lines[first])
        assert match is not None
        desired = f"{match.group('indent')}{key}: {value}"
        if lines[first].strip() != f"{key}: {value}":
            lines[first] = desired
            changed.append(key)
        # Remove duplicate workflow-owned guard entries so OMP sees one value.
        for duplicate in reversed(indexes[1:]):
            del lines[duplicate]
            end -= 1
            changed.append(f"dedup:{key}")

    if missing:
        insertion = [f"{child_indent}{key}: {value}" for key, value in missing]
        lines[end:end] = insertion
        changed.extend(key for key, _ in missing)

    if changed:
        notes.append("task policy: " + ", ".join(changed))
    return lines


def normalize_config_text(source: str) -> tuple[str, list[str]]:
    lines = source.splitlines()
    notes: list[str] = []
    bounds = _model_roles_bounds(lines)
    if bounds is None:
        block = ["modelRoles:", *[f'  {key}: "{value}"' for key, value in DESIGN_DEFAULTS], ""]
        lines = block + lines
        notes.append("created modelRoles block")
    else:
        start, end, child_indent = bounds
        lines, repaired_count = _quote_bare_aliases(lines, start, end)
        if repaired_count:
            notes.append(f"quoted {repaired_count} bare @ role alias(es)")

        start, end, child_indent = _model_roles_bounds(lines) or (start, end, child_indent)
        existing: dict[str, int] = {}
        for line in lines[start + 1:end]:
            role_match = ROLE_LINE.match(line)
            if role_match:
                existing[role_match.group("key")] = existing.get(role_match.group("key"), 0) + 1

        missing = [(key, value) for key, value in DESIGN_DEFAULTS if key not in existing]
        if missing:
            insertion = [f'{child_indent}{key}: "{value}"' for key, value in missing]
            lines[end:end] = insertion
            notes.append("added " + ", ".join(key for key, _ in missing))

    lines = _normalize_task_policy(lines, notes)
    return "\n".join(lines).rstrip() + "\n", notes


def validate_config_text(source: str) -> list[str]:
    errors: list[str] = []
    lines = source.splitlines()
    bounds = _model_roles_bounds(lines)
    if bounds is None:
        errors.append("modelRoles block is missing")
    else:
        start, end, _ = bounds
        counts: dict[str, int] = {}
        for line in lines[start + 1:end]:
            role_match = ROLE_LINE.match(line)
            if not role_match:
                continue
            key = role_match.group("key")
            counts[key] = counts.get(key, 0) + 1
            if BARE_ALIAS_VALUE.match(role_match.group("rest")):
                errors.append(f"{key} uses an unquoted @ role alias")
        for key, _ in DESIGN_DEFAULTS:
            if counts.get(key, 0) == 0:
                errors.append(f"missing model role: {key}")
            elif counts[key] > 1:
                errors.append(f"duplicate model role: {key}")

    task_bounds = _section_bounds(lines, "task")
    if task_bounds is None:
        errors.append("task block is missing")
    else:
        start, end, _ = task_bounds
        values: dict[str, list[str]] = {}
        for line in lines[start + 1:end]:
            match = ROLE_LINE.match(line)
            if not match:
                continue
            values.setdefault(match.group("key"), []).append(match.group("rest").strip().split("#", 1)[0].strip())
        for key, expected in TASK_POLICY:
            entries = values.get(key, [])
            if not entries:
                errors.append(f"missing task policy: {key}")
            elif len(entries) > 1:
                errors.append(f"duplicate task policy: {key}")
            elif entries[0] != expected:
                errors.append(f"task policy {key} must be {expected}, got {entries[0] or '<empty>'}")
    return errors


def _looks_like_workflow_config(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return False
    return "modelRoles:" in text and ("workflow_orchestrator:" in text or "workflow_coder:" in text)


def _newest(paths: list[Path]) -> list[Path]:
    def key(path: Path) -> tuple[float, str]:
        try:
            return path.stat().st_mtime, str(path)
        except OSError:
            return -1.0, str(path)
    return sorted(paths, key=key, reverse=True)


def recovery_candidates(project_root: Path, common_git_dir: Path | None) -> list[tuple[str, Path]]:
    candidates: list[tuple[str, Path]] = []
    omp_dir = project_root / ".omp"
    if omp_dir.exists():
        for path in _newest(list(omp_dir.glob("config.yml.broken-*"))):
            candidates.append(("OMP broken backup", path))
    if common_git_dir is not None:
        backup_root = common_git_dir / "pavans-workflow" / "update-backups"
        if backup_root.exists():
            for path in _newest(list(backup_root.glob("*/.omp/config.yml"))):
                candidates.append(("workflow update backup", path))
    return candidates


def atomic_write(path: Path, text: str, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent), text=True)
    temp_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        if mode is not None:
            os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def repair_project(project_root: Path, upstream_config: Path, common_git_dir: Path | None) -> tuple[str, list[str]]:
    config = project_root / ".omp" / "config.yml"
    source_label = "existing project config"
    original_mode: int | None = None

    if config.exists():
        source_path = config
        original_mode = config.stat().st_mode & 0o777
    else:
        source_path = None
        for label, candidate in recovery_candidates(project_root, common_git_dir):
            if _looks_like_workflow_config(candidate):
                source_label = label
                source_path = candidate
                break
        if source_path is None:
            source_label = "upstream template defaults"
            source_path = upstream_config
        if source_path.exists():
            original_mode = source_path.stat().st_mode & 0o777

    source = source_path.read_text(encoding="utf-8")
    normalized, notes = normalize_config_text(source)
    errors = validate_config_text(normalized)
    if errors:
        raise RuntimeError("; ".join(errors))
    atomic_write(config, normalized, original_mode)
    return source_label, notes


def command_check(path: Path) -> int:
    if not path.exists():
        print(f"ERROR: missing config: {path}", file=sys.stderr)
        return 1
    errors = validate_config_text(path.read_text(encoding="utf-8"))
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"OK: workflow config guard passed ({path})")
    return 0


def command_repair(project_root: Path, upstream_config: Path, common_git_dir: Path | None) -> int:
    try:
        source_label, notes = repair_project(project_root, upstream_config, common_git_dir)
    except (OSError, UnicodeError, RuntimeError) as error:
        print(f"ERROR: unable to repair .omp/config.yml: {error}", file=sys.stderr)
        return 1
    note = "; ".join(notes) if notes else "no workflow-owned config edits required"
    print(f"OK   config preserved/recovered from {source_label}; {note}")
    return command_check(project_root / ".omp" / "config.yml")


def main() -> int:
    parser = argparse.ArgumentParser(description="Repair/validate Pavan's Workflow project YAML safely.")
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check")
    check.add_argument("config", type=Path)

    repair = sub.add_parser("repair")
    repair.add_argument("project_root", type=Path)
    repair.add_argument("upstream_config", type=Path)
    repair.add_argument("common_git_dir", type=Path, nargs="?")

    args = parser.parse_args()
    if args.command == "check":
        return command_check(args.config)
    return command_repair(
        args.project_root.resolve(),
        args.upstream_config.resolve(),
        args.common_git_dir.resolve() if args.common_git_dir else None,
    )


if __name__ == "__main__":
    raise SystemExit(main())
