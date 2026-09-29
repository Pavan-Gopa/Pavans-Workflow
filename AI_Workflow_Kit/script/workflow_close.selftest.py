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

## Q5 — Quick with a manual gate

**Pipeline profile:** quick

### Objective gates

- [ ] [Q5.O1] `$ true` exits 0
- [ ] [Q5.O2] the settings screen still loads

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


def guarded_worker(root: Path, step: str, role: str, change, edits: tuple[str, ...] = ()) -> None:
    """A worker run as the extension drives it: snapshot, `allow` per edit, verify."""
    agent = f"workflow-{role}"
    subprocess.run([sys.executable, str(GUARD), "--project", str(root), "snapshot", "--role", role, "--agent", agent, "--step", step], check=True, capture_output=True)
    for rel in edits:
        subprocess.run([sys.executable, str(GUARD), "--project", str(root), "allow", "--agent", agent, f"--path={rel}"], capture_output=True)
    change()
    subprocess.run([sys.executable, str(GUARD), "--project", str(root), "verify"], capture_output=True)


def guard_dir(root: Path) -> Path:
    common = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-common-dir"], capture_output=True, text=True).stdout.strip()
    return (root / common).resolve() / "pavans-workflow" / "guard"


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
        assert "no guard verdict for a Coder/Designer run of this step" in decision["quick_blockers"], decision

        git(root, "rm", "-q", "--cached", "-r", "--ignore-unmatch", "src")
        (root / "src/feature.ts").unlink()
        guarded_worker(root, "Q1", "coder", lambda: write(root, "src/feature.ts", "export {}\n"), ("src/feature.ts",))
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

        # Someone else (Main, the Human, a parallel session) edits a workflow file
        # while the Coder runs: not the Coder's, so the step is not stopped.
        guarded_worker(root, "Q1", "coder", lambda: write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS + "\n<!-- Main note -->\n"))
        code, decision = close(root, "Q1")
        assert code == 0 and decision["decision"] == "close_quick", decision
        write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS)

        # A violation the worker itself caused (here: an audit with --whole-repo).
        subprocess.run([sys.executable, str(GUARD), "--project", str(root), "snapshot", "--role", "coder", "--agent", "workflow-coder", "--step", "Q1"], check=True, capture_output=True)
        write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS.replace("test -f", "true ||"))
        subprocess.run([sys.executable, str(GUARD), "--project", str(root), "verify", "--whole-repo"], capture_output=True)
        code, decision = close(root, "Q1")
        assert code == 1 and decision["decision"] == "reject_worker_result", decision
        write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS)
        violation_id = decision["guard"]["open_violations"][0]["id"]

        # A later clean verdict (another agent, or a re-run that sees the leftover
        # change as pre-existing) must not mask the open violation.
        guarded_worker(root, "Q1", "reviewer", lambda: None)
        code, decision = close(root, "Q1")
        assert code == 1 and decision["decision"] == "reject_worker_result", "open violations are never masked"

        subprocess.run(
            [sys.executable, str(GUARD), "--project", str(root), "resolve", "--id", violation_id, "--note", "Human: reverted STEPS.md"],
            check=True, capture_output=True,
        )
        code, decision = close(root, "Q1")
        assert code == 0 and decision["decision"] == "close_quick", decision

        # A 3.5.x violation (whole-repository diff, no schema) is listed, never blocking.
        legacy = {
            "id": "20260101T000000000000Z-reviewer-dead", "role": "reviewer", "agent": "workflow-reviewer", "step": "Q1",
            "verdict": "violation", "violations": [{"path": "HEAD", "reason": "workers never commit, tag, or switch branches"}],
            "notes": [], "changed": ["src/other-session.ts"],
        }
        (guard_dir(root) / f"{legacy['id']}.verdict.json").write_text(json.dumps(legacy), encoding="utf-8")
        code, decision = close(root, "Q1")
        assert code == 0 and decision["decision"] == "close_quick", decision
        assert decision["guard"]["legacy"] == [legacy["id"]] and any("3.5.x" in line for line in decision["guard"]["info"]), decision

        guarded_worker(root, "Q5", "coder", lambda: write(root, "src/q5.ts", "export {}\n"), ("src/q5.ts",))
        code, decision = close(root, "Q5")
        assert decision["decision"] == "review", decision
        assert any("manual Objective gate(s) not verified" in blocker and "Q5.O2" in blocker for blocker in decision["quick_blockers"])
        write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS.replace("- [ ] [Q5.O2]", "- [x] [Q5.O2]"))
        code, decision = close(root, "Q5")
        assert decision["decision"] == "close_quick", decision
        write(root, "AI_Workflow_Kit/docs/STEPS.md", STEPS)
        (root / "src/q5.ts").unlink()

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
