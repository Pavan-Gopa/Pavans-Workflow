#!/usr/bin/env python3
"""Find project rule files that make every agent run Graphify or refresh the graph (R20).

  workflow_graphify_rules.py [PROJECT]     prints `<file>: <clause>` per hit; exit 1 on a hit

R20 leaves graph freshness to Main and Graphify to non-trivial discovery. Rules
installed by Graphify itself (`.cursor/rules/graphify.mdc`, AGENTS.md sections)
often say the opposite — "MANDATORY … every subagent", "after modifying code run
`graphify update`" — and OMP loads them into every worker. This is advisory: the
doctor prints a warning, nothing is blocked.

A clause (text split on `.`, `;`, and line breaks) is a hit when it names Graphify and
  * mandates it for everyone: upper-case MANDATORY/MUST, or must/required/always
    together with every/all/each/workers/subagents; or
  * tells agents to refresh it: `graphify update`, `graphify_rebuild`;
unless the clause is negated (never, not, n't, optional, no need) or a refresh
clause names Main as its owner.
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
SHOUTED = re.compile(r"\bMANDATORY\b|\bMUST\b")
OBLIGATION = re.compile(r"\b(?:must|required|mandatory|always)\b", re.I)
EVERYONE = re.compile(r"\b(?:every|all|each|workers?|subagents?)\b", re.I)
NEGATED = re.compile(r"\b(?:never|not|optional)\b|n't\b|\bno need\b", re.I)
MAIN_OWNER = re.compile(r"\bMain\b")


def clause_hit(clause: str) -> bool:
    if not MENTIONS.search(clause) or NEGATED.search(clause):
        return False
    if REFRESH.search(clause):
        return not MAIN_OWNER.search(clause)
    return bool(SHOUTED.search(clause) or (OBLIGATION.search(clause) and EVERYONE.search(clause)))


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
