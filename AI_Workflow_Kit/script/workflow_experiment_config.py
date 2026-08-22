#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import tempfile
from pathlib import Path

MARKER = "# PAVANS_WORKFLOW_EXPERIMENT: context-economy-v1"
MANAGED_SECTIONS = ("cycleOrder", "contextPromotion", "compaction")
TOP_LEVEL = re.compile(r"^(?P<key>[A-Za-z0-9_.-]+):(?:[ \t]*(?:#.*)?)?$")
CHILD_KEY = re.compile(r"^(?P<indent>[ \t]+)(?P<key>[A-Za-z0-9_.-]+):(?:.*)$")


def _section_bounds(lines: list[str], key: str) -> tuple[int, int] | None:
    for start, line in enumerate(lines):
        match = TOP_LEVEL.match(line)
        if not match or match.group("key") != key:
            continue
        end = len(lines)
        for index in range(start + 1, len(lines)):
            candidate = lines[index]
            if TOP_LEVEL.match(candidate):
                end = index
                break
        while end > start + 1 and not lines[end - 1].strip():
            end -= 1
        return start, end
    return None


def _all_section_bounds(lines: list[str], key: str) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    offset = 0
    while offset < len(lines):
        local = _section_bounds(lines[offset:], key)
        if local is None:
            break
        start, end = local
        result.append((offset + start, offset + end))
        offset += max(end, start + 1)
    return result


def _normalized_block(block: list[str]) -> list[str]:
    result = list(block)
    while result and not result[-1].strip():
        result.pop()
    return result


def replace_section(lines: list[str], key: str, block: list[str] | None) -> list[str]:
    result = list(lines)
    bounds = _all_section_bounds(result, key)
    for start, end in reversed(bounds[1:]):
        del result[start:end]
        while start < len(result) and not result[start].strip() and start > 0 and not result[start - 1].strip():
            del result[start]
    first = _section_bounds(result, key)
    replacement = _normalized_block(block or [])
    if first is not None:
        start, end = first
        if replacement:
            result[start:end] = replacement
        else:
            del result[start:end]
            if start < len(result) and not result[start].strip():
                del result[start]
    elif replacement:
        if result and result[-1].strip():
            result.append("")
        result.extend(replacement)
    return result


def _child_bounds(lines: list[str], section: str, child: str) -> tuple[int, int, str] | None:
    bounds = _section_bounds(lines, section)
    if bounds is None:
        return None
    start, end = bounds
    section_indent = len(lines[start]) - len(lines[start].lstrip(" \t"))
    for index in range(start + 1, end):
        match = CHILD_KEY.match(lines[index])
        if not match or match.group("key") != child:
            continue
        indent = match.group("indent")
        width = len(indent)
        if width <= section_indent:
            continue
        child_end = end
        for next_index in range(index + 1, end):
            candidate = lines[next_index]
            if not candidate.strip() or candidate.lstrip().startswith("#"):
                continue
            candidate_width = len(candidate) - len(candidate.lstrip(" \t"))
            if candidate_width <= width:
                child_end = next_index
                break
        while child_end > index + 1 and not lines[child_end - 1].strip():
            child_end -= 1
        return index, child_end, indent
    return None


def set_child(lines: list[str], section: str, child: str, value_lines: list[str]) -> list[str]:
    result = list(lines)
    if _section_bounds(result, section) is None:
        result = replace_section(result, section, [f"{section}:"])
    child_info = _child_bounds(result, section, child)
    if child_info is not None:
        start, end, indent = child_info
        block = [f"{indent}{child}:{value_lines[0]}"]
        block.extend(f"{indent}{line}" for line in value_lines[1:])
        result[start:end] = block
    else:
        bounds = _section_bounds(result, section)
        assert bounds is not None
        _, end = bounds
        indent = "  "
        block = [f"{indent}{child}:{value_lines[0]}"]
        block.extend(f"{indent}{line}" for line in value_lines[1:])
        result[end:end] = block
    return result


def apply_experiment(source: str) -> str:
    lines = [line for line in source.splitlines() if line.strip() != MARKER]
    lines.insert(0, MARKER)
    lines = replace_section(
        lines,
        "cycleOrder",
        [
            "cycleOrder:",
            "  - workflow_orchestrator",
            "  - workflow_orchestrator_backup",
        ],
    )
    lines = set_child(lines, "contextPromotion", "enabled", [" false"])
    managed = {
        "enabled": [" true"],
        "thresholdPercent": [" 28"],
        "thresholdTokens": [" -1"],
        "midTurnEnabled": [" true"],
        "autoContinue": [" true"],
        "idleEnabled": [" false"],
        "asyncEnabled": [" false"],
        "methodOrder": ["", "  - shake", "  - soft"],
        "remoteEnabled": [" false"],
        "supersedeReads": [" true"],
        "dropUseless": [" true"],
    }
    for child, value in managed.items():
        lines = set_child(lines, "compaction", child, value)
    return "\n".join(lines).rstrip() + "\n"


def restore_experiment(current: str, baseline: str) -> str:
    lines = [line for line in current.splitlines() if line.strip() != MARKER]
    baseline_lines = baseline.splitlines()
    for key in MANAGED_SECTIONS:
        bounds = _section_bounds(baseline_lines, key)
        block = baseline_lines[bounds[0]:bounds[1]] if bounds else None
        lines = replace_section(lines, key, block)
    return "\n".join(lines).rstrip() + "\n"


def _section_text(source: str, key: str) -> str:
    lines = source.splitlines()
    bounds = _section_bounds(lines, key)
    if bounds is None:
        return ""
    return "\n".join(lines[bounds[0]:bounds[1]])


def validate_experiment(source: str) -> list[str]:
    errors: list[str] = []
    if source.splitlines().count(MARKER) != 1:
        errors.append("experiment marker must appear exactly once")
    cycle = _section_text(source, "cycleOrder")
    if re.findall(r"^\s+-\s+(.+?)\s*$", cycle, flags=re.MULTILINE) != [
        "workflow_orchestrator",
        "workflow_orchestrator_backup",
    ]:
        errors.append("cycleOrder must contain orchestrator primary and backup only")
    promotion = _section_text(source, "contextPromotion")
    if not re.search(r"^\s+enabled:\s+false\s*$", promotion, flags=re.MULTILINE):
        errors.append("contextPromotion.enabled must be false")
    compaction = _section_text(source, "compaction")
    expected_scalars = {
        "enabled": "true",
        "thresholdPercent": "28",
        "thresholdTokens": "-1",
        "midTurnEnabled": "true",
        "autoContinue": "true",
        "idleEnabled": "false",
        "asyncEnabled": "false",
        "remoteEnabled": "false",
        "supersedeReads": "true",
        "dropUseless": "true",
    }
    for key, value in expected_scalars.items():
        matches = re.findall(rf"^\s+{re.escape(key)}:\s+([^#\s]+)", compaction, flags=re.MULTILINE)
        if matches != [value]:
            errors.append(f"compaction.{key} must be {value} exactly once")
    method_match = re.search(
        r"^\s+methodOrder:\s*$\n(?P<body>(?:\s+-\s+.*\n?)*)",
        compaction,
        flags=re.MULTILINE,
    )
    methods = re.findall(r"^\s+-\s+(.+?)\s*$", method_match.group("body"), flags=re.MULTILINE) if method_match else []
    if methods != ["shake", "soft"]:
        errors.append("compaction.methodOrder must be [shake, soft]")
    for role in ("workflow_orchestrator", "workflow_coder"):
        if not re.search(rf"^\s+{role}:\s+", source, flags=re.MULTILINE):
            errors.append(f"model role was lost: {role}")
    return errors


def atomic_write(path: Path, text: str) -> None:
    write_path = path.resolve() if path.is_symlink() else path
    write_path.parent.mkdir(parents=True, exist_ok=True)
    mode = write_path.stat().st_mode & 0o777 if write_path.exists() else None
    descriptor, temporary = tempfile.mkstemp(prefix=f".{write_path.name}.", dir=str(write_path.parent), text=True)
    temp_path = Path(temporary)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
        if mode is not None:
            os.chmod(temp_path, mode)
        os.replace(temp_path, write_path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def command_apply(path: Path) -> int:
    if not path.exists():
        print(f"ERROR: missing config: {path}", file=os.sys.stderr)
        return 1
    result = apply_experiment(path.read_text(encoding="utf-8"))
    errors = validate_experiment(result)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=os.sys.stderr)
        return 1
    atomic_write(path, result)
    print(f"OK   applied context-economy config overlay: {path}")
    return 0


def command_check(path: Path) -> int:
    if not path.exists():
        print(f"ERROR: missing config: {path}", file=os.sys.stderr)
        return 1
    errors = validate_experiment(path.read_text(encoding="utf-8"))
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=os.sys.stderr)
        return 1
    print(f"OK   context-economy config guard: {path}")
    return 0


def command_restore(current: Path, baseline: Path) -> int:
    if not baseline.exists():
        print(f"ERROR: missing baseline config: {baseline}", file=os.sys.stderr)
        return 1
    if not current.exists():
        atomic_write(current, baseline.read_text(encoding="utf-8"))
    else:
        atomic_write(
            current,
            restore_experiment(current.read_text(encoding="utf-8"), baseline.read_text(encoding="utf-8")),
        )
    print(f"OK   restored pre-experiment config sections: {current}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Patch Pavan workflow context-economy experiment settings safely.")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("apply", "check"):
        command = sub.add_parser(name)
        command.add_argument("config", type=Path)
    restore = sub.add_parser("restore")
    restore.add_argument("config", type=Path)
    restore.add_argument("baseline", type=Path)
    args = parser.parse_args()
    if args.command == "apply":
        return command_apply(args.config)
    if args.command == "check":
        return command_check(args.config)
    return command_restore(args.config, args.baseline)


if __name__ == "__main__":
    raise SystemExit(main())
