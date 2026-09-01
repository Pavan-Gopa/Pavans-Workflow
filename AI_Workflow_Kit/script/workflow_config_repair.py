#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from pathlib import Path

MAIN_ROLE = "workflow_orchestrator"
MAIN_ALIAS = "@default"
MAIN_TAG_NAME = "Main Orchestrator (managed by DEFAULT)"

DESIGN_DEFAULTS = (
    ("workflow_design_advisor", "@workflow_reviewer"),
    ("workflow_designer", "@workflow_architect"),
    ("workflow_design_advisor_backup", "@workflow_reviewer_backup"),
    ("workflow_designer_backup", "@workflow_architect_backup"),
)

MIN_RUNTIME_MS = 14_400_000  # 4 hours
SOFT_REQUEST_BUDGET = 0      # disable request-count forced-yield guard

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


def _scalar(rest: str) -> str:
    return rest.strip().split("#", 1)[0].strip()


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def _normalize_main_role(lines: list[str], notes: list[str]) -> list[str]:
    bounds = _model_roles_bounds(lines)
    assert bounds is not None
    start, end, child_indent = bounds

    entries: dict[str, list[int]] = {}
    for index in range(start + 1, end):
        match = ROLE_LINE.match(lines[index])
        if match:
            entries.setdefault(match.group("key"), []).append(index)

    role_indexes = entries.get(MAIN_ROLE, [])
    if not role_indexes:
        lines.insert(start + 1, f'{child_indent}{MAIN_ROLE}: "{MAIN_ALIAS}"')
        notes.append(f"added managed {MAIN_ROLE} alias")
        return lines

    first = role_indexes[0]
    match = ROLE_LINE.match(lines[first])
    assert match is not None
    value = _scalar(match.group("rest"))
    resolved_value = _unquote(value)

    if resolved_value != MAIN_ALIAS:
        # Preserve an old direct Main selection only when no authoritative
        # DEFAULT role exists. When DEFAULT is already present it remains the
        # source of truth, matching the runtime contract.
        if value and not entries.get("default"):
            lines.insert(first, f"{match.group('indent')}default: {value}")
            first += 1
            notes.append(f"migrated explicit {MAIN_ROLE} selection to default")
        lines[first] = f'{match.group("indent")}{MAIN_ROLE}: "{MAIN_ALIAS}"'
        notes.append(f"restored {MAIN_ROLE} as managed @default alias")

    # Recalculate because the optional DEFAULT insertion shifts indexes.
    bounds = _model_roles_bounds(lines)
    assert bounds is not None
    start, end, _ = bounds
    duplicates: list[int] = []
    seen = False
    for index in range(start + 1, end):
        role_match = ROLE_LINE.match(lines[index])
        if not role_match or role_match.group("key") != MAIN_ROLE:
            continue
        if seen:
            duplicates.append(index)
        else:
            seen = True
    for duplicate in reversed(duplicates):
        del lines[duplicate]
    if duplicates:
        notes.append(f"removed {len(duplicates)} duplicate {MAIN_ROLE} entr{'y' if len(duplicates) == 1 else 'ies'}")
    return lines


def _normalize_main_tag(lines: list[str], notes: list[str]) -> list[str]:
    bounds = _section_bounds(lines, "modelTags")
    if bounds is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.extend([
            "modelTags:",
            f"  {MAIN_ROLE}:",
            f"    name: {MAIN_TAG_NAME}",
            "    hidden: true",
        ])
        notes.append(f"added hidden model tag for managed {MAIN_ROLE} alias")
        return lines

    def role_entries() -> tuple[int, int, str, list[int]]:
        current = _section_bounds(lines, "modelTags")
        assert current is not None
        section_start, section_end, child_indent = current
        child_width = len(child_indent)
        indexes: list[int] = []
        for index in range(section_start + 1, section_end):
            match = ROLE_LINE.match(lines[index])
            if match and _indent_width(lines[index]) == child_width and match.group("key") == MAIN_ROLE:
                indexes.append(index)
        return section_start, section_end, child_indent, indexes

    start, end, child_indent, indexes = role_entries()
    if not indexes:
        lines[end:end] = [
            f"{child_indent}{MAIN_ROLE}:",
            f"{child_indent}  name: {MAIN_TAG_NAME}",
            f"{child_indent}  hidden: true",
        ]
        notes.append(f"added hidden model tag for managed {MAIN_ROLE} alias")
        return lines

    # Remove duplicate role blocks before inserting nested fields so indexes
    # cannot become stale while the first block is normalized.
    for duplicate in reversed(indexes[1:]):
        duplicate_indent = _indent_width(lines[duplicate])
        delete_end = duplicate + 1
        while delete_end < len(lines):
            stripped = lines[delete_end].strip()
            if stripped and not stripped.startswith("#") and _indent_width(lines[delete_end]) <= duplicate_indent:
                break
            delete_end += 1
        del lines[duplicate:delete_end]
        notes.append(f"removed duplicate model tag for {MAIN_ROLE}")

    _, section_end, _, indexes = role_entries()
    assert len(indexes) == 1
    role_index = indexes[0]
    role_indent = _indent_width(lines[role_index])
    lines[role_index] = f"{' ' * role_indent}{MAIN_ROLE}:"

    entry_end = section_end
    for index in range(role_index + 1, section_end):
        stripped = lines[index].strip()
        if stripped and not stripped.startswith("#") and _indent_width(lines[index]) <= role_indent:
            entry_end = index
            break

    nested: dict[str, list[int]] = {}
    nested_indent = " " * (role_indent + 2)
    for index in range(role_index + 1, entry_end):
        match = ROLE_LINE.match(lines[index])
        if not match or _indent_width(lines[index]) <= role_indent:
            continue
        nested_indent = match.group("indent")
        nested.setdefault(match.group("key"), []).append(index)

    insertion = entry_end
    if not nested.get("name"):
        lines.insert(insertion, f"{nested_indent}name: {MAIN_TAG_NAME}")
        insertion += 1
        notes.append(f"named managed {MAIN_ROLE} model tag")

    hidden_indexes = nested.get("hidden", [])
    if not hidden_indexes:
        lines.insert(insertion, f"{nested_indent}hidden: true")
        notes.append(f"hid managed {MAIN_ROLE} alias from role picker")
    else:
        hidden = hidden_indexes[0]
        match = ROLE_LINE.match(lines[hidden])
        assert match is not None
        if _unquote(_scalar(match.group("rest"))).lower() != "true":
            lines[hidden] = f"{match.group('indent')}hidden: true"
            notes.append(f"hid managed {MAIN_ROLE} alias from role picker")
        for duplicate in reversed(hidden_indexes[1:]):
            del lines[duplicate]
            notes.append(f"removed duplicate hidden flag for {MAIN_ROLE}")
    return lines


def _normalize_task_policy(lines: list[str], notes: list[str]) -> list[str]:
    bounds = _section_bounds(lines, "task")
    if bounds is None:
        lines.extend([
            "",
            "task:",
            f"  maxRuntimeMs: {MIN_RUNTIME_MS}",
            f"  softRequestBudget: {SOFT_REQUEST_BUDGET}",
        ])
        notes.append("created task policy block (minimum 4h runtime; request budget disabled)")
        return lines

    start, end, child_indent = bounds
    positions: dict[str, list[int]] = {}
    for index in range(start + 1, end):
        match = ROLE_LINE.match(lines[index])
        if match:
            positions.setdefault(match.group("key"), []).append(index)

    changed: list[str] = []

    runtime_indexes = positions.get("maxRuntimeMs", [])
    if not runtime_indexes:
        lines[end:end] = [f"{child_indent}maxRuntimeMs: {MIN_RUNTIME_MS}"]
        end += 1
        changed.append("maxRuntimeMs:add")
    else:
        first = runtime_indexes[0]
        match = ROLE_LINE.match(lines[first])
        assert match is not None
        raw = _scalar(match.group("rest"))
        try:
            current = int(raw)
        except ValueError:
            current = 0
        if current < MIN_RUNTIME_MS:
            lines[first] = f"{match.group('indent')}maxRuntimeMs: {MIN_RUNTIME_MS}"
            changed.append("maxRuntimeMs:min4h")
        for duplicate in reversed(runtime_indexes[1:]):
            del lines[duplicate]
            end -= 1
            changed.append("dedup:maxRuntimeMs")

    bounds = _section_bounds(lines, "task")
    assert bounds is not None
    start, end, child_indent = bounds
    budget_indexes: list[int] = []
    for index in range(start + 1, end):
        match = ROLE_LINE.match(lines[index])
        if match and match.group("key") == "softRequestBudget":
            budget_indexes.append(index)

    if not budget_indexes:
        lines[end:end] = [f"{child_indent}softRequestBudget: {SOFT_REQUEST_BUDGET}"]
        changed.append("softRequestBudget:add")
    else:
        first = budget_indexes[0]
        match = ROLE_LINE.match(lines[first])
        assert match is not None
        if _scalar(match.group("rest")) != str(SOFT_REQUEST_BUDGET):
            lines[first] = f"{match.group('indent')}softRequestBudget: {SOFT_REQUEST_BUDGET}"
            changed.append("softRequestBudget:disable")
        for duplicate in reversed(budget_indexes[1:]):
            del lines[duplicate]
            changed.append("dedup:softRequestBudget")

    if changed:
        notes.append("task policy: " + ", ".join(changed))
    return lines


def normalize_config_text(source: str) -> tuple[str, list[str]]:
    lines = source.splitlines()
    notes: list[str] = []
    bounds = _model_roles_bounds(lines)
    if bounds is None:
        block = [
            "modelRoles:",
            f'  {MAIN_ROLE}: "{MAIN_ALIAS}"',
            *[f'  {key}: "{value}"' for key, value in DESIGN_DEFAULTS],
            "",
        ]
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

    lines = _normalize_main_role(lines, notes)
    lines = _normalize_main_tag(lines, notes)
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
        values: dict[str, list[str]] = {}
        for line in lines[start + 1:end]:
            role_match = ROLE_LINE.match(line)
            if not role_match:
                continue
            key = role_match.group("key")
            counts[key] = counts.get(key, 0) + 1
            values.setdefault(key, []).append(_unquote(_scalar(role_match.group("rest"))))
            if BARE_ALIAS_VALUE.match(role_match.group("rest")):
                errors.append(f"{key} uses an unquoted @ role alias")
        for key, _ in DESIGN_DEFAULTS:
            if counts.get(key, 0) == 0:
                errors.append(f"missing model role: {key}")
            elif counts[key] > 1:
                errors.append(f"duplicate model role: {key}")
        if counts.get(MAIN_ROLE, 0) == 0:
            errors.append(f"missing model role: {MAIN_ROLE}")
        elif counts[MAIN_ROLE] > 1:
            errors.append(f"duplicate model role: {MAIN_ROLE}")
        elif values[MAIN_ROLE][0] != MAIN_ALIAS:
            errors.append(f"{MAIN_ROLE} must be the managed {MAIN_ALIAS} alias")

    tag_bounds = _section_bounds(lines, "modelTags")
    hidden_values: list[str] = []
    if tag_bounds is not None:
        start, end, child_indent = tag_bounds
        child_width = len(child_indent)
        role_index: int | None = None
        role_count = 0
        for index in range(start + 1, end):
            match = ROLE_LINE.match(lines[index])
            if match and _indent_width(lines[index]) == child_width and match.group("key") == MAIN_ROLE:
                role_count += 1
                role_index = role_index if role_index is not None else index
        if role_count > 1:
            errors.append(f"duplicate model tag: {MAIN_ROLE}")
        if role_index is not None:
            role_indent = _indent_width(lines[role_index])
            for index in range(role_index + 1, end):
                stripped = lines[index].strip()
                if stripped and not stripped.startswith("#") and _indent_width(lines[index]) <= role_indent:
                    break
                match = ROLE_LINE.match(lines[index])
                if match and _indent_width(lines[index]) > role_indent and match.group("key") == "hidden":
                    hidden_values.append(_unquote(_scalar(match.group("rest"))).lower())
    if tag_bounds is None or not hidden_values:
        errors.append(f"modelTags.{MAIN_ROLE}.hidden must be true")
    elif len(hidden_values) > 1:
        errors.append(f"duplicate hidden flag for model tag: {MAIN_ROLE}")
    elif hidden_values[0] != "true":
        errors.append(f"modelTags.{MAIN_ROLE}.hidden must be true")

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
            values.setdefault(match.group("key"), []).append(_scalar(match.group("rest")))

        runtime_entries = values.get("maxRuntimeMs", [])
        if not runtime_entries:
            errors.append("missing task policy: maxRuntimeMs")
        elif len(runtime_entries) > 1:
            errors.append("duplicate task policy: maxRuntimeMs")
        else:
            try:
                runtime_ms = int(runtime_entries[0])
            except ValueError:
                runtime_ms = 0
            if runtime_ms < MIN_RUNTIME_MS:
                errors.append(f"task policy maxRuntimeMs must be >= {MIN_RUNTIME_MS}, got {runtime_entries[0] or '<empty>'}")

        budget_entries = values.get("softRequestBudget", [])
        if not budget_entries:
            errors.append("missing task policy: softRequestBudget")
        elif len(budget_entries) > 1:
            errors.append("duplicate task policy: softRequestBudget")
        elif budget_entries[0] != str(SOFT_REQUEST_BUDGET):
            errors.append(
                f"task policy softRequestBudget must be {SOFT_REQUEST_BUDGET}, got {budget_entries[0] or '<empty>'}"
            )
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
