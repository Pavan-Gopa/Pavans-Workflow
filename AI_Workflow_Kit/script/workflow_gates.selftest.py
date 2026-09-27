#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "AI_Workflow_Kit" / "script" / "workflow_gates.py"

STEPS = """# Steps

## How to write a card

```markdown
## S1 — Short title

### Objective gates

- [ ] [S1.O9] `$ touch FENCED_EXAMPLE_RAN` exits 0
```

## S1 — Commanded

**Goal:** exercise gates
**Risk:** normal
**Pipeline profile:** quick

## Verification

### Objective gates

- [ ] [S1.O1] `python3 -c 'print(1)'` exits 0
- [ ] [S1.O2] `README.md` mentions the feature
- [ ] [S1.O3] `python3 -c 'raise SystemExit(2)'` exits 0
- [ ] [S1.O4] `$ echo first > ONE` and `$ echo second > TWO` both succeed

### Judgment gates

- [ ] [S1.J1] `python3 -c 'raise SystemExit(9)'` is a judgment note, never run

## S2 — Manual only

**Risk:** high

### Objective gates

- [ ] [S2.O1] the settings screen still loads

**Stop-gate:** `$ touch STOP_GATE_RAN` must never run

## S3 — Slow

### Objective gates

- [ ] [S3.O1] `$ sleep 30 & sleep 30` finishes

## S4 — _(title)_

### Objective gates

- [ ] [S4.O1] `$ touch TEMPLATE_RAN`
"""


def write_project(tmp: Path) -> None:
    docs = tmp / "AI_Workflow_Kit" / "docs" / "AI"
    docs.mkdir(parents=True)
    (tmp / "AI_Workflow_Kit" / "docs" / "STEPS.md").write_text(STEPS, encoding="utf-8")
    (docs / "STATE.yaml").write_text("current_step: S1  # active\n", encoding="utf-8")


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
        assert payload["risk"] == "normal" and payload["pipeline_profile"] == "quick"
        assert len(payload["card_sha256"]) == 64
        assert payload["gate_count"] == 4, payload
        assert payload["command_gates"] == 3
        manual = payload["gates"][1]
        assert manual["kind"] == "manual" and "note" in manual, "a backticked file name is not executed"
        assert payload["gates"][3]["commands"] == ["echo first > ONE", "echo second > TWO"]

        failed = run(tmp, "run")
        assert failed.returncode == 1, failed.stderr
        result = json.loads(failed.stdout)
        assert result["status"] == "fail"
        assert [gate["ok"] for gate in result["gates"]] == [True, None, False, True]
        assert (tmp / "ONE").exists() and (tmp / "TWO").exists(), "every command on a gate line runs"
        assert not (tmp / "FENCED_EXAMPLE_RAN").exists(), "fenced examples are never executed"

        manual_only = run(tmp, "run", "--step", "S2")
        assert manual_only.returncode == 0
        manual_payload = json.loads(manual_only.stdout)
        assert manual_payload["status"] == "no_commands" and manual_payload["risk"] == "high"
        assert not (tmp / "STOP_GATE_RAN").exists(), "only the Objective gates section runs"
        required = run(tmp, "run", "--step", "S2", "--require-commands")
        assert required.returncode == 3, "a quick close needs at least one deterministic gate"

        template = run(tmp, "run", "--step", "S4")
        assert template.returncode == 2, "template cards are not runnable steps"
        assert not (tmp / "TEMPLATE_RAN").exists()

        started = time.monotonic()
        slow = run(tmp, "run", "--step", "S3", "--timeout", "1")
        elapsed = time.monotonic() - started
        assert slow.returncode == 1
        slow_gate = json.loads(slow.stdout)["gates"][0]
        assert slow_gate["timed_out"] is True and slow_gate["exit_code"] == 124
        assert elapsed < 15, f"timeout must kill the whole process group (took {elapsed:.1f}s)"

        missing = run(tmp, "run", "--step", "S9")
        assert missing.returncode == 2

    # Command recognition: prefixes, runners that used to be caught by the old
    # catch-all, and executables given by path; names are never executed.
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location("workflow_gates", SCRIPT)
    assert spec and spec.loader
    gates = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gates)
    for span in ("cd web && npm test", "env CI=1 npm test", "flutter test", "turbo run test", "mix test", "sbt test"):
        assert gates.command_from_span(span) == span, span
    for span in ("README.md", "maxRetries", "task", "src/app.ts", "install.sh", "cd docs && README.md"):
        assert gates.command_from_span(span) is None, span
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        tool = root / "vendor" / "bin" / "phpunit"
        tool.parent.mkdir(parents=True)
        tool.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        assert gates.command_from_span("vendor/bin/phpunit", root) is None, "not executable yet"
        os.chmod(tool, 0o755)
        assert gates.command_from_span("vendor/bin/phpunit --testsuite unit", root) == "vendor/bin/phpunit --testsuite unit"

    print("workflow_gates.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
