#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLOSE = ROOT / "AI_Workflow_Kit" / "script" / "workflow_close.py"
GUARD = ROOT / "AI_Workflow_Kit" / "script" / "workflow_guard.py"

STEPS = """# Steps

## Q1 — Quick fix

**Risk:** normal
**Pipeline profile:** quick

### Objective gates

- [ ] [Q1.O1] `$ test -f src/feature.ts` exits 0

## Q2 — Quick but risky

**Risk:** high
**Pipeline profile:** quick

### Objective gates

- [ ] [Q2.O1] `$ true` exits 0

## Q3 — Quick without commands

**Pipeline profile:** quick

### Objective gates

- [ ] [Q3.O1] the page renders

## Q4 — Quick with a failing gate

**Pipeline profile:** quick

### Objective gates

- [ ] [Q4.O1] `$ false` exits 0

## S1 — Standard

### Objective gates

- [ ] [S1.O1] `$ true` exits 0
"""


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def close(root: Path, step: str) -> tuple[int, dict]:
    completed = subprocess.run(
        [sys.executable, str(CLOSE), "check", "--project", str(root), "--step", step, "--json"],
        capture_output=True,
        text=True,
    )
    assert completed.returncode in (0, 1), completed.stderr
    return completed.returncode, json.loads(completed.stdout)


def guarded_worker(root: Path, step: str, role: str, change) -> None:
    subprocess.run([sys.executable, str(GUARD), "--project", str(root), "snapshot", "--role", role, "--step", step], check=True, capture_output=True)
    change()
    subprocess.run([sys.executable, str(GUARD), "--project", str(root), "verify"], capture_output=True)


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        git(root, "init", "-q")
        git(root, "config", "user.email", "t@example.com")
        git(root, "config", "user.name", "t")
        write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS)
        write(root, "AI_Workflow_Kit/docs/AI/STATE.yaml", "current_step: Q1\ntarget_files:\n  - src/\n")
        write(root, "README.md", "x\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "base")
        git(root, "tag", "proj/pre-Q1")

        write(root, "src/feature.ts", "export {}\n")
        code, decision = close(root, "Q1")
        assert code == 0 and decision["decision"] == "review", decision
        assert "no guard verdict for this step" in decision["quick_blockers"]

        git(root, "rm", "-q", "--cached", "-r", "--ignore-unmatch", "src")
        (root / "src/feature.ts").unlink()
        guarded_worker(root, "Q1", "coder", lambda: write(root, "src/feature.ts", "export {}\n"))
        code, decision = close(root, "Q1")
        assert code == 0 and decision["decision"] == "close_quick", decision
        assert decision["effective_profile"] == "quick" and decision["quick_forbidden"] is False
        assert decision["evidence"] and Path(decision["evidence"]).is_file()

        write(root, "src/login.ts", "export const login = 1\n")
        code, decision = close(root, "Q1")
        assert decision["decision"] == "review" and decision["quick_forbidden"] is True
        assert any(blocker.startswith("blast radius: security") for blocker in decision["quick_blockers"]), decision
        assert decision["offer_scoped_security"] is True
        (root / "src/login.ts").unlink()

        guarded_worker(root, "Q1", "coder", lambda: write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS.replace("test -f", "true ||")))
        code, decision = close(root, "Q1")
        assert code == 1 and decision["decision"] == "reject_worker_result", decision
        write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS)

        code, decision = close(root, "Q2")
        assert decision["decision"] == "review" and "card risk is high" in decision["quick_blockers"]

        code, decision = close(root, "Q3")
        assert decision["decision"] == "review"
        assert any("no deterministic Objective gate" in blocker for blocker in decision["quick_blockers"])

        code, decision = close(root, "Q4")
        assert code == 1 and decision["decision"] == "reopen_coder" and decision["objective"]["failed"] == ["Q4.O1"]

        code, decision = close(root, "S1")
        assert code == 0 and decision["decision"] == "review" and decision["quick_blockers"] == []

    print("workflow_close.selftest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
