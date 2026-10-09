#!/usr/bin/env python3
"""Self-test for workflow_graphify_rules.py (R20 doctor warning)."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("workflow_graphify_rules.py")
spec = importlib.util.spec_from_file_location("workflow_graphify_rules", SCRIPT)
rules = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(rules)

FLAGGED = [
    "**MANDATORY: Before using Read, Grep, Glob, or Bash to explore the codebase, you MUST run graphify first:**",
    "Graphify is REQUIRED for every agent.",
    "After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).",
    "./script/graphify_rebuild.sh",
    "Main updates docs; workers must use Graphify on every task.",
    "Every worker must not skip Graphify.",
    "Always run graphify query before reading files.",
]
QUIET = [
    "Graphify is not mandatory for any agent.",
    "You are not required to use Graphify.",
    "Workers must never run graphify update.",
    "Workers MUST NOT run graphify update.",
    "Main owns graphify_rebuild.sh after every handoff.",
    "Use graphify query for unknown code.",
    "Security agents must use Graphify.",
    "Security agents MUST use Graphify for threat-model work.",
    "Main MUST use Graphify before planning.",
    "You must verify Graphify output against real source.",
    "Do not run graphify update; Main does it.",
]
# The rule Graphify installs into projects (`.cursor/rules/graphify.mdc`): two clauses are R20 conflicts.
GRAPHIFY_INSTALLED_RULE = """---
description: graphify knowledge graph context
alwaysApply: true
---

This project has a graphify knowledge graph at graphify-out/.

**MANDATORY: Before using Read, Grep, Glob, or Bash to explore the codebase, you MUST run graphify first:**
- `graphify query "<question>"` — scoped subgraph for any codebase or architecture question
- `graphify path "<A>" "<B>"` — dependency path between two symbols

Only use Read/Grep/Glob directly when:
1. graphify has already oriented you and you need to modify or debug specific lines
2. `graphify-out/graph.json` does not exist yet

- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review when query/path/explain do not surface enough context
- After modifying code files, run `graphify update .` to keep the graph current (AST-only, no API cost)
"""


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / ".cursor" / "rules").mkdir(parents=True)
        for index, line in enumerate(FLAGGED):
            (root / ".cursor" / "rules" / f"flag{index}.mdc").write_text(line + "\n", encoding="utf-8")
        for index, line in enumerate(QUIET):
            (root / ".cursor" / "rules" / f"quiet{index}.mdc").write_text(line + "\n", encoding="utf-8")
        (root / "AGENTS.md").write_text("# Project\n\nUse graphify query for unknown code.\n", encoding="utf-8")
        hits = {path for path, _ in rules.scan(root)}
        expected = {f".cursor/rules/flag{index}.mdc" for index in range(len(FLAGGED))}
        assert hits == expected, sorted(hits ^ expected)
        mixed = [clause for path, clause in rules.scan(root) if path.endswith("flag4.mdc")]
        assert mixed == ["workers must use Graphify on every task"], mixed
        installed = root / "installed"
        (installed / ".cursor" / "rules").mkdir(parents=True)
        (installed / ".cursor" / "rules" / "graphify.mdc").write_text(GRAPHIFY_INSTALLED_RULE, encoding="utf-8")
        clauses = [clause for _, clause in rules.scan(installed)]
        assert len(clauses) == 2 and clauses[0].startswith("**MANDATORY") and "graphify update" in clauses[1], clauses
        clean = root / "clean"
        clean.mkdir()
        (clean / "AGENTS.md").write_text("Use graphify query for unknown code.\n", encoding="utf-8")
        assert rules.main([str(clean)]) == 0
    print("workflow_graphify_rules.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
