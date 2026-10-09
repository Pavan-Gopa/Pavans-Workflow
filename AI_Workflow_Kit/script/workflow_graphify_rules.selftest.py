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
]
QUIET = [
    "Graphify is not mandatory for any agent.",
    "You are not required to use Graphify.",
    "Workers must never run graphify update.",
    "Main owns graphify_rebuild.sh after every handoff.",
    "Use graphify query for unknown code.",
    "Security agents must use Graphify.",
    "Do not run graphify update; Main does it.",
]


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
        clean = root / "clean"
        clean.mkdir()
        (clean / "AGENTS.md").write_text("Use graphify query for unknown code.\n", encoding="utf-8")
        assert rules.main([str(clean)]) == 0
    print("workflow_graphify_rules.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
