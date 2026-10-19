#!/usr/bin/env python3
"""Per-role skill additions that survive Workflow updates.

An agent's `autoloadSkills` line in .omp/agents/workflow-*.md is Workflow-owned and
replaced on update. A project adds skills to a role in .omp/workflow-skills.json
(project-owned, not in framework.manifest, protected from workers by the guard):

    {"version": 1, "added": {"workflow-coder": ["graphify"]}}

  workflow_skills.py show  --target T [--json]
  workflow_skills.py set   --target T --agent A [--agent B] --skills=x,y [--json]
  workflow_skills.py apply --target T
  workflow_skills.py check --target T

  show   effective = the agent's parsed autoloadSkills line; added = overlay entries
         present in it; workflow = effective minus added; forbidden = skills the role
         must not load (ponytail for the design roles, as the doctor enforces).
  set    makes --skills the complete additions of every --agent (empty = none).
         Rejects unknown agents, forbidden skills, malformed names and names the
         Workflow already loads. All files change or none.
  apply  writes the overlay into every agent file again (idempotent). update runs it.
  check  doctor lines: every overlay addition must be in its agent's line.
  has    exit 0 when --skill is in --agent's autoloadSkills list (the doctor's membership test).

Additions are appended to the line as `, "name"` and removed again as the exact inverse, so the
file's own quoting, spacing, CRLF newlines and an upstream `[]` (or no line at all) come back byte
for byte. The overlay's optional "inserted" list names agents whose line the helper had to create.
workflow_framework.py hashes agent files with the additions removed (upstream_bytes),
so additions are never reported as local modifications.

Standard library only; Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

OVERLAY_REL = ".omp/workflow-skills.json"
AGENTS_REL = ".omp/agents"
VERSION = 1
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
NAME_MAX = 64
AGENT_RE = re.compile(r"^workflow-[a-z0-9]+(-[a-z0-9]+)*$")
# The doctor's rule: the design roles load ui-designer and never ponytail.
FORBIDDEN_BY_AGENT = {
    f"workflow-{role}{suffix}": ("ponytail",)
    for role in ("designer", "design-advisor")
    for suffix in ("", "-backup")
}


class SkillsError(RuntimeError):
    """A rejected request or an unreadable file; the message is shown to the user."""


def agent_rel(agent: str) -> str:
    return f"{AGENTS_REL}/{agent}.md"


# ---------------------------------------------------------------------------
# agent frontmatter
#
# Edits are surgical: only the items added or removed (and their separator) change, so the
# line's other bytes, quoting, spacing and newline survive and removal restores the original.
# The key forms and the value types follow OMP's own reading of the file:
#   pi-utils/src/frontmatter.ts parseFrontmatter (CRLF -> LF, `---` fences, Bun YAML, kebab-case
#   keys -> camelCase) and pi-coding-agent/src/discovery/helpers.ts parseArrayOrCSV (string items).

_ITEM = r"""\"(?:[^"\\]|\\.)*\"|'(?:[^']|'')*'|[^\s,\[\]{}"'#](?:[^,\[\]{}#]*[^\s,\[\]{}#])?"""
# autoloadSkills / "autoloadSkills" / 'autoloadSkills' / autoload-skills, optionally spaced before the colon
_KEY = re.compile(r"""^["']?autoload(?:Skills|-skills)["']?[ \t]*:""")
_LINE = re.compile(
    r"""^(?P<q>["']?)autoload(?:Skills|-skills)(?P=q)[ \t]*:[ \t]*\[(?P<lead>[ \t]*)"""
    rf"""(?:(?P<items>(?:{_ITEM})(?:[ \t]*,[ \t]*(?:{_ITEM}))*)[ \t]*(?:,[ \t]*)?)?\](?:[ \t]+#.*|[ \t]*)$"""
)


def _lines(text: str) -> list[str]:
    """Lines with their own newline bytes (unlike str.splitlines, only \\n ends a line)."""
    return re.findall(r"[^\n]*\n|[^\n]+", text)


def _frontmatter_end(lines: list[str]) -> int:
    if not lines or lines[0].strip() != "---":
        raise SkillsError("agent file has no frontmatter")
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            return index
    raise SkillsError("agent frontmatter is not closed")


def _line_index(lines: list[str], end: int) -> int | None:
    found = [index for index in range(1, end) if _KEY.match(lines[index])]
    if len(found) > 1:
        raise SkillsError("autoloadSkills appears more than once")
    return found[0] if found else None


def _item_value(token: str) -> str:
    if token[0] == '"':
        try:
            return str(json.loads(token))
        except ValueError:
            raise SkillsError(f"autoloadSkills item {token} cannot be read") from None
    return token[1:-1].replace("''", "'") if token[0] == "'" else token


def _parse(body: str) -> tuple["re.Match[str]", list[tuple[str, int, int]]]:
    """The matched line (without its newline) and its items as (name, start, end)."""
    match = _LINE.match(body)
    if match is None:
        raise SkillsError("autoloadSkills is not a single-line list of names")
    items: list[tuple[str, int, int]] = []
    if match.group("items"):
        base = match.start("items")
        for item in re.finditer(_ITEM, match.group("items")):
            items.append((_item_value(item.group()), base + item.start(), base + item.end()))
    return match, items


def _split_line(line: str) -> tuple[str, str]:
    body = line.rstrip("\r\n")
    return body, line[len(body):]


def read_skills(text: str) -> list[str] | None:
    """The `autoloadSkills` list; None when the line is absent. SkillsError when it cannot be read."""

    lines = _lines(text)
    index = _line_index(lines, _frontmatter_end(lines))
    if index is None:
        return None
    return [name for name, _, _ in _parse(_split_line(lines[index])[0])[1]]


def add_skills(text: str, names: list[str]) -> str:
    """`text` with each of `names` not yet in its autoloadSkills line appended to it.

    A missing line is created after `model:` (else at the end of the frontmatter). The new item
    follows the last one as `, "name"` (single-quoted after a single-quoted item); a list
    without items gets it right after the `[`."""

    lines = _lines(text)
    end = _frontmatter_end(lines)
    index = _line_index(lines, end)
    if index is None:
        names = list(dict.fromkeys(names))
        if not names:
            return text
        newline = _split_line(lines[0])[1]
        model = next((i for i in range(1, end) if lines[i].startswith("model:")), end - 1)
        lines.insert(model + 1, "autoloadSkills: " + json.dumps(names) + newline)
        return "".join(lines)
    body, newline = _split_line(lines[index])
    for name in dict.fromkeys(names):
        match, items = _parse(body)
        if name in (existing for existing, _, _ in items):
            continue
        if items:
            quote = "'" if body[items[-1][1]] == "'" else '"'
            at, piece = items[-1][2], f", {quote}{name}{quote}"
        else:
            at, piece = match.end("lead"), f'"{name}"'
        body = body[:at] + piece + body[at:]
    lines[index] = body + newline
    return "".join(lines)


def remove_skills(text: str, names: list[str], drop_empty: bool = False) -> str:
    """`text` with each of `names` removed from its autoloadSkills line: the item and one separator,
    the exact inverse of add_skills. With `drop_empty`, a line left without items is deleted."""

    lines = _lines(text)
    end = _frontmatter_end(lines)
    index = _line_index(lines, end)
    if index is None:
        return text
    body, newline = _split_line(lines[index])
    removed = False
    for name in dict.fromkeys(names):
        while True:
            _, items = _parse(body)
            position = next((i for i, item in enumerate(items) if item[0] == name), None)
            if position is None:
                break
            if position > 0:
                start, stop = items[position - 1][2], items[position][2]
            elif len(items) > 1:
                start, stop = items[0][1], items[1][1]
            else:
                start, stop = items[0][1], items[0][2]
            body = body[:start] + body[stop:]
            removed = True
    if removed and drop_empty and not _parse(body)[1]:
        del lines[index]
    else:
        lines[index] = body + newline
    return "".join(lines)


def upstream_bytes(target: Path, rel: str, data: bytes) -> bytes:
    """An agent file as the upstream release ships it: this project's additions removed.

    Any other file, an unreadable overlay or an unreadable agent file comes back unchanged."""

    agent = rel[len(AGENTS_REL) + 1:-3] if rel.startswith(AGENTS_REL + "/") and rel.endswith(".md") else ""
    if not AGENT_RE.match(agent):
        return data
    try:
        overlay, inserted = _load(target)
        if not overlay.get(agent):
            return data
        return remove_skills(data.decode("utf-8"), overlay[agent], drop_empty=agent in inserted).encode("utf-8")
    except (SkillsError, UnicodeDecodeError):
        return data


# ---------------------------------------------------------------------------
# overlay


def valid_name(name: object) -> bool:
    return isinstance(name, str) and len(name) <= NAME_MAX and NAME_RE.match(name) is not None


def _load(target: Path) -> tuple[dict[str, list[str]], set[str]]:
    """(additions per agent, agents whose autoloadSkills line the helper created); empty when the
    project has no overlay. SkillsError when it is malformed."""

    path = target / OVERLAY_REL
    if not path.is_file():
        return {}, set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise SkillsError(f"{OVERLAY_REL} cannot be read: {error}") from None
    added = data.get("added") if isinstance(data, dict) else None
    inserted = data.get("inserted", []) if isinstance(data, dict) else None
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(added, dict) or not isinstance(inserted, list):
        raise SkillsError(f'{OVERLAY_REL} must be {{"version": {VERSION}, "added": {{agent: [skills]}}}}')
    for agent, names in added.items():
        if not AGENT_RE.match(agent) or not isinstance(names, list) or not all(valid_name(n) for n in names):
            raise SkillsError(f"{OVERLAY_REL}: bad entry for '{agent}'")
    if not all(isinstance(agent, str) and AGENT_RE.match(agent) for agent in inserted):
        raise SkillsError(f"{OVERLAY_REL}: bad 'inserted' list")
    overlay = {agent: list(dict.fromkeys(names)) for agent, names in added.items() if names}
    return overlay, {agent for agent in inserted if agent in overlay}


def load_overlay(target: Path) -> dict[str, list[str]]:
    """{agent: [added skills]}; empty when the project has no overlay. SkillsError when it is malformed."""

    return _load(target)[0]


def _dump_overlay(overlay: dict[str, list[str]], inserted: set[str]) -> str | None:
    """The overlay file's text; None (delete the file) when nothing is added.

    `inserted` names the agents whose autoloadSkills line did not exist upstream and was created
    for the first addition: removing the last addition deletes it again (an upstream `[]` stays)."""

    overlay = {agent: names for agent, names in overlay.items() if names}
    if not overlay:
        return None
    data: dict[str, object] = {"version": VERSION, "added": overlay}
    if inserted & overlay.keys():
        data["inserted"] = sorted(inserted & overlay.keys())
    return json.dumps(data, indent=2, sort_keys=True) + "\n"


def _read_agent(target: Path, agent: str) -> str:
    path = target / agent_rel(agent)
    if not AGENT_RE.match(agent) or not path.is_file():
        raise SkillsError(f"unknown agent '{agent}'")
    try:
        return path.read_bytes().decode("utf-8")  # not read_text: CRLF must survive
    except (OSError, UnicodeDecodeError) as error:
        raise SkillsError(f"{agent_rel(agent)} cannot be read: {error}") from None


def _agents(target: Path) -> list[str]:
    folder = target / AGENTS_REL
    return sorted(p.stem for p in folder.glob("workflow-*.md") if p.is_file()) if folder.is_dir() else []


# ---------------------------------------------------------------------------
# show / set / apply / check


def show(target: Path) -> dict[str, object]:
    overlay = load_overlay(target)
    agents: list[dict[str, object]] = []
    warnings: list[str] = []
    known = _agents(target)
    for agent in known:
        try:
            effective = read_skills(_read_agent(target, agent)) or []
        except SkillsError as error:
            warnings.append(f"{agent}: {error}")
            continue
        added = [name for name in overlay.get(agent, []) if name in effective]
        agents.append(
            {
                "agent": agent,
                "file": agent_rel(agent),
                "workflow": [name for name in effective if name not in added],
                "added": added,
                "effective": effective,
                "forbidden": list(FORBIDDEN_BY_AGENT.get(agent, ())),
            }
        )
    for agent, names in overlay.items():
        if agent not in known:
            warnings.append(f"{OVERLAY_REL} names '{agent}', which has no agent file")
    return {"version": VERSION, "agents": agents, "warnings": warnings}


def plan_set(target: Path, agents: list[str], skills: list[str]) -> dict[str, str | None]:
    """The new content of every file `set` changes ({rel: text}; None deletes the file)."""

    bad = [name for name in skills if not valid_name(name)]
    if bad:
        raise SkillsError("malformed skill name: " + ", ".join(repr(name) for name in bad))
    names = list(dict.fromkeys(skills))
    overlay, inserted = _load(target)
    writes: dict[str, str | None] = {}
    for agent in dict.fromkeys(agents):
        text = _read_agent(target, agent)
        line = read_skills(text)
        current = line or []
        previous = [name for name in overlay.get(agent, []) if name in current]
        defaults = [name for name in current if name not in previous]
        forbidden = [name for name in names if name in FORBIDDEN_BY_AGENT.get(agent, ())]
        if forbidden:
            raise SkillsError(f"{agent} must not load: " + ", ".join(forbidden))
        builtin = [name for name in names if name in defaults]
        if builtin:
            raise SkillsError(f"already loaded by the Workflow for {agent}: " + ", ".join(builtin))
        stale = [name for name in previous if name not in names]
        writes[agent_rel(agent)] = remove_skills(add_skills(text, names), stale, drop_empty=agent in inserted)
        overlay[agent] = names
        if names and (line is None or agent in inserted):
            inserted.add(agent)
        else:
            inserted.discard(agent)
    writes[OVERLAY_REL] = _dump_overlay(overlay, inserted)
    return writes


def plan_apply(target: Path, fresh: frozenset[str] | set[str] = frozenset()) -> tuple[dict[str, str | None], list[str]]:
    """The new content of every file `apply` changes, plus notes.

    `fresh` are agent files just copied from upstream: an overlay entry already in such a
    file's line is now an upstream default, so it leaves the overlay (else it would be
    stripped from the file's hash and, on removal, from the line). A fresh file's line is
    upstream's own, so a line `apply` has to create there is again one it inserted."""

    overlay, inserted = _load(target)
    kept: dict[str, list[str]] = {}
    kept_inserted: set[str] = set()
    writes: dict[str, str | None] = {}
    notes: list[str] = []
    for agent, names in overlay.items():
        rel = agent_rel(agent)
        if not (target / rel).is_file():
            notes.append(f"{agent}: no agent file; its additions stay in {OVERLAY_REL}")
            kept[agent] = names
            if agent in inserted:
                kept_inserted.add(agent)
            continue
        text = _read_agent(target, agent)
        line = read_skills(text)
        current = line or []
        made_line = agent in inserted and rel not in fresh
        if rel in fresh:
            now_default = [name for name in names if name in current]
            if now_default:
                notes.append(f"{agent}: now a Workflow default, no longer an addition: " + ", ".join(now_default))
                names = [name for name in names if name not in current]
        kept[agent] = names
        if names and line is None:
            made_line = True
        if names and made_line:
            kept_inserted.add(agent)
        merged = add_skills(text, names)
        if merged != text:
            writes[rel] = merged
    if kept != overlay or kept_inserted != inserted & overlay.keys():
        writes[OVERLAY_REL] = _dump_overlay(kept, kept_inserted)
    return writes, notes


def commit(target: Path, writes: dict[str, str | None]) -> None:
    """Write every file or none: each through a temp file and os.replace, undone on failure."""

    paths = {rel: target / rel for rel in writes}
    originals = {rel: (path.read_bytes() if path.is_file() else None) for rel, path in paths.items()}
    temps: dict[Path, Path] = {}
    done: list[str] = []
    try:
        for rel, text in writes.items():
            if text is not None:
                path = paths[rel]
                temps[path] = path.with_name(f".{path.name}.tmp-{os.getpid()}")
                temps[path].write_bytes(text.encode("utf-8"))
        for rel, text in writes.items():
            path = paths[rel]
            if text is None:
                path.unlink(missing_ok=True)
            else:
                os.replace(temps[path], path)
                del temps[path]
            done.append(rel)
    except BaseException:
        for temp in temps.values():
            temp.unlink(missing_ok=True)
        for rel in done:
            original = originals[rel]
            if original is None:
                paths[rel].unlink(missing_ok=True)
            else:
                paths[rel].write_bytes(original)
        raise


def check(target: Path) -> list[tuple[str, str]]:
    """Doctor lines: every overlay addition is present in its agent's autoloadSkills line."""

    try:
        overlay = load_overlay(target)
    except SkillsError as error:
        return [("FAIL", str(error))]
    lines: list[tuple[str, str]] = []
    for agent, names in sorted(overlay.items()):
        try:
            effective = read_skills(_read_agent(target, agent)) or []
        except SkillsError as error:
            lines.append(("FAIL", f"role skills: {agent}: {error}"))
            continue
        missing = [name for name in names if name not in effective]
        if missing:
            lines.append(("FAIL", f"role skills: {agent_rel(agent)} lacks {', '.join(missing)} from {OVERLAY_REL} "
                                  "(python3 AI_Workflow_Kit/script/workflow_skills.py apply)"))
    if not lines:
        total = sum(len(names) for names in overlay.values())
        lines.append(("OK", f"role skill additions present: {total} across {len(overlay)} agent(s)" if overlay else "no per-role skill additions"))
    return lines


# ---------------------------------------------------------------------------
# CLI


def _print_show(result: dict[str, object], as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return
    for entry in result["agents"]:  # type: ignore[union-attr]
        extra = f"  (+ {', '.join(entry['added'])})" if entry["added"] else ""
        print(f"{entry['agent']}: {', '.join(entry['effective']) or '-'}{extra}")
    for warning in result["warnings"]:  # type: ignore[union-attr]
        print(f"WARN {warning}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("show", "set", "apply", "check", "has"):
        command = sub.add_parser(name)
        command.add_argument("--target", default=".")
        if name in ("show", "set"):
            command.add_argument("--json", action="store_true")
        if name == "set":
            command.add_argument("--agent", action="append", required=True, default=[])
            command.add_argument("--skills", required=True, help="comma-separated; empty removes every addition")
        if name == "has":
            command.add_argument("--agent", required=True)
            command.add_argument("--skill", required=True)
    args = parser.parse_args(argv)
    target = Path(args.target).resolve()
    try:
        if args.command == "show":
            _print_show(show(target), args.json)
        elif args.command == "set":
            skills = [part.strip() for part in args.skills.split(",")] if args.skills.strip() else []
            commit(target, plan_set(target, args.agent, skills))
            _print_show(show(target), args.json)
        elif args.command == "apply":
            writes, notes = plan_apply(target)
            commit(target, writes)
            for note in notes:
                print(f"NOTE {note}", file=sys.stderr)
            print(f"OK   role skills applied: {len(writes)} file(s) changed")
        elif args.command == "has":
            return 0 if args.skill in (read_skills(_read_agent(target, args.agent)) or []) else 1
        else:
            lines = check(target)
            for level, text in lines:
                print(f"{level}   {text}")
            return 1 if any(level == "FAIL" for level, _ in lines) else 0
    except SkillsError as error:
        print(f"workflow_skills: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
