#!/usr/bin/env python3
"""Find project rule files that make every agent run Graphify or refresh the graph (R20).

  workflow_graphify_rules.py [PROJECT]     prints `<file>: <clause>` per hit; exit 1 on a hit

R20 leaves graph freshness to Main and Graphify to non-trivial discovery. Rules
installed by Graphify itself (`.cursor/rules/graphify.mdc`, AGENTS.md sections)
often say the opposite — "MANDATORY … every subagent", "after modifying code run
`graphify update`" — and OMP loads them into every worker. This is advisory: the
doctor prints a warning, nothing is blocked.

A clause (text split on `.`, `;`, and line breaks) is a hit when it names Graphify and
  * mandates using it (MANDATORY/MUST/must/required/always with run/use/query, or
    "Graphify is required"), unless only a named role (Main, Architect, Security,
    Reviewer, Tester, Coder, Designer) is addressed without every/all/you/workers; or
  * tells agents to refresh it (`graphify update`, `graphify_rebuild`) and does not
    name Main as the owner;
unless it prohibits the action (never/not/don't run|use|refresh …) or calls Graphify
optional, not required, not mandatory, or not needed. "Must not skip Graphify" is a mandate.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

RULE_GLOBS = (
    "AGENTS.md", "CLAUDE.md", ".cursorrules", ".clinerules", ".github/copilot-instructions.md",
    ".cursor/rules/*.mdc", ".cursor/rules/*.md", ".claude/rules/*.md", ".windsurf/rules/*.md",
)
# Sentence ends (`.`/`;` after a non-space) and line breaks; `graphify update .` stays whole.
CLAUSE_SPLIT = re.compile(r"(?<=\S)[.;](?=\s|$)|\n")
MENTIONS = re.compile(r"graphify", re.I)
REFRESH = re.compile(r"graphify[ \t]+update|graphify_rebuild", re.I)
OBLIGATION = re.compile(r"\b(?:must|required|mandatory|always)\b", re.I)
USE = re.compile(r"\b(?:run|use|query|call|consult)\b|\bnot\s+skip\b|graphify\b[^.;]*\b(?:required|mandatory)\b", re.I)
GLOBAL_AUDIENCE = re.compile(r"\b(?:every|all|each|any|you|workers?|subagents?)\b", re.I)
NAMED_ROLE = re.compile(r"\b(?:Main|Architect|Security|Reviewer|Tester|Coder|Designer|Orchestrator)s?\b")
PROHIBITION = re.compile(
    r"\b(?:never|not|don't|do not|mustn't)\s+(?:\w+\s+){0,2}?(?:run|use|call|refresh|update|rebuild|load)\b"
    r"|\boptional\b|\bnot\s+(?:required|mandatory|needed|necessary)\b|\bno need\b",
    re.I,
)


def clause_hit(clause: str) -> bool:
    if not MENTIONS.search(clause) or PROHIBITION.search(clause):
        return False
    if REFRESH.search(clause):
        return not re.search(r"\bMain\b", clause)
    if not (OBLIGATION.search(clause) and USE.search(clause)):
        return False
    role_only = NAMED_ROLE.search(clause) and not GLOBAL_AUDIENCE.search(clause)
    return not role_only


def scan(root: Path) -> list[tuple[str, str]]:
    hits: list[tuple[str, str]] = []
    seen: set[Path] = set()
    for pattern in RULE_GLOBS:
        for path in sorted(root.glob(pattern)):
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            text = path.read_text(encoding="utf-8", errors="replace")
            for clause in CLAUSE_SPLIT.split(text):
                if clause_hit(clause):
                    hits.append((path.relative_to(root).as_posix(), " ".join(clause.split())[:160]))
    return hits


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    root = Path(args[0] if args else ".").resolve()
    hits = scan(root)
    for path, clause in hits:
        print(f"{path}: {clause}")
    return 1 if hits else 0


if __name__ == "__main__":
    raise SystemExit(main())
