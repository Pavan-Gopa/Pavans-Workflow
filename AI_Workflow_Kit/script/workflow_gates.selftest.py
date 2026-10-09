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

## S5 — Step gate and whole suite

### Objective gates

- [ ] [S5.O1] `$ touch STEP_GATE_RAN` exits 0
- [ ] [S5.O2] (close-only) `$ touch SUITE_RAN` exits 0

## S6 — Only the whole suite

### Objective gates

- [ ] [S6.O1] (close-only) `$ true` exits 0

## S7 — Tester line among the gates

### Objective gates

- [ ] [S7.O1] `$ true` exits 0
**Tester:** required
- [ ] [S7.O2] `$ true` exits 0

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

        # The Coder runs the step's own gates; the whole suite is left to the close check.
        coder = run(tmp, "run", "--step", "S5", "--for", "coder")
        assert coder.returncode == 0, coder.stderr
        coder_payload = json.loads(coder.stdout)
        assert coder_payload["command_gates"] == 1 and coder_payload["close_only_gates"] == 1, coder_payload
        assert (tmp / "STEP_GATE_RAN").exists() and not (tmp / "SUITE_RAN").exists(), "close-only gates never run for the Coder"
        everything = run(tmp, "run", "--step", "S5")
        assert everything.returncode == 0 and (tmp / "SUITE_RAN").exists(), "the close check runs every gate"
        assert [gate["close_only"] for gate in json.loads(everything.stdout)["gates"]] == [False, True]
        only_suite = json.loads(run(tmp, "list", "--step", "S6", "--for", "coder").stdout)
        assert only_suite["command_gates"] == 0 and only_suite["notes"], "a card must leave the Coder a command gate"

        # Every command keeps its full output in a log Main can read.
        logged = run(tmp, "run", "--step", "S1", "--log-dir", str(tmp / "logs"))
        assert logged.returncode == 1
        failing = next(gate for gate in json.loads(logged.stdout)["gates"] if gate["ok"] is False)
        assert Path(failing["runs"][0]["log"]).is_file() and "failure_excerpt" in failing["runs"][0], failing

        # A **Tester:** line placed among the gates never hides the gates after it.
        tester_among = json.loads(run(tmp, "list", "--step", "S7").stdout)
        assert [gate["id"] for gate in tester_among["gates"]] == ["S7.O1", "S7.O2"], tester_among

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

    # Each runner's own failure line reaches the excerpt, ahead of noise that merely mentions failures.
    noise = [
        "ERROR: refusing --enable-gpl: the bundled FFmpeg must stay LGPL-only",
        "objc[1]: Class X is implemented in both A and B. This may cause spurious casting failures.",
        "CompileSwift /tmp/error:fixtures/Cart.swift",
        "ERROR expected application log while test passes",
        "FAIL-safe parser test passed",
        "FAIL NamedScenario passed",
    ]
    samples = {
        "swift": "Sources/App/Cart.swift:12:5: error: cannot find 'total' in scope",
        "xctest": "Test Case '-[CartTests testTotal]' failed (0.104 seconds).",
        "swift-testing": "✘ Test total() recorded an issue at CartTests.swift:9:5: Expectation failed",
        "tsc": "src/app.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        "go-build": "./main.go:12:2: undefined: total",
        "go-test": "--- FAIL: TestTotal (0.00s)",
        "pytest-failed": "FAILED tests/test_cart.py::test_total - assert 3 == 4",
        "pytest-error": "ERROR tests/test_app.py - ImportError: cannot import name 'total'",
        "jest": "\x1b[31mFAIL\x1b[39m src/cart.test.ts",
        "cargo": "error[E0308]: mismatched types",
        "cargo-panic": "thread 'main' panicked at src/main.rs:2:5:",
    }
    for runner_name, line in samples.items():
        excerpt = gates.failure_excerpt("\n".join(noise + ["ok"] * 50 + [line, "Executed 9 tests, with 0 failures"]))
        assert excerpt and gates.ANSI.sub("", line).strip() == excerpt[0], (runner_name, excerpt)
        assert not any("with 0 failures" in item for item in excerpt), (runner_name, excerpt)
    # Noise never takes a runner slot, and an early flood of runner lines never hides the last failure.
    assert not [line for line in noise if gates.RUNNER_FAILURE.search(line)], "benign lines are never runner failures"
    flood = [f"Sources/Gen{n}.swift:{n}:1: error: generated file out of date" for n in range(60)]
    real = "FAILED tests/test_real.py::test_bug - assert 1 == 2"
    excerpt = gates.failure_excerpt("\n".join(flood + [real]))
    assert len(excerpt) == gates.EXCERPT_LINES and real in excerpt and flood[0] in excerpt, excerpt

    # Log names are injective and never path components.
    assert gates.safe_name("feature/auth") != gates.safe_name("feature_auth")
    assert gates.safe_name("feature/auth") != gates.safe_name(gates.safe_name("feature/auth"))
    assert gates.safe_name("ST57.S4") == "ST57.S4"
    assert gates.safe_name("..") not in {".", ".."} and "/" not in gates.safe_name("../x")

    # Retention keeps the 20 most recently run steps, including an old step that was just re-run.
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        write_project(tmp)
        subprocess.run(["git", "-C", str(tmp), "init", "-q"], check=True)
        assert run(tmp, "run", "--step", "S5").returncode == 0
        logs = tmp / ".git" / "pavans-workflow" / "gate-logs"
        os.utime(logs / "S5", (1_000, 1_000))
        for number in range(25):
            (logs / f"OLD{number}").mkdir()
            os.utime(logs / f"OLD{number}", (2_000 + number, 2_000 + number))
        assert run(tmp, "run", "--step", "S5").returncode == 0
        kept = sorted(path.name for path in logs.iterdir())
        assert len(kept) == 20 and "S5" in kept and "OLD24" in kept and "OLD0" not in kept, kept
        assert (logs / "S5" / "S5.O2.log").is_file()

    print("workflow_gates.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
