#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "AI_Workflow_Kit" / "script" / "workflow_gates.py"


def write_project(tmp: Path) -> None:
    docs = tmp / "AI_Workflow_Kit" / "docs" / "AI"
    docs.mkdir(parents=True)
    (tmp / "AI_Workflow_Kit" / "docs" / "STEPS.md").write_text(
        """# Steps

## S1 — Commanded

**Goal:** exercise gates

### Objective gates

- [ ] [S1.O1] `python3 -c 'print(1)'` exits 0
- [ ] [S1.O2] artifact exists in the repo
- [ ] [S1.O3] `python3 -c 'raise SystemExit(2)'` exits 0

## S2 — Manual only

### Objective gates

- [ ] [S2.O1] the settings screen still loads
""",
        encoding="utf-8",
    )
    (docs / "STATE.yaml").write_text("current_step: S1\n", encoding="utf-8")


def run(tmp: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args, "--project", str(tmp), "--json"],
        check=False,
        capture_output=True,
        text=True,
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        write_project(tmp)

        listed = run(tmp, "list")
        assert listed.returncode == 0, listed.stderr
        payload = json.loads(listed.stdout)
        assert payload["step"] == "S1"
        assert payload["command_gates"] == 2
        assert payload["gates"][1]["kind"] == "manual"

        failed = run(tmp, "run")
        assert failed.returncode == 1
        result = json.loads(failed.stdout)
        assert result["status"] == "fail"
        assert result["gates"][0]["ok"] is True
        assert result["gates"][2]["ok"] is False

        (tmp / "AI_Workflow_Kit" / "docs" / "AI" / "STATE.yaml").write_text(
            "current_step: S2\n", encoding="utf-8"
        )
        manual = run(tmp, "run")
        assert manual.returncode == 0
        assert json.loads(manual.stdout)["status"] == "no_commands"

    print("workflow_gates.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
